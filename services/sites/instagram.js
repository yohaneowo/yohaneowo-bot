const { fetchVideo } = require('./video');
const { fetchOpenGraph, downloadImage } = require('./openGraph');

const IMAGE_URL_PATTERN = /^https:\/\/[\w.-]+\.(?:cdninstagram\.com|fbcdn\.net)\//i;

// og:title looks like: Lucia on Instagram: "caption"
// og:description like: 44K likes, 547 comments - luciababes_ on September 28, 2026: "caption".
function parseInstagramMeta(meta) {
	const title = meta['og:title'] ?? '';
	const description = meta['og:description'] ?? '';
	const name = title.match(/^(.*?) on Instagram/s)?.[1] ?? '';
	const username = description.match(/ - ([\w.]+) on /)?.[1] ?? '';
	const caption = title.match(/on Instagram: "(.*)"$/s)?.[1] ?? description.match(/: "(.*)"\.?$/s)?.[1] ?? '';

	return {
		author: [name, username && `@${username}`].filter(Boolean).join(' '),
		text: caption,
	};
}

// Reels and video posts: try yt-dlp for the actual video first. Restricted posts need a login
// (and Instagram rate-limits anonymous requests), so fall back to the link preview cover and caption.
async function fetchInstagramPost(url, dir, maxBytes, onStage) {
	try {
		const video = await fetchVideo(url, dir, maxBytes, onStage);
		// yt-dlp's Instagram title is a generic "Video by <user>": the caption is in description,
		// uploader is the display name and channel the @username.
		const { uploader, channel, description } = video.info;
		return {
			...video,
			author: [uploader, channel && `@${channel}`].filter(Boolean).join(' '),
			text: description || '',
		};
	}
	catch (error) {
		// Too-long videos aren't a download problem; report them rather than posting a cover.
		if (error.code === 'VIDEO_TOO_LONG') throw error;
		console.warn(`Instagram video unavailable (${error.message}); falling back to link preview.`);
	}

	const meta = await fetchOpenGraph(url);
	const { author, text } = parseInstagramMeta(meta);
	const imageUrl = meta['og:image'] ?? '';
	if (!author && !imageUrl) {
		throw new Error('Instagram post is private or unavailable without login');
	}

	onStage?.('downloading');
	const image = await downloadImage(imageUrl, IMAGE_URL_PATTERN, dir, maxBytes);

	return {
		files: image ? [image] : [],
		author,
		text,
		note: '无法下载影片，只显示封面',
		compressed: false,
	};
}

module.exports = {
	fetchInstagramPost,
};
