const { downloadMedia } = require('./media');

const MAX_CONCURRENT_DOWNLOADS = 2;
const DEFAULT_UPLOAD_LIMIT_MB = 10;
const INITIAL_STATUS = '🔍 收到链接，解析中…';
const STAGE_TEXT = {
	downloading: '⬇️ 下载中…',
	compressing: '🗜️ 影片超过上传上限，压缩中…',
};

let activeDownloads = 0;

function isMediaQueueFull() {
	return activeDownloads >= MAX_CONCURRENT_DOWNLOADS;
}

// Bot upload limit follows the server boost tier; DMs and unboosted servers allow 10 MB.
function getGuildUploadLimitBytes(guild) {
	const limitMb = { 2: 50, 3: 100 }[guild?.premiumTier] ?? DEFAULT_UPLOAD_LIMIT_MB;
	return Math.floor(limitMb * 1000 * 1000 * 0.98);
}

// Interactions report the exact limit for wherever they were used (servers, DMs, group DMs).
function getInteractionUploadLimitBytes(interaction) {
	const limit = interaction.attachmentSizeLimit ?? DEFAULT_UPLOAD_LIMIT_MB * 1000 * 1000;
	return Math.floor(limit * 0.98);
}

// The original link message may get deleted, so the caption carries the link (and sharer if given).
function formatCaption(video, url, sharerId) {
	const title = video.title.length > 300 ? `${video.title.slice(0, 300)}…` : video.title;
	const lines = [video.uploader ? `**@${video.uploader}**` : null, title || null];
	const sharer = sharerId ? `<@${sharerId}> 分享 · ` : '';
	lines.push(`-# ${sharer}<${url}>${video.compressed ? ' · 原片超过上传上限，已压缩' : ''}`);
	return lines.filter(Boolean).join('\n');
}

// Drives a status message (already showing INITIAL_STATUS) through the download stages,
// then replaces it with the video. `update(payload)` edits that status message.
// Returns true once the video has been posted.
async function postMedia({ url, maxBytes, sharerId, update }) {
	// Serialize edits so a slow edit can't land after a newer one.
	let pendingEdit = Promise.resolve();
	const setStatus = (content) => {
		pendingEdit = pendingEdit
			.then(() => update(content))
			.catch((error) => console.warn('Media status edit failed:', error.message));
		return pendingEdit;
	};

	if (isMediaQueueFull()) {
		await setStatus('⏳ 目前处理中的影片太多，请稍后再试');
		return false;
	}

	activeDownloads += 1;
	let video;
	try {
		video = await downloadMedia(url, maxBytes, (stage) => setStatus(STAGE_TEXT[stage]));
		await setStatus('⬆️ 上传中…');
		await update({
			content: formatCaption(video, url, sharerId),
			files: [{ attachment: video.filePath, name: 'video.mp4' }],
			allowedMentions: { parse: [] },
		});
		return true;
	}
	catch (error) {
		console.warn(`Media download failed for ${url}:`, error.message);
		await pendingEdit;
		await setStatus('❌ 影片解析失败了 😢');
		return false;
	}
	finally {
		activeDownloads -= 1;
		await video?.cleanup();
	}
}

// Used by /x and the「解析链接」context menu. The first URL answers the interaction itself and
// later ones get follow-ups; each response is edited in place through the interaction webhook,
// which also works in DMs/group DMs the bot isn't part of (user-installed app).
async function postMediaForInteraction(interaction, urls) {
	const maxBytes = getInteractionUploadLimitBytes(interaction);
	for (const [index, url] of urls.entries()) {
		let status = '@original';
		if (index === 0) {
			await interaction.reply({ content: INITIAL_STATUS });
		}
		else {
			status = await interaction.followUp({ content: INITIAL_STATUS });
		}
		await postMedia({
			url,
			maxBytes,
			update: (payload) =>
				interaction.editReply({
					...(typeof payload === 'string' ? { content: payload } : payload),
					message: status,
				}),
		});
	}
}

module.exports = {
	INITIAL_STATUS,
	isMediaQueueFull,
	getGuildUploadLimitBytes,
	postMedia,
	postMediaForInteraction,
};
