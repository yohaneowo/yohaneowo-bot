const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fetchVideo, EmptyFileError } = require('./sites/video');
const { fetchFacebookVideo, fetchFacebookPreview } = require('./sites/facebook');
const { fetchInstagramPost } = require('./sites/instagram');
const { fetchXiaohongshuNote } = require('./sites/xiaohongshu');
const { fetchYouTubeShort } = require('./sites/youtube');
const { fetchThreadsPost } = require('./sites/threads');
const { fetchXPost } = require('./sites/x');
const { withFallbackChain } = require('./sites/chain');
const { createJob, jobLogger, runInJob, formatMb } = require('./mediaLog');

// Sites the bot will fetch from, each with its own fetcher. Add a site by adding an entry.
// Only listed sites are accepted so arbitrary URLs (e.g. LAN addresses) are never requested.
// Every fetcher is wrapped with withFallbackChain(): LinkHub (LINKHUB_API_URL) parses first, the
// site's own parser is the fallback, and yt-dlp sites get one more run with different settings
// (`alt`) when a file comes back empty. A fetcher receives (url, dir, maxBytes, onStage) and
// returns { files, author, text, compressed, note? } — note is an optional line shown under the post.
const fetchVideoAlt = (url, dir, maxBytes, onStage) =>
	fetchVideo(url, dir, maxBytes, onStage, { strategy: 'alt' });
const fetchYouTubeShortAlt = (url, dir, maxBytes, onStage) =>
	fetchYouTubeShort(url, dir, maxBytes, onStage, { strategy: 'alt' });

const SUPPORTED_SITES = [
	{
		name: 'TikTok',
		pattern:
			/^https?:\/\/(?:(?:(?:www|m)\.)?tiktok\.com\/(?:@[\w.-]+\/video\/\d+|t\/[\w-]+|v\/\d+)|(?:vm|vt)\.tiktok\.com\/[\w-]+)/i,
		fetch: withFallbackChain(fetchVideo, { site: 'TikTok', alt: fetchVideoAlt }),
	},
	{
		name: 'Facebook',
		pattern:
			/^https?:\/\/(?:(?:(?:www|m|web|mbasic)\.)?facebook\.com\/(?:share\/(?:[prv]\/)?[\w-]+|[\w.-]+\/posts\/|groups\/[\w.-]+\/(?:posts|permalink)\/|permalink\.php\?|story\.php\?|photo(?:\.php)?\/?\?|[\w.-]+\/photos\/|reel\/\d+|watch\/?\?|[\w.-]+\/videos\/)|fb\.watch\/[\w-]+)/i,
		// LinkHub's Cobalt returns another reel's video for some Facebook links (it takes the first video
		// in the page), so yt-dlp goes first; LinkHub is the second try and the link preview the last.
		fetch: withFallbackChain(fetchFacebookPreview, { site: 'Facebook', first: fetchFacebookVideo }),
	},
	{
		name: 'Instagram',
		pattern:
			/^https?:\/\/(?:www\.)?instagram\.com\/(?:[\w.]+\/)?(?:reels?|p|tv)\/[\w-]+|^https?:\/\/(?:www\.)?instagram\.com\/share\/(?:reel\/|p\/)?[\w-]+/i,
		fetch: withFallbackChain(fetchInstagramPost, { site: 'Instagram' }),
	},
	{
		name: '小红书',
		pattern:
			/^https?:\/\/(?:xhslink\.com\/(?:[a-z]\/)?\w+|(?:www\.)?xiaohongshu\.com\/(?:explore|discovery\/item)\/[\da-f]+)/i,
		fetch: withFallbackChain(fetchXiaohongshuNote, { site: '小红书' }),
	},
	{
		name: 'YouTube',
		// Shorts only; regular videos are too long to post.
		pattern: /^https?:\/\/(?:(?:www|m)\.)?youtube\.com\/shorts\/[\w-]{11}/i,
		fetch: withFallbackChain(fetchYouTubeShort, { site: 'YouTube', alt: fetchYouTubeShortAlt }),
	},
	{
		name: 'B站',
		// Videos (BV / av ids) and the b23.tv / bili2233.cn short links the app shares.
		pattern:
			/^https?:\/\/(?:(?:(?:www|m)\.)?bilibili\.com\/video\/(?:BV\w{10}|av\d+)|(?:b23\.tv|bili2233\.cn)\/[\w-]+)/i,
		fetch: withFallbackChain(fetchVideo, { site: 'B站', alt: fetchVideoAlt }),
	},
	{
		name: 'Threads',
		pattern:
			/^https?:\/\/(?:www\.)?threads\.(?:com|net)\/(?:@[\w.]+\/post\/[\w-]+|share\/[\w-]+)/i,
		fetch: withFallbackChain(fetchThreadsPost, { site: 'Threads' }),
	},
	{
		name: 'X',
		// Also the fxtwitter / vxtwitter / fixupx mirrors people share for better embeds.
		pattern:
			/^https?:\/\/(?:(?:www|mobile)\.)?(?:x|twitter|fxtwitter|vxtwitter|fixupx|fixvx)\.com\/(?:\w{1,15}|i(?:\/web)?)\/status(?:es)?\/\d+/i,
		fetch: withFallbackChain(fetchXPost, { site: 'X' }),
	},
];

const URL_TOKEN_PATTERN = /https?:\/\/[^\s<>]+/gi;

function findSupportedSite(url) {
	return SUPPORTED_SITES.find((site) => site.pattern.test(url)) ?? null;
}

function extractMediaUrls(text) {
	const urls = String(text ?? '').match(URL_TOKEN_PATTERN) ?? [];
	return [...new Set(urls.filter((url) => findSupportedSite(url)))];
}

// True when the text is nothing but supported links (an optional <...> wrapper included),
// so deleting the message loses nothing.
function isOnlyMediaUrls(text) {
	const tokens = String(text ?? '')
		.split(/\s+/)
		.filter(Boolean)
		.map((token) => token.replace(/^<(.*)>$/, '$1'));
	return tokens.length > 0 && tokens.every((token) => findSupportedSite(token));
}

// Fetches a supported link into a fresh temp dir. Caller must call cleanup() when done, and can
// log later steps (uploading) under the same job with the returned log.
// onStage is called with 'downloading' and (if needed) 'compressing' as the work progresses.
async function downloadMedia(url, maxBytes, onStage) {
	const site = findSupportedSite(url);
	if (!site) {
		throw new Error(`Unsupported URL: ${url}`);
	}

	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'media-'));
	const cleanup = () => fs.rm(dir, { recursive: true, force: true });
	const job = createJob(site.name);
	const log = jobLogger(job);

	try {
		log.info(`start ${url} (upload limit ${formatMb(maxBytes)})`);
		const result = await runInJob(job, () => site.fetch(url, dir, maxBytes, onStage));
		const sizes = await Promise.all(
			result.files.map((file) => fs.stat(file.path).then((stat) => stat.size)),
		);
		// Last line of defence for every site: a 0-byte attachment is never a valid result.
		if (sizes.some((size) => size === 0)) {
			throw new EmptyFileError('a downloaded file is 0 bytes');
		}
		log.info(
			`parsed: ${result.files.length} file(s), ${formatMb(sizes.reduce((a, b) => a + b, 0))}` +
				`${result.compressed ? ', compressed' : ''}${result.note ? `, note "${result.note}"` : ''}`,
		);
		return { ...result, site: site.name, log, cleanup };
	}
	catch (error) {
		log.warn(`failed: ${error.message}`);
		await cleanup();
		if (error.code === 'VIDEO_TOO_LONG') {
			// Space out Latin names ("到 TikTok 观看") but not Chinese ones ("到小红书观看").
			const name = /^[\x20-\x7e]+$/.test(site.name) ? ` ${site.name} ` : site.name;
			error.userMessage = `影片太长，压缩后会太糊，建议直接到${name}观看`;
		}
		throw error;
	}
}

module.exports = {
	SUPPORTED_SITES,
	findSupportedSite,
	extractMediaUrls,
	isOnlyMediaUrls,
	downloadMedia,
};
