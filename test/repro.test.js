// scripts/repro.js: the download-only reproduction tool. Everything runs against fake version trees and fake
// fetches: no network, no yt-dlp, no Discord. The git and GitHub-archive paths need `git` / `tar` and are
// skipped without them.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync, spawnSync } = require('node:child_process');
const repro = require('../scripts/repro.js');

const {
	main, parseArgs, validateUrl, extractContentId, buildChildEnv, collectRedactions, readBotEnviron, redact, sweepStale,
	analyzeLog, buildReport, runChild, assertSafeTarEntries, findArchiveTop, readArchiveSha, emergencyCleanup, ScriptError, EXIT,
} = repro;

const haveGit = spawnSync('git', ['--version']).status === 0;
const haveTar = spawnSync('tar', ['--version']).status === 0;
const KEY = 'secret-key-1234567890';
const LINKHUB_URL = 'http://linkhub.internal:8080';
const URL_A = 'https://www.youtube.com/shorts/HPawwstzIU0';
const FULL_SHA = 'a'.repeat(40);

let root;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-test-'));
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function capture() {
	const chunks = [];
	return {
		stdout: { write: (text) => chunks.push(text) },
		text: () => chunks.join(''),
		json: () => JSON.parse(chunks.join('')),
	};
}

function throwsUsage(argv, pattern) {
	assert.throws(() => parseArgs(argv), (error) => {
		assert.ok(error instanceof ScriptError, String(error));
		assert.equal(error.exitCode, EXIT.USAGE);
		assert.match(error.message, pattern);
		return true;
	});
}

// ---------------------------------------------------------------- arguments and links

test('parseArgs: the accepted forms', () => {
	const a = parseArgs([URL_A, '--ref', '5adaaef', '--pretty']);
	assert.equal(a.url, URL_A);
	assert.equal(a.ref, '5adaaef');
	assert.equal(a.maxBytes, 9_800_000);
	assert.equal(a.timeoutSeconds, 300);
	assert.equal(a.pretty, true);
	const b = parseArgs(['--ref=current', URL_A, '--max-bytes=5000000', '--timeout=30', '--min-free-mb', '0', '--source=github', '--keep']);
	assert.deepEqual([b.ref, b.maxBytes, b.timeoutSeconds, b.minFreeMb, b.source, b.keep], ['current', 5_000_000, 30, 0, 'github', true]);
	assert.equal(parseArgs(['--help']).help, true);
	assert.equal(parseArgs([URL_A, '--ref', FULL_SHA.toUpperCase()]).ref, FULL_SHA.toUpperCase());
});

test('parseArgs: refuses anything that is not exactly one link, a SHA or "current", and sane numbers', () => {
	throwsUsage([], /exactly one link/);
	throwsUsage([URL_A, URL_A, '--ref', 'current'], /exactly one link/);
	throwsUsage([URL_A], /--ref/);
	throwsUsage([URL_A, '--ref', 'main'], /SHA/);
	throwsUsage([URL_A, '--ref', 'abc12'], /SHA/);
	throwsUsage([URL_A, '--ref', '5adaaef; rm -rf /'], /SHA/);
	throwsUsage([URL_A, '--ref'], /needs a value/);
	throwsUsage([URL_A, '--ref', '--pretty'], /needs a value/);
	throwsUsage([URL_A, '--ref', 'current', '--max-bytes', 'abc'], /max-bytes/);
	throwsUsage([URL_A, '--ref', 'current', '--timeout', '1'], /timeout/);
	throwsUsage([URL_A, '--ref', 'current', '--timeout', '100000'], /timeout/);
	throwsUsage([URL_A, '--ref', 'current', '--shell'], /unknown option/);
	throwsUsage([URL_A, '--ref', 'current', '--source', 'ftp'], /--source/);
});

test('validateUrl: one plain http(s) link only', () => {
	validateUrl(URL_A);
	for (const bad of ['not a url', 'ftp://example.com/x', 'file:///etc/passwd', 'https://a.com/x y', `https://a.com/${'x'.repeat(2100)}`]) {
		assert.throws(() => validateUrl(bad), (error) => error instanceof ScriptError && error.exitCode === EXIT.USAGE, bad.slice(0, 40));
	}
});

test('extractContentId: the id that is in the link, nothing for share links', () => {
	const cases = [
		['https://www.youtube.com/shorts/HPawwstzIU0', 'HPawwstzIU0'],
		['https://youtu.be/jNQXAC9IVRw', 'jNQXAC9IVRw'],
		['https://www.bilibili.com/video/BV17YdXY4Ewj?p=2', 'BV17YdXY4Ewj'],
		['https://www.tiktok.com/@scout2015/video/6718335390845095173', '6718335390845095173'],
		['https://x.com/GIPHY/status/1957913446118285360', '1957913446118285360'],
		['https://www.facebook.com/reel/858979257261500', '858979257261500'],
		['https://www.facebook.com/facebook/videos/10153231379946729/', '10153231379946729'],
		['https://www.instagram.com/p/fA9uwTtkSN/', 'fA9uwTtkSN'],
		['https://www.threads.net/@zuck/post/C27tpcvx77t', 'C27tpcvx77t'],
		['https://www.xiaohongshu.com/explore/65a1b2c3d4e5f60718293a4b', '65a1b2c3d4e5f60718293a4b'],
		['https://b23.tv/AbCdEf', null],
		['https://www.facebook.com/share/r/1AbCdEfGh/', null],
		['https://vm.tiktok.com/ZMabc123/', null],
	];
	for (const [url, id] of cases) {
		const found = extractContentId(url);
		assert.equal(found.id, id, url);
		assert.equal(found.source, id ? 'link' : 'unresolved', url);
	}
});

// ---------------------------------------------------------------- the environment the version runs with

test('buildChildEnv: tools and the two LinkHub settings only; the bot token and every other setting stay behind', () => {
	const env = {
		PATH: '/usr/bin',
		HOME: '/home/node',
		YTDLP_PATH: '/usr/local/bin/yt-dlp',
		XHS_API_URL: 'http://xhs:5556',
		TOKEN: 'discord-bot-token',
		DOPPLER_TOKEN: 'dp.st.xxx',
		ADMIN_API_URL: 'http://admin',
		ADMIN_API_TOKEN: 'admin-token',
		MAGNET_WEBHOOK_SECRET: 'magnet-secret',
		LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
		ANTHROPIC_API_KEY: 'sk-ant-xxx',
	};
	const childEnv = buildChildEnv(env, '/staging/tmp', { LINKHUB_API_URL: LINKHUB_URL, LINKHUB_API_KEY: KEY, TOKEN: 'should-never-pass' });
	assert.deepEqual(Object.keys(childEnv).sort(), [
		'HOME', 'LINKHUB_API_KEY', 'LINKHUB_API_URL', 'PATH', 'TEMP', 'TMP', 'TMPDIR', 'XHS_API_URL', 'YTDLP_PATH',
	]);
	assert.equal(childEnv.LINKHUB_API_KEY, KEY);
	assert.equal(childEnv.TMPDIR, '/staging/tmp');
	assert.equal(JSON.stringify(childEnv).includes('discord-bot-token'), false);
	assert.equal(JSON.stringify(childEnv).includes('should-never-pass'), false);
});

test('buildChildEnv: the bot process wins over the caller\'s environment; the caller\'s is the fallback', () => {
	const fromBot = buildChildEnv({ LINKHUB_API_URL: 'http://stale', LINKHUB_API_KEY: 'stale-key' }, '/t', { LINKHUB_API_URL: LINKHUB_URL, LINKHUB_API_KEY: KEY });
	assert.deepEqual([fromBot.LINKHUB_API_URL, fromBot.LINKHUB_API_KEY], [LINKHUB_URL, KEY]);
	const fallback = buildChildEnv({ LINKHUB_API_URL: 'http://local', LINKHUB_API_KEY: 'local-key' }, '/t', {});
	assert.deepEqual([fallback.LINKHUB_API_URL, fallback.LINKHUB_API_KEY], ['http://local', 'local-key']);
	assert.equal('LINKHUB_API_KEY' in buildChildEnv({}, '/t', {}), false);
});

// A /proc look-alike: PID 1 is docker-init (it holds DOPPLER_TOKEN), the bot process holds the LinkHub settings.
function makeFakeProc(repoRoot, { botCwd = repoRoot } = {}) {
	const proc = path.join(root, 'proc');
	const put = (pid, cmdline, environ) => {
		fs.mkdirSync(path.join(proc, pid), { recursive: true });
		fs.writeFileSync(path.join(proc, pid, 'cmdline'), cmdline.join('\0'));
		fs.writeFileSync(path.join(proc, pid, 'environ'), `${environ.join('\0')}\0`);
	};
	put('1', ['/sbin/docker-init', '--', '/bin/sh'], ['DOPPLER_TOKEN=dp.st.pid1', 'XHS_API_URL=http://xhs:5556', 'PATH=/usr/bin']);
	put('7', ['doppler', 'run', '--', 'node', 'index.js'], ['DOPPLER_TOKEN=dp.st.pid7', `LINKHUB_API_KEY=${KEY}`]);
	put('17', ['node', 'index.js'], ['TOKEN=discord-bot-token', `LINKHUB_API_URL=${LINKHUB_URL}`, `LINKHUB_API_KEY=${KEY}`, 'DOPPLER_TOKEN=dp.st.pid17']);
	put('18', ['node', 'index.js'], ['LINKHUB_API_URL=http://other-bot', 'LINKHUB_API_KEY=other-key']);
	fs.symlinkSync(botCwd, path.join(proc, '17', 'cwd'), 'junction');
	const elsewhere = path.join(root, 'elsewhere');
	fs.mkdirSync(elsewhere);
	fs.symlinkSync(elsewhere, path.join(proc, '18', 'cwd'), 'junction');
	return proc;
}

test('readBotEnviron: only the two LinkHub names, only from PID 1 or the bot started in this repo; never the tokens', () => {
	const repoRoot = path.join(root, 'app');
	fs.mkdirSync(repoRoot);
	const found = readBotEnviron(repoRoot, makeFakeProc(repoRoot));
	assert.deepEqual(found, { LINKHUB_API_KEY: KEY, LINKHUB_API_URL: LINKHUB_URL });
	const dump = JSON.stringify(found);
	for (const forbidden of ['dp.st', 'discord-bot-token', 'other-bot', 'other-key', 'XHS_API_URL']) {
		assert.equal(dump.includes(forbidden), false, forbidden);
	}
});

test('readBotEnviron: a node index.js started somewhere else is not the bot; no /proc gives nothing', () => {
	const repoRoot = path.join(root, 'app');
	const elsewhere = path.join(root, 'other-dir');
	fs.mkdirSync(repoRoot);
	fs.mkdirSync(elsewhere);
	assert.deepEqual(readBotEnviron(repoRoot, makeFakeProc(repoRoot, { botCwd: elsewhere })), {});
	assert.deepEqual(readBotEnviron(repoRoot, path.join(root, 'no-such-proc')), {});
});

test('redact: the value is replaced in plain and JSON-escaped form; empty values change nothing', () => {
	const tricky = 'k"ey\\1234';
	assert.equal(redact(`a ${KEY} b`, [KEY]), 'a [redacted] b');
	assert.equal(redact(JSON.stringify({ m: tricky }), [tricky]), '{"m":"[redacted]"}');
	assert.equal(redact('unchanged text', ['', undefined]), 'unchanged text');
});

// ---------------------------------------------------------------- reading the bot's log

test('analyzeLog: LinkHub gave an empty file, yt-dlp recovered it (the real 2026-11-17 run)', () => {
	const lines = [
		'[YouTube#7882 +0.0s] start https://www.youtube.com/shorts/HPawwstzIU0 (upload limit 9.8 MB)',
		'[YouTube#7882 +0.6s] LinkHub: youtube via cobalt, 1 item(s)',
		'[YouTube#7882 +1.0s] downloaded 0 KB via LinkHub (HTTP 200, content-length 0, 0 bytes)',
		'[YouTube#7882 +1.1s] linkhub failed after 1.1s: 下载到的影片是空的或已损坏，请稍后再试',
		'[YouTube#7882 +1.1s] running yt-dlp',
		'[YouTube#7882 +7.4s] video 360x640 h264, 121s, 9.0 MB',
		'[YouTube#7882 +7.5s] recovered by local after linkhub came back empty',
	];
	const { downloads, layer } = analyzeLog(lines);
	assert.deepEqual(downloads, { linkhub: 1, ytdlp: 1, direct: 0, total: 2, linkhub_parses: 1, via_linkhub: true });
	assert.equal(layer, 'local');
});

test('analyzeLog: other shapes (LinkHub only, GIF, local only, an older version without the chain)', () => {
	assert.deepEqual(analyzeLog(['LinkHub: twitter via legacy, 1 item(s)', 'downloaded 2.5 MB via LinkHub (HTTP 200, content-length 2509153, 2509153 bytes)']),
		{ downloads: { linkhub: 1, ytdlp: 0, direct: 0, total: 1, linkhub_parses: 1, via_linkhub: true }, layer: 'linkhub' });
	assert.equal(analyzeLog(['LinkHub: twitter via legacy, 1 item(s)', 'downloaded GIF 437 KB via LinkHub']).downloads.linkhub, 1);
	const local = analyzeLog(['running yt-dlp', 'yt-dlp downloaded format 18', 'video 360x640 h264, 121s, 9.0 MB']);
	assert.deepEqual([local.downloads.total, local.downloads.via_linkhub, local.layer], [1, false, 'local']);
	const alt = analyzeLog(['running yt-dlp', 'running yt-dlp (alternative strategy)']);
	assert.equal(alt.downloads.ytdlp, 2);
	const direct = analyzeLog(['downloaded 155 KB from scontent.cdninstagram.com']);
	assert.deepEqual([direct.downloads.direct, direct.layer], [1, 'local']);
	const old = analyzeLog(['LinkHub failed: LinkHub UPSTREAM_ERROR; falling back to the local parser', 'running yt-dlp']);
	assert.equal(old.layer, 'local');
	assert.equal(analyzeLog([]).layer, null);
});

// ---------------------------------------------------------------- the report

function reportFor(reported, { lines = [], timedOut = false, exitCode = 0 } = {}) {
	return buildReport({
		options: { url: URL_A, ref: '5adaaef', maxBytes: 9_800_000, timeoutSeconds: 300 },
		siteName: 'YouTube',
		version: { sha: FULL_SHA, source: 'git' },
		childOutcome: { lines, result: reported, timedOut, exitCode, signal: null },
		elapsedMs: 7493,
		notes: [],
	});
}

test('buildReport: a delivered file: bytes, seconds, layer (reported by the bot or inferred from the log), id, version, cost', () => {
	const measured = { ok: true, files: [{ name: 'video.mp4', bytes: 9020128, duration_sec: 121.17 }], bytes_total: 9020128, duration_sec: 121.17, compressed: false, layer: 'local', stages: ['downloading'] };
	const reported = reportFor(measured, { lines: ['downloaded 0 KB via LinkHub', 'running yt-dlp'] });
	assert.equal(reported.ok, true);
	assert.deepEqual([reported.result.bytes_total, reported.result.duration_sec, reported.result.layer, reported.result.layer_source], [9020128, 121.17, 'local', 'reported']);
	assert.deepEqual([reported.content_id, reported.version_sha, reported.elapsed_ms], ['HPawwstzIU0', FULL_SHA, 7493]);
	assert.equal(reported.downloads.via_linkhub, true);
	assert.ok(reported.notes.some((note) => /2 downloads/.test(note)));
	assert.ok(reported.notes.some((note) => /LinkHub/.test(note)));
	assert.equal('ok' in reported.result, false);

	const inferred = reportFor({ ...measured, layer: null }, { lines: ['running yt-dlp'] });
	assert.deepEqual([inferred.result.layer, inferred.result.layer_source], ['local', 'inferred']);
});

test('buildReport: an empty file, a timeout and a vanished runner are all reported as what they are', () => {
	const empty = reportFor({ ok: false, error: { code: 'EMPTY_FILE', message: 'empty', tried: ['linkhub', 'local'] } });
	assert.deepEqual([empty.ok, empty.result, empty.error.code, empty.error.tried], [false, null, 'EMPTY_FILE', ['linkhub', 'local']]);
	assert.equal(empty.measured, true);
	assert.equal(reportFor(null, { timedOut: true }).error.code, 'REPRO_TIMEOUT');
	assert.equal(reportFor(null, { exitCode: 1 }).error.code, 'RUNNER_NO_RESULT');
});

// ---------------------------------------------------------------- staging safety

test('assertSafeTarEntries: no absolute paths, no .., no drive letters', () => {
	assertSafeTarEntries(['yohaneowo-bot-abc/', 'yohaneowo-bot-abc/services/media.js']);
	for (const bad of ['/etc/passwd', 'a/../../b', '../x', 'C:/Windows/x']) {
		assert.throws(() => assertSafeTarEntries([bad]), (error) => error.code === 'UNSAFE_ARCHIVE', bad);
	}
});

test('findArchiveTop: the top directory is found even when the tar lists a pax_global_header first (busybox does)', () => {
	const sha = 'c'.repeat(40);
	const busybox = ['pax_global_header', 'yohaneowo-bot-5adaaef/', 'yohaneowo-bot-5adaaef/services/media.js'];
	assert.deepEqual(findArchiveTop(busybox), { directory: 'yohaneowo-bot-5adaaef', ref: '5adaaef' });
	assert.deepEqual(findArchiveTop(busybox.slice(1)), { directory: 'yohaneowo-bot-5adaaef', ref: '5adaaef' });
	assert.deepEqual(findArchiveTop([`yohaneowo-bot-${sha}/`]), { directory: `yohaneowo-bot-${sha}`, ref: sha });
	assert.equal(findArchiveTop(['pax_global_header', 'README.md']), null);
	assert.equal(findArchiveTop([]), null);
	assert.equal(findArchiveTop(['yohaneowo-bot-notasha/x']), null);
});

test('readArchiveSha: the full SHA comes from the pax global header GitHub puts first in the archive', () => {
	const sha = 'd'.repeat(40);
	const record = `52 comment=${sha}\n`;
	const header = Buffer.alloc(512);
	header.write('pax_global_header', 0);
	header.write('g', 156);
	const data = Buffer.alloc(512);
	data.write(record, 0);
	const withHeader = path.join(root, 'with-header.tgz');
	fs.writeFileSync(withHeader, zlib.gzipSync(Buffer.concat([header, data, Buffer.alloc(4096, 0x41)])));
	assert.equal(readArchiveSha(withHeader), sha);
	const without = path.join(root, 'without-header.tgz');
	fs.writeFileSync(without, zlib.gzipSync(Buffer.alloc(2048, 0x41)));
	assert.equal(readArchiveSha(without), null);
	fs.writeFileSync(path.join(root, 'broken.tgz'), 'not gzip at all');
	assert.equal(readArchiveSha(path.join(root, 'broken.tgz')), null);
	assert.equal(readArchiveSha(path.join(root, 'missing.tgz')), null);
});

test('sweepStale: removes only old repro-XXXXXX directories', async () => {
	const names = ['repro-abc123', 'repro-fresh1', 'repro-toolong1', 'other-dir', 'repro-ab'];
	for (const name of names) fs.mkdirSync(path.join(root, name));
	const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
	for (const name of ['repro-abc123', 'repro-toolong1', 'other-dir', 'repro-ab']) fs.utimesSync(path.join(root, name), old, old);
	assert.equal(await sweepStale(root), 1);
	assert.deepEqual(fs.readdirSync(root).sort(), ['other-dir', 'repro-ab', 'repro-fresh1', 'repro-toolong1']);
	assert.equal(await sweepStale(path.join(root, 'missing')), 0);
});

test('the scripts never load discord.js or index.js, never use doppler, never print the environment', () => {
	for (const file of ['repro.js', 'repro-runner.js']) {
		const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', file), 'utf8');
		assert.doesNotMatch(source, /require\(['"]discord\.js['"]\)/, file);
		assert.doesNotMatch(source, /require\([^)]*index(\.js)?['"]\)/, file);
		assert.doesNotMatch(source, /['"]doppler['"]|doppler run/i, file);
		assert.doesNotMatch(source, /console\.[a-z]+\([^)]*process\.env\b/, file);
		assert.doesNotMatch(source, /JSON\.stringify\(\s*(process\.)?env\b/, file);
	}
});

// ---------------------------------------------------------------- the child process

const SLEEPER = 'setInterval(() => undefined, 1000);';

test('runChild: collects log lines from stdout and stderr and the REPRO_RESULT line', async () => {
	const runner = path.join(root, 'ok-runner.js');
	fs.writeFileSync(runner, [
		'console.log("first line");',
		'console.error("a warning");',
		'console.log("REPRO_RESULT " + JSON.stringify({ ok: true, bytes_total: 5 }));',
	].join('\n'));
	const outcome = await runChild({ tree: root, url: URL_A, maxBytes: 1000, timeoutSeconds: 20, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, runnerPath: runner });
	assert.deepEqual(outcome.result, { ok: true, bytes_total: 5 });
	assert.deepEqual(outcome.lines.sort(), ['a warning', 'first line']);
	assert.equal(outcome.timedOut, false);
});

test('runChild: a runner that never answers is stopped at the timeout together with what it started', async () => {
	const pidFile = path.join(root, 'grandchild.pid');
	const runner = path.join(root, 'hang-runner.js');
	fs.writeFileSync(runner, [
		'const { spawn } = require("node:child_process");',
		`const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(SLEEPER)}], { stdio: "ignore" });`,
		`require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));`,
		SLEEPER,
	].join('\n'));
	const started = Date.now();
	const outcome = await runChild({ tree: root, url: URL_A, maxBytes: 1000, timeoutSeconds: 1.5, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, runnerPath: runner });
	assert.equal(outcome.timedOut, true);
	assert.equal(outcome.result, null);
	assert.ok(Date.now() - started < 15_000);
	await new Promise((resolve) => setTimeout(resolve, 500));
	const grandchildPid = Number(fs.readFileSync(pidFile, 'utf8'));
	assert.throws(() => process.kill(grandchildPid, 0), (error) => error.code === 'ESRCH', 'the process the runner started is gone');
});

// ---------------------------------------------------------------- whole runs against fake version trees

// A stand-in for services/media.js of some old version: it logs like the real one, writes a file and
// deliberately prints the LinkHub key and the bot token (it must not be given the token, and the key
// must not reach the output).
const FAKE_MEDIA = `
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
module.exports = {
	findSupportedSite: (url) => (/youtube\\.com/.test(url) ? { name: 'YouTube' } : null),
	async downloadMedia(url, maxBytes, onStage) {
		console.log('[YouTube#abcd +0.1s] LinkHub: youtube via cobalt, 1 item(s)');
		console.log('[YouTube#abcd +0.2s] downloaded 0 KB via LinkHub (HTTP 200, content-length 0, 0 bytes)');
		console.log('[YouTube#abcd +0.3s] running yt-dlp');
		console.log('debug: key=' + process.env.LINKHUB_API_KEY + ' url=' + process.env.LINKHUB_API_URL);
		console.log('debug: token present=' + Boolean(process.env.TOKEN) + ' doppler present=' + Boolean(process.env.DOPPLER_TOKEN) + ' admin present=' + Boolean(process.env.ADMIN_API_TOKEN));
		console.log('debug: ytdlp=' + process.env.YTDLP_PATH + ' xhs=' + process.env.XHS_API_URL + ' lang=' + process.env.LANG);
		console.log('debug: dependencies visible=' + fs.existsSync(path.join(__dirname, '..', 'node_modules', 'marker.txt')));
		console.log('debug: tmpdir=' + os.tmpdir().replace(/\\\\/g, '/').split('/').slice(-2).join('/'));
		console.log('[YouTube#abcd +0.4s] recovered by local after linkhub came back empty');
		onStage('downloading');
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-'));
		const file = path.join(dir, 'video.mp4');
		fs.writeFileSync(file, Buffer.alloc(12345, 1));
		return { files: [{ path: file, name: 'video.mp4' }], compressed: false, layer: 'local', site: 'YouTube', info: { id: 'HPawwstzIU0' }, cleanup: async () => fs.rmSync(dir, { recursive: true, force: true }) };
	},
};
`;

function makeTree(dir, { media = FAKE_MEDIA, dependencies = {} } = {}) {
	fs.mkdirSync(path.join(dir, 'services'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'services', 'media.js'), media);
	fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fake', dependencies }));
}

// The "repo" the script belongs to: a tree with a node_modules whose content must survive every run.
function makeRepo({ git = false } = {}) {
	const repo = path.join(root, 'repo');
	makeTree(repo);
	fs.mkdirSync(path.join(repo, 'node_modules'));
	fs.writeFileSync(path.join(repo, 'node_modules', '.package-lock.json'), '{}');
	let sha = null;
	if (git) {
		const run = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
		run('init', '-q');
		run('config', 'user.email', 'test@example.com');
		run('config', 'user.name', 'test');
		run('add', '-A');
		run('commit', '-q', '-m', 'fake version');
		sha = run('rev-parse', 'HEAD');
	}
	fs.writeFileSync(path.join(repo, 'node_modules', 'marker.txt'), 'the real dependencies');
	return { repo, sha };
}

const BASE_ENV = {
	PATH: process.env.PATH,
	SystemRoot: process.env.SystemRoot,
	SYSTEMROOT: process.env.SYSTEMROOT,
	TOKEN: 'discord-bot-token',
	DOPPLER_TOKEN: 'dp.st.xxx',
	ADMIN_API_TOKEN: 'admin-token',
};

async function runMain(argv, { repo, stagingRoot, fromBot = { LINKHUB_API_URL: LINKHUB_URL, LINKHUB_API_KEY: KEY }, ...more } = {}) {
	const out = capture();
	const code = await main(argv, {
		repoRoot: repo,
		stdout: out.stdout,
		env: BASE_ENV,
		tmpdir: stagingRoot,
		loadMedia: () => ({ findSupportedSite: (url) => (/youtube\.com/.test(url) ? { name: 'YouTube' } : null) }),
		readFromBot: () => fromBot,
		...more,
	});
	return { code, out, json: out.json() };
}

function newStagingRoot() {
	const dir = path.join(root, 'staging-root');
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

test('a run on the copy itself (--ref current): measured, no extraction, nothing left behind, key and tokens kept out', async () => {
	const { repo } = makeRepo();
	const stagingRoot = newStagingRoot();
	const { code, out, json } = await runMain([URL_A, '--ref', 'current', '--min-free-mb', '0'], { repo, stagingRoot });
	assert.equal(code, EXIT.OK);
	assert.equal(json.ok, true);
	assert.equal(json.measured, true);
	assert.deepEqual([json.site, json.content_id, json.version_source], ['YouTube', 'HPawwstzIU0', 'current']);
	assert.deepEqual([json.result.bytes_total, json.result.layer, json.result.layer_source], [12345, 'local', 'reported']);
	assert.deepEqual(json.result.files.map((file) => [file.name, file.bytes]), [['video.mp4', 12345]]);
	assert.deepEqual([json.downloads.linkhub, json.downloads.ytdlp, json.downloads.total, json.downloads.via_linkhub], [1, 1, 2, true]);
	assert.ok(json.elapsed_ms >= 0);
	const tail = json.log_tail.join('\n');
	assert.match(tail, /token present=false doppler present=false admin present=false/);
	assert.equal(out.text().includes(KEY), false, 'the LinkHub key is not in the output');
	assert.equal(out.text().includes(LINKHUB_URL), false, 'the LinkHub URL is not in the output');
	assert.match(tail, /key=\[redacted\] url=\[redacted\]/);
	assert.match(tail, /tmpdir=repro-[A-Za-z0-9]{6}\/tmp/, 'the version ran with the staging directory as its temp dir');
	assert.deepEqual(fs.readdirSync(stagingRoot), [], 'the staging directory (and the media it made) is gone');
	assert.equal(fs.readFileSync(path.join(repo, 'node_modules', 'marker.txt'), 'utf8'), 'the real dependencies');
});

test('every environment value handed to the version is kept out of the output, not only the LinkHub ones', async () => {
	const { repo } = makeRepo();
	const stagingRoot = newStagingRoot();
	const ytdlp = 'C:/tools/private-name/yt-dlp-special.exe';
	const xhs = 'http://internal-host.example:5556/xhs';
	const { code, out, json } = await runMain([URL_A, '--ref', 'current', '--min-free-mb', '0'], {
		repo,
		stagingRoot,
		env: { ...BASE_ENV, YTDLP_PATH: ytdlp, XHS_API_URL: xhs, LANG: 'C' },
	});
	assert.equal(code, EXIT.OK);
	assert.equal(json.ok, true);
	for (const value of [ytdlp, xhs]) {
		assert.equal(out.text().includes(value), false, 'a whitelisted environment value is not in the output');
	}
	assert.match(json.log_tail.join('\n'), /debug: ytdlp=\[redacted\] xhs=\[redacted\] lang=C/, 'a value shorter than four characters is left alone');
	assert.deepEqual(collectRedactions({ A: 'abc', B: 'abcd', C: 'abcdef', D: undefined, E: '', F: 'abcd' }), ['abcdef', 'abcd']);
});

test('the output carries the judge view: fixed fields only, and none of the debug lines or secrets of the run', async () => {
	const { repo } = makeRepo();
	const { json, out } = await runMain([URL_A, '--ref', 'current', '--min-free-mb', '0'], { repo, stagingRoot: newStagingRoot() });
	const view = json.judge_view;
	assert.equal(view.schema, 'judge_view/1');
	assert.deepEqual([view.ok, view.measured, view.bytes_total, view.layer, view.content_id, view.content_id_source], [true, true, 12345, 'local', 'HPawwstzIU0', 'link']);
	assert.deepEqual([json.result.media_id, view.media_id, view.id_match], ['HPawwstzIU0', 'HPawwstzIU0', true], 'the id of the downloaded video comes from the version itself');
	assert.deepEqual(view.log_lines, [
		'[YouTube +0.1s] LinkHub: youtube via cobalt, 1 item(s)',
		'[YouTube +0.2s] downloaded 0 KB via LinkHub (HTTP 200, content-length 0, 0 bytes)',
		'[YouTube +0.3s] running yt-dlp',
		'[YouTube +0.4s] recovered by local after linkhub came back empty',
	]);
	assert.ok(view.log_lines_dropped >= 5, 'the debug lines are left out');
	assert.equal(JSON.stringify(view).includes('debug'), false);
	assert.equal(out.text().includes(KEY), false);
});

test('a Facebook share link: the reel id comes from the redirects and the run is still made with the link as given', async () => {
	const { repo } = makeRepo();
	const share = 'https://www.facebook.com/share/r/AbCdEf/';
	const asked = [];
	const shareFetchImpl = async (url) => {
		asked.push(url);
		return { status: 302, headers: new Headers({ location: 'https://www.facebook.com/reel/858979257261500/?s=1' }), body: null };
	};
	const { json } = await runMain([share, '--ref', 'current', '--min-free-mb', '0'], {
		repo,
		stagingRoot: newStagingRoot(),
		shareFetchImpl,
		loadMedia: () => ({ findSupportedSite: () => ({ name: 'Facebook' }) }),
	});
	assert.deepEqual(asked, [share]);
	assert.deepEqual([json.url, json.content_id, json.content_id_source], [share, '858979257261500', 'redirect']);
	assert.deepEqual([json.judge_view.content_id, json.judge_view.content_id_source], ['858979257261500', 'redirect']);
	assert.ok(json.notes.some((note) => /read the reel id from 1 redirect/.test(note)));
});

test('a run that fails before measuring still prints a judge view with a fixed code', async () => {
	const { repo } = makeRepo();
	const { code, json } = await runMain([URL_A, '--ref', 'current', '--min-free-mb', '500'], { repo, stagingRoot: newStagingRoot(), statfs: () => ({ bavail: 1, bsize: 1 }) });
	assert.equal(code, EXIT.SETUP);
	assert.deepEqual([json.judge_view.measured, json.judge_view.error_code, json.judge_view.log_lines], [false, 'LOW_DISK', []]);
});

test('without the LinkHub settings the run still happens and says so', async () => {
	const { repo } = makeRepo();
	const { json } = await runMain([URL_A, '--ref', 'current', '--min-free-mb', '0'], { repo, stagingRoot: newStagingRoot(), fromBot: {} });
	assert.equal(json.ok, true);
	assert.ok(json.notes.some((note) => /LINKHUB_API_URL \/ LINKHUB_API_KEY were not found/.test(note)));
});

test('a version taken from git: full SHA from a short one, the tracked node_modules replaced by a link, the real one untouched', { skip: !haveGit || !haveTar }, async () => {
	const { repo, sha } = makeRepo({ git: true });
	assert.equal(fs.readdirSync(path.join(repo, 'node_modules')).includes('.package-lock.json'), true);
	const stagingRoot = newStagingRoot();
	const { code, json } = await runMain([URL_A, '--ref', sha.slice(0, 9), '--min-free-mb', '0'], { repo, stagingRoot });
	assert.equal(code, EXIT.OK);
	assert.equal(json.ok, true);
	assert.deepEqual([json.version_sha, json.version_source, json.ref], [sha, 'git', sha.slice(0, 9)]);
	assert.match(json.log_tail.join('\n'), /dependencies visible=true/, 'the version ran on the real node_modules');
	assert.deepEqual(fs.readdirSync(stagingRoot), []);
	assert.deepEqual(fs.readdirSync(path.join(repo, 'node_modules')).sort(), ['.package-lock.json', 'marker.txt']);
	assert.equal(fs.readFileSync(path.join(repo, 'node_modules', 'marker.txt'), 'utf8'), 'the real dependencies');
});

test('a version that asks for other dependencies is run on this copy\'s node_modules and the report says so', { skip: !haveGit || !haveTar }, async () => {
	const repo = path.join(root, 'repo');
	makeTree(repo, { dependencies: { discord: '1' } });
	fs.mkdirSync(path.join(repo, 'node_modules'));
	const run = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
	run('init', '-q');
	run('config', 'user.email', 'test@example.com');
	run('config', 'user.name', 'test');
	run('add', '-A');
	run('commit', '-q', '-m', 'old version');
	const sha = run('rev-parse', 'HEAD');
	fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'fake', dependencies: { discord: '2' } }));
	const { json } = await runMain([URL_A, '--ref', sha, '--min-free-mb', '0'], { repo, stagingRoot: newStagingRoot() });
	assert.equal(json.ok, true);
	assert.ok(json.notes.some((note) => /other dependencies/.test(note)), JSON.stringify(json.notes));
});

test('git does not know the version (--source git): a setup error, exit 3, nothing left behind', { skip: !haveGit || !haveTar }, async () => {
	const { repo } = makeRepo({ git: true });
	const stagingRoot = newStagingRoot();
	const { code, json } = await runMain([URL_A, '--ref', 'deadbee', '--source', 'git', '--min-free-mb', '0'], { repo, stagingRoot });
	assert.equal(code, EXIT.SETUP);
	assert.deepEqual([json.ok, json.measured, json.script_error.code], [false, false, 'VERSION_NOT_FOUND']);
	assert.deepEqual(fs.readdirSync(stagingRoot), []);
});

// A GitHub-style source archive: one top directory named <repo>-<full sha>.
function makeArchive(shortRef) {
	const source = path.join(root, 'archive-src');
	const top = path.join(source, `yohaneowo-bot-${shortRef}`);
	makeTree(top);
	fs.mkdirSync(path.join(top, 'node_modules'));
	fs.writeFileSync(path.join(top, 'node_modules', '.package-lock.json'), '{}');
	execFileSync('tar', ['-czf', 'archive.tgz', '-C', 'archive-src', `yohaneowo-bot-${shortRef}`], { cwd: root });
	return fs.readFileSync(path.join(root, 'archive.tgz'));
}

test('no .git next to the script (the dev container): the version comes from GitHub as a source archive', { skip: !haveTar }, async () => {
	const { repo } = makeRepo();
	const archive = makeArchive(FULL_SHA);
	const asked = [];
	const fetchImpl = async (url) => {
		asked.push(String(url));
		return new Response(archive, { status: 200 });
	};
	const stagingRoot = newStagingRoot();
	const { code, json } = await runMain([URL_A, '--ref', 'aaaaaaa', '--min-free-mb', '0'], { repo, stagingRoot, fetchImpl });
	assert.equal(code, EXIT.OK);
	assert.equal(json.ok, true);
	assert.deepEqual([json.version_sha, json.version_source], [FULL_SHA, 'github']);
	assert.deepEqual(asked, ['https://codeload.github.com/yohaneowo/yohaneowo-bot/tar.gz/aaaaaaa']);
	assert.match(json.log_tail.join('\n'), /dependencies visible=true/, 'the version ran on the real node_modules');
	assert.deepEqual(fs.readdirSync(stagingRoot), []);
	assert.equal(fs.readFileSync(path.join(repo, 'node_modules', 'marker.txt'), 'utf8'), 'the real dependencies');
});

test('a real GitHub-style archive (made by git archive: it starts with a pax_global_header entry) is read correctly', { skip: !haveGit || !haveTar }, async () => {
	const { repo: source, sha } = makeRepo({ git: true });
	execFileSync('git', ['archive', '--format=tar.gz', `--prefix=yohaneowo-bot-${sha.slice(0, 8)}/`, '-o', path.join(root, 'real.tgz'), sha], { cwd: source });
	const listing = execFileSync('tar', ['-tzf', 'real.tgz'], { cwd: root, encoding: 'utf8' }).split('\n');
	assert.ok(listing[0].startsWith('pax_global_header') || listing[0].startsWith(`yohaneowo-bot-${sha.slice(0, 8)}/`), listing[0]);
	const archive = fs.readFileSync(path.join(root, 'real.tgz'));
	fs.rmSync(path.join(source, '.git'), { recursive: true, force: true });
	const stagingRoot = newStagingRoot();
	const { code, json } = await runMain([URL_A, '--ref', sha.slice(0, 8), '--min-free-mb', '0'], { repo: source, stagingRoot, fetchImpl: async () => new Response(archive, { status: 200 }) });
	assert.equal(code, EXIT.OK);
	assert.deepEqual([json.ok, json.version_sha, json.version_source], [true, sha, 'github']);
	assert.deepEqual(fs.readdirSync(stagingRoot), []);
});

test('an archive without the pax header and a short ref: version_sha is the short one and the report says it could not be completed', { skip: !haveTar }, async () => {
	const { repo } = makeRepo();
	const archive = makeArchive('aaaaaaa');
	const { code, json } = await runMain([URL_A, '--ref', 'aaaaaaa', '--min-free-mb', '0'], { repo, stagingRoot: newStagingRoot(), fetchImpl: async () => new Response(archive, { status: 200 }) });
	assert.equal(code, EXIT.OK);
	assert.deepEqual([json.ok, json.version_sha, json.version_source], [true, 'aaaaaaa', 'github']);
	assert.ok(json.notes.some((note) => /full commit SHA could not be read/.test(note)), JSON.stringify(json.notes));
});

test('GitHub does not have the commit: a setup error, exit 3', async () => {
	const { repo } = makeRepo();
	const stagingRoot = newStagingRoot();
	const { code, json } = await runMain([URL_A, '--ref', 'bbbbbbb', '--min-free-mb', '0'], { repo, stagingRoot, fetchImpl: async () => new Response('Not Found', { status: 404 }) });
	assert.equal(code, EXIT.SETUP);
	assert.equal(json.script_error.code, 'VERSION_NOT_FOUND');
	assert.match(json.script_error.message, /HTTP 404/);
	assert.deepEqual(fs.readdirSync(stagingRoot), []);
});

test('an archive that is not a version of the bot is refused', { skip: !haveTar }, async () => {
	const { repo } = makeRepo();
	const empty = path.join(root, 'empty-src', `yohaneowo-bot-${FULL_SHA}`);
	fs.mkdirSync(empty, { recursive: true });
	fs.writeFileSync(path.join(empty, 'README.md'), 'hello');
	execFileSync('tar', ['-czf', 'empty.tgz', '-C', 'empty-src', `yohaneowo-bot-${FULL_SHA}`], { cwd: root });
	const archive = fs.readFileSync(path.join(root, 'empty.tgz'));
	const stagingRoot = newStagingRoot();
	const { code, json } = await runMain([URL_A, '--ref', 'aaaaaaa', '--min-free-mb', '0'], { repo, stagingRoot, fetchImpl: async () => new Response(archive, { status: 200 }) });
	assert.equal(code, EXIT.SETUP);
	assert.equal(json.script_error.code, 'BAD_TREE');
	assert.deepEqual(fs.readdirSync(stagingRoot), []);
});

test('too little free disk: not run, no staging directory created, exit 3', async () => {
	const { repo } = makeRepo();
	const stagingRoot = newStagingRoot();
	const statfs = () => ({ bavail: 10, bsize: 4096 });
	const { code, json } = await runMain([URL_A, '--ref', 'current'], { repo, stagingRoot, statfs });
	assert.equal(code, EXIT.SETUP);
	assert.equal(json.script_error.code, 'LOW_DISK');
	assert.match(json.script_error.message, /need 500 MB/);
	assert.deepEqual(fs.readdirSync(stagingRoot), []);
});

test('a link the bot does not support is refused before anything is prepared', async () => {
	const { repo } = makeRepo();
	const stagingRoot = newStagingRoot();
	const { code, json } = await runMain(['https://example.com/video/1', '--ref', 'current', '--min-free-mb', '0'], { repo, stagingRoot });
	assert.equal(code, EXIT.USAGE);
	assert.equal(json.script_error.code, 'UNSUPPORTED_LINK');
	assert.deepEqual(fs.readdirSync(stagingRoot), []);
});

test('a version that throws is a measurement, not a script failure; a version that cannot be loaded says so', async () => {
	const failing = String.raw`module.exports = { findSupportedSite: () => ({ name: 'YouTube' }), async downloadMedia() { const error = new Error('下载到的影片是空的或已损坏'); error.code = 'EMPTY_FILE'; error.tried = ['linkhub', 'local']; error.detail = 'tried=linkhub,local; site_consecutive=1; 0 bytes'; console.log('LinkHub: youtube via cobalt, 1 item(s)'); throw error; } };`;
	const { repo } = makeRepo();
	fs.writeFileSync(path.join(repo, 'services', 'media.js'), failing);
	const first = await runMain([URL_A, '--ref', 'current', '--min-free-mb', '0'], { repo, stagingRoot: newStagingRoot() });
	assert.equal(first.code, EXIT.OK);
	assert.deepEqual([first.json.ok, first.json.measured, first.json.error.code, first.json.error.tried], [false, true, 'EMPTY_FILE', ['linkhub', 'local']]);
	assert.equal(first.json.downloads.linkhub_parses, 1);

	fs.writeFileSync(path.join(repo, 'services', 'media.js'), 'throw new Error("syntax of an old version");');
	const second = await runMain([URL_A, '--ref', 'current', '--min-free-mb', '0'], { repo, stagingRoot: newStagingRoot() });
	assert.equal(second.code, EXIT.OK);
	assert.deepEqual([second.json.ok, second.json.error.code], [false, null]);
	assert.match(second.json.error.message, /old version/);
});

test('the watchdog: a run that does not finish is stopped, its process tree killed and the staging directory removed', async () => {
	const { repo } = makeRepo();
	const stagingRoot = newStagingRoot();
	const pidFile = path.join(root, 'runner.pid');
	const runner = path.join(root, 'sleeping-runner.js');
	fs.writeFileSync(runner, `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); ${SLEEPER}`);
	let fired = 0;
	const { code } = await runMain([URL_A, '--ref', 'current', '--min-free-mb', '0'], {
		repo,
		stagingRoot,
		runnerPath: runner,
		watchdogMs: 1500,
		onWatchdog: () => {
			fired += 1;
			assert.equal(fs.readdirSync(stagingRoot).length, 1, 'the staging directory exists while the run is stuck');
			emergencyCleanup();
			assert.deepEqual(fs.readdirSync(stagingRoot), [], 'and the emergency cleanup removed it');
		},
	});
	assert.equal(fired, 1);
	assert.equal(code, EXIT.OK);
	await new Promise((resolve) => setTimeout(resolve, 500));
	assert.throws(() => process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 0), (error) => error.code === 'ESRCH', 'the stuck runner was killed');
});

test('the CLI: --help works and a bad call prints a JSON error with exit code 64', () => {
	const script = path.join(__dirname, '..', 'scripts', 'repro.js');
	const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
	assert.equal(help.status, 0);
	assert.match(help.stdout, /usage: node scripts\/repro\.js/);
	const bad = spawnSync(process.execPath, [script, URL_A, '--ref', 'main'], { encoding: 'utf8' });
	assert.equal(bad.status, EXIT.USAGE);
	assert.equal(JSON.parse(bad.stdout).script_error.code, 'USAGE');
	assert.equal(bad.stderr, '');
});
