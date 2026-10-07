const { fetchOpenGraph, downloadImage } = require('./openGraph');

const IMAGE_URL_PATTERN = /^https:\/\/[\w.-]+\.(?:fbcdn\.net|fbsbx\.com)\//i;

// Fetches a public Facebook post's author, text and first image into dir.
async function fetchFacebookPost(url, dir, maxBytes, onStage) {
	const meta = await fetchOpenGraph(url);
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
		compressed: false,
	};
}

module.exports = {
	fetchFacebookPost,
};
