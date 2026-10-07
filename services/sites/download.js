const fs = require('node:fs');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_DOWNLOAD_BYTES = 500 * 1000 * 1000;
const IMAGE_EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

// Streams url into filePath. allowedUrlPattern pins the host (the site's own CDN) so a site's
// data can never make the bot fetch arbitrary URLs. Returns the response content type.
async function downloadToFile(url, filePath, allowedUrlPattern) {
	if (!allowedUrlPattern.test(url)) {
		throw new Error(`Refusing to download from ${new URL(url).hostname}`);
	}

	const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
	if (!response.ok) {
		throw new Error(`Media request returned HTTP ${response.status}`);
	}
	if (Number(response.headers.get('content-length')) > MAX_DOWNLOAD_BYTES) {
		throw new Error('Media file is too large to download');
	}

	await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(filePath));
	return (response.headers.get('content-type') ?? '').split(';')[0].trim();
}

function imageExtension(contentType) {
	return IMAGE_EXTENSIONS[contentType] ?? null;
}

module.exports = {
	downloadToFile,
	imageExtension,
};
