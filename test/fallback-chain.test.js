// The retry ladder of chain.js, with fake rungs (no network, no yt-dlp, no ffmpeg).
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
	createFallbackChain,
	createRepairState,
	normalizeUrlKey,
} = require('../services/sites/chain');
const { currentSignal } = require('../services/sites/deadline');
const { spawnSync } = require('node:child_process');
const { EmptyFileError, probeVideo } = require('../services/sites/video');
const { UserFacingError } = require('../services/sites/errors');

const URL_A = 'https://www.youtube.com/shorts/AAAAAAAAAAA';
const URL_B = 'https://www.youtube.com/shorts/BBBBBBBBBBB';
const URL_C = 'https://www.youtube.com/shorts/CCCCCCCCCCC';
const URL_D = 'https://www.youtube.com/shorts/DDDDDDDDDDD';
const MAX = 10 * 1000 * 1000;
const MINUTE = 60 * 1000;

let dir;
let now;
const clock = () => now;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-test-'));
	now = 1_000_000;
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

// A fake rung. behaviour(dir, callNumber) returns a result or throws.
function rung(name, behaviour, { repair = false, enabled = true } = {}) {
	const r = {
		name,
		repair,
		enabled: () => enabled,
		calls: 0,
		dirs: [],
		async run(url, rungDir) {
			r.calls += 1;
			r.dirs.push(rungDir);
			return behaviour(rungDir, r.calls);
		},
	};
	return r;
}

function fileResult(rungDir, name, bytes) {
	const filePath = path.join(rungDir, name);
	fs.writeFileSync(filePath, Buffer.alloc(bytes, 1));
	return { path: filePath, name };
}

const good = (rungDir) => ({
	files: [fileResult(rungDir, 'video.mp4', 20000)],
	author: '',
	text: '',
	compressed: false,
});
const zeroByteFile = (rungDir) => ({
	files: [fileResult(rungDir, 'video.mp4', 0)],
	author: '',
	text: '',
	compressed: false,
});
const throwEmpty = () => {
	throw new EmptyFileError('simulated empty download');
};

// The fake files are not real videos: ffprobe is replaced by a probe that reads them as 2 seconds long.
const readable = async () => ({ duration: 2, codec: 'h264' });

function chainOf(rungs, options = {}) {
	return createFallbackChain({
		site: 'YouTube',
		rungs,
		state: createRepairState(clock),
		now: clock,
		isBusy: () => false,
		probe: readable,
		...options,
	});
}

test('a rung that returns a 0-byte file is treated as empty and the next rung runs in a clean directory', async () => {
	const first = rung('linkhub', (d) => {
		fileResult(d, 'leftover.bin', 5);
		return zeroByteFile(d);
	});
	const second = rung('local', (d) => {
		assert.deepEqual(fs.readdirSync(d), [], 'the second rung must start with an empty directory');
		return good(d);
	});
	const repair = rung('local-alt', good, { repair: true });
	const result = await chainOf([first, second, repair])(URL_A, dir, MAX);

	assert.equal(result.files[0].name, 'video.mp4');
	assert.equal(fs.statSync(result.files[0].path).size, 20000);
	assert.notEqual(first.dirs[0], second.dirs[0]);
	assert.equal(fs.existsSync(first.dirs[0]), false, 'the failed rung directory is deleted');
	assert.equal(repair.calls, 0, 'the extra rung is not needed');
});

test('empty from every route up to the extra rung: the extra rung recovers and the user sees "retrying"', async () => {
	const stages = [];
	const first = rung('linkhub', throwEmpty);
	const second = rung('local', zeroByteFile);
	const repair = rung('local-alt', good, { repair: true });
	const result = await chainOf([first, second, repair])(URL_A, dir, MAX, (stage) => stages.push(stage));

	assert.equal(result.files.length, 1);
	assert.deepEqual([first.calls, second.calls, repair.calls], [1, 1, 1]);
	assert.deepEqual(stages, ['retrying']);
});

test('every route empty: one EmptyFileError, each rung tried exactly once, nothing left behind', async () => {
	const rungs = [
		rung('linkhub', throwEmpty),
		rung('local', zeroByteFile),
		rung('local-alt', throwEmpty, { repair: true }),
	];
	await assert.rejects(chainOf(rungs)(URL_A, dir, MAX), (error) => {
		assert.equal(error.code, 'EMPTY_FILE');
		assert.deepEqual(error.tried, ['linkhub', 'local', 'local-alt']);
		assert.match(error.detail, /tried=linkhub,local,local-alt; site_consecutive=1; /);
		return true;
	});
	assert.deepEqual(rungs.map((r) => r.calls), [1, 1, 1]);
	assert.deepEqual(fs.readdirSync(dir), [], 'no rung directory is left');
});

test('without an empty file the extra rung never runs, and a plain failure still falls back to the next base rung', async () => {
	const first = rung('linkhub', () => {
		throw new Error('LinkHub HTTP 502');
	});
	const second = rung('local', () => {
		throw new Error('yt-dlp exited with code 1');
	});
	const repair = rung('local-alt', good, { repair: true });
	await assert.rejects(chainOf([first, second, repair])(URL_A, dir, MAX), /yt-dlp exited with code 1/);
	assert.deepEqual([first.calls, second.calls, repair.calls], [1, 1, 0]);

	const third = rung('local', good);
	const result = await chainOf([rung('linkhub', () => {
		throw new Error('LinkHub down');
	}), third])(URL_B, dir, MAX);
	assert.equal(result.files.length, 1);
	assert.equal(third.calls, 1);
});

test('final errors are not retried: too long, and any other user-facing error', async () => {
	const tooLong = Object.assign(new UserFacingError('too long'), { code: 'VIDEO_TOO_LONG' });
	const first = rung('linkhub', () => {
		throw tooLong;
	});
	const second = rung('local', good);
	await assert.rejects(chainOf([first, second])(URL_A, dir, MAX), (error) => error === tooLong);
	assert.equal(second.calls, 0);

	const loginWall = new UserFacingError('needs login');
	const third = rung('local', () => {
		throw loginWall;
	});
	const repair = rung('local-alt', good, { repair: true });
	await assert.rejects(chainOf([third, repair])(URL_B, dir, MAX), (error) => error === loginWall);
	assert.equal(repair.calls, 0);

	// An empty file followed by a final error: the final error wins.
	const empty = rung('linkhub', throwEmpty);
	const long = rung('local', () => {
		throw tooLong;
	});
	const repair2 = rung('local-alt', good, { repair: true });
	await assert.rejects(chainOf([empty, long, repair2])(URL_C, dir, MAX), (error) => error === tooLong);
	assert.equal(repair2.calls, 0);
});

test('a result with several files is rejected when any of them is empty (multi-item post)', async () => {
	const first = rung('linkhub', (d) => ({
		files: [fileResult(d, 'image-1.jpg', 3000), fileResult(d, 'video-2.mp4', 0)],
		author: '',
		text: '',
	}));
	const second = rung('local', (d) => ({
		files: [fileResult(d, 'image-1.jpg', 3000), fileResult(d, 'video-2.mp4', 30000)],
		author: '',
		text: '',
	}));
	const result = await chainOf([first, second])(URL_A, dir, MAX);
	assert.deepEqual(result.files.map((f) => f.name), ['image-1.jpg', 'video-2.mp4']);
	assert.equal(second.calls, 1);
});

test('LINE calls the chain without onStage: the extra rung still works', async () => {
	const first = rung('local', throwEmpty);
	const repair = rung('local-alt', good, { repair: true });
	const result = await chainOf([first, repair])(URL_A, dir, MAX, undefined);
	assert.equal(result.files.length, 1);
	assert.equal(repair.calls, 1);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A rung that never finishes and only ends when the link's time budget cancels it.
function hangingRung(name, onAbort = () => undefined) {
	return rung(name, () => new Promise((resolve, reject) => {
		const signal = currentSignal();
		assert.ok(signal, 'the rung runs with a budget signal');
		signal.addEventListener('abort', () => {
			onAbort();
			reject(signal.reason);
		});
	}));
}

test('a rung that outlives the total time budget is cancelled, and nothing new starts afterwards', async () => {
	let sawAbort = false;
	const hang = hangingRung('hang', () => {
		sawAbort = true;
	});
	const next = rung('local', good);
	const started = Date.now();
	const chain = chainOf([hang, next], { now: Date.now, totalMs: 40 });
	await assert.rejects(chain(URL_A, dir, MAX), (error) => error.code === 'MEDIA_TIMEOUT');

	assert.equal(sawAbort, true);
	assert.ok(Date.now() - started < 2000, 'cancelled by the budget, not by waiting for the rung');
	assert.equal(next.calls, 0, 'the budget is spent: no further rung, not even a base one');
});

test('when only a hung rung is left, the failure is a timeout, not an empty-file error', async () => {
	const chain = chainOf([hangingRung('hang')], { now: Date.now, totalMs: 30 });
	await assert.rejects(chain(URL_A, dir, MAX), (error) => error.code === 'MEDIA_TIMEOUT');
});

test('the first rung always starts; a later rung is not started when too little of the budget is left', async () => {
	const slow = rung('linkhub', async () => {
		await sleep(60);
		throw new Error('LinkHub failed late');
	});
	const next = rung('local', good);
	const chain = chainOf([slow, next], { now: Date.now, totalMs: 20, minRemainingMs: 1000 });
	// The rung ignores the cancellation for 60 ms, but the budget ran out meanwhile: a timeout.
	await assert.rejects(chain(URL_A, dir, MAX), (error) => error.code === 'MEDIA_TIMEOUT');
	assert.equal(slow.calls, 1, 'the first rung ran although the budget was tiny');
	assert.equal(next.calls, 0, 'the budget was spent: no new rung, and no extra 60 seconds for it');
});

test('the extra rung only follows an empty file, not a plain failure that comes after one', async () => {
	const empty = rung('linkhub', throwEmpty);
	const plain = rung('local', () => {
		throw new Error('yt-dlp exited with code 1');
	});
	const repair = rung('local-alt', good, { repair: true });
	await assert.rejects(chainOf([empty, plain, repair])(URL_A, dir, MAX), (error) => {
		assert.equal(error.code, undefined, 'reported as the plain failure it is');
		assert.match(error.message, /yt-dlp exited with code 1/);
		return true;
	});
	assert.equal(repair.calls, 0);
});

test('a timeout after an empty file is reported as a timeout and is not held against the site or the link', async () => {
	const state = createRepairState(Date.now);
	const empty = rung('linkhub', throwEmpty);
	const chain = chainOf([empty, hangingRung('local')], {
		state,
		now: Date.now,
		totalMs: 60,
		minRemainingMs: 0,
	});
	await assert.rejects(chain(URL_A, dir, MAX), (error) => error.code === 'MEDIA_TIMEOUT');
	assert.equal(state.consecutiveFailures('YouTube'), 0);
	assert.equal(state.isCoolingDown(normalizeUrlKey(URL_A)), false);
});

test('the extra rung is skipped when too little of the time budget is left, and that is not recorded as a failure', async () => {
	const state = createRepairState(clock);
	const first = rung('local', throwEmpty);
	const repair = rung('local-alt', good, { repair: true });
	const chain = chainOf([first, repair], { state, totalMs: 100, minRemainingMs: 1000 });

	await assert.rejects(chain(URL_A, dir, MAX), (error) => {
		assert.equal(error.code, 'EMPTY_FILE');
		assert.match(error.detail, /retry skipped/);
		return true;
	});
	assert.equal(repair.calls, 0);
	assert.equal(state.consecutiveFailures('YouTube'), 0);
	await assert.rejects(chain(URL_A, dir, MAX), (error) => error.code === 'EMPTY_FILE');
	assert.equal(first.calls, 2, 'no cooldown: the same link may be tried again right away');
});

test('every video in a result must have a readable length; images are not probed; no ffprobe means no judgement', async () => {
	const probed = [];
	const probe = async (file) => {
		probed.push(path.basename(file));
		return file.includes('rung-1') ? null : { duration: 3, codec: 'h264' };
	};
	const first = rung('linkhub', (d) => ({
		files: [fileResult(d, 'image-1.jpg', 3000), fileResult(d, 'video-2.mp4', 30000)],
		author: '',
		text: '',
	}));
	const second = rung('local', (d) => ({
		files: [fileResult(d, 'image-1.jpg', 3000), fileResult(d, 'video-2.mp4', 30000)],
		author: '',
		text: '',
	}));
	const result = await chainOf([first, second], { probe })(URL_A, dir, MAX);
	assert.equal(result.files.length, 2);
	assert.equal(first.calls + second.calls, 2, 'the unreadable video made the first rung fail');
	assert.deepEqual(probed, ['video-2.mp4', 'video-2.mp4'], 'only the videos are probed');

	const third = rung('local', good);
	const unavailable = await chainOf([third], { probe: async () => ({ unavailable: true }) })(URL_B, dir, MAX);
	assert.equal(unavailable.files.length, 1, 'without ffprobe the file is accepted');
});

test('the extra rung is skipped while the other download slot is busy, and runs when it is free', async () => {
	let busy = true;
	const base = rung('local', throwEmpty);
	const repair = rung('local-alt', good, { repair: true });
	const chain = chainOf([base, repair], { isBusy: () => busy });

	await assert.rejects(chain(URL_A, dir, MAX), (error) => error.code === 'EMPTY_FILE');
	assert.equal(repair.calls, 0);

	busy = false;
	const result = await chain(URL_B, dir, MAX);
	assert.equal(result.files.length, 1);
	assert.equal(repair.calls, 1);
});

test('a retry skipped because the other slot is busy is not recorded: no cooldown, no failure count', async () => {
	const state = createRepairState(clock);
	const base = rung('local', throwEmpty);
	const repair = rung('local-alt', good, { repair: true });
	const chain = chainOf([base, repair], { state, isBusy: () => true });

	await assert.rejects(chain(URL_A, dir, MAX), (error) => /retry skipped/.test(error.detail));
	await assert.rejects(chain(URL_A, dir, MAX), (error) => /retry skipped/.test(error.detail));
	assert.equal(base.calls, 2, 'the same link was tried again at once: nothing locked it out');
	assert.equal(repair.calls, 0);
	assert.equal(state.consecutiveFailures('YouTube'), 0);
	assert.equal(state.isBreakerOpen('YouTube'), false);
});

test('while the breaker is open a skipped retry does not extend it or start a link cooldown', async () => {
	const state = createRepairState(clock);
	const base = rung('local', throwEmpty);
	const repair = rung('local-alt', throwEmpty, { repair: true });
	const chain = chainOf([base, repair], { state });

	await assert.rejects(chain(URL_A, dir, MAX));
	await assert.rejects(chain(URL_B, dir, MAX));
	assert.equal(state.isBreakerOpen('YouTube'), true);
	assert.equal(state.consecutiveFailures('YouTube'), 2);

	await assert.rejects(chain(URL_C, dir, MAX), (error) => /retry skipped/.test(error.detail));
	assert.equal(state.consecutiveFailures('YouTube'), 2, 'the skipped attempt was not counted');
	assert.equal(state.isCoolingDown(normalizeUrlKey(URL_C)), false);
	assert.equal(state.isCoolingDown(normalizeUrlKey(URL_A)), true, 'the fully failed links stay on cooldown');
});

test('two complete failures pause the extra rung for the site; it resumes after the window or a success', async () => {
	const base = rung('local', throwEmpty);
	const repair = rung('local-alt', throwEmpty, { repair: true });
	const chain = chainOf([base, repair]);

	await assert.rejects(chain(URL_A, dir, MAX), (e) => e.code === 'EMPTY_FILE');
	await assert.rejects(chain(URL_B, dir, MAX), (e) => e.code === 'EMPTY_FILE');
	assert.deepEqual([base.calls, repair.calls], [2, 2], 'first two failures use the whole ladder');

	await assert.rejects(chain(URL_C, dir, MAX), (e) => e.code === 'EMPTY_FILE');
	assert.deepEqual([base.calls, repair.calls], [3, 2], 'the breaker is open: no extra attempt');

	now += 11 * MINUTE;
	await assert.rejects(chain(URL_D, dir, MAX), (e) => e.code === 'EMPTY_FILE');
	assert.deepEqual([base.calls, repair.calls], [4, 3], 'ten minutes later the extra rung is back');
});

test('a success resets the site breaker and the consecutive count', async () => {
	let mode = 'empty';
	const base = rung('local', (d) => (mode === 'ok' ? good(d) : throwEmpty()));
	const repair = rung('local-alt', throwEmpty, { repair: true });
	const state = createRepairState(clock);
	const chain = chainOf([base, repair], { state });

	await assert.rejects(chain(URL_A, dir, MAX));
	await assert.rejects(chain(URL_B, dir, MAX));
	assert.equal(state.isBreakerOpen('YouTube'), true);
	assert.equal(state.consecutiveFailures('YouTube'), 2);

	mode = 'ok';
	await chain(URL_C, dir, MAX);
	assert.equal(state.isBreakerOpen('YouTube'), false);
	assert.equal(state.consecutiveFailures('YouTube'), 0);

	mode = 'empty';
	await assert.rejects(chain(URL_D, dir, MAX));
	assert.equal(repair.calls, 3, 'the extra rung runs again right after a success');
});

test('a link that failed completely is not retried for 5 minutes; a success clears it', async () => {
	let mode = 'empty';
	const base = rung('local', (d) => (mode === 'ok' ? good(d) : throwEmpty()));
	const chain = chainOf([base]);

	await assert.rejects(chain(URL_A, dir, MAX), (e) => e.code === 'EMPTY_FILE');
	assert.equal(base.calls, 1);

	await assert.rejects(chain(URL_A, dir, MAX), (error) => {
		assert.equal(error.code, 'EMPTY_FILE');
		assert.match(error.userMessage, /刚刚下载失败/);
		assert.match(error.detail, /^cooldown/);
		return true;
	});
	assert.equal(base.calls, 1, 'nothing ran during the cooldown');

	now += 5 * MINUTE + 1000;
	mode = 'ok';
	await chain(URL_A, dir, MAX);
	assert.equal(base.calls, 2);
	mode = 'empty';
	await assert.rejects(chain(URL_A, dir, MAX), (error) => error.code === 'EMPTY_FILE');
	assert.equal(base.calls, 3, 'the success cleared the cooldown');
});

test('the cooldown table drops expired entries and never grows past 200', () => {
	const state = createRepairState(clock);
	for (let i = 0; i < 250; i++) state.recordFailure('X', `link-${i}`);
	assert.equal(state.size(), 200);
	assert.equal(state.isCoolingDown('link-0'), false, 'the oldest entries were dropped');
	assert.equal(state.isCoolingDown('link-249'), true);
	now += 6 * MINUTE;
	assert.equal(state.isCoolingDown('link-249'), false);
	assert.equal(state.size(), 0, 'expired entries are cleaned on access');
});

test('normalizeUrlKey: the same content maps to one key, different content does not', () => {
	assert.equal(
		normalizeUrlKey('https://www.youtube.com/shorts/HPawwstzIU0?feature=share'),
		normalizeUrlKey('https://youtube.com/shorts/HPawwstzIU0'),
	);
	assert.equal(
		normalizeUrlKey('https://www.bilibili.com/video/BV17YdXY4Ewj?p=2&spm_id_from=333'),
		'bilibili.com/video/BV17YdXY4Ewj?p=2',
	);
	assert.notEqual(
		normalizeUrlKey('https://www.bilibili.com/video/BV17YdXY4Ewj?p=1'),
		normalizeUrlKey('https://www.bilibili.com/video/BV17YdXY4Ewj?p=2'),
	);
	assert.equal(
		normalizeUrlKey('https://x.com/GIPHY/status/1957913446118285360/?s=20'),
		normalizeUrlKey('https://X.com/GIPHY/status/1957913446118285360'),
	);
	assert.notEqual(
		normalizeUrlKey('https://www.facebook.com/watch/?v=111'),
		normalizeUrlKey('https://www.facebook.com/watch/?v=222'),
	);
	assert.equal(normalizeUrlKey('not a url'), 'not a url');
});

test('a file check that hangs is cancelled by the budget: a timeout, no success, no cooldown', async () => {
	const state = createRepairState(Date.now);
	let sawSignal = false;
	const stuckProbe = () => new Promise((resolve, reject) => {
		const signal = currentSignal();
		sawSignal = Boolean(signal);
		signal.addEventListener('abort', () => reject(signal.reason));
	});
	const chain = chainOf([rung('local', good)], { state, now: Date.now, totalMs: 50, probe: stuckProbe });
	await assert.rejects(chain(URL_A, dir, MAX), (error) => error.code === 'MEDIA_TIMEOUT');
	assert.equal(sawSignal, true, 'the file check runs under the budget signal');
	assert.equal(state.consecutiveFailures('YouTube'), 0);
	assert.equal(state.isCoolingDown(normalizeUrlKey(URL_A)), false);
});

test('a rung that only finishes after the budget was spent is not counted as a success', async () => {
	const state = createRepairState(Date.now);
	// Ignores the cancellation and its answer is fine, but it comes too late.
	const slowProbe = async () => {
		await sleep(80);
		return { duration: 2, codec: 'h264' };
	};
	const chain = chainOf([rung('local', good)], { state, now: Date.now, totalMs: 30, probe: slowProbe });
	await assert.rejects(chain(URL_A, dir, MAX), (error) => error.code === 'MEDIA_TIMEOUT');
	assert.equal(state.consecutiveFailures('YouTube'), 0);
	assert.equal(state.isCoolingDown(normalizeUrlKey(URL_A)), false);
});

test('an mp4 that has a length but no video stream (audio only) fails the file check', async () => {
	const probe = async (file) => (file.includes('rung-1') ? { duration: 3 } : { duration: 3, codec: 'h264' });
	const first = rung('linkhub', (d) => ({ files: [fileResult(d, 'video.mp4', 30000)], author: '', text: '' }));
	const second = rung('local', good);
	const result = await chainOf([first, second], { probe })(URL_A, dir, MAX);
	assert.equal(result.files.length, 1);
	assert.equal(second.calls, 1, 'the audio-only file made the first rung fail');
});

const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

test('with the real ffprobe: an audio-only mp4 is rejected and a real video passes', { skip: !haveFfmpeg && 'ffmpeg / ffprobe are not installed' }, async () => {
	function make(name, args) {
		const file = path.join(dir, name);
		const made = spawnSync('ffmpeg', ['-loglevel', 'error', ...args, '-y', file], { encoding: 'utf8' });
		assert.equal(made.status, 0, made.stderr);
		return file;
	}
	const audioOnly = make('audio-only.mp4', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'aac']);
	const realVideo = make('real.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15', '-t', '2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264']);
	const returning = (source) => (d) => {
		const target = path.join(d, 'video.mp4');
		fs.copyFileSync(source, target);
		return { files: [{ path: target, name: 'video.mp4' }], author: '', text: '' };
	};
	const first = rung('local', returning(audioOnly));
	const second = rung('local-2', returning(realVideo));
	const result = await chainOf([first, second], { probe: probeVideo })(URL_A, dir, MAX);
	assert.equal(result.files.length, 1);
	assert.equal(second.calls, 1, 'the audio-only file was rejected, the real video accepted');
});

test('a repair rung that is disabled or not configured is silently skipped', async () => {
	const linkhub = rung('linkhub', throwEmpty, { enabled: false });
	const local = rung('local', good);
	const result = await chainOf([linkhub, local])(URL_A, dir, MAX);
	assert.equal(result.files.length, 1);
	assert.equal(linkhub.calls, 0);
});
