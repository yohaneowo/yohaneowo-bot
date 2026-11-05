// LinkHub animated items: GIF first, mp4 fallback. Runs with `npm test` (node:test, no network:
// fetch is replaced by a fake gateway).
process.env.LINKHUB_API_URL = 'http://linkhub.test';
process.env.LINKHUB_API_KEY = 'test-key';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pickVideoFormat, downloadItem, fetchViaLinkHub } = require('../services/sites/linkhub');

const GIF_BYTES = Buffer.from('GIF89a-fake-animation');
const MP4_BYTES = Buffer.from('fake-mp4-bytes');
const GIF_URL = 'http://linkhub.test/v1/download?t=gif-token';
const MP4_URL = 'http://linkhub.test/v1/download?t=mp4-token';

let dir;
let calls;
let routes;
const realFetch = globalThis.fetch;

function reply(status, body, headers = {}) {
	return new Response(body, { status, headers });
}

function jsonError(status, code) {
	return reply(status, JSON.stringify({ ok: false, code, message: code }), {
		'content-type': 'application/json',
	});
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkhub-gif-test-'));
	calls = [];
	routes = {};
	globalThis.fetch = async (input, init = {}) => {
		const url = new URL(String(input));
		calls.push({ url, headers: init.headers ?? {} });
		const key = `${url.origin}${url.pathname}?t=${url.searchParams.get('t')}`;
		const handler = routes[key] ?? routes[`${url.origin}${url.pathname}`];
		if (!handler) throw new Error(`unexpected fetch ${url}`);
		return handler(url, init);
	};
});

afterEach(() => {
	globalThis.fetch = realFetch;
	fs.rmSync(dir, { recursive: true, force: true });
});

function animatedItem(extraFormats = []) {
	return {
		type: 'video',
		animation: 'gif',
		durationSec: 4,
		formats: [
			{
				quality: 'gif',
				url: GIF_URL,
				downloadUrl: GIF_URL,
				ext: 'gif',
				mimeType: 'image/gif',
				hasVideo: true,
				hasAudio: false,
			},
			...extraFormats,
			{
				url: 'https://video.twimg.com/tweet_video/abc.mp4',
				downloadUrl: MP4_URL,
				ext: 'mp4',
				videoCodec: 'h264',
			},
		],
	};
}

const mp4Route = () => reply(200, MP4_BYTES, { 'content-type': 'video/mp4' });

test('animated item downloads the GIF with maxBytes = remaining quota and keeps the Bearer header', async () => {
	routes[GIF_URL] = () => reply(200, GIF_BYTES, { 'content-type': 'image/gif' });
	const file = await downloadItem(animatedItem(), dir, 2, 7_000_000);

	assert.equal(file.name, 'image-2.gif');
	assert.equal(file.isVideo, false);
	assert.deepEqual(fs.readFileSync(file.path), GIF_BYTES);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url.searchParams.get('maxBytes'), '7000000');
	assert.equal(calls[0].url.searchParams.get('t'), 'gif-token');
	assert.equal(calls[0].headers.Authorization, 'Bearer test-key');
});

for (const [status, code] of [
	[413, 'GIF_TOO_LARGE'],
	[502, 'GIF_FAILED'],
]) {
	test(`${status} ${code} falls back to the same item's mp4`, async () => {
		routes[GIF_URL] = () => jsonError(status, code);
		routes[MP4_URL] = mp4Route;
		const file = await downloadItem(animatedItem(), dir, 1, 10_000_000);

		assert.equal(file.name, 'video-1.mp4');
		assert.equal(file.isVideo, true);
		assert.equal(file.durationSec, 4);
		assert.deepEqual(fs.readFileSync(file.path), MP4_BYTES);
		assert.equal(fs.existsSync(path.join(dir, 'image-1.gif')), false);
		assert.equal(calls.at(-1).url.searchParams.get('t'), 'mp4-token');
	});
}

test('a GIF without content-length is cut off once it passes the limit, then the mp4 is used', async () => {
	// 100 chunks of 1 KB with no content-length; the limit is 2 KB, so the download must stop early.
	let pulled = 0;
	let cancelled = false;
	const body = new ReadableStream({
		pull(controller) {
			pulled += 1;
			if (pulled > 100) controller.close();
			else controller.enqueue(new Uint8Array(1024));
		},
		cancel() {
			cancelled = true;
		},
	});
	routes[GIF_URL] = () => reply(200, body, { 'content-type': 'image/gif' });
	routes[MP4_URL] = mp4Route;
	const file = await downloadItem(animatedItem(), dir, 1, 2048);

	assert.equal(file.name, 'video-1.mp4');
	assert.equal(file.isVideo, true);
	assert.ok(pulled < 10, `read ${pulled} chunks; should stop right after the limit`);
	assert.equal(cancelled, true);
	assert.deepEqual(fs.readdirSync(dir), ['video-1.mp4']);
});

test('a GIF exactly at the limit without content-length is kept', async () => {
	routes[GIF_URL] = () =>
		reply(200, new Blob([Buffer.alloc(2048)]).stream(), { 'content-type': 'image/gif' });
	const file = await downloadItem(animatedItem(), dir, 1, 2048);
	assert.equal(file.name, 'image-1.gif');
	assert.equal(fs.statSync(file.path).size, 2048);
});

test('an existing GIF whose content-length is over the limit is not downloaded', async () => {
	routes[GIF_URL] = () =>
		reply(200, Buffer.alloc(2048), { 'content-type': 'image/gif', 'content-length': '2048' });
	routes[MP4_URL] = mp4Route;
	const file = await downloadItem(animatedItem(), dir, 1, 1024);
	assert.equal(file.name, 'video-1.mp4');
});

test('a non-GIF response is not saved as a GIF', async () => {
	routes[GIF_URL] = () => reply(200, MP4_BYTES, { 'content-type': 'video/mp4' });
	routes[MP4_URL] = mp4Route;
	const file = await downloadItem(animatedItem(), dir, 1, 10_000_000);
	assert.equal(file.name, 'video-1.mp4');
});

test('ordinary videos stay mp4 and never request a GIF', async () => {
	routes[MP4_URL] = mp4Route;
	const item = animatedItem();
	delete item.animation;
	const file = await downloadItem(item, dir, 1, 10_000_000);

	assert.equal(file.name, 'video-1.mp4');
	assert.equal(file.isVideo, true);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url.searchParams.get('t'), 'mp4-token');
});

test('pickVideoFormat never returns a GIF', () => {
	const gif = { quality: 'gif', ext: 'gif', mimeType: 'image/gif', url: 'x' };
	const mp4 = { ext: 'mp4', url: 'y' };
	assert.equal(pickVideoFormat([gif, mp4], 1000), mp4);
	assert.equal(pickVideoFormat([{ ext: 'GIF', url: 'z' }, mp4], 1000), mp4);
	assert.equal(pickVideoFormat([{ mimeType: 'image/gif', url: 'z' }], 1000), null);
});

test('single animated item: posted as image-1.gif without going through video compression', async () => {
	routes['http://linkhub.test/v1/parse'] = () =>
		reply(
			200,
			JSON.stringify({
				ok: true,
				post: { title: 't', text: 'hello', author: { name: 'a' } },
				items: [animatedItem()],
				meta: { platform: 'twitter', adapter: 'legacy' },
				raw: { possibly_sensitive: true },
			}),
			{ 'content-type': 'application/json' },
		);
	routes[GIF_URL] = () => reply(200, GIF_BYTES, { 'content-type': 'image/gif' });
	const result = await fetchViaLinkHub('https://x.com/a/status/1', dir, 10_000_000);

	assert.equal(result.files.length, 1);
	assert.equal(result.files[0].name, 'SPOILER_image-1.gif');
	assert.equal(result.compressed, false);
	assert.equal(calls[1].url.searchParams.get('maxBytes'), '10000000');
});

test('several items: the GIF gets the quota left after earlier items', async () => {
	const imageUrl = 'http://linkhub.test/v1/download?t=img-token';
	routes['http://linkhub.test/v1/parse'] = () =>
		reply(
			200,
			JSON.stringify({
				ok: true,
				post: { text: 'two' },
				items: [
					{
						type: 'image',
						formats: [{ url: imageUrl, downloadUrl: imageUrl, ext: 'jpg' }],
					},
					animatedItem(),
				],
				meta: { platform: 'twitter', adapter: 'legacy' },
			}),
			{ 'content-type': 'application/json' },
		);
	routes[imageUrl] = () => reply(200, Buffer.alloc(1000), { 'content-type': 'image/jpeg' });
	routes[GIF_URL] = () => reply(200, GIF_BYTES, { 'content-type': 'image/gif' });
	const result = await fetchViaLinkHub('https://x.com/a/status/2', dir, 5000);

	assert.deepEqual(
		result.files.map((file) => file.name),
		['image-1.jpg', 'image-2.gif'],
	);
	const gifCall = calls.find((call) => call.url.searchParams.get('t') === 'gif-token');
	assert.equal(gifCall.url.searchParams.get('maxBytes'), '4000');
});
