const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { fitVideoToLimit } = require('./video');
const { imageExtension } = require('./download');
const { UserFacingError } = require('./errors');
const { mediaLog, formatMb } = require('../mediaLog');

// LinkHub (../LinkHub) is the parsing aggregator: it routes a link across several open-source
// parsers (yt-dlp, cobalt, XHS-Downloader, ...) and returns post metadata plus media links.
// The bot still downloads, compresses and uploads itself. Every fetcher in media.js is wrapped
// with withLinkHub(): LinkHub first, the site's own parser as fallback while the migration settles.
const API_URL = (process.env.LINKHUB_API_URL ?? '').replace(/\/+$/, '');
const API_KEY = process.env.LINKHUB_API_KEY ?? '';
const PARSE_TIMEOUT_MS = 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 3 * 60 * 1000;
const MAX_FILES = 10;
// Platforms whose post text is a video description rather than the post itself.
const VIDEO_SITES = new Set(['youtube', 'bilibili']);

function isConfigured() {
	return Boolean(API_URL);
}

function authHeaders() {
	return API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {};
}

async function parse(url) {
	const response = await fetch(`${API_URL}/v1/parse?raw=1`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...authHeaders() },
		body: JSON.stringify({ url }),
		signal: AbortSignal.timeout(PARSE_TIMEOUT_MS),
	});
	const payload = await response.json().catch(() => null);
	if (!payload?.ok) {
		const attempts = payload?.attempts
			?.map((attempt) => `${attempt.adapter}=${attempt.code}`)
			.join(', ');
		const error = new Error(
			`LinkHub ${payload?.code ?? `HTTP ${response.status}`}${attempts ? ` (${attempts})` : ''}`,
		);
		error.code = payload?.code;
		throw error;
	}
	return payload;
}

// "Name @handle", or whichever of the two exists.
function formatAuthor(author) {
	if (!author) return '';
	const { name, handle } = author;
	if (name && handle && handle !== `@${name}`) return `${name} ${handle}`;
	return name || handle || '';
}

// A GIF format: the gateway's transcode (quality=gif) or a GIF the site already serves.
function isGifFormat(format) {
	return (
		format.quality === 'gif' ||
		(format.ext ?? '').toLowerCase() === 'gif' ||
		(format.mimeType ?? '').toLowerCase() === 'image/gif'
	);
}

// Prefer a single H.264 file (plays inline everywhere in Discord) that fits the upload limit when
// the size is known, then any H.264, then any combined video + audio, then whatever is first.
// GIFs are never picked here; animated items try them first in downloadItem.
function pickVideoFormat(formats, maxBytes) {
	const videos = formats.filter((format) => !isGifFormat(format));
	const combined = videos.filter(
		(format) => format.hasVideo !== false && format.hasAudio !== false,
	);
	const h264 = combined.filter((format) => /^(?:h264|avc1)/i.test(format.videoCodec ?? ''));
	const fits = (format) => format.sizeBytes && format.sizeBytes <= maxBytes;
	return h264.find(fits) ?? h264[0] ?? combined.find(fits) ?? combined[0] ?? videos[0] ?? null;
}

class GifUnavailableError extends Error {
	constructor(message, code) {
		super(message);
		this.code = code;
	}
}

// Downloads an animated item's GIF, capped at maxBytes. Through the gateway, ?maxBytes= makes the
// transcode pick a size that fits (413 GIF_TOO_LARGE when even the smallest step doesn't); a GIF
// the site already serves isn't resized, so the size is checked here. Any failure throws
// GifUnavailableError and the caller falls back to the item's mp4.
async function downloadGif(format, filePath, maxBytes) {
	const viaGateway = Boolean(format.downloadUrl);
	const url = new URL(format.downloadUrl ?? format.url);
	if (viaGateway) url.searchParams.set('maxBytes', String(Math.max(1, Math.floor(maxBytes))));
	let response;
	try {
		response = await fetch(url, {
			headers: viaGateway ? authHeaders() : (format.headers ?? {}),
			signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
		});
	}
	catch (error) {
		throw new GifUnavailableError(`GIF request failed: ${error.message}`, 'NETWORK');
	}
	if (!response.ok) {
		const payload = await response.json().catch(() => null);
		const code = payload?.code ?? `HTTP_${response.status}`;
		throw new GifUnavailableError(`LinkHub GIF HTTP ${response.status} ${code}`, code);
	}
	const contentType = (response.headers.get('content-type') ?? '')
		.split(';')[0]
		.trim()
		.toLowerCase();
	if (contentType && contentType !== 'image/gif') {
		await response.body?.cancel().catch(() => undefined);
		throw new GifUnavailableError(`GIF response is ${contentType}`, 'NOT_GIF');
	}
	if (Number(response.headers.get('content-length')) > maxBytes) {
		await response.body?.cancel().catch(() => undefined);
		throw new GifUnavailableError('GIF is over the upload limit', 'GIF_TOO_LARGE');
	}
	// content-length may be missing or wrong, so count while streaming and stop at the limit.
	let size = 0;
	const limit = new Transform({
		transform(chunk, _encoding, callback) {
			size += chunk.length;
			if (size > maxBytes) {
				callback(new GifUnavailableError('GIF is over the upload limit', 'GIF_TOO_LARGE'));
				return;
			}
			callback(null, chunk);
		},
	});
	try {
		await pipeline(Readable.fromWeb(response.body), limit, fs.createWriteStream(filePath));
	}
	catch (error) {
		await fsp.rm(filePath, { force: true });
		if (error instanceof GifUnavailableError) throw error;
		throw new GifUnavailableError(`GIF download failed: ${error.message}`, 'NETWORK');
	}
	mediaLog.info(`downloaded GIF ${formatMb(size)} via ${viaGateway ? 'LinkHub' : url.hostname}`);
}

// Prefer downloadUrl: the gateway adds the right request headers, and for sites whose direct
// links reject third parties (TikTok) it has the upstream tool download the file itself.
async function downloadFormat(format, filePath) {
	const viaGateway = Boolean(format.downloadUrl);
	const response = await fetch(format.downloadUrl ?? format.url, {
		headers: viaGateway ? authHeaders() : (format.headers ?? {}),
		signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`LinkHub download HTTP ${response.status}`);
	}
	await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(filePath));
	mediaLog.info(
		`downloaded ${formatMb(fs.statSync(filePath).size)} via ${viaGateway ? 'LinkHub' : new URL(format.url).hostname}`,
	);
	return (response.headers.get('content-type') ?? '').split(';')[0].trim();
}

async function downloadItem(item, dir, index, maxBytes) {
	if (!item.formats?.length) return null;
	// Animated items (X GIFs, live photos) go out as a GIF: Discord loops it, while an mp4 plays once.
	const gifFormat =
		item.type === 'video' && item.animation ? item.formats.find(isGifFormat) : null;
	if (gifFormat) {
		const name = `image-${index}.gif`;
		const filePath = path.join(dir, name);
		try {
			await downloadGif(gifFormat, filePath, maxBytes);
			return { path: filePath, name, ext: 'gif', isVideo: false };
		}
		catch (error) {
			if (!(error instanceof GifUnavailableError)) throw error;
			mediaLog.info(`GIF unavailable (${error.code}): ${error.message}; using the mp4`);
		}
	}
	if (item.type === 'video' || item.type === 'audio') {
		const format = pickVideoFormat(item.formats, maxBytes);
		if (!format) return null;
		const ext = /^[a-z0-9]{2,5}$/i.test(format.ext ?? '') ? format.ext.toLowerCase() : 'mp4';
		const name = `video-${index}.${ext}`;
		const filePath = path.join(dir, name);
		await downloadFormat(format, filePath);
		return { path: filePath, name, ext, isVideo: true, durationSec: item.durationSec };
	}
	const tempPath = path.join(dir, `image-${index}`);
	const contentType = await downloadFormat(item.formats[0], tempPath);
	const extension = imageExtension(contentType) ?? item.formats[0].ext ?? 'jpg';
	const filePath = `${tempPath}.${extension}`;
	await fsp.rename(tempPath, filePath);
	return { path: filePath, name: `image-${index}.${extension}`, isVideo: false };
}

async function fetchViaLinkHub(url, dir, maxBytes, onStage) {
	const { post, items, meta, raw } = await parse(url);
	mediaLog.info(
		`LinkHub: ${meta.platform} via ${meta.adapter}${meta.cached ? ' (cached)' : ''}, ${items.length} item(s)` +
			`${meta.linkValidation === 'failed' ? ', direct links unusable (gateway downloads)' : ''}`,
	);

	// Video sites carry the description in text; the bot only posts the title there.
	const text = VIDEO_SITES.has(meta.platform) ? post.title || '' : post.text || post.title || '';
	const result = { files: [], author: formatAuthor(post.author), text, compressed: false };
	// Discord blurs SPOILER_ attachments, matching X's sensitive-media warning.
	const filePrefix = raw?.possibly_sensitive ? 'SPOILER_' : '';
	if (!items.length) return result;

	onStage?.('downloading');
	const list = items.slice(0, MAX_FILES);

	// A single video may be compressed to fit; with several items, keep whatever fits as-is.
	if (list.length === 1) {
		const file = await downloadItem(list[0], dir, 1, maxBytes);
		if (file?.isVideo) {
			const { filePath, compressed } = await fitVideoToLimit(
				file.path,
				dir,
				maxBytes,
				onStage,
				file.durationSec,
			);
			result.files.push({
				path: filePath,
				name: `${filePrefix}video.${compressed ? 'mp4' : file.ext}`,
			});
			result.compressed = compressed;
		}
		else if (file) {
			result.files.push({ ...file, name: filePrefix + file.name });
		}
		return result;
	}

	let totalBytes = 0;
	for (const [index, item] of list.entries()) {
		const file = await downloadItem(item, dir, index + 1, maxBytes - totalBytes);
		if (!file) continue;
		const { size } = await fsp.stat(file.path);
		if (totalBytes + size > maxBytes) {
			mediaLog.info(`skipping item ${index + 1} (${formatMb(size)}): over the upload limit`);
			continue;
		}
		totalBytes += size;
		result.files.push({ ...file, name: filePrefix + file.name });
	}
	if (result.files.length < list.length) {
		result.note = `共 ${list.length} 个媒体，受上传上限只附上 ${result.files.length} 个`;
	}
	return result;
}

async function clearDir(dir) {
	for (const name of await fsp.readdir(dir)) {
		await fsp.rm(path.join(dir, name), { recursive: true, force: true });
	}
}

// LinkHub first; the site's own parser when LinkHub isn't configured or fails. Errors meant for
// the user (too long to compress, ...) are final either way.
function withLinkHub(fallback) {
	return async (url, dir, maxBytes, onStage) => {
		if (!isConfigured()) return fallback(url, dir, maxBytes, onStage);
		try {
			return await fetchViaLinkHub(url, dir, maxBytes, onStage);
		}
		catch (error) {
			if (error instanceof UserFacingError || error.code === 'VIDEO_TOO_LONG') throw error;
			mediaLog.warn(`LinkHub failed: ${error.message}; falling back to the local parser`);
			await clearDir(dir);
			return fallback(url, dir, maxBytes, onStage);
		}
	};
}

module.exports = {
	fetchViaLinkHub,
	withLinkHub,
	isConfigured,
	// For tests.
	pickVideoFormat,
	downloadItem,
};
