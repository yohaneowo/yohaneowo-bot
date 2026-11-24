// Empty / truncated video guard (fitVideoToLimit). Runs with `npm test`, no ffmpeg needed: ffprobe
// is replaced by a fake probe.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fitVideoToLimit, EmptyFileError, MIN_VIDEO_BYTES } = require('../services/sites/video');
const { UserFacingError } = require('../services/sites/errors');

const LIMIT = 10 * 1000 * 1000;
let dir;

// Fake ffprobe: reports a duration only for files that start with "GOODVIDEO".
async function fakeProbe(filePath) {
	const good = fs.readFileSync(filePath).subarray(0, 9).toString() === 'GOODVIDEO';
	return good ? { width: 640, height: 360, codec: 'h264', duration: 12.5 } : null;
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-file-test-'));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function writeFile(name, bytes, head = 'GOODVIDEO') {
	const file = path.join(dir, name);
	fs.writeFileSync(file, Buffer.concat([Buffer.from(head), Buffer.alloc(Math.max(0, bytes - head.length))]));
	return file;
}

test('0-byte file is rejected as empty_file with a user message', async () => {
	const file = path.join(dir, 'video.mp4');
	fs.writeFileSync(file, '');
	await assert.rejects(
		() => fitVideoToLimit(file, dir, LIMIT, undefined, undefined, { probeFn: fakeProbe }),
		(error) => {
			assert.ok(error instanceof EmptyFileError);
			assert.ok(error instanceof UserFacingError);
			assert.equal(error.code, 'EMPTY_FILE');
			assert.ok(error.userMessage);
			return true;
		},
	);
});

test('one byte under the minimum is rejected', async () => {
	const file = writeFile('video.mp4', MIN_VIDEO_BYTES - 1);
	await assert.rejects(
		() => fitVideoToLimit(file, dir, LIMIT, undefined, undefined, { probeFn: fakeProbe }),
		{ code: 'EMPTY_FILE' },
	);
});

test('exactly the minimum size passes', async () => {
	const file = writeFile('video.mp4', MIN_VIDEO_BYTES);
	const result = await fitVideoToLimit(file, dir, LIMIT, undefined, undefined, { probeFn: fakeProbe });
	assert.deepEqual(result, { filePath: file, compressed: false });
});

test('a normal file passes', async () => {
	const file = writeFile('video.mp4', 500 * 1000);
	const result = await fitVideoToLimit(file, dir, LIMIT, undefined, undefined, { probeFn: fakeProbe });
	assert.deepEqual(result, { filePath: file, compressed: false });
});

test('Discord rejects a 240p YouTube source even when it fits, and LINE keeps its previous behavior', async () => {
	const file = writeFile('video.mp4', 500 * 1000);
	const probeFn = async () => ({ width: 240, height: 426, codec: 'h264', duration: 12.5 });
	await assert.rejects(
		fitVideoToLimit(file, dir, LIMIT, undefined, undefined, { probeFn, youtube: true }),
		{ code: 'VIDEO_TOO_BLURRY' },
	);
	const result = await fitVideoToLimit(file, dir, LIMIT, undefined, undefined, {
		probeFn,
		youtube: true,
		allowLowQualityYouTube: true,
	});
	assert.deepEqual(result, { filePath: file, compressed: false });
});

test('Discord keeps a 360p YouTube video that fits at its original quality', async () => {
	const file = writeFile('video.mp4', 500 * 1000);
	const result = await fitVideoToLimit(file, dir, LIMIT, undefined, undefined, { probeFn: fakeProbe, youtube: true });
	assert.deepEqual(result, { filePath: file, compressed: false });
});

test('Discord declines oversized YouTube videos that would need a bitrate below the shared floor', async () => {
	const file = writeFile('video.mp4', MIN_VIDEO_BYTES);
	fs.truncateSync(file, 28_400_000);
	await assert.rejects(
		fitVideoToLimit(file, dir, 20_552_089, undefined, 712, { probeFn: fakeProbe, youtube: true }),
		{ code: 'VIDEO_TOO_LONG' },
	);
	assert.equal(fs.existsSync(path.join(dir, 'compressed.mp4')), false);
});

test('a big file ffprobe cannot read is rejected even if the site reported a duration', async () => {
	const file = writeFile('video.mp4', 500 * 1000, 'GARBAGE');
	await assert.rejects(
		() => fitVideoToLimit(file, dir, LIMIT, undefined, 30, { probeFn: fakeProbe }),
		{ code: 'EMPTY_FILE' },
	);
});

test('a missing ffprobe binary does not reject a normal-size file', async () => {
	const file = writeFile('video.mp4', 500 * 1000);
	const result = await fitVideoToLimit(file, dir, LIMIT, undefined, 30, { probeFn: async () => ({ unavailable: true }) });
	assert.equal(result.filePath, file);
});
