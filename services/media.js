const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fetchVideo } = require('./sites/video');
const { fetchFacebookPost } = require('./sites/facebook');

// Sites the bot will fetch from, each with its own fetcher. Add a site by adding an entry.
// Only listed sites are accepted so arbitrary URLs (e.g. LAN addresses) are never requested.
// A fetcher receives (url, dir, maxBytes, onStage) and returns { files, author, text, compressed }.
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
