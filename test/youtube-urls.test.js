const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractMediaUrls, findSupportedSite, isOnlyMediaUrls } = require('../services/media');

const VIDEO_ID = 'dQw4w9WgXcQ';

test('YouTube share, watch and Shorts links reach the media parser', () => {
	const urls = [
		`https://youtu.be/${VIDEO_ID}?si=abc`,
		`https://youtu.be/${VIDEO_ID}`,
		`https://www.youtube.com/watch?v=${VIDEO_ID}`,
		`https://m.youtube.com/watch?si=abc&v=${VIDEO_ID}&t=42`,
		`https://www.youtube.com/shorts/${VIDEO_ID}`,
	];
	for (const url of urls) {
		assert.equal(findSupportedSite(url)?.name, 'YouTube');
		assert.deepEqual(extractMediaUrls(`Video <${url}>`), [url]);
		assert.equal(isOnlyMediaUrls(`<${url}>`), true);
	}
});

test('YouTube matching requires a video ID and a supported host and path', () => {
	for (const url of [
		'https://www.youtube.com/watch?list=PL123',
		'https://www.youtube.com/watch?v=short',
		`https://www.youtube.com/watch?v=${VIDEO_ID}extra`,
		`https://youtu.be/${VIDEO_ID}/extra`,
		`https://youtu.be.evil.test/${VIDEO_ID}`,
		`https://www.youtube.com@evil.test/watch?v=${VIDEO_ID}`,
	]) {
		assert.equal(findSupportedSite(url), null);
	}
});
