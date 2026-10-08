const { fetchVideo } = require('./video');
const { fetchOpenGraph, downloadImage, PREVIEW_NOTE } = require('./openGraph');
const { mediaLog } = require('../mediaLog');

const IMAGE_URL_PATTERN = /^https:\/\/[\w.-]+\.(?:fbcdn\.net|fbsbx\.com)\//i;

// Video posts and reels: yt-dlp gets the video. Its title is engagement stats
// ("51K views · 501 reactions | ..."), so the text comes from description instead.
async function fetchFacebookVideo(url, dir, maxBytes, onStage) {
	const video = await fetchVideo(url, dir, maxBytes, onStage);
	const { uploader, description } = video.info;
	return {
		...video,
		author: uploader ?? '',
		text: description ?? '',
	};
}

// Photo/text posts: the link preview gives the author, text and first image.
async function fetchFacebookPreview(url, dir, maxBytes, onStage) {
	const meta = await fetchOpenGraph(url);
	mediaLog.info(`link preview: title "${meta['og:title'] ?? ''}", image ${meta['og:image'] ? 'yes' : 'no'}`);
	const author = meta['og:title'] ?? '';
	const text = meta['og:description'] ?? '';
	const imageUrl = meta['og:image'] ?? '';
	// Private posts and login walls come back without post data (or titled "Facebook"/"Log in").
	if ((!text && !imageUrl) || /^(?:facebook|log in|登入|登录)/i.test(author)) {
		throw new Error('Facebook post is private or unavailable without login');
	}

	onStage?.('downloading');
	const image = await downloadImage(imageUrl, IMAGE_URL_PATTERN, dir, maxBytes);

	return {
		files: image ? [image] : [],
		author,
		text,
		note: PREVIEW_NOTE,
		compressed: false,
	};
}

// Try the video first (any post may contain one); photo posts make yt-dlp fail quickly,
// and fall back to the link preview.
async function fetchFacebookPost(url, dir, maxBytes, onStage) {
	try {
		return await fetchFacebookVideo(url, dir, maxBytes, onStage);
	}
	catch (error) {
		if (error.code === 'VIDEO_TOO_LONG') throw error;
		mediaLog.warn(`no video (${error.message}); falling back to link preview`);
	}
	return fetchFacebookPreview(url, dir, maxBytes, onStage);
}

module.exports = {
	fetchFacebookPost,
};
