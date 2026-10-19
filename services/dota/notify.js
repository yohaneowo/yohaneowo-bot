// DotaHub's death-map DMs. Admin checks every linked player's ranked matches on STRATZ and queues
// each new parsed one; this polls the queue and DMs the player that match's deaths (in order,
// with the map drawn by the site), then marks it sent — also when the DM can't be delivered, so a
// closed DM inbox doesn't block the queue.
const { AttachmentBuilder, EmbedBuilder, RESTJSONErrorCodes } = require('discord.js');
const { adminApiEnabled, dotaRequest } = require('../adminApi');

const SITE_URL = process.env.SITE_URL || 'https://yohaneowo.com';
const POLL_MS = 60 * 1000;
const HEROES_TTL_MS = 24 * 60 * 60 * 1000;
// A DM that keeps failing for another reason (the site down, Discord hiccups) is given up after this many polls.
const MAX_ATTEMPTS = 5;
const WIN = 0x10b981;
const LOSS = 0xef4444;
const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳'];

let heroes = { at: 0, names: new Map() };
const attempts = new Map();
let running = false;

// Chinese hero names from Valve's datafeed (the same list the site uses).
async function heroNames() {
	if (Date.now() - heroes.at < HEROES_TTL_MS && heroes.names.size) return heroes.names;
	try {
		const response = await fetch('https://www.dota2.com/datafeed/herolist?language=schinese', { signal: AbortSignal.timeout(15000) });
		const feed = await response.json();
		heroes = { at: Date.now(), names: new Map(feed.result.data.heroes.map((h) => [h.id, h.name_loc || h.name_english_loc])) };
	}
	catch (error) {
		console.warn('[dota] Could not load hero names:', error.message);
	}
	return heroes.names;
}

function clock(seconds) {
	const s = Math.abs(seconds);
	return `${seconds < 0 ? '-' : ''}${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function signed(n) {
	return n > 0 ? `+${n}` : String(n);
}

async function deathMap(match) {
	try {
		const url = `${SITE_URL}/api/dotahub/deathmap?match=${match.matchId}&account=${match.accountId}`;
		const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		// Behind Cloudflare Access (the dev site) the answer is a login page, not the image.
		if (!response.headers.get('content-type')?.startsWith('image/')) throw new Error('not an image');
		return new AttachmentBuilder(Buffer.from(await response.arrayBuffer()), { name: 'deathmap.png' });
	}
	catch (error) {
		console.warn(`[dota] No death map image for ${match.matchId}:`, error.message);
		return null;
	}
}

async function buildMessage(match) {
	const names = await heroNames();
	const hero = names.get(match.heroId) ?? `#${match.heroId}`;
	const events = [...match.deathEvents].sort((a, b) => a.t - b.t);
	const head = [
		`${match.kills} / ${match.deaths} / ${match.assists} · ${clock(match.duration)}`,
		match.imp == null ? null : `IMP ${signed(match.imp)}`,
	].filter(Boolean).join(' · ');
	const lines = events.map((e, i) => {
		const killer = names.get(e.by) ?? '防御塔或中立生物';
		// fb: this death was the match's first blood.
		return `${CIRCLED[i] ?? `${i + 1}.`} \`${clock(e.t)}\`${e.fb ? ' **一血**' : ''} ${killer} · 掉 ${e.gold} 金 · 等 ${e.dead} 秒`;
	});
	const embed = new EmbedBuilder()
		.setColor(match.won ? WIN : LOSS)
		.setTitle(`${hero} · ${match.won ? '胜' : '负'}`)
		.setURL(`${SITE_URL}/dotahub/matches/${match.matchId}`)
		.setDescription([head, '', events.length ? `**死了 ${events.length} 次**\n${lines.join('\n')}` : '**这场没死**'].join('\n').slice(0, 4000))
		.setFooter({ text: `天梯 · 比赛 ${match.matchId} · 资料来自 STRATZ` })
		.setTimestamp(new Date(match.startTime * 1000));
	const files = [];
	if (events.length) {
		const image = await deathMap(match);
		if (image) {
			embed.setImage('attachment://deathmap.png');
			files.push(image);
		}
	}
	return { content: events.length ? '刚打完的天梯，死亡地图：' : '刚打完的天梯：', embeds: [embed], files };
}

// Resolves to true when the match should leave the queue (sent, or never deliverable).
async function deliver(client, match) {
	const key = `${match.accountId}:${match.matchId}`;
	try {
		const user = await client.users.fetch(match.discordId);
		await user.send(await buildMessage(match));
		console.log(`[dota] Sent the death map of ${match.matchId} to ${match.discordId}.`);
		return true;
	}
	catch (error) {
		if ([RESTJSONErrorCodes.CannotSendMessagesToThisUser, RESTJSONErrorCodes.CannotSendMessagesToThisUserDueToHavingNoMutualGuilds, RESTJSONErrorCodes.UnknownUser].includes(error.code)) {
			console.warn(`[dota] Could not DM ${match.discordId}: their DMs are closed to the bot`);
			return true;
		}
		const tries = (attempts.get(key) ?? 0) + 1;
		attempts.set(key, tries);
		console.warn(`[dota] DM for ${match.matchId} failed (${tries}/${MAX_ATTEMPTS}):`, error.message);
		return tries >= MAX_ATTEMPTS;
	}
}

async function poll(client) {
	if (running) return;
	running = true;
	try {
		const queue = await dotaRequest('GET', '/notifications');
		for (const match of queue) {
			if (!(await deliver(client, match))) continue;
			attempts.delete(`${match.accountId}:${match.matchId}`);
			await dotaRequest('POST', `/notifications/${match.accountId}/${match.matchId}/sent`).catch((error) => {
				console.warn(`[dota] Could not mark ${match.matchId} sent:`, error.message);
			});
		}
	}
	catch (error) {
		console.warn('[dota] Polling the DM queue failed:', error.message);
	}
	finally {
		running = false;
	}
}

function startDotaNotifications(client) {
	if (!adminApiEnabled) return;
	poll(client);
	setInterval(() => poll(client), POLL_MS).unref();
	console.log('DotaHub death-map DMs are enabled.');
}

module.exports = { startDotaNotifications, buildMessage };
