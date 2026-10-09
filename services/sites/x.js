const fs = require('node:fs/promises');
const path = require('node:path');
const { fetchVideo, fitVideoToLimit } = require('./video');
const { downloadToFile, imageExtension } = require('./download');
const { mediaLog, formatMb } = require('../mediaLog');

// X (Twitter) posts come from the syndication endpoint that embedded tweets use. It answers
// without a login and returns the text, author, photos and every mp4 rendition of the videos.
// Age-restricted and protected posts come back empty; those fall back to yt-dlp (videos only).
const SYNDICATION_URL = 'https://cdn.syndication.twimg.com/tweet-result';
const REQUEST_TIMEOUT_MS = 15 * 1000;
const MEDIA_URL_PATTERN = /^https:\/\/(?:pbs|video)\.twimg\.com\//i;

function getPostId(url) {
	const id = url.match(/\/status(?:es)?\/(\d+)/)?.[1];
	if (!id) throw new Error('No post id in the X link');
	return id;
}

// The endpoint wants a token derived from the id (the same formula X's embed script uses).
function syndicationToken(id) {
	return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

async function fetchTweet(id) {
	const response = await fetch(`${SYNDICATION_URL}?id=${id}&token=${syndicationToken(id)}&lang=en`, {
		headers: { 'User-Agent': 'Mozilla/5.0' },
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`X syndication returned HTTP ${response.status}`);
	}
	const tweet = await response.json().catch(() => null);
	if (tweet?.__typename !== 'Tweet') {
		throw new Error(`X post unavailable without login (${tweet?.__typename ?? 'empty response'})`);
	}
	return tweet;
}

function decodeEntities(text) {
	return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// display_text_range (in code points) cuts off the trailing t.co link to the media itself;
// other t.co links are expanded so readers see where they go.
function formatText(tweet) {
	const [start, end] = tweet.display_text_range ?? [0, Infinity];
	let text = Array.from(tweet.text ?? '').slice(start, end).join('');
	for (const link of tweet.entities?.urls ?? []) {
		if (link.url && link.expanded_url) text = text.split(link.url).join(link.expanded_url);
	}
	return decodeEntities(text).trim();
}

function formatAuthor(user) {
	if (!user?.screen_name) return '';
	return user.name && user.name !== user.screen_name ? `${user.name} @${user.screen_name}` : `@${user.screen_name}`;
}

async function contentLength(url) {
	if (!MEDIA_URL_PATTERN.test(url)) return null;
	const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }).catch(() => null);
	return Number(response?.headers.get('content-length')) || null;
}

// Highest-quality mp4 that fits the budget. The listed bitrates are peaks (files come out about
// half that), so ask for each file's real size instead of estimating. When none fits, the
// smallest one (compressed afterwards when it is the only item).
async function pickVideoVariant(media, budgetBytes) {
	const variants = (media.video_info?.variants ?? [])
		.filter((variant) => variant.content_type === 'video/mp4')
		.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
	for (const variant of variants) {
		const size = await contentLength(variant.url);
		if (size && size <= budgetBytes) return variant;
	}
	return variants.at(-1);
}

async function downloadMediaItem(media, dir, index, budgetBytes, filePrefix) {
	if (media.type === 'video' || media.type === 'animated_gif') {
		const variant = await pickVideoVariant(media, budgetBytes);
		if (!variant) return null;
		const resolution = variant.url.match(/\/(\d+x\d+)\//)?.[1] ?? '?';
		mediaLog.info(`${media.type} ${index}: picked ${resolution} (${Math.round((variant.bitrate ?? 0) / 1000)} kbps)`);
		const name = `${filePrefix}video-${index}.mp4`;
		const filePath = path.join(dir, name);
		await downloadToFile(variant.url, filePath, MEDIA_URL_PATTERN);
		return { path: filePath, name, isVideo: true };
	}

	if (!media.media_url_https) return null;
	// name=orig asks for the original upload instead of the resized default.
	const tempPath = path.join(dir, `image-${index}`);
	const contentType = await downloadToFile(`${media.media_url_https}?name=orig`, tempPath, MEDIA_URL_PATTERN);
	const extension = imageExtension(contentType) ?? 'jpg';
	const name = `${filePrefix}image-${index}.${extension}`;
	const filePath = path.join(dir, name);
	await fs.rename(tempPath, filePath);
	return { path: filePath, name, isVideo: false };
}

// Logged-out fallback for posts the embed endpoint won't show: yt-dlp may still get the video.
async function fetchXVideoWithYtDlp(url, dir, maxBytes, onStage) {
	const video = await fetchVideo(url, dir, maxBytes, onStage);
	const { uploader, uploaderId, description } = video.info;
	return {
		...video,
		author: [uploader, uploaderId && `@${uploaderId}`].filter(Boolean).join(' '),
		text: description ?? '',
	};
}

async function fetchXPost(url, dir, maxBytes, onStage) {
	const id = getPostId(url);
	let tweet;
	try {
		tweet = await fetchTweet(id);
	}
	catch (error) {
		mediaLog.warn(`${error.message}; trying yt-dlp`);
		// Mirror links (fxtwitter etc.) aren't yt-dlp URLs, so hand it the canonical one.
		return fetchXVideoWithYtDlp(`https://x.com/i/status/${id}`, dir, maxBytes, onStage);
	}

	// A post with no media of its own that quotes one with media shows the quoted media.
	const quoted = tweet.quoted_tweet;
	const source = tweet.mediaDetails?.length ? tweet : quoted?.mediaDetails?.length ? quoted : null;
	const textParts = [formatText(tweet)];
	if (quoted && source === quoted) {
		textParts.push(`↪ ${formatAuthor(quoted.user)}：${formatText(quoted)}`.trim());
	}
	const result = {
		files: [],
		author: formatAuthor(tweet.user),
		text: textParts.filter(Boolean).join('\n\n'),
		compressed: false,
	};
	const items = source?.mediaDetails ?? [];
	mediaLog.info(
		`post ${id} by ${result.author || '?'}: ${items.length ? items.map((media) => media.type).join(', ') : 'text only'}` +
			`${source === quoted && quoted ? ' from the quoted post' : ''}${source?.possibly_sensitive ? ', sensitive' : ''}`,
	);
	if (!items.length) return result;

	onStage?.('downloading');
	// Discord blurs SPOILER_ attachments, matching X's sensitive-media warning.
	const filePrefix = source.possibly_sensitive ? 'SPOILER_' : '';

	// A single video may be compressed to fit; with several items, keep whatever fits as-is.
	if (items.length === 1) {
		const file = await downloadMediaItem(items[0], dir, 1, maxBytes, filePrefix);
		if (file?.isVideo) {
			const durationSeconds = (items[0].video_info?.duration_millis ?? 0) / 1000;
			const { filePath, compressed } = await fitVideoToLimit(file.path, dir, maxBytes, onStage, durationSeconds);
			result.files.push({ path: filePath, name: `${filePrefix}video.mp4` });
			result.compressed = compressed;
		}
		else if (file) {
			result.files.push(file);
		}
		return result;
	}

	let totalBytes = 0;
	for (const [index, media] of items.entries()) {
		const file = await downloadMediaItem(media, dir, index + 1, maxBytes - totalBytes, filePrefix);
		if (!file) continue;
		const { size } = await fs.stat(file.path);
		if (totalBytes + size > maxBytes) {
			mediaLog.info(`skipping item ${index + 1} (${formatMb(size)}): over the upload limit`);
			continue;
		}
		totalBytes += size;
		result.files.push(file);
	}
	if (result.files.length < items.length) {
		result.note = `共 ${items.length} 个媒体，受上传上限只附上 ${result.files.length} 个`;
	}
	return result;
}

module.exports = {
	fetchXPost,
};
