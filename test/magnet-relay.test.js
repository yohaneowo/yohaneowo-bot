// Magnet hand-off through DM confirm buttons. Runs with `npm test` (node:test): fetch, Discord messages
// and button presses are fakes, nothing touches the network or a real Discord server.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
	loadConfig,
	parseMagnet,
	extractMagnets,
	createDeduper,
	createPendingStore,
	createState,
	signRequest,
	sendWebhook,
	handleMagnetMessage,
	handleMagnetButton,
} = require('../services/magnetRelay');
const { makeTorrent } = require('./helpers-torrent');

const HEX = '897ab67a6ef93e3f71950bf34b9a0d1747338f6a';
const MAGNET = `magnet:?xt=urn:btih:${HEX}&dn=Test%20Show&tr=https%3A%2F%2Ftr.example.test%3A9696%2Fannounce`;
const ALLOWED = '111111111111111111';
const OTHER = '222222222222222222';
const SECRET = 'test-secret';

function config(overrides = {}) {
	return loadConfig({
		MAGNET_USER_IDS: ALLOWED,
		MAGNET_WEBHOOK_URL: 'https://openbot.test/hook',
		MAGNET_WEBHOOK_SECRET: SECRET,
		...overrides,
	});
}

// A DM by default (no guild).
function fakeMessage(content, authorId = ALLOWED, extra = {}) {
	const replies = [];
	return {
		id: 'm1',
		channelId: 'c1',
		guildId: null,
		content,
		author: { id: authorId, bot: false, ...extra.author },
		replies,
		reply: async (payload) => {
			replies.push(payload);
		},
		delete: async () => {
			throw new Error('the original message must never be deleted');
		},
	};
}

function fakeFetch(statuses) {
	const calls = [];
	const fn = async (url, init) => {
		calls.push({ url, init });
		const status = statuses[Math.min(calls.length - 1, statuses.length - 1)];
		if (status === 'throw') throw new Error('network down');
		return { ok: status >= 200 && status < 300, status };
	};
	fn.calls = calls;
	return fn;
}

const noWait = () => Promise.resolve();

test('config is enabled only with users, a valid URL and a secret', () => {
	assert.equal(config().enabled, true);
	assert.deepEqual([...config({ MAGNET_USER_IDS: `${ALLOWED}, ${OTHER}` }).userIds], [ALLOWED, OTHER]);
	assert.equal(config({ MAGNET_USER_IDS: 'not-an-id' }).enabled, false);
	assert.equal(config({ MAGNET_WEBHOOK_URL: 'not a url' }).enabled, false);
	assert.equal(config({ MAGNET_WEBHOOK_URL: 'ftp://x.test/' }).enabled, false);
	assert.equal(config({ MAGNET_WEBHOOK_SECRET: '' }).enabled, false);
	assert.equal(loadConfig({}).enabled, false);
	assert.equal(config().metaLookup, true);
	assert.equal(config({ MAGNET_META_LOOKUP: 'false' }).metaLookup, false);
});

test('without MAGNET_USER_IDS the two built-in users are allowed, and the variable replaces them', () => {
	const bare = { MAGNET_WEBHOOK_URL: 'https://openbot.test/hook', MAGNET_WEBHOOK_SECRET: SECRET };
	for (const env of [bare, { ...bare, MAGNET_USER_IDS: '' }, { ...bare, MAGNET_USER_IDS: '  ' }]) {
		const defaults = loadConfig(env);
		assert.equal(defaults.enabled, true);
		assert.equal(defaults.userIds.size, 2);
		assert.ok([...defaults.userIds].every((id) => /^\d{15,25}$/.test(id)));
	}
	assert.deepEqual([...loadConfig({ ...bare, MAGNET_USER_IDS: ALLOWED }).userIds], [ALLOWED]);
	// The URL and secret are still required.
	assert.equal(loadConfig({}).enabled, false);
});

test('parseMagnet reads hex and base32 info hashes to the same value', () => {
	assert.equal(parseMagnet(MAGNET).infohash, HEX);
	assert.equal(parseMagnet(MAGNET).name, 'Test Show');
	assert.equal(parseMagnet(`magnet:?xt=urn:btih:${HEX.toUpperCase()}`).infohash, HEX);
	// base32 of bytes 0x00..0x13 (20 bytes -> 32 chars)
	const bytes = Buffer.from([...Array(20).keys()]);
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	let bits = '';
	for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
	let base32 = '';
	for (let i = 0; i < bits.length; i += 5) base32 += alphabet[parseInt(bits.slice(i, i + 5), 2)];
	assert.equal(base32.length, 32);
	assert.equal(parseMagnet(`magnet:?xt=urn:btih:${base32}`).infohash, bytes.toString('hex'));
});

test('parseMagnet rejects links without a valid btih hash', () => {
	assert.equal(parseMagnet('magnet:?dn=nothing'), null);
	assert.equal(parseMagnet('magnet:?xt=urn:btih:abc123'), null);
	assert.equal(parseMagnet(`magnet:?xt=urn:btih:${HEX}0`), null);
	assert.equal(parseMagnet(`magnet:?xt=urn:sha1:${HEX}`), null);
	assert.equal(parseMagnet(`magnet:?xt=urn:btih:${HEX}&dn=${'a'.repeat(5000)}`), null);
});

test('extractMagnets strips wrapping and punctuation, dedupes and caps per message', () => {
	assert.equal(extractMagnets(`看这个 <${MAGNET}>`)[0].magnet, MAGNET);
	assert.equal(extractMagnets(`(${MAGNET}).`)[0].magnet, MAGNET);
	assert.equal(extractMagnets(`${MAGNET} ${MAGNET}`).length, 1);
	assert.equal(extractMagnets('没有链接').length, 0);
	const many = Array.from({ length: 8 }, (_, i) => `magnet:?xt=urn:btih:${String(i).repeat(40)}`).join(' ');
	assert.equal(extractMagnets(many).length, 5);
});

test('deduper forgets an info hash after the window', () => {
	let time = 0;
	const deduper = createDeduper(1000, () => time);
	assert.equal(deduper.has(HEX), false);
	deduper.add(HEX);
	time = 999;
	assert.equal(deduper.has(HEX), true);
	time = 1000;
	assert.equal(deduper.has(HEX), false);
});

test('webhook request carries a verifiable signature and the expected body', async () => {
	const fetchImpl = fakeFetch([200]);
	await sendWebhook(
		config(),
		{ magnet: MAGNET, infohash: HEX, name: 'Test Show', message_id: 'm1', requester_id: ALLOWED },
		{ fetchImpl, now: () => 1_700_000_000_000 },
	);
	const [{ url, init }] = fetchImpl.calls;
	assert.equal(url, 'https://openbot.test/hook');
	assert.equal(init.method, 'POST');
	const body = JSON.parse(init.body);
	assert.equal(body.type, 'bot.magnet_request');
	assert.equal(body.data.infohash, HEX);
	assert.equal(init.headers['x-openbot-timestamp'], '1700000000');
	assert.equal(init.headers['x-openbot-delivery-id'], `magnet-${HEX}-m1`);
	const expected = signRequest(SECRET, '1700000000', `magnet-${HEX}-m1`, init.body);
	assert.equal(init.headers['x-openbot-signature'], `sha256=${expected}`);
	assert.match(expected, /^[0-9a-f]{64}$/);
});

test('webhook retries a server error once and gives up on a client error', async () => {
	const retried = fakeFetch([502, 200]);
	await sendWebhook(config(), { infohash: HEX, message_id: 'm1' }, { fetchImpl: retried, wait: noWait });
	assert.equal(retried.calls.length, 2);

	const rejected = fakeFetch([401, 200]);
	await assert.rejects(
		sendWebhook(config(), { infohash: HEX, message_id: 'm1' }, { fetchImpl: rejected, wait: noWait }),
		/401/,
	);
	assert.equal(rejected.calls.length, 1);

	const down = fakeFetch(['throw']);
	await assert.rejects(
		sendWebhook(config(), { infohash: HEX, message_id: 'm1' }, { fetchImpl: down, wait: noWait }),
		/network down/,
	);
	assert.equal(down.calls.length, 2);
});

const TORRENT = makeTorrent({
	name: 'Show [1080p]',
	'piece length': 16384,
	pieces: Buffer.alloc(20),
	files: [
		{ length: 1_500_000_000, path: ['Show [01].mkv'] },
		{ length: 43_000, path: ['Show [01].ass'] },
	],
});
const TORRENT_MAGNET = `magnet:?xt=urn:btih:${TORRENT.infohash}`;

function cacheHit() {
	return { meta: { fetchImpl: async () => new Response(TORRENT.buffer) } };
}

function cacheMiss() {
	return { meta: { fetchImpl: async () => new Response('', { status: 404 }) } };
}

function buttonId(message, index) {
	return message.replies[0].components[0].components[index].custom_id;
}

function fakeButton(customId, userId = ALLOWED, extra = {}) {
	const calls = [];
	return {
		customId,
		user: { id: userId },
		calls,
		inGuild: () => false,
		update: async (payload) => calls.push(['update', payload]),
		deferUpdate: async () => calls.push(['defer']),
		editReply: async (payload) => calls.push(['edit', payload]),
		...extra,
	};
}

test('a DM magnet gets a card with the verified title, size and two buttons, and nothing is sent yet', async () => {
	const state = createState();
	const fetchImpl = fakeFetch([200]);
	const message = fakeMessage(TORRENT_MAGNET);
	await handleMagnetMessage(message, config(), state, { ...cacheHit(), send: { fetchImpl, wait: noWait } });
	assert.equal(fetchImpl.calls.length, 0);
	assert.equal(message.replies.length, 1);
	const [embed] = message.replies[0].embeds;
	assert.equal(embed.title, 'Show [1080p]');
	assert.match(embed.description, /1\.5 GB/);
	assert.match(embed.description, /文件数：2/);
	const buttons = message.replies[0].components[0].components;
	assert.deepEqual(
		buttons.map((button) => button.style),
		[3, 4],
	);
	assert.match(buttons[0].custom_id, /^magnet:ok:[0-9a-f]{16}$/);
	assert.match(buttons[1].custom_id, /^magnet:no:[0-9a-f]{16}$/);
	assert.deepEqual(message.replies[0].allowedMentions, { parse: [], repliedUser: false });
});

test('without cache metadata the card falls back to the link name, then to a warning', async () => {
	const named = fakeMessage(MAGNET);
	await handleMagnetMessage(named, config(), createState(), cacheMiss());
	assert.equal(named.replies[0].embeds[0].title, 'Test Show');
	assert.match(named.replies[0].embeds[0].description, /dn/);

	const bare = fakeMessage(`magnet:?xt=urn:btih:${HEX}`);
	await handleMagnetMessage(bare, config(), createState(), cacheMiss());
	assert.equal(bare.replies[0].embeds[0].title, '（查不到名称）');
	assert.match(bare.replies[0].embeds[0].description, /自行确认/);
});

test('metadata lookup can be turned off, and then no request leaves the bot', async () => {
	let lookups = 0;
	const meta = {
		fetchImpl: async () => {
			lookups += 1;
			return new Response(TORRENT.buffer);
		},
	};
	const message = fakeMessage(TORRENT_MAGNET);
	await handleMagnetMessage(message, config({ MAGNET_META_LOOKUP: 'false' }), createState(), { meta });
	assert.equal(lookups, 0);
	assert.equal(message.replies[0].embeds[0].title, '（查不到名称）');
});

test('guild messages, other users, bots and plain messages are ignored silently', async () => {
	const options = cacheHit();
	const inGuild = fakeMessage(TORRENT_MAGNET);
	inGuild.guildId = 'g1';
	const stranger = fakeMessage(TORRENT_MAGNET, OTHER);
	const bot = fakeMessage(TORRENT_MAGNET, ALLOWED, { author: { bot: true } });
	const plain = fakeMessage('hello https://example.test');
	const disabled = fakeMessage(TORRENT_MAGNET);
	for (const message of [inGuild, stranger, bot, plain]) {
		await handleMagnetMessage(message, config(), createState(), options);
	}
	await handleMagnetMessage(disabled, loadConfig({}), createState(), options);
	for (const message of [inGuild, stranger, bot, plain, disabled]) assert.equal(message.replies.length, 0);
});

test('Confirm sends one signed hand-off with the looked-up details, then closes the card', async () => {
	const state = createState();
	const fetchImpl = fakeFetch([200]);
	const options = { ...cacheHit(), send: { fetchImpl, wait: noWait } };
	const message = fakeMessage(TORRENT_MAGNET);
	await handleMagnetMessage(message, config(), state, options);

	const press = fakeButton(buttonId(message, 0));
	assert.equal(await handleMagnetButton(press, config(), state, options), true);
	assert.equal(fetchImpl.calls.length, 1);
	const { type, data } = JSON.parse(fetchImpl.calls[0].init.body);
	assert.equal(type, 'bot.magnet_request');
	assert.equal(data.infohash, TORRENT.infohash);
	assert.equal(data.magnet, TORRENT_MAGNET);
	assert.equal(data.name, 'Show [1080p]');
	assert.equal(data.size_bytes, 1_500_043_000);
	assert.equal(data.file_count, 2);
	assert.equal(data.requester_id, ALLOWED);
	assert.equal(data.message_id, 'm1');
	assert.equal(data.guild_id, null);
	assert.deepEqual(press.calls[0], ['defer']);
	assert.match(press.calls[1][1].content, /已转交/);
	assert.deepEqual(press.calls[1][1].components, []);

	// A second press on the same card finds nothing pending.
	const again = fakeButton(buttonId(message, 0));
	await handleMagnetButton(again, config(), state, options);
	assert.match(again.calls[0][1].content, /已过期/);
	assert.equal(fetchImpl.calls.length, 1);
});

test('Cancel sends nothing and closes the card', async () => {
	const state = createState();
	const fetchImpl = fakeFetch([200]);
	const options = { ...cacheHit(), send: { fetchImpl, wait: noWait } };
	const message = fakeMessage(TORRENT_MAGNET);
	await handleMagnetMessage(message, config(), state, options);
	const press = fakeButton(buttonId(message, 1));
	await handleMagnetButton(press, config(), state, options);
	assert.equal(fetchImpl.calls.length, 0);
	assert.match(press.calls[0][1].content, /已取消/);
	assert.deepEqual(press.calls[0][1].components, []);
});

test('a press from someone else, or in a server, does nothing', async () => {
	const state = createState();
	const fetchImpl = fakeFetch([200]);
	const options = { ...cacheHit(), send: { fetchImpl, wait: noWait } };
	const message = fakeMessage(TORRENT_MAGNET);
	await handleMagnetMessage(message, config(), state, options);
	const id = buttonId(message, 0);
	const otherUser = fakeButton(id, OTHER);
	const otherAllowed = fakeButton(id, '333333333333333333');
	const inServer = fakeButton(id, ALLOWED, { inGuild: () => true });
	const presses = [otherUser, otherAllowed, inServer];
	for (const press of presses) await handleMagnetButton(press, config(), state, options);
	assert.equal(fetchImpl.calls.length, 0);
	for (const press of presses) assert.equal(press.calls.length, 0);
});

test('a second allowed user cannot press the first user card', async () => {
	const second = '333333333333333333';
	const both = config({ MAGNET_USER_IDS: `${ALLOWED},${second}` });
	const state = createState();
	const fetchImpl = fakeFetch([200]);
	const options = { ...cacheHit(), send: { fetchImpl, wait: noWait } };
	const message = fakeMessage(TORRENT_MAGNET);
	await handleMagnetMessage(message, both, state, options);
	const press = fakeButton(buttonId(message, 0), second);
	await handleMagnetButton(press, both, state, options);
	assert.equal(fetchImpl.calls.length, 0);
	assert.equal(press.calls.length, 0);
});

test('non-magnet buttons are left to other handlers', async () => {
	const press = fakeButton('movie:feedback:1');
	assert.equal(await handleMagnetButton(press, config(), createState()), false);
	assert.equal(press.calls.length, 0);
});

test('a failed hand-off keeps the card so Confirm can be pressed again', async () => {
	const state = createState();
	const message = fakeMessage(TORRENT_MAGNET);
	await handleMagnetMessage(message, config(), state, cacheHit());
	const id = buttonId(message, 0);

	const failing = { send: { fetchImpl: fakeFetch(['throw']), wait: noWait } };
	const first = fakeButton(id);
	await handleMagnetButton(first, config(), state, failing);
	assert.match(first.calls[1][1].content, /转交失败/);
	assert.equal('components' in first.calls[1][1], false);
	assert.equal(state.deduper.has(TORRENT.infohash), false);

	const working = fakeFetch([200]);
	const second = fakeButton(id);
	await handleMagnetButton(second, config(), state, { send: { fetchImpl: working, wait: noWait } });
	assert.equal(working.calls.length, 1);
	assert.match(second.calls[1][1].content, /已转交/);
});

test('a link handed off recently is skipped at the card step and at the button step', async () => {
	const state = createState();
	const fetchImpl = fakeFetch([200]);
	const options = { ...cacheHit(), send: { fetchImpl, wait: noWait } };
	const first = fakeMessage(TORRENT_MAGNET);
	await handleMagnetMessage(first, config(), state, options);
	// Two cards for the same link, both open before either is confirmed.
	const second = fakeMessage(TORRENT_MAGNET);
	second.id = 'm2';
	await handleMagnetMessage(second, config(), state, options);
	await handleMagnetButton(fakeButton(buttonId(first, 0)), config(), state, options);
	const late = fakeButton(buttonId(second, 0));
	await handleMagnetButton(late, config(), state, options);
	assert.equal(fetchImpl.calls.length, 1);
	assert.match(late.calls[1][1].content, /刚处理过/);

	const third = fakeMessage(TORRENT_MAGNET);
	await handleMagnetMessage(third, config(), state, options);
	assert.equal(third.replies.length, 1);
	assert.match(third.replies[0].content, /刚处理过/);
	assert.equal(third.replies[0].embeds, undefined);
});

test('pending requests expire after the TTL and the store is capped', () => {
	let time = 0;
	const store = createPendingStore(1000, () => time);
	const token = store.create({ infohash: HEX });
	time = 999;
	assert.ok(store.get(token));
	time = 1000;
	assert.equal(store.get(token), undefined);
	const first = store.create({ infohash: 'first' });
	for (let i = 0; i < 100; i++) store.create({ infohash: `n${i}` });
	assert.equal(store.get(first), undefined);
});

test('a failing card reply does not throw', async () => {
	const message = fakeMessage(TORRENT_MAGNET);
	message.reply = async () => {
		throw new Error('missing permissions');
	};
	await handleMagnetMessage(message, config(), createState(), cacheHit());
});
