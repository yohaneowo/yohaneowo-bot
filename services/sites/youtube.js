const { fetchVideo } = require('./video');

// YouTube via yt-dlp. uploader is the channel's display name and uploader_id its
// @handle (e.g. "YouTube" / "@YouTube"), so build the author from both rather than "@<name>".
async function fetchYouTube(url, dir, maxBytes, onStage, options) {
	const video = await fetchVideo(url, dir, maxBytes, onStage, options);
	const { uploader, uploaderId, title } = video.info;
	const handle = uploaderId?.startsWith('@') && uploaderId.slice(1) !== uploader ? uploaderId : '';
	return {
		...video,
		author: [uploader, handle].filter(Boolean).join(' '),
		text: title || '',
	};
}

module.exports = {
	fetchYouTube,
};
