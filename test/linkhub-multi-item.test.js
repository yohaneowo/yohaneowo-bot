// LinkHub results with several items: an empty or unreadable file fails the whole attempt (so the
// chain can try the next route) instead of slipping through to Discord. fetch is a fake gateway.
process.env.LINKHUB_API_URL = 'http://linkhub.test';
process.env.LINKHUB_API_KEY = 'test-key';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fetchViaLinkHub } = require('../services/sites/linkhub');
const { runWithSignal } = require('../services/sites/deadline');

let dir;
let routes;
const realFetch = globalThis.fetch;

const IMG_1 = 'http://linkhub.test/v1/download?t=img-1';
const IMG_2 = 'http://linkhub.test/v1/download?t=img-2';
const VID = 'http://linkhub.test/v1/download?t=vid';

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkhub-multi-test-'));
	routes = {};
	globalThis.fetch = async (input, init) => {
		const url = new URL(String(input));
		const handler = routes[`${url.origin}${url.pathname}?t=${url.searchParams.get('t')}`] ?? routes[`${url.origin}${url.pathname}`];
		if (!handler) throw new Error(`unexpected fetch ${url}`);
		return handler(init);
	};
});
afterEach(() => {
	globalThis.fetch = realFetch;
	fs.rmSync(dir, { recursive: true, force: true });
});

// 200 with exactly `bytes` bytes. bytes = 0 is an empty stream, the real "200 but nothing" case.
const body = (bytes, type, extra = {}) => () =>
	new Response(
		bytes === 0
			? new ReadableStream({ start: (controller) => controller.close() })
			: Buffer.alloc(bytes, 1),
		{ status: 200, headers: { 'content-type': type, ...extra } },
	);

function parseReturns(items) {
	routes['http://linkhub.test/v1/parse'] = () =>
		new Response(
			JSON.stringify({
				ok: true,
				post: { text: 'post' },
				items,
				meta: { platform: 'twitter', adapter: 'legacy' },
			}),
			{ status: 200, headers: { 'content-type': 'application/json' } },
		);
}

const image = (url) => ({ type: 'image', formats: [{ url, downloadUrl: url, ext: 'jpg' }] });
const video = (url) => ({ type: 'video', formats: [{ url, downloadUrl: url, ext: 'mp4' }] });

test('a 0-byte video among several items fails the attempt as empty_file', async () => {
	parseReturns([image(IMG_1), video(VID)]);
	routes[IMG_1] = body(4000, 'image/jpeg');
	routes[VID] = body(0, 'video/mp4');
	await assert.rejects(fetchViaLinkHub('https://x.com/a/status/1', dir, 10_000_000), (error) => {
		assert.equal(error.code, 'EMPTY_FILE');
		assert.match(error.detail, /item 2/);
		return true;
	});
});

test('a video under the 10 KB floor among several items fails the attempt as empty_file', async () => {
	parseReturns([video(VID), image(IMG_1)]);
	routes[VID] = body(3000, 'video/mp4');
	routes[IMG_1] = body(4000, 'image/jpeg');
	await assert.rejects(fetchViaLinkHub('https://x.com/a/status/2', dir, 10_000_000), (error) => error.code === 'EMPTY_FILE');
});

test('a 0-byte image among several items fails the attempt as empty_file', async () => {
	parseReturns([image(IMG_1), image(IMG_2)]);
	routes[IMG_1] = body(4000, 'image/jpeg');
	routes[IMG_2] = body(0, 'image/jpeg');
	await assert.rejects(fetchViaLinkHub('https://x.com/a/status/3', dir, 10_000_000), (error) => error.code === 'EMPTY_FILE');
});

test('several healthy images still come through unchanged', async () => {
	parseReturns([image(IMG_1), image(IMG_2)]);
	routes[IMG_1] = body(4000, 'image/jpeg');
	routes[IMG_2] = body(5000, 'image/png');
	const result = await fetchViaLinkHub('https://x.com/a/status/4', dir, 10_000_000);
	assert.deepEqual(result.files.map((file) => file.name), ['image-1.jpg', 'image-2.png']);
});

test('a single 0-byte video is still rejected as empty_file (stage 1 behaviour)', async () => {
	parseReturns([video(VID)]);
	routes[VID] = body(0, 'video/mp4');
	await assert.rejects(fetchViaLinkHub('https://x.com/a/status/5', dir, 10_000_000), (error) => error.code === 'EMPTY_FILE');
});

test('a response without any body is an empty file, not a crash', async () => {
	parseReturns([image(IMG_1), image(IMG_2)]);
	routes[IMG_1] = body(4000, 'image/jpeg');
	routes[IMG_2] = () => new Response(null, { status: 200, headers: { 'content-type': 'image/jpeg' } });
	await assert.rejects(fetchViaLinkHub('https://x.com/a/status/7', dir, 10_000_000), (error) => error.code === 'EMPTY_FILE');
});

test('a LinkHub request in flight is cancelled when the rung time budget is spent', async () => {
	let sawSignal = false;
	// The gateway never answers; the request only ends when its signal fires.
	routes['http://linkhub.test/v1/parse'] = (init) =>
		new Promise((resolve, reject) => {
			sawSignal = Boolean(init?.signal);
			init.signal.addEventListener('abort', () => reject(init.signal.reason));
		});
	const controller = new AbortController();
	setTimeout(() => controller.abort(new Error('budget spent')), 50);
	const started = Date.now();
	await assert.rejects(
		runWithSignal(controller.signal, () => fetchViaLinkHub('https://x.com/a/status/8', dir, 10_000_000)),
		/budget spent/,
	);
	assert.equal(sawSignal, true, 'the request carries the rung budget signal');
	assert.ok(Date.now() - started < 2000, 'cancelled by the budget, not by the 60 s parse timeout');
});

test('the download log records status, announced length and bytes written', async () => {
	parseReturns([image(IMG_1)]);
	routes[IMG_1] = body(4000, 'image/jpeg', { 'content-length': '4000' });
	const lines = [];
	const realLog = console.log;
	console.log = (...args) => lines.push(args.join(' '));
	try {
		await fetchViaLinkHub('https://x.com/a/status/6', dir, 10_000_000);
	}
	finally {
		console.log = realLog;
	}
	assert.ok(
		lines.some((line) => /HTTP 200, content-length 4000, 4000 bytes/.test(line)),
		`log lines: ${lines.join(' | ')}`,
	);
});
