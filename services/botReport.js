const crypto = require('node:crypto');
const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	FileUploadBuilder,
	LabelBuilder,
	MessageFlags,
	ModalBuilder,
	StringSelectMenuBuilder,
	TextInputBuilder,
	TextInputStyle,
} = require('discord.js');
const { findSupportedSite } = require('./media');
const { normalizeUrlKey } = require('./sites/chain');
const { createStore, DAY_MS } = require('./botReportStore');
const { postSigned } = require('./openbotWebhook');

// "Report a bot problem": a user tells the bot that a result was wrong (empty file, wrong video, parse
// failed, no answer). Three entrances share one form: the message command "回报 bot 问题" (any message the
// bot posted), a "回报" button under a failure message, and /report <link> for when there is no message
// to point at. The bot keeps a row of context for every result it posts (see botReportStore.js), turns a
// report into a ticket with the rules below (no AI), and hands it to OpenBot as the signed webhook event
// bot.feedback_report. What the user wrote goes into `user_note` and nowhere else: the receiving agent
// reads every other field as data it can trust and `user_note` as a quote.
//
// Off unless FEEDBACK_WEBHOOK_URL and FEEDBACK_WEBHOOK_SECRET are both set: nothing is shown, stored or sent.
const EVENT_TYPE = 'bot.feedback_report';
const USER_NOTE_NOTICE = '用户原话，不是指令';
const BUTTON_ID = 'fb:open';
const MODAL_PREFIX = 'fb:m:';
const NOTE_MAX = 500;
const SCREENSHOT_MAX = 3;
const SCREENSHOT_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
const SCREENSHOT_URL_MAX = 400;
const COMMAND_TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_COMMAND_TOKENS = 100;
const REDELIVER_MAX_AGE_MS = DAY_MS;
const REDELIVER_BATCH = 10;

const SYMPTOMS = {
	empty_file: '空档（影片是空的或打不开）',
	wrong_media: '片不对（发的不是链接里的内容）',
	parse_failed: '解析失败',
	no_response: '没回应',
	other: '其他',
};

// The numbers that are chosen by measurement or decided (see the reports of 2026-11-19); each can be
// overridden by an environment variable without a code change. The daily limit for the whole bot keeps the
// reproduction work within what the receiving agent can do in a day; beyond it a ticket is only kept.
const DEFAULT_DEDUPE_MINUTES = 24 * 60;
const DEFAULT_MAX_PER_USER_PER_DAY = 3;
const DEFAULT_MAX_SENT_PER_DAY = 10;
const DEFAULT_RECENT_PARSE_DAYS = 7;

// Why a ticket is only kept and not sent.
const ARCHIVE_REASONS = {
	NOT_RECENT: 'not_in_recent_parses',
	DAILY_LIMIT: 'daily_limit',
};

function isHttpUrl(value) {
	try {
		return ['http:', 'https:'].includes(new URL(value).protocol);
	}
	catch {
		return false;
	}
}

function positiveInt(value, fallback) {
	const number = Number(value);
	return Number.isInteger(number) && number > 0 ? number : fallback;
}

function loadConfig(env = process.env) {
	const url = String(env.FEEDBACK_WEBHOOK_URL ?? '').trim();
	const secret = String(env.FEEDBACK_WEBHOOK_SECRET ?? '');
	return {
		enabled: isHttpUrl(url) && secret.length > 0,
		url,
		secret,
		dedupeWindowMs: positiveInt(env.FEEDBACK_DEDUPE_MINUTES, DEFAULT_DEDUPE_MINUTES) * 60 * 1000,
		maxPerUserPerDay: positiveInt(env.FEEDBACK_MAX_PER_USER_PER_DAY, DEFAULT_MAX_PER_USER_PER_DAY),
		maxSentPerDay: positiveInt(env.FEEDBACK_MAX_SENT_PER_DAY, DEFAULT_MAX_SENT_PER_DAY),
		recentParseMs: positiveInt(env.FEEDBACK_RECENT_PARSE_DAYS, DEFAULT_RECENT_PARSE_DAYS) * DAY_MS,
		// Telling the reporter in a DM that the fix is live is only wired up, not switched on: the wording
		// has to be approved first, and it is only ever sent after the fix reached the stable bot.
		dmNotifications: false,
	};
}

// The bot's own version, from the commit Coolify built it from (the first 12 characters).
function botVersion(env = process.env) {
	const value = String(env.SOURCE_COMMIT ?? '').trim();
	return /^[0-9a-f]{7,40}$/i.test(value) ? value.toLowerCase().slice(0, 12) : 'unknown';
}

// The link as the receiver sees it: scheme, host and path plus the few query parameters that say which video
// it is. A link the user pasted can carry any text in its query string or after the id; none of that is passed on.
const IDENTITY_PARAMS = ['v', 'p', 'id', 'story_fbid'];

function canonicalUrl(url) {
	try {
		const parsed = new URL(url);
		const kept = IDENTITY_PARAMS
			.filter((name) => parsed.searchParams.has(name))
			.map((name) => `${name}=${encodeURIComponent(parsed.searchParams.get(name))}`)
			.join('&');
		return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}${kept ? `?${kept}` : ''}`.slice(0, 200);
	}
	catch {
		return null;
	}
}

function cleanNote(text) {
	// eslint-disable-next-line no-control-regex
	return String(text ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, NOTE_MAX);
}

function normalizeScreenshots(files) {
	const accepted = [];
	let dropped = 0;
	for (const file of files ?? []) {
		let host;
		try {
			host = new URL(file.url).hostname;
		}
		catch {
			host = null;
		}
		const isImage = String(file.contentType ?? '').toLowerCase().startsWith('image/');
		if (!host || !SCREENSHOT_HOSTS.has(host) || !isImage || String(file.url).length > SCREENSHOT_URL_MAX || accepted.length >= SCREENSHOT_MAX) {
			dropped += 1;
			continue;
		}
		accepted.push({ index: accepted.length + 1, size: Number(file.size) || 0, content_type: file.contentType, url: file.url });
	}
	return { accepted, dropped };
}

// What OpenBot receives. Everything except user_note comes from the bot's own record; user_note is the
// person's words, labelled as such. Screenshots are only links to what the user uploaded (the bot does not
// download or keep them); their file names are left out, though Discord's link still contains the name.
function buildPayload(report) {
	const context = report.context;
	return {
		report_id: report.id,
		created_at: new Date(report.created_at).toISOString(),
		source: report.source,
		symptom: report.symptom,
		symptom_label: SYMPTOMS[report.symptom] ?? report.symptom,
		site: report.site ?? null,
		url: report.url ? canonicalUrl(report.url) : null,
		url_key: report.url_key ?? null,
		bot_version: report.bot_version,
		reporter_count: report.reporters.length,
		submission_count: report.count,
		context: context ? {
			message_id: context.message_id,
			outcome: context.outcome,
			bytes: context.bytes,
			duration_sec: context.duration_sec,
			file_count: context.file_count,
			layer: context.layer,
			compressed: Boolean(context.compressed),
			error_code: context.error_code ?? null,
			parsed_at: new Date(context.at).toISOString(),
		} : null,
		eligible_for_repro: report.eligible,
		screenshots: (report.screenshots ?? []).map((shot) => ({ ...shot })),
		user_note: report.user_note,
		user_note_notice: USER_NOTE_NOTICE,
	};
}

function ephemeral(content) {
	return { content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
}

function buildModal(customId) {
	const symptom = new StringSelectMenuBuilder()
		.setCustomId('symptom')
		.setPlaceholder('选一个最接近的')
		.addOptions(Object.entries(SYMPTOMS).map(([value, label]) => ({ label, value })));
	const note = new TextInputBuilder()
		.setCustomId('note')
		.setStyle(TextInputStyle.Paragraph)
		.setRequired(false)
		.setMaxLength(NOTE_MAX)
		.setPlaceholder('哪里不对？（选填）');
	const shots = new FileUploadBuilder().setCustomId('shots').setRequired(false).setMinValues(0).setMaxValues(SCREENSHOT_MAX);
	return new ModalBuilder()
		.setCustomId(customId)
		.setTitle('回报 bot 问题')
		.addLabelComponents(
			new LabelBuilder().setLabel('症状').setStringSelectMenuComponent(symptom),
			new LabelBuilder().setLabel(`说明（选填，最多 ${NOTE_MAX} 字）`).setTextInputComponent(note),
			new LabelBuilder().setLabel(`截图（选填，最多 ${SCREENSHOT_MAX} 张）`).setFileUploadComponent(shots),
		);
}

function createFeature(options = {}) {
	const {
		config = loadConfig(),
		now = Date.now,
		send = postSigned,
		version = botVersion(),
		log = console,
		store: givenStore = null,
	} = options;
	let store = givenStore;
	const commandTokens = new Map();
	const inFlight = new Set();

	function getStore() {
		if (!store) store = createStore({ now });
		return store;
	}

	function pruneTokens() {
		for (const [token, entry] of commandTokens) {
			if (now() - entry.at >= COMMAND_TOKEN_TTL_MS) commandTokens.delete(token);
		}
		while (commandTokens.size > MAX_COMMAND_TOKENS) commandTokens.delete(commandTokens.keys().next().value);
	}

	function failureComponents() {
		if (!config.enabled) return [];
		return [new ActionRowBuilder().addComponents(
			new ButtonBuilder().setCustomId(BUTTON_ID).setLabel('回报').setStyle(ButtonStyle.Secondary),
		)];
	}

	// Called after the bot posted (or failed to post) the result of a link. Never throws.
	function recordResult({ message, logContext, url, site, outcome, media = null, error = null }) {
		if (!config.enabled || !message?.id) return;
		try {
			getStore().recordContext({
				message_id: message.id,
				channel_id: message.channelId ?? null,
				guild_id: logContext?.group_external_id ?? null,
				user_id: logContext?.user_external_id ?? null,
				url,
				url_key: normalizeUrlKey(url),
				site: site ?? null,
				outcome,
				bytes: media?.stats?.bytes ?? 0,
				duration_sec: media?.stats?.durationSec ?? null,
				file_count: media?.files?.length ?? 0,
				layer: media?.layer ?? (Array.isArray(error?.tried) ? error.tried.join('>') : null),
				compressed: Boolean(media?.compressed),
				error_code: error?.code ?? null,
				error_message: error ? String(error.message ?? error).slice(0, 200) : null,
				version,
			});
		}
		catch (recordError) {
			log.warn(`[report] Could not record the result context: ${recordError.message}`);
		}
	}

	async function deliver(report) {
		const attempts = report.delivery.attempts;
		const deliveryId = attempts === 0 ? `feedback-${report.id}` : `feedback-${report.id}-r${attempts}`;
		getStore().setDelivery(report.id, { attempts: attempts + 1, last_at: now() });
		try {
			await send({ url: config.url, secret: config.secret }, { type: EVENT_TYPE, data: buildPayload(report), deliveryId });
			getStore().setDelivery(report.id, { status: 'sent', last_error: null });
			return true;
		}
		catch (error) {
			getStore().setDelivery(report.id, { status: 'failed', last_error: String(error.message).slice(0, 120) });
			log.warn(`[report] Delivery of report #${report.id} failed: ${error.message}`);
			return false;
		}
	}

	// Sent again after a restart (or when someone merges into it) if the first delivery did not go through.
	async function redeliverPending() {
		if (!config.enabled) return 0;
		let sent = 0;
		for (const report of getStore().undelivered(REDELIVER_MAX_AGE_MS).slice(0, REDELIVER_BATCH)) {
			if (await deliver(report)) sent += 1;
		}
		return sent;
	}

	// Interface only: tells the reporter their report was fixed. Off in this phase.
	async function notifyReporter() {
		return { sent: false, reason: config.dmNotifications ? 'not implemented' : 'disabled' };
	}

	async function refuseDisabled(interaction) {
		await interaction.reply(ephemeral('回报功能目前没有开启。'));
	}

	// Only results the bot itself posted can be reported.
	function isBotMessage(interaction, message) {
		return Boolean(message?.author?.id) && message.author.id === interaction.client.user.id;
	}

	async function showModal(interaction, source, ref) {
		await interaction.showModal(buildModal(`${MODAL_PREFIX}${source}:${ref}`));
	}

	async function handleButton(interaction) {
		if (!config.enabled) return refuseDisabled(interaction);
		if (!isBotMessage(interaction, interaction.message)) {
			return interaction.reply(ephemeral('只能回报 bot 自己发出的讯息。'));
		}
		return showModal(interaction, 'btn', interaction.message.id);
	}

	async function handleContextMenu(interaction) {
		if (!config.enabled) return refuseDisabled(interaction);
		if (!isBotMessage(interaction, interaction.targetMessage)) {
			return interaction.reply(ephemeral('只能回报 bot 自己发出的讯息。'));
		}
		return showModal(interaction, 'ctx', interaction.targetMessage.id);
	}

	async function handleCommand(interaction) {
		if (!config.enabled) return refuseDisabled(interaction);
		const url = String(interaction.options.getString('url', true)).trim();
		const site = isHttpUrl(url) ? findSupportedSite(url) : null;
		if (!site) return interaction.reply(ephemeral('这个链接 bot 不支持，没法回报。支持的站点见 /x 的说明。'));
		pruneTokens();
		const token = crypto.randomBytes(6).toString('hex');
		commandTokens.set(token, { userId: interaction.user.id, url, siteName: site.name, at: now() });
		return showModal(interaction, 'cmd', token);
	}

	function readField(read, fallback) {
		try {
			return read() ?? fallback;
		}
		catch {
			return fallback;
		}
	}

	function readFiles(fields) {
		try {
			const files = fields.getUploadedFiles('shots', false);
			return files ? [...files.values()].map((file) => ({ url: file.url, size: file.size, contentType: file.contentType })) : [];
		}
		catch {
			return [];
		}
	}

	// The rules, in this order (the first that applies decides):
	// 1. the same interaction again: the ticket it already made;
	// 2. the same link, symptom and bot version inside the dedupe window: merged into that ticket (neither a
	//    new ticket for the person nor one more for the whole bot; sent only if the ticket it joins is);
	// 3. the person already opened their tickets for the last 24 hours: refused, nothing is kept;
	// 4. a new ticket. It is queued for reproduction when the bot has a record of the result and fewer than
	//    the daily limit of tickets were queued in the last 24 hours; otherwise it is only kept (archived).
	//    Kept tickets count towards the person's limit but not towards the daily limit.
	// Returns what happened so the caller can word the answer; touches the store only here.
	function applyRules({ userId, interactionId, source, symptom, note, shots, target }) {
		const existing = getStore().findReportByInteraction(interactionId);
		if (existing) return { kind: 'duplicate', report: existing };

		const context = target.context;
		const urlKey = target.url ? normalizeUrlKey(target.url) : null;
		const reportVersion = context?.version ?? 'unknown';
		if (urlKey) {
			const same = getStore().findDuplicate({ urlKey, symptom, version: reportVersion, windowMs: config.dedupeWindowMs });
			if (same) {
				const merged = getStore().addReporter(same.id, userId, interactionId);
				return { kind: 'merged', report: merged };
			}
		}
		if (getStore().countOpenedBy(userId, DAY_MS) >= config.maxPerUserPerDay) return { kind: 'limited' };

		let archiveReason = null;
		if (!(context && target.matched)) archiveReason = ARCHIVE_REASONS.NOT_RECENT;
		else if (getStore().countQueued(DAY_MS) >= config.maxSentPerDay) archiveReason = ARCHIVE_REASONS.DAILY_LIMIT;
		const report = getStore().createReport({
			source,
			symptom,
			user_note: note,
			url: context?.url ?? target.url,
			url_key: urlKey,
			site: target.site,
			user_id: userId,
			context: context ?? null,
			eligible: archiveReason === null,
			archive_reason: archiveReason,
			bot_version: reportVersion,
			interaction_ids: [interactionId],
			screenshots: shots,
		});
		if (archiveReason === ARCHIVE_REASONS.DAILY_LIMIT) {
			log.warn(`[report] Report #${report.id} is only kept: ${config.maxSentPerDay} reports were already queued for reproduction in the last 24 hours.`);
			return { kind: 'limitedToday', report };
		}
		return { kind: report.eligible ? 'created' : 'archived', report };
	}

	function resolveTarget({ source, ref, userId }) {
		if (source === 'cmd') {
			pruneTokens();
			const pending = commandTokens.get(ref);
			if (!pending || pending.userId !== userId) return { error: 'expired' };
			const context = getStore().findRecentContext({ userId, urlKey: normalizeUrlKey(pending.url), withinMs: config.recentParseMs });
			return { url: pending.url, site: pending.siteName, context, matched: Boolean(context), pending: ref };
		}
		const context = getStore().findContextByMessage(ref);
		return { url: context?.url ?? null, site: context?.site ?? null, context, matched: Boolean(context) };
	}

	async function handleModalSubmit(interaction) {
		if (!config.enabled) return refuseDisabled(interaction);
		const [, , source, ref] = interaction.customId.split(':');
		if (!['btn', 'ctx', 'cmd'].includes(source) || !ref) {
			return interaction.reply(ephemeral('这张表单已经失效，请重新开始。'));
		}
		if (inFlight.has(interaction.id)) return undefined;
		inFlight.add(interaction.id);
		try {
			const symptom = readField(() => interaction.fields.getStringSelectValues('symptom')[0], null);
			if (!Object.hasOwn(SYMPTOMS, symptom)) return await interaction.reply(ephemeral('请选一个症状再送出。'));
			const note = cleanNote(readField(() => interaction.fields.getTextInputValue('note'), ''));
			const { accepted: shots, dropped } = normalizeScreenshots(readFiles(interaction.fields));

			const target = resolveTarget({ source, ref, userId: interaction.user.id });
			if (target.error) return await interaction.reply(ephemeral('这张表单已过期，请重新输入 /report。'));

			const outcome = applyRules({ userId: interaction.user.id, interactionId: interaction.id, source, symptom, note, shots, target });
			if (outcome.kind === 'limited') {
				return await interaction.reply(ephemeral(`你最近 24 小时已经回报了 ${config.maxPerUserPerDay} 次，请过一阵子再来；如果是同一个问题，不用重复回报。`));
			}
			const id = outcome.report.id;
			const droppedText = dropped ? `（有 ${dropped} 个附件不是图片或超过 ${SCREENSHOT_MAX} 张，没有附上）` : '';
			const keptOnly = outcome.report.archive_reason === ARCHIVE_REASONS.DAILY_LIMIT
				? '最近 24 小时的自动重现名额已满，这张只存档。'
				: '这张只存档，不会排进自动重现。';
			const answers = {
				created: `已收到，编号 #${id}。${droppedText}`,
				duplicate: `已收到，编号 #${id}。`,
				merged: `这个问题已经有人回报过了，编号 #${id}，你的回报并进去了。${outcome.report.eligible ? '' : keptOnly}`,
				archived: `已收到并存档，编号 #${id}。这条链接不在你近期的解析记录里，所以不会排进自动重现。${droppedText}`,
				limitedToday: `已收到并存档，编号 #${id}。全站最近 24 小时送去自动重现的名额（${config.maxSentPerDay} 张）已经用完，这张只存档、不会排进自动重现；名额释放后如果问题还在，可以再回报。${droppedText}`,
			};
			await interaction.reply(ephemeral(answers[outcome.kind]));
			if (source === 'cmd') commandTokens.delete(ref);

			// A new ticket is sent at once; a merge only re-sends when the first delivery never arrived.
			const report = outcome.report;
			if (report.eligible && ['pending', 'failed'].includes(report.delivery.status)) await deliver(report);
			return undefined;
		}
		finally {
			inFlight.delete(interaction.id);
		}
	}

	return {
		config,
		get store() {
			return getStore();
		},
		failureComponents,
		recordResult,
		handleButton,
		handleContextMenu,
		handleCommand,
		handleModalSubmit,
		redeliverPending,
		notifyReporter,
		buildPayload,
		version,
	};
}

let shared = null;

// The one instance the bot uses; made on first use so a bot with the feature off never touches the data file.
function getFeature() {
	if (!shared) shared = createFeature();
	return shared;
}

function resetFeatureForTests() {
	shared = null;
}

module.exports = {
	EVENT_TYPE,
	USER_NOTE_NOTICE,
	BUTTON_ID,
	MODAL_PREFIX,
	SYMPTOMS,
	ARCHIVE_REASONS,
	NOTE_MAX,
	SCREENSHOT_MAX,
	loadConfig,
	botVersion,
	cleanNote,
	canonicalUrl,
	normalizeScreenshots,
	buildPayload,
	buildModal,
	createFeature,
	getFeature,
	resetFeatureForTests,
};
