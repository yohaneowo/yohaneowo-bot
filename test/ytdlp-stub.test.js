// The retry ladder against a fake yt-dlp, in a separate Node process (command-level environment:
// nothing about the running bot or Doppler is touched). Needs a Linux-style executable stub and
// ffmpeg/ffprobe, so it is skipped on Windows and where they are missing; it runs in the dev container.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const haveFfmpeg =
	spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const skip =
	process.platform === 'win32'
		? 'needs an executable script as YTDLP_PATH (run it on Linux / in the dev container)'
		: !haveFfmpeg && 'ffmpeg / ffprobe are not installed';

const DRIVER = path.join(__dirname, 'helpers', 'chain-driver.js');
const STUB_SOURCE = path.join(__dirname, 'helpers', 'fake-ytdlp.js');
const URL_A = 'https://www.youtube.com/shorts/HPawwstzIU0';

let tmp;
let stub;
let stateFile;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdlp-stub-test-'));
	stub = path.join(tmp, 'yt-dlp');
	fs.copyFileSync(STUB_SOURCE, stub);
	fs.chmodSync(stub, 0o755);
	stateFile = path.join(tmp, 'calls.jsonl');
});
afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

function runDriver(failures) {
	const env = { ...process.env, YTDLP_PATH: stub, STUB_STATE: stateFile, STUB_FAILURES: String(failures) };
	delete env.LINKHUB_API_URL;
	delete env.FFMPEG_PATH;
	const child = spawnSync(process.execPath, [DRIVER, URL_A], { env, encoding: 'utf8', timeout: 60_000 });
	const line = child.stdout.split('\n').find((text) => text.startsWith('DRIVER_RESULT '));
	assert.ok(line, `driver printed no result. stderr: ${child.stderr}`);
	const calls = fs.existsSync(stateFile)
		? fs.readFileSync(stateFile, 'utf8').split('\n').filter(Boolean).map((text) => JSON.parse(text))
		: [];
	return { result: JSON.parse(line.slice('DRIVER_RESULT '.length)), calls };
}

const after = (args, flag) => args[args.indexOf(flag) + 1];

test('a good first download needs one yt-dlp call and no retry', { skip }, () => {
	const { result, calls } = runDriver(0);
	assert.equal(result.ok, true);
	assert.equal(result.files[0].name, 'video.mp4');
	assert.ok(result.files[0].size > 10_000);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].args.includes('--extractor-args'), false);
	assert.equal(result.stages.includes('retrying'), false);
});

test('an empty first download is retried with the alternative settings in a clean directory', { skip }, () => {
	const { result, calls } = runDriver(1);
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.files[0].name, 'video.mp4');
	assert.ok(result.files[0].size > 10_000);
	assert.equal(calls.length, 2, 'exactly one retry');

	const [first, second] = calls;
	assert.equal(first.args.includes('--extractor-args'), false);
	assert.equal(after(first.args, '-S'), 'res,br');
	assert.equal(after(second.args, '--extractor-args'), 'youtube:player_client=mweb');
	assert.equal(after(second.args, '-S'), 'res:480,br');
	assert.equal(after(second.args, '-f').includes('+'), false, 'the retry asks for a single file, no merge');
	assert.notEqual(path.dirname(after(first.args, '-o')), path.dirname(after(second.args, '-o')));
	assert.deepEqual(second.filesAlreadyThere, [], 'the retry starts in an empty directory');
	assert.ok(result.stages.includes('retrying'));
});

test('a yt-dlp that hangs is killed when the rung time budget is spent', { skip }, () => {
	const env = {
		...process.env,
		YTDLP_PATH: stub,
		STUB_STATE: stateFile,
		STUB_HANG: '1',
		STUB_PID_FILE: path.join(tmp, 'stub.pid'),
	};
	delete env.FFMPEG_PATH;
	const child = spawnSync(process.execPath, [path.join(__dirname, 'helpers', 'cancel-driver.js'), URL_A], {
		env,
		encoding: 'utf8',
		timeout: 30_000,
	});
	const line = child.stdout.split('\n').find((text) => text.startsWith('DRIVER_RESULT '));
	assert.ok(line, `driver printed no result. stderr: ${child.stderr}`);
	const outcome = JSON.parse(line.slice('DRIVER_RESULT '.length));
	assert.equal(outcome.rejected, true);
	assert.match(outcome.message, /budget spent/);
	assert.ok(outcome.elapsed < 3000, `stopped by the budget after ${outcome.elapsed} ms, not by yt-dlp's own timeout`);
	assert.equal(outcome.childAlive, false, 'the yt-dlp process is gone');
});

test('when every download is empty it gives up after the planned attempts and reports empty_file', { skip }, () => {
	const { result, calls } = runDriver(99);
	assert.equal(result.ok, false);
	assert.equal(result.code, 'EMPTY_FILE');
	assert.deepEqual(result.tried, ['local', 'local-alt']);
	assert.match(result.detail, /^tried=local,local-alt; site_consecutive=1; /);
	assert.equal(calls.length, 2, 'no more than the two planned attempts');
});
