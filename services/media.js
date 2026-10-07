const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fetchVideo } = require('./sites/video');
const { fetchFacebookPost } = require('./sites/facebook');
const { fetchInstagramPost } = require('./sites/instagram');
const { fetchXiaohongshuNote } = require('./sites/xiaohongshu');
const { fetchYouTubeShort } = require('./sites/youtube');

// Sites the bot will fetch from, each with its own fetcher. Add a site by adding an entry.
// Only listed sites are accepted so arbitrary URLs (e.g. LAN addresses) are never requested.
// A fetcher receives (url, dir, maxBytes, onStage) and returns
// { files, author, text, compressed, note? } — note is an optional line shown under the post.
const SUPPORTED_SITES = [
	{
		name: 'TikTok',
		pattern:
			/^https?:\/\/(?:(?:(?:www|m)\.)?tiktok\.com\/(?:@[\w.-]+\/video\/\d+|t\/[\w-]+|v\/\d+)|(?:vm|vt)\.tiktok\.com\/[\w-]+)/i,
		fetch: fetchVideo,
	},
	{
		name: 'Facebook',
		pattern:
			/^https?:\/\/(?:(?:(?:www|m|web|mbasic)\.)?facebook\.com\/(?:share\/(?:[prv]\/)?[\w-]+|[\w.-]+\/posts\/|groups\/[\w.-]+\/(?:posts|permalink)\/|permalink\.php\?|story\.php\?|photo(?:\.php)?\/?\?|[\w.-]+\/photos\/|reel\/\d+|watch\/?\?|[\w.-]+\/videos\/)|fb\.watch\/[\w-]+)/i,
		fetch: fetchFacebookPost,
	},
	{
		name: 'Instagram',
		pattern: /^https?:\/\/(?:www\.)?instagram\.com\/(?:[\w.]+\/)?(?:reels?|p|tv)\/[\w-]+|^https?:\/\/(?:www\.)?instagram\.com\/share\/(?:reel\/|p\/)?[\w-]+/i,
		fetch: fetchInstagramPost,
	},
	{
		name: '小红书',
		pattern: /^https?:\/\/(?:xhslink\.com\/(?:[a-z]\/)?\w+|(?:www\.)?xiaohongshu\.com\/(?:explore|discovery\/item)\/[\da-f]+)/i,
		fetch: fetchXiaohongshuNote,
	},
	{
		name: 'YouTube',
		// Shorts only; regular videos are too long to post.
		pattern: /^https?:\/\/(?:(?:www|m)\.)?youtube\.com\/shorts\/[\w-]{11}/i,
		fetch: fetchYouTubeShort,
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

// Fetches a supported link into a fresh temp dir. Caller must call cleanup() when done.
// onStage is called with 'downloading' and (if needed) 'compressing' as the work progresses.
async function downloadMedia(url, maxBytes, onStage) {
	const site = findSupportedSite(url);
	if (!site) {
		throw new Error(`Unsupported URL: ${url}`);
	}

	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'media-'));
	const cleanup = () => fs.rm(dir, { recursive: true, force: true });

	try {
		const result = await site.fetch(url, dir, maxBytes, onStage);
		return { ...result, site: site.name, cleanup };
	}
	catch (error) {
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
