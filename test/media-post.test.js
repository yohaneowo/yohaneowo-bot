// postMedia (services/mediaPost.js) around the retry ladder. media.js and adminApi.js are replaced
// by fakes, so nothing touches the network, Discord or the admin.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mediaPath = require.resolve('../services/media');
const adminPath = require.resolve('../services/adminApi');
const reports = [];
const fakeMedia = {
	impl: async () => {
		throw new Error('no fake installed');
	},
	downloadMedia: (...args) => fakeMedia.impl(...args),
	findSupportedSite: () => ({ name: 'YouTube' }),
};
require.cache[mediaPath] = { id: mediaPath, filename: mediaPath, loaded: true, exports: fakeMedia };
require.cache[adminPath] = {
	id: adminPath,
	filename: adminPath,
	loaded: true,
	exports: { reportParse: (entry) => reports.push(entry), withLogSite: (site, fn) => fn() },
};

const { postMedia } = require('../services/mediaPost');
const { createFallbackChain, createRepairState } = require('../services/sites/chain');
const { EmptyFileError } = require('../services/sites/video');

const URL_A = 'https://www.youtube.com/shorts/AAAAAAAAAAA';
let dir;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-post-test-'));
	reports.length = 0;
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function run(url = URL_A) {
	const updates = [];
	const promise = postMedia({
		url,
		maxBytes: 10_000_000,
		update: async (payload) => updates.push(payload),
		logContext: { source: 'auto', group_external_id: 'g', user_external_id: 'u', user_name: 'tester' },
	});
	return { updates, promise };
}

const fakeLog = { info: () => undefined, warn: () => undefined };
function mediaFrom(result) {
	return { ...result, site: 'YouTube', log: fakeLog, cleanup: async () => undefined };
}

test('when every route is empty the post is not counted as posted (so the original message is kept)', async () => {
	fakeMedia.impl = async () => {
		throw new EmptyFileError('tried=local,local-alt; site_consecutive=1; 0 bytes');
	};
	const { updates, promise } = run();
	assert.equal(await promise, false, 'postMedia returns false, so index.js never deletes the message');
	assert.equal(updates.at(-1).content, `-# <${URL_A}>\n⚠️ 下载到的影片是空的或已损坏，请稍后再试`);
	assert.equal(reports.length, 1);
	assert.equal(reports[0].result, 'failed');
	assert.match(reports[0].error_message, /^empty_file: tried=local,local-alt; site_consecutive=1;/);
});

test('the retry shows its own status text', async () => {
	fakeMedia.impl = async (url, maxBytes, onStage) => {
		onStage('retrying');
		throw new EmptyFileError('x');
	};
	const { updates, promise } = run();
	await promise;
	assert.ok(updates.includes('🔁 换个方式再试…'), `statuses: ${JSON.stringify(updates)}`);
});

test('a link that recovers through the retry is posted once and logged as a success', async () => {
	fakeMedia.impl = async () => {
		const file = path.join(dir, 'video.mp4');
		fs.writeFileSync(file, Buffer.alloc(20000, 1));
		return mediaFrom({ files: [{ path: file, name: 'video.mp4' }], author: '', text: '', compressed: false });
	};
	const { updates, promise } = run();
	assert.equal(await promise, true);
	assert.equal(reports.length, 1);
	assert.equal(reports[0].result, 'success');
	assert.equal(updates.filter((u) => u && u.files).length, 1, 'uploaded exactly once');
});

// Rungs for the wiring test: the base route is always empty, the extra route counts its runs.
function ladder(counter) {
	return createFallbackChain({
		site: 'YouTube',
		state: createRepairState(),
		rungs: [
			{
				name: 'local',
				repair: false,
				enabled: () => true,
				run: async () => {
					throw new EmptyFileError('empty');
				},
			},
			{
				name: 'local-alt',
				repair: true,
				enabled: () => true,
				run: async (url, rungDir) => {
					counter.runs += 1;
					const file = path.join(rungDir, 'video.mp4');
					fs.writeFileSync(file, Buffer.alloc(20000, 1));
					return { files: [{ path: file, name: 'video.mp4' }], author: '', text: '', compressed: false };
				},
			},
		],
		// The files above are not real videos, so ffprobe is replaced; isBusy stays at its default:
		// the probe that mediaPost.js installed.
		probe: async () => ({ duration: 2, codec: 'h264' }),
	});
}

test('while another link holds a download slot the extra retry is skipped; alone, it runs', async () => {
	const busyRun = { runs: 0 };
	let releaseBlocker;
	const blocker = new Promise((resolve) => {
		releaseBlocker = resolve;
	});
	fakeMedia.impl = async (url, maxBytes, onStage) => {
		if (url.includes('BBBBBBBBBBB')) {
			// This link just sits on its download slot until the test lets it go.
			await blocker;
			const file = path.join(dir, 'blocker.mp4');
			fs.writeFileSync(file, Buffer.alloc(20000, 1));
			return mediaFrom({ files: [{ path: file, name: 'video.mp4' }], author: '', text: '', compressed: false });
		}
		return mediaFrom(await ladder(busyRun)(url, dir, maxBytes, onStage));
	};

	const holding = run('https://www.youtube.com/shorts/BBBBBBBBBBB');
	const tested = run('https://www.youtube.com/shorts/CCCCCCCCCCC');
	assert.equal(await tested.promise, false);
	assert.equal(busyRun.runs, 0, 'both slots were in use: no extra attempt');
	releaseBlocker();
	assert.equal(await holding.promise, true);

	const aloneRun = { runs: 0 };
	fakeMedia.impl = async (url, maxBytes, onStage) => mediaFrom(await ladder(aloneRun)(url, dir, maxBytes, onStage));
	assert.equal(await run('https://www.youtube.com/shorts/DDDDDDDDDDD').promise, true);
	assert.equal(aloneRun.runs, 1, 'a single link may use the extra attempt');
});
