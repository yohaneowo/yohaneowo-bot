const crypto = require('node:crypto');

// Magnet links sent in a DM to the bot by a few allowed Discord users: the bot looks up the title,
// shows a card with Confirm / Cancel buttons, and only after Confirm hands the link to OpenBot
// through a signed webhook; an OpenBot agent adds it to PikPak (the bot never holds PikPak
// credentials). Best-effort: a failure is reported to the user and never affects anything else.
const { fetchTorrentMeta, formatBytes } = require('./magnetMeta');

const EVENT_TYPE = 'bot.magnet_request';
const DEDUPE_WINDOW_MS = 30 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 100;
const BUTTON_PREFIX = 'magnet:';
const SEND_TIMEOUT_MS = 10 * 1000;
const SEND_ATTEMPTS = 2;
const RETRY_DELAY_MS = 2000;
const MAX_MAGNETS_PER_MESSAGE = 5;
const MAX_MAGNET_LENGTH = 4096;
const MAGNET_PATTERN = /magnet:\?[^\s<>]+/gi;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function isHttpUrl(value) {
	try {
		return ['http:', 'https:'].includes(new URL(value).protocol);
	}
	catch {
		return false;
	}
}

// Discord users allowed to use the feature. MAGNET_USER_IDS (comma separated) replaces this list.
const DEFAULT_USER_IDS = ['559762654084857876', '406386663007322113'];

// The feature is on only when the allowed users, the webhook URL and the signing secret are all set.
function loadConfig(env = process.env) {
	const configured = String(env.MAGNET_USER_IDS ?? '').trim();
	const userIds = new Set(
		(configured ? configured.split(/[,\s]+/) : DEFAULT_USER_IDS).filter((id) => /^\d{5,25}$/.test(id)),
	);
	const url = String(env.MAGNET_WEBHOOK_URL ?? '').trim();
	const secret = String(env.MAGNET_WEBHOOK_SECRET ?? '');
	return {
		enabled: userIds.size > 0 && isHttpUrl(url) && secret.length > 0,
		userIds,
		url,
		secret,
		// Looking up a title sends the info hash to a public torrent cache; this switch turns it off.
		metaLookup: String(env.MAGNET_META_LOOKUP ?? '').toLowerCase() !== 'false',
	};
}

function base32ToHex(input) {
	let bits = '';
	for (const char of input.toUpperCase()) {
		bits += BASE32_ALPHABET.indexOf(char).toString(2).padStart(5, '0');
	}
	let hex = '';
	for (let i = 0; i + 8 <= bits.length; i += 8) {
		hex += parseInt(bits.slice(i, i + 8), 2).toString(16).padStart(2, '0');
	}
	return hex;
}

// Returns { magnet, infohash (40 lowercase hex), name } or null when it is not a usable magnet link.
function parseMagnet(raw) {
	const magnet = raw.replace(/[)\]}>.,;!?'"。，；！？）】」』]+$/u, '');
	if (magnet.length > MAX_MAGNET_LENGTH) return null;
	let url;
	try {
		url = new URL(magnet);
	}
	catch {
		return null;
	}
	if (url.protocol !== 'magnet:') return null;
	for (const xt of url.searchParams.getAll('xt')) {
		const match = /^urn:btih:([0-9a-f]{40}|[a-z2-7]{32})$/i.exec(xt);
		if (!match) continue;
		const hash = match[1];
		const infohash = hash.length === 40 ? hash.toLowerCase() : base32ToHex(hash);
		return { magnet, infohash, name: (url.searchParams.get('dn') ?? '').slice(0, 200) };
	}
	return null;
}

// Unique magnet links (by infohash) found in a message, capped per message.
function extractMagnets(text) {
	const found = new Map();
	for (const raw of String(text ?? '').match(MAGNET_PATTERN) ?? []) {
		const parsed = parseMagnet(raw);
		if (parsed && !found.has(parsed.infohash)) found.set(parsed.infohash, parsed);
	}
	return [...found.values()].slice(0, MAX_MAGNETS_PER_MESSAGE);
}

// Remembers handed-off infohashes so the same link is not sent twice within the window.
function createDeduper(windowMs = DEDUPE_WINDOW_MS, now = Date.now) {
	const seen = new Map();
	const prune = () => {
		for (const [hash, at] of seen) {
			if (now() - at >= windowMs) seen.delete(hash);
		}
	};
	return {
		has(hash) {
			prune();
			return seen.has(hash);
		},
		add(hash) {
			prune();
			seen.set(hash, now());
		},
	};
}

// Same signing scheme as the other OpenBot webhooks: HMAC-SHA256 (hex) over "<timestamp>.<delivery id>.<body>".
function signRequest(secret, timestamp, deliveryId, body) {
	return crypto.createHmac('sha256', secret).update(`${timestamp}.${deliveryId}.${body}`).digest('hex');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendWebhook(config, data, { fetchImpl = fetch, now = Date.now, wait = sleep } = {}) {
	const body = JSON.stringify({ type: EVENT_TYPE, data });
	const deliveryId = `magnet-${data.infohash}-${data.message_id}`;
	let lastError;
	for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt++) {
		const timestamp = String(Math.floor(now() / 1000));
		try {
			const response = await fetchImpl(config.url, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-openbot-timestamp': timestamp,
					'x-openbot-delivery-id': deliveryId,
					'x-openbot-signature': `sha256=${signRequest(config.secret, timestamp, deliveryId, body)}`,
				},
				body,
				signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
			});
			if (response.ok) return;
			// A rejected request will not succeed on retry (bad signature, unknown routine, ...).
			if (response.status < 500) throw Object.assign(new Error(`webhook answered ${response.status}`), { final: true });
			lastError = new Error(`webhook answered ${response.status}`);
		}
		catch (error) {
			if (error.final) throw error;
			lastError = error;
		}
		if (attempt < SEND_ATTEMPTS) await wait(RETRY_DELAY_MS);
	}
	throw lastError;
}

// Requests waiting for a button press. Memory only: a bot restart or the TTL expires them.
function createPendingStore(ttlMs = PENDING_TTL_MS, now = Date.now) {
	const entries = new Map();
	const prune = () => {
		for (const [token, entry] of entries) {
			if (now() - entry.createdAt >= ttlMs) entries.delete(token);
		}
		while (entries.size > MAX_PENDING) entries.delete(entries.keys().next().value);
	};
	return {
		create(entry) {
			prune();
			const token = crypto.randomBytes(8).toString('hex');
			entries.set(token, { ...entry, createdAt: now(), busy: false });
			return token;
		},
		get(token) {
			prune();
			return entries.get(token);
		},
		delete(token) {
			entries.delete(token);
		},
	};
}

function createState() {
	// inflight: info hashes whose hand-off is being sent right now (a second card for the same link must wait out the first).
	return { deduper: createDeduper(), pending: createPendingStore(), inflight: new Set() };
}

function buildCard({ name, infohash, meta, token }) {
	const lines = [];
	if (meta) {
		lines.push(`大小：${formatBytes(meta.totalBytes)}，文件数：${meta.fileCount}`);
		if (meta.fileCount > 1) {
			lines.push(...meta.files.slice(0, 5).map((file) => `• ${file.path} (${formatBytes(file.size)})`));
			if (meta.fileCount > 5) lines.push(`…另有 ${meta.fileCount - 5} 个文件`);
		}
	}
	else if (name) {
		lines.push('名称来自磁力链接自带的 dn，没有核对到大小。');
	}
	else {
		lines.push('链接没带名称，也没有从公开快取查到标题；请自行确认来源后再决定。');
	}
	lines.push(`infohash：\`${infohash.slice(0, 12)}…\``);
	return {
		embeds: [{ title: (name || '（查不到名称）').slice(0, 250), description: lines.join('\n').slice(0, 1500) }],
		components: [
			{
				type: 1,
				components: [
					{ type: 2, style: 3, label: '✅ 确认加入 PikPak', custom_id: `${BUTTON_PREFIX}ok:${token}` },
					{ type: 2, style: 4, label: '❌ 取消', custom_id: `${BUTTON_PREFIX}no:${token}` },
				],
			},
		],
	};
}

// Handles one Discord message. Only DMs from an allowed user count; anything else is ignored silently.
async function handleMagnetMessage(message, config, state, options = {}) {
	if (!config.enabled || message.guildId || message.author?.bot || !config.userIds.has(message.author?.id)) return;
	const magnets = extractMagnets(message.content);
	if (!magnets.length) return;

	const fresh = magnets.filter((item) => !state.deduper.has(item.infohash));
	const skipped = magnets.length - fresh.length;
	const metas = await Promise.all(
		fresh.map((item) => (config.metaLookup ? fetchTorrentMeta(item.infohash, options.meta) : null)),
	);
	const reply = (payload) =>
		message
			.reply({ ...payload, allowedMentions: { parse: [], repliedUser: false } })
			.then(() => true)
			.catch((error) => {
				console.warn('Magnet card reply failed:', error.message);
				return false;
			});

	for (const [index, item] of fresh.entries()) {
		const meta = metas[index];
		const name = meta?.name || item.name;
		const token = state.pending.create({
			magnet: item.magnet,
			infohash: item.infohash,
			name,
			sizeBytes: meta?.totalBytes ?? null,
			fileCount: meta?.fileCount ?? null,
			requesterId: message.author.id,
			channelId: message.channelId,
			messageId: message.id,
		});
		if (!(await reply(buildCard({ name, infohash: item.infohash, meta, token })))) state.pending.delete(token);
	}
	if (skipped) await reply({ content: `${skipped} 个磁力链接刚处理过，已略过` });
}

// Handles a Confirm / Cancel press on a card. Resolves to true when the interaction was a magnet button.
async function handleMagnetButton(interaction, config, state, options = {}) {
	const match = /^magnet:(ok|no):([0-9a-f]+)$/.exec(interaction.customId ?? '');
	if (!match) return false;
	const [, action, token] = match;
	if (!config.enabled || interaction.inGuild?.() || !config.userIds.has(interaction.user?.id)) return true;

	const entry = state.pending.get(token);
	if (!entry) {
		await interaction.update({ content: '⌛ 这个请求已过期（超过 10 分钟或 bot 重启过），请重新贴一次', embeds: [], components: [] });
		return true;
	}
	if (entry.requesterId !== interaction.user.id) return true;

	if (action === 'no') {
		state.pending.delete(token);
		await interaction.update({ content: '❌ 已取消，没有转交', components: [] });
		return true;
	}
	if (entry.busy) {
		await interaction.deferUpdate();
		return true;
	}
	entry.busy = true;
	await interaction.deferUpdate();
	if (state.deduper.has(entry.infohash) || state.inflight.has(entry.infohash)) {
		state.pending.delete(token);
		await interaction.editReply({ content: '⏭️ 这个磁力刚处理过，已略过', components: [] });
		return true;
	}
	state.inflight.add(entry.infohash);
	try {
		await sendWebhook(
			config,
			{
				magnet: entry.magnet,
				infohash: entry.infohash,
				name: entry.name,
				size_bytes: entry.sizeBytes,
				file_count: entry.fileCount,
				requester_id: entry.requesterId,
				channel_id: entry.channelId,
				guild_id: null,
				message_id: entry.messageId,
				requested_at: new Date().toISOString(),
			},
			options.send,
		);
		state.deduper.add(entry.infohash);
		state.pending.delete(token);
		await interaction.editReply({ content: '🧲 已转交，Hana 会加入 PikPak', components: [] });
	}
	catch (error) {
		entry.busy = false;
		console.warn(`Magnet hand-off failed for ${entry.infohash}: ${error.message}`);
		await interaction.editReply({ content: '⚠️ 转交失败，可以再按一次确认，或稍后重试' });
	}
	finally {
		state.inflight.delete(entry.infohash);
	}
	return true;
}

module.exports = {
	EVENT_TYPE,
	loadConfig,
	parseMagnet,
	extractMagnets,
	createDeduper,
	createPendingStore,
	createState,
	signRequest,
	sendWebhook,
	buildCard,
	handleMagnetMessage,
	handleMagnetButton,
};
