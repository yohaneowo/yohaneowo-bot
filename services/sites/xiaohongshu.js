const path = require('node:path');
const { fitVideoToLimit } = require('./video');
const { downloadToFile } = require('./download');
const { UserFacingError } = require('./errors');

// Xiaohongshu's web pages need a login unless the link carries an xsec_token, which app share
// links no longer include. XHS-Downloader (https://github.com/JoeanAmier/XHS-Downloader) gets
// note data without logging in, so it runs as a separate service and we call its API.
const XHS_API_URL = (process.env.XHS_API_URL ?? '').replace(/\/+$/, '');
const API_TIMEOUT_MS = 60 * 1000;
// Video files must come from Xiaohongshu's CDN.
const VIDEO_URL_PATTERN = /^https?:\/\/[\w.-]+\.xhscdn\.com\//i;

async function fetchNoteDetail(url) {
	if (!XHS_API_URL) {
		throw new Error('XHS_API_URL is not set; the XHS-Downloader service is required for Xiaohongshu');
	}

	const response = await fetch(`${XHS_API_URL}/xhs/detail`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ url, download: false }),
		signal: AbortSignal.timeout(API_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`XHS-Downloader returned HTTP ${response.status}`);
	}

	const payload = await response.json();
	if (!payload?.data) {
		throw new Error(`XHS-Downloader: ${payload?.message ?? 'no data'}`);
	}
	return payload.data;
}

// Video notes are downloaded (and compressed if needed); image notes aren't supported yet.
async function fetchXiaohongshuNote(url, dir, maxBytes, onStage) {
	const note = await fetchNoteDetail(url);
	if (note['作品类型'] !== '视频') {
		throw new UserFacingError('小红书图文笔记暂未开放解析');
	}

	const videoUrl = [note['下载地址']].flat().find((candidate) => VIDEO_URL_PATTERN.test(candidate ?? ''));
	if (!videoUrl) {
		throw new Error('XHS-Downloader returned no usable video URL');
	}

	onStage?.('downloading');
	const downloadedPath = path.join(dir, 'video.mp4');
	await downloadToFile(videoUrl.replace(/^http:/, 'https:'), downloadedPath, VIDEO_URL_PATTERN);
	const { filePath, compressed } = await fitVideoToLimit(downloadedPath, dir, maxBytes, onStage);

	// Descriptions mark hashtags as "#家具[话题]#" and pad them with long runs of spaces.
	const description = (note['作品描述'] ?? '').replace(/\[话题\]/g, '').replace(/[^\S\r\n]{2,}/g, ' ').trim();
	return {
		files: [{ path: filePath, name: 'video.mp4' }],
		author: note['作者昵称'] ?? '',
		text: [note['作品标题'], description].filter(Boolean).join('\n'),
		compressed,
	};
}

module.exports = {
	fetchXiaohongshuNote,
};
