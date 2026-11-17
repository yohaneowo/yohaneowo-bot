// Rung order for sites that put a local parser ahead of LinkHub (Facebook). Fake rungs only:
// no network, no yt-dlp, no ffmpeg.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildRungs, createFallbackChain, createRepairState } = require('../services/sites/chain');
const { EmptyFileError } = require('../services/sites/video');
const { UserFacingError } = require('../services/sites/errors');

const URL_FB = 'https://www.facebook.com/reel/858979257261500/';
const MAX = 10 * 1000 * 1000;
let dir;
const noop = () => null;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-order-test-'));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function video(label) {
	return async (url, rungDir) => {
		const file = path.join(rungDir, 'video.mp4');
		fs.writeFileSync(file, Buffer.alloc(20000, 1));
		return { files: [{ path: file, name: 'video.mp4' }], author: label, text: '', compressed: false };
	};
}

function failing(message, code) {
	return async () => {
		throw Object.assign(new Error(message), code ? { code } : {});
	};
}

// Builds the real ladder, then swaps every rung's work for a recording fake.
function ladder({ first, linkhub, local, alt, linkhubConfigured = true }) {
	const calls = [];
	const rungs = buildRungs(local.fn, { first: first?.fn, alt: alt?.fn });
	const behaviours = { 'local-first': first, linkhub, local, 'local-alt': alt };
	for (const rung of rungs) {
		const behaviour = behaviours[rung.name];
		rung.run = async (...args) => {
			calls.push(rung.name);
			return behaviour.fn(...args);
		};
		if (rung.name === 'linkhub') rung.enabled = () => linkhubConfigured;
	}
	const chain = createFallbackChain({
		site: 'Facebook',
		rungs,
		state: createRepairState(),
		isBusy: () => false,
		probe: async () => ({ duration: 2, codec: 'h264' }),
	});
	return { chain, calls, names: rungs.map((rung) => rung.name) };
}

test('without a first rung the order is unchanged: LinkHub, then local', () => {
	assert.deepEqual(
		buildRungs(noop).map((rung) => rung.name),
		['linkhub', 'local'],
	);
	assert.deepEqual(
		buildRungs(noop, { alt: noop }).map((rung) => rung.name),
		['linkhub', 'local', 'local-alt'],
	);
});

test('with a first rung it runs before LinkHub', () => {
	assert.deepEqual(
		buildRungs(noop, { first: noop }).map((rung) => rung.name),
		['local-first', 'linkhub', 'local'],
	);
});

test('when the local video works LinkHub is never asked', async () => {
	const { chain, calls } = ladder({
		first: { fn: video('yt-dlp') },
		linkhub: { fn: video('linkhub') },
		local: { fn: video('preview') },
	});
	const result = await chain(URL_FB, dir, MAX);
	assert.equal(result.author, 'yt-dlp');
	assert.deepEqual(calls, ['local-first']);
});

test('when the local video fails LinkHub gets its turn, and the preview comes last', async () => {
	const failedFirst = ladder({
		first: { fn: failing('yt-dlp could not extract') },
		linkhub: { fn: video('linkhub') },
		local: { fn: video('preview') },
	});
	assert.equal((await failedFirst.chain(URL_FB, dir, MAX)).author, 'linkhub');
	assert.deepEqual(failedFirst.calls, ['local-first', 'linkhub']);

	const bothFailed = ladder({
		first: { fn: failing('yt-dlp could not extract') },
		linkhub: { fn: failing('LinkHub down') },
		local: { fn: video('preview') },
	});
	assert.equal((await bothFailed.chain(URL_FB, dir, MAX)).author, 'preview');
	assert.deepEqual(bothFailed.calls, ['local-first', 'linkhub', 'local']);
});

test('an empty local file also falls through to LinkHub', async () => {
	const { chain, calls } = ladder({
		first: {
			fn: async () => {
				throw new EmptyFileError('simulated empty download');
			},
		},
		linkhub: { fn: video('linkhub') },
		local: { fn: video('preview') },
	});
	assert.equal((await chain(URL_FB, dir, MAX)).author, 'linkhub');
	assert.deepEqual(calls, ['local-first', 'linkhub']);
});

test('a final error from the local video (too long) stops the ladder', async () => {
	const { chain, calls } = ladder({
		first: {
			fn: async () => {
				throw Object.assign(new UserFacingError('影片太长'), { code: 'VIDEO_TOO_LONG' });
			},
		},
		linkhub: { fn: video('linkhub') },
		local: { fn: video('preview') },
	});
	await assert.rejects(chain(URL_FB, dir, MAX), { code: 'VIDEO_TOO_LONG' });
	assert.deepEqual(calls, ['local-first']);
});

test('without LinkHub configured the order is local video, then preview', async () => {
	const { chain, calls } = ladder({
		first: { fn: failing('yt-dlp could not extract') },
		linkhub: { fn: video('linkhub') },
		local: { fn: video('preview') },
		linkhubConfigured: false,
	});
	assert.equal((await chain(URL_FB, dir, MAX)).author, 'preview');
	assert.deepEqual(calls, ['local-first', 'local']);
});

test('only Facebook is configured with a first rung', () => {
	const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'media.js'), 'utf8');
	assert.equal(source.match(/first:/g).length, 1);
	assert.match(source, /fetchFacebookPreview, \{ site: 'Facebook', first: fetchFacebookVideo \}/);
});
