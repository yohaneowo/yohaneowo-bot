const fs = require('node:fs/promises');
const path = require('node:path');

// Facebook and Instagram serve link-preview (Open Graph) data to known crawlers without a login.
// That gives the author, post text and cover image, but never the video file itself.
const CRAWLER_USER_AGENT = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)';
const REQUEST_TIMEOUT_MS = 15 * 1000;
const IMAGE_EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

// Shown under posts built from link-preview data, so readers know it is not the full post.
const PREVIEW_NOTE = '无法取得完整内容，只显示预览';

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

async function fetchOpenGraph(url) {
	const response = await fetch(url, {
		headers: { 'User-Agent': CRAWLER_USER_AGENT },
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`${new URL(url).hostname} returned HTTP ${response.status}`);
	}
	return parseOpenGraph(await response.text());
}

// Downloads og:image into dir, but only from hosts matching allowedUrlPattern (the site's own CDN),
// so a page can't make the bot fetch arbitrary URLs.
async function downloadImage(imageUrl, allowedUrlPattern, dir, maxBytes) {
	if (!allowedUrlPattern.test(imageUrl)) {
		return null;
	}

	const response = await fetch(imageUrl, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
	const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim();
	if (!response.ok || !IMAGE_EXTENSIONS[contentType]) {
		throw new Error(`Image request returned HTTP ${response.status} (${contentType || 'no type'})`);
	}

	const buffer = Buffer.from(await response.arrayBuffer());
	if (buffer.length > maxBytes) {
		throw new Error('Image exceeds the upload limit');
	}

	const name = `image.${IMAGE_EXTENSIONS[contentType]}`;
	const filePath = path.join(dir, name);
	await fs.writeFile(filePath, buffer);
	return { path: filePath, name };
}

module.exports = {
	PREVIEW_NOTE,
	fetchOpenGraph,
	downloadImage,
};
