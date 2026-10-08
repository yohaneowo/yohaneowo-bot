const { downloadMedia, findSupportedSite } = require('./media');
const { reportParse, withLogSite } = require('./adminApi');

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

// Leaves room under Discord's 2000-character message limit for the author and link lines.
const MAX_TEXT_LENGTH = 1500;

// The original link message may get deleted, so the caption carries the link (and sharer if given).
function formatCaption(media, url, sharerId) {
	const text = media.text.length > MAX_TEXT_LENGTH ? `${media.text.slice(0, MAX_TEXT_LENGTH)}…` : media.text;
	const sharer = sharerId ? `<@${sharerId}> 分享 · ` : '';
	return [
		`-# ${sharer}<${url}>`,
		media.author ? `**${media.author}**` : null,
		text || null,
		media.compressed ? '-# 原片超过上传上限，已压缩' : null,
		media.note ? `-# ${media.note}` : null,
	]
		.filter(Boolean)
		.join('\n');
}

// Who asked for a parse, for the admin's parse log.
// { source: 'auto' | 'command', group_external_id, user_external_id, user_name }
function parseLogContext(source, guildId, user, member) {
	return {
		source,
		group_external_id: guildId ?? null,
		user_external_id: user.id,
		user_name: member?.displayName ?? user.displayName,
	};
}

// Logs a link that was skipped because too many downloads were already running.
function reportBusy(url, logContext) {
	reportParse({ platform: 'discord', ...logContext, url, site: findSupportedSite(url)?.name, result: 'busy' });
}

// Drives a status message (already showing INITIAL_STATUS) through the download stages,
// then replaces it with the post/video. `update(payload)` edits that status message.
// Returns true once the result has been posted.
function postMedia(options) {
	return withLogSite(findSupportedSite(options.url)?.name, () => postMediaInSiteScope(options));
}

async function postMediaInSiteScope({ url, maxBytes, sharerId, update, logContext }) {
	// Serialize edits so a slow edit can't land after a newer one.
	let pendingEdit = Promise.resolve();
	const setStatus = (content) => {
		pendingEdit = pendingEdit
			.then(() => update(content))
			.catch((error) => console.warn('Media status edit failed:', error.message));
		return pendingEdit;
	};

	if (isMediaQueueFull()) {
		reportBusy(url, logContext);
		await setStatus('⏳ 目前处理中的链接太多，请稍后再试');
		return false;
	}

	const startedAt = Date.now();
	const logResult = (result, extra) =>
		reportParse({
			platform: 'discord',
			...logContext,
			url,
			site: findSupportedSite(url)?.name,
			result,
			duration_ms: Date.now() - startedAt,
			...extra,
		});

	activeDownloads += 1;
	let media;
	try {
		media = await downloadMedia(url, maxBytes, (stage) => setStatus(STAGE_TEXT[stage]));
		await setStatus('⬆️ 上传中…');
		media.log.info('uploading to Discord');
		await update({
			content: formatCaption(media, url, sharerId),
			files: media.files.map((file) => ({ attachment: file.path, name: file.name })),
			allowedMentions: { parse: [] },
		});
		media.log.info('posted to Discord');
		logResult('success', { file_count: media.files.length, compressed: Boolean(media.compressed) });
		return true;
	}
	catch (error) {
		// Download failures are already logged by downloadMedia; only the upload is left.
		if (media) media.log.warn(`upload to Discord failed: ${error.message}`);
		logResult('failed', { error_message: error.message });
		await pendingEdit;
		await setStatus(error.userMessage ? `⚠️ ${error.userMessage}` : '❌ 解析失败了 😢');
		return false;
	}
	finally {
		activeDownloads -= 1;
		await media?.cleanup();
	}
}

// Used by /x and the「解析链接」context menu. The first URL answers the interaction itself and
// later ones get follow-ups; each response is edited in place through the interaction webhook,
// which also works in DMs/group DMs the bot isn't part of (user-installed app).
async function postMediaForInteraction(interaction, urls) {
	const maxBytes = getInteractionUploadLimitBytes(interaction);
	const logContext = parseLogContext('command', interaction.guildId, interaction.user, interaction.member);
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
			logContext,
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
	parseLogContext,
	reportBusy,
};
