const fs = require('node:fs/promises');
const path = require('node:path');

// Facebook serves link-preview (Open Graph) data to known crawlers without a login.
// That gives the author, post text and first image, but never the video file itself.
const CRAWLER_USER_AGENT = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)';
const REQUEST_TIMEOUT_MS = 15 * 1000;
// og:image must point at Facebook's CDN; anything else is never fetched.
const IMAGE_URL_PATTERN = /^https:\/\/[\w.-]+\.(?:fbcdn\.net|fbsbx\.com)\//i;
const IMAGE_EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

function decodeHtmlEntities(text) {
	return text
		.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, '\'')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');
}

function parseOpenGraph(html) {
	const meta = {};
	for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
		const key = tag.match(/\b(?:property|name)="([^"]+)"/i)?.[1];
		const content = tag.match(/\bcontent="([^"]*)"/i)?.[1];
		if (key && content !== undefined && !(key in meta)) {
			meta[key] = decodeHtmlEntities(content);
		}
	}
	return meta;
}

async function downloadImage(imageUrl, dir, maxBytes) {
	const response = await fetch(imageUrl, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
	const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim();
	if (!response.ok || !IMAGE_EXTENSIONS[contentType]) {
		throw new Error(`Facebook image request returned HTTP ${response.status} (${contentType || 'no type'})`);
	}

	const buffer = Buffer.from(await response.arrayBuffer());
	if (buffer.length > maxBytes) {
		throw new Error('Facebook image exceeds the Discord upload limit');
	}

	const name = `image.${IMAGE_EXTENSIONS[contentType]}`;
	const filePath = path.join(dir, name);
	await fs.writeFile(filePath, buffer);
	return { path: filePath, name };
}

// Fetches a public Facebook post's author, text and first image into dir.
async function fetchFacebookPost(url, dir, maxBytes, onStage) {
	const response = await fetch(url, {
		headers: { 'User-Agent': CRAWLER_USER_AGENT },
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`Facebook returned HTTP ${response.status}`);
	}

	const meta = parseOpenGraph(await response.text());
	const author = meta['og:title'] ?? '';
	const text = meta['og:description'] ?? '';
	const imageUrl = meta['og:image'] ?? '';
	// Private posts and login walls come back without post data (or titled "Facebook"/"Log in").
	if ((!text && !imageUrl) || /^(?:facebook|log in|登入|登录)/i.test(author)) {
		throw new Error('Facebook post is private or unavailable without login');
	}

	onStage?.('downloading');
	const files = [];
	if (IMAGE_URL_PATTERN.test(imageUrl)) {
		files.push(await downloadImage(imageUrl, dir, maxBytes));
	}

	return {
		files,
		author,
		text,
		compressed: false,
	};
}

module.exports = {
	fetchFacebookPost,
};
