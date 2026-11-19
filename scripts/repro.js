#!/usr/bin/env node
// Download-only reproduction tool: runs one link through the bot's real download path (downloadMedia) at a
// given version, and prints what came out (bytes, seconds, which layer delivered the file, how many
// downloads it cost). It never uploads and never talks to Discord: the version runs in a child process whose
// environment holds no bot token, and everything it creates lives in a staging directory that is deleted
// afterwards.
//
//   node scripts/repro.js <url> --ref <sha|current> [--max-bytes N] [--timeout SECONDS] [--pretty]
//
// --ref <sha>     a commit of the bot repo; its tree is taken from git, or from GitHub when there is no .git
//                 (the repo is public). The dependencies are the ones of the running copy (node_modules is linked).
// --ref current   no extraction: run the copy this script belongs to (in the dev container that is the deployed version).
// Exit code: 0 measurement done (the link may still have failed: read "result" and "error"), 3 setup failed
// (low disk, version not found, ...), 64 bad arguments, 130 / 143 interrupted.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const zlib = require('node:zlib');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.join(__dirname, '..');
const RUNNER_PATH = path.join(__dirname, 'repro-runner.js');
const GITHUB_REPO = 'yohaneowo/yohaneowo-bot';
const DEFAULT_MAX_BYTES = 9_800_000;
const DEFAULT_TIMEOUT_SECONDS = 300;
const DEFAULT_MIN_FREE_MB = 500;
const TARBALL_MAX_BYTES = 100 * 1000 * 1000;
const TARBALL_TIMEOUT_MS = 60 * 1000;
const KEPT_LOG_LINES = 2000;
const REPORTED_LOG_LINES = 30;
const REPORTED_LINE_LENGTH = 300;
const EXIT = { OK: 0, SETUP: 3, USAGE: 64, SIGINT: 130, SIGTERM: 143 };
const HEX_REF = /^[0-9a-f]{7,40}$/i;

// The only plain settings the child process takes from this process's environment: where the tools are and the
// Xiaohongshu helper URL (it is in the container's own environment). No bot token, no admin or webhook
// settings, nothing else.
const PLAIN_ENV_KEYS = new Set([
	'PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL',
	'YTDLP_PATH', 'FFMPEG_PATH', 'FFPROBE_PATH', 'XHS_API_URL',
]);
// The two LinkHub settings are not in the environment of a plain `docker exec`: Doppler hands them to the bot
// process only. They are copied by name from there (readBotEnviron) and are never printed.
const SECRET_ENV_KEYS = ['LINKHUB_API_URL', 'LINKHUB_API_KEY'];
const STALE_STAGING_MS = 60 * 60 * 1000;
const WATCHDOG_EXTRA_SECONDS = 30;

class ScriptError extends Error {
	constructor(code, message, exitCode = EXIT.SETUP) {
		super(message);
		this.name = 'ScriptError';
		this.code = code;
		this.exitCode = exitCode;
	}
}

function parsePositiveInteger(name, value, { min, max }) {
	const number = Number(value);
	if (!Number.isInteger(number) || number < min || number > max) {
		throw new ScriptError('USAGE', `${name} must be an integer from ${min} to ${max}`, EXIT.USAGE);
	}
	return number;
}

function parseArgs(argv) {
	const options = {
		url: null,
		ref: null,
		maxBytes: DEFAULT_MAX_BYTES,
		timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
		minFreeMb: DEFAULT_MIN_FREE_MB,
		source: 'auto',
		pretty: false,
		keep: false,
		help: false,
	};
	const valued = new Set(['--ref', '--max-bytes', '--timeout', '--min-free-mb', '--source']);
	const flags = new Set(['--pretty', '--keep', '--help']);
	const positional = [];
	for (let index = 0; index < argv.length; index++) {
		const [name, equalsValue] = argv[index].startsWith('--') ? argv[index].split(/=(.*)/s, 2) : [argv[index]];
		let inlineValue = equalsValue;
		if (!name.startsWith('--')) {
			positional.push(name);
			continue;
		}
		if (flags.has(name)) {
			options[{ '--pretty': 'pretty', '--keep': 'keep', '--help': 'help' }[name]] = true;
			continue;
		}
		if (!valued.has(name)) throw new ScriptError('USAGE', `unknown option ${name}`, EXIT.USAGE);
		if (inlineValue === undefined) {
			inlineValue = argv[++index];
			if (inlineValue === undefined || inlineValue.startsWith('--')) {
				throw new ScriptError('USAGE', `${name} needs a value`, EXIT.USAGE);
			}
		}
		if (name === '--ref') options.ref = inlineValue;
		else if (name === '--max-bytes') options.maxBytes = parsePositiveInteger(name, inlineValue, { min: 1000, max: 200 * 1000 * 1000 });
		else if (name === '--timeout') options.timeoutSeconds = parsePositiveInteger(name, inlineValue, { min: 5, max: 900 });
		else if (name === '--min-free-mb') options.minFreeMb = parsePositiveInteger(name, inlineValue, { min: 0, max: 1_000_000 });
		else if (name === '--source') options.source = inlineValue;
	}
	if (options.help) return options;
	if (positional.length !== 1) throw new ScriptError('USAGE', 'give exactly one link', EXIT.USAGE);
	options.url = positional[0];
	if (!options.ref) throw new ScriptError('USAGE', '--ref <sha|current> is required', EXIT.USAGE);
	if (options.ref !== 'current' && !HEX_REF.test(options.ref)) {
		throw new ScriptError('USAGE', '--ref must be "current" or a commit SHA (7-40 hex characters)', EXIT.USAGE);
	}
	if (!['auto', 'git', 'github'].includes(options.source)) {
		throw new ScriptError('USAGE', '--source must be auto, git or github', EXIT.USAGE);
	}
	return options;
}

function validateUrl(url) {
	let parsed;
	try {
		parsed = new URL(url);
	}
	catch {
		throw new ScriptError('USAGE', 'the link is not a valid URL', EXIT.USAGE);
	}
	if (!['http:', 'https:'].includes(parsed.protocol) || url.length > 2048 || /\s/.test(url)) {
		throw new ScriptError('USAGE', 'the link must be one http(s) URL without spaces (max 2048 characters)', EXIT.USAGE);
	}
}

// The video / post id that is visible in the link itself. Share links and short links (b23.tv, fb.watch,
// vm.tiktok.com, xhslink.com, Facebook /share/) are not followed here, so they have no id.
function extractContentId(url) {
	const patterns = [
		/youtube\.com\/shorts\/([\w-]{11})/i,
		/youtu\.be\/([\w-]{11})/i,
		/[?&]v=([\w-]{11})(?:&|$)/i,
		/bilibili\.com\/video\/(BV\w{10}|av\d+)/i,
		/tiktok\.com\/@[\w.-]+\/video\/(\d+)/i,
		/\/status(?:es)?\/(\d+)/i,
		/facebook\.com\/(?:[\w.-]+\/)?(?:reel|videos)\/(\d+)/i,
		/facebook\.com\/watch\/?\?v=(\d+)/i,
		/instagram\.com\/(?:[\w.]+\/)?(?:reels?|p|tv)\/([\w-]+)/i,
		/threads\.(?:com|net)\/@[\w.]+\/post\/([\w-]+)/i,
		/xiaohongshu\.com\/(?:explore|discovery\/item)\/([\da-f]+)/i,
	];
	for (const pattern of patterns) {
		const match = pattern.exec(url);
		if (match) return { id: match[1], source: 'link' };
	}
	return { id: null, source: 'unresolved' };
}

// Keeps only the whitelisted names of an environment dump (the NUL-separated text of /proc/<pid>/environ).
function parseEnviron(raw, wanted) {
	const found = {};
	for (const entry of raw.split('\0')) {
		const separator = entry.indexOf('=');
		if (separator <= 0) continue;
		const key = entry.slice(0, separator);
		if (wanted.includes(key)) found[key] = entry.slice(separator + 1);
	}
	return found;
}

function readTextOrNull(file) {
	try {
		return fs.readFileSync(file, 'utf8');
	}
	catch {
		return null;
	}
}

// The LinkHub settings, copied by name from the process that has them: PID 1 first, then the bot itself
// (`node index.js` started in this repo's directory; in the Coolify container PID 1 is docker-init and only
// the bot has them). Nothing else is copied, and nothing is returned for names that are not whitelisted
// (PID 1 also holds DOPPLER_TOKEN). Returns {} when /proc is not available.
function readBotEnviron(repoRoot, procRoot = '/proc') {
	const found = {};
	const take = (pid) => {
		const raw = readTextOrNull(path.join(procRoot, pid, 'environ'));
		if (raw === null) return;
		for (const [key, value] of Object.entries(parseEnviron(raw, SECRET_ENV_KEYS))) {
			if (!(key in found)) found[key] = value;
		}
	};
	let names;
	try {
		names = fs.readdirSync(procRoot);
	}
	catch {
		return found;
	}
	take('1');
	let realRoot;
	try {
		realRoot = fs.realpathSync(repoRoot);
	}
	catch {
		return found;
	}
	for (const pid of names.filter((name) => /^\d+$/.test(name) && name !== '1')) {
		const argv = (readTextOrNull(path.join(procRoot, pid, 'cmdline')) ?? '').split('\0');
		if (path.basename(argv[0]) !== 'node' || argv[1] !== 'index.js') continue;
		try {
			if (fs.realpathSync(path.join(procRoot, pid, 'cwd')) !== realRoot) continue;
		}
		catch {
			continue;
		}
		take(pid);
	}
	return found;
}

function buildChildEnv(env, stagingTmp, fromBot = {}) {
	const childEnv = {};
	for (const [key, value] of Object.entries(env)) {
		if (PLAIN_ENV_KEYS.has(key.toUpperCase()) && value !== undefined) childEnv[key] = value;
	}
	for (const key of SECRET_ENV_KEYS) {
		const value = fromBot[key] ?? env[key];
		if (value) childEnv[key] = value;
	}
	childEnv.TMPDIR = stagingTmp;
	childEnv.TEMP = stagingTmp;
	childEnv.TMP = stagingTmp;
	return childEnv;
}

// Every value handed to the child, not only the two LinkHub ones: any of them can end up in a log line or an
// error message. Very short values (a one-letter LANG) are left alone, they would mangle the output. Longest
// first, so a value that contains another one is replaced whole.
function collectRedactions(childEnv) {
	const values = new Set();
	for (const value of Object.values(childEnv)) {
		if (typeof value === 'string' && value.length >= 4) values.add(value);
	}
	return [...values].sort((a, b) => b.length - a.length);
}

// Everything this script prints goes through here first: a value that came from the environment must not
// show up in a log line, an error message or a note, whatever put it there.
function redact(text, secretValues) {
	let out = String(text);
	for (const secret of secretValues) {
		if (!secret) continue;
		for (const form of new Set([secret, JSON.stringify(secret).slice(1, -1)])) out = out.split(form).join('[redacted]');
	}
	return out;
}

// Staging directories of runs that were killed before they could clean up (SIGKILL cannot be caught).
async function sweepStale(dir, now = Date.now, maxAgeMs = STALE_STAGING_MS) {
	let names;
	try {
		names = await fsp.readdir(dir);
	}
	catch {
		return 0;
	}
	let removed = 0;
	for (const name of names.filter((entry) => /^repro-[A-Za-z0-9]{6}$/.test(entry))) {
		const full = path.join(dir, name);
		try {
			const stat = await fsp.stat(full);
			if (stat.isDirectory() && now() - stat.mtimeMs > maxAgeMs) {
				removeStagingSync(full);
				removed += 1;
			}
		}
		catch {
			continue;
		}
	}
	return removed;
}

// Counts what the run downloaded and works out which layer delivered the file, from the bot's own log lines.
// Newer versions report the layer themselves; older ones do not, so it is read from the log and marked as such.
function analyzeLog(lines) {
	const counts = { linkhub: 0, ytdlp: 0, direct: 0 };
	let linkhubParses = 0;
	let lastLinkhub = -1;
	let lastLocal = -1;
	let recoveredBy = null;
	lines.forEach((line, index) => {
		if (/\bdownloaded (?:GIF )?\d+(?:\.\d+)? (?:KB|MB) via LinkHub\b/.test(line)) {
			counts.linkhub += 1;
			lastLinkhub = index;
		}
		else if (/\bdownloaded (?:GIF )?\d+(?:\.\d+)? (?:KB|MB) (?:via|from) \S+/.test(line)) {
			counts.direct += 1;
			lastLocal = index;
		}
		if (/\brunning yt-dlp\b/.test(line)) {
			counts.ytdlp += 1;
			lastLocal = index;
		}
		if (/\bLinkHub: \S+ via \S+/.test(line)) linkhubParses += 1;
		const recovered = /\brecovered by (\S+) after\b/.exec(line);
		if (recovered) recoveredBy = recovered[1];
		if (/falling back to the local parser/.test(line)) lastLocal = Math.max(lastLocal, index);
	});
	let layer = null;
	if (recoveredBy) layer = recoveredBy;
	else if (lastLinkhub !== -1 || lastLocal !== -1) layer = lastLinkhub > lastLocal ? 'linkhub' : 'local';
	return {
		downloads: {
			linkhub: counts.linkhub,
			ytdlp: counts.ytdlp,
			direct: counts.direct,
			total: counts.linkhub + counts.ytdlp + counts.direct,
			linkhub_parses: linkhubParses,
			via_linkhub: counts.linkhub > 0,
		},
		layer,
	};
}

function tail(lines, count = REPORTED_LOG_LINES) {
	return lines.slice(-count).map((line) => (line.length > REPORTED_LINE_LENGTH ? `${line.slice(0, REPORTED_LINE_LENGTH)}…` : line));
}

function buildReport({ options, siteName, version, childOutcome, elapsedMs, notes, timeoutSeconds = options.timeoutSeconds }) {
	const analysis = analyzeLog(childOutcome.lines);
	const content = extractContentId(options.url);
	let result = null;
	let error = null;
	const reported = childOutcome.result;
	if (childOutcome.timedOut) {
		error = { code: 'REPRO_TIMEOUT', message: `no result within ${timeoutSeconds} s; the run was stopped` };
	}
	else if (!reported) {
		error = { code: 'RUNNER_NO_RESULT', message: `the child process ended without a result (exit ${childOutcome.exitCode ?? childOutcome.signal})` };
	}
	else if (reported.ok) {
		const measured = { ...reported };
		delete measured.ok;
		delete measured.error;
		const layerFromBot = measured.layer ?? null;
		result = { ...measured, layer: layerFromBot ?? analysis.layer, layer_source: layerFromBot ? 'reported' : 'inferred' };
	}
	else {
		error = reported.error;
	}
	const extraNotes = [...notes];
	if (analysis.downloads.total > 1) extraNotes.push(`this run used ${analysis.downloads.total} downloads (counts against the per-ticket budget)`);
	if (analysis.downloads.via_linkhub) extraNotes.push('at least one download went through LinkHub');
	return {
		ok: Boolean(result),
		measured: true,
		url: options.url,
		site: siteName,
		content_id: content.id,
		content_id_source: content.source,
		ref: options.ref,
		version_sha: version.sha,
		version_source: version.source,
		max_bytes: options.maxBytes,
		result,
		error,
		downloads: analysis.downloads,
		elapsed_ms: elapsedMs,
		node: process.version,
		notes: extraNotes,
		log_tail: tail(childOutcome.lines),
	};
}

async function killTree(child) {
	try {
		if (process.platform === 'win32') {
			await execFileAsync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { timeout: 10 * 1000 });
		}
		else {
			process.kill(-child.pid, 'SIGKILL');
		}
	}
	catch {
		child.kill('SIGKILL');
	}
}

// Runs the runner script for one version tree and collects its output. At most timeoutSeconds, then the
// whole process tree (node, yt-dlp, ffmpeg) is killed.
function runChild({ tree, url, maxBytes, timeoutSeconds, env, runnerPath = RUNNER_PATH, onChild = () => undefined }) {
	return new Promise((resolve) => {
		const child = spawn(
			process.execPath,
			[runnerPath, '--tree', tree, '--url', url, '--max-bytes', String(maxBytes)],
			{ cwd: tree, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' },
		);
		onChild(child);
		const lines = [];
		let result = null;
		let timedOut = false;
		const buffers = { stdout: '', stderr: '' };
		const takeLine = (line) => {
			if (line.startsWith('REPRO_RESULT ')) {
				try {
					result = JSON.parse(line.slice('REPRO_RESULT '.length));
				}
				catch {
					lines.push(line);
				}
				return;
			}
			if (lines.length < KEPT_LOG_LINES) lines.push(line);
		};
		const feed = (name) => (chunk) => {
			buffers[name] += chunk.toString('utf8');
			const parts = buffers[name].split(/\r?\n/);
			buffers[name] = parts.pop();
			parts.forEach(takeLine);
		};
		child.stdout.on('data', feed('stdout'));
		child.stderr.on('data', feed('stderr'));
		const timer = setTimeout(() => {
			timedOut = true;
			killTree(child);
		}, timeoutSeconds * 1000);
		child.on('error', (error) => {
			clearTimeout(timer);
			lines.push(`could not start the runner: ${error.message}`);
			resolve({ lines, result, timedOut, exitCode: null, signal: null });
		});
		child.on('close', (exitCode, signal) => {
			clearTimeout(timer);
			Object.values(buffers).forEach((rest) => rest && takeLine(rest));
			resolve({ lines, result, timedOut, exitCode, signal });
		});
	});
}

function assertSafeTarEntries(entries) {
	for (const entry of entries) {
		const parts = entry.split('/');
		if (entry.startsWith('/') || parts.includes('..') || /^[a-z]:/i.test(entry)) {
			throw new ScriptError('UNSAFE_ARCHIVE', `the source archive has an unsafe path: ${entry.slice(0, 80)}`);
		}
	}
}

async function downloadTarball({ ref, destFile, fetchImpl = fetch }) {
	const response = await fetchImpl(`https://codeload.github.com/${GITHUB_REPO}/tar.gz/${ref}`, {
		redirect: 'follow',
		signal: AbortSignal.timeout(TARBALL_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new ScriptError('VERSION_NOT_FOUND', `GitHub has no commit ${ref} in ${GITHUB_REPO} (HTTP ${response.status})`);
	}
	let seen = 0;
	const limit = new Transform({
		transform(chunk, _encoding, callback) {
			seen += chunk.length;
			if (seen > TARBALL_MAX_BYTES) callback(new ScriptError('ARCHIVE_TOO_LARGE', 'the source archive is larger than 100 MB'));
			else callback(null, chunk);
		},
	});
	await pipeline(Readable.fromWeb(response.body), limit, fs.createWriteStream(destFile));
}

// The top directory of a GitHub source archive is <repo>-<the ref that was asked for>/ (a short SHA stays
// short). Some tars (busybox) also list a pax_global_header entry first, so the first entry is not
// necessarily the directory.
function findArchiveTop(entries) {
	const match = entries.map((entry) => /^([^/]+)-([0-9a-f]{7,40})\//.exec(entry)).find(Boolean);
	return match ? { directory: `${match[1]}-${match[2]}`, ref: match[2] } : null;
}

// GitHub writes the full commit SHA into the archive's pax global header ("comment=<sha>"), which is the
// first thing in the file; only the beginning of the gzip stream is read.
function readArchiveSha(file) {
	try {
		const head = Buffer.alloc(8192);
		const fd = fs.openSync(file, 'r');
		let length;
		try {
			length = fs.readSync(fd, head, 0, head.length, 0);
		}
		finally {
			fs.closeSync(fd);
		}
		const text = zlib.gunzipSync(head.subarray(0, length), { finishFlush: zlib.constants.Z_SYNC_FLUSH }).subarray(0, 2048).toString('latin1');
		const match = /comment=([0-9a-f]{40})\b/.exec(text);
		return match ? match[1] : null;
	}
	catch {
		return null;
	}
}

async function extractFromGithub({ ref, staging, tree, fetchImpl }) {
	await downloadTarball({ ref, destFile: path.join(staging, 'source.tar.gz'), fetchImpl });
	const { stdout } = await execFileAsync('tar', ['-tzf', 'source.tar.gz'], { cwd: staging, maxBuffer: 64 * 1024 * 1024, timeout: 60 * 1000 });
	const entries = stdout.split('\n').filter(Boolean);
	assertSafeTarEntries(entries);
	const top = findArchiveTop(entries);
	if (!top) throw new ScriptError('BAD_ARCHIVE', 'the source archive has an unexpected layout');
	await execFileAsync('tar', ['-xzf', 'source.tar.gz', '-C', path.relative(staging, tree), '--strip-components=1'], { cwd: staging, timeout: 120 * 1000 });
	const fullSha = readArchiveSha(path.join(staging, 'source.tar.gz')) ?? (top.ref.length === 40 ? top.ref : null);
	if (fullSha) return { sha: fullSha, source: 'github' };
	return { sha: top.ref, source: 'github', note: 'the full commit SHA could not be read from the archive; version_sha is the (short) SHA as given' };
}

async function extractFromGit({ ref, repoRoot, staging, tree }) {
	const { stdout } = await execFileAsync('git', ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { timeout: 30 * 1000 });
	const sha = stdout.trim();
	const archive = path.join(staging, 'source.tar');
	await execFileAsync('git', ['-C', repoRoot, 'archive', '--format=tar', '-o', archive, sha], { timeout: 60 * 1000 });
	const { stdout: listing } = await execFileAsync('tar', ['-tf', 'source.tar'], { cwd: staging, maxBuffer: 64 * 1024 * 1024, timeout: 60 * 1000 });
	assertSafeTarEntries(listing.split('\n').filter(Boolean));
	await execFileAsync('tar', ['-xf', 'source.tar', '-C', path.relative(staging, tree)], { cwd: staging, timeout: 120 * 1000 });
	return { sha, source: 'git' };
}

function currentVersion() {
	const fromEnv = (process.env.SOURCE_COMMIT ?? '').trim();
	if (/^[0-9a-f]{40}$/i.test(fromEnv)) return fromEnv.toLowerCase();
	return null;
}

// Puts the requested version in `tree` and returns { sha, source }.
async function prepareTree({ options, repoRoot, staging, tree, fetchImpl }) {
	if (options.ref === 'current') {
		return { tree: repoRoot, sha: currentVersion() ?? 'unknown', source: 'current' };
	}
	let extracted = null;
	const gitUsable = fs.existsSync(path.join(repoRoot, '.git'));
	if (options.source !== 'github' && gitUsable) {
		try {
			extracted = await extractFromGit({ ref: options.ref, repoRoot, staging, tree });
		}
		catch (error) {
			if (options.source === 'git') throw new ScriptError('VERSION_NOT_FOUND', `git could not provide ${options.ref}: ${String(error.message).split('\n')[0]}`);
			await fsp.rm(tree, { recursive: true, force: true });
			await fsp.mkdir(tree, { recursive: true });
		}
	}
	else if (options.source === 'git') {
		throw new ScriptError('NO_GIT', 'no .git directory next to this script; use --source github');
	}
	if (!extracted) extracted = await extractFromGithub({ ref: options.ref, staging, tree, fetchImpl });
	if (!fs.existsSync(path.join(tree, 'services', 'media.js'))) {
		throw new ScriptError('BAD_TREE', `commit ${extracted.sha.slice(0, 12)} has no services/media.js`);
	}
	return { tree, ...extracted };
}

// The old version runs on the dependencies of this copy; say so when its package.json asks for others.
async function linkDependencies({ repoRoot, tree }) {
	const source = path.join(repoRoot, 'node_modules');
	if (!fs.existsSync(source)) throw new ScriptError('NO_NODE_MODULES', 'node_modules is missing next to this script');
	await fsp.rm(path.join(tree, 'node_modules'), { recursive: true, force: true });
	await fsp.symlink(source, path.join(tree, 'node_modules'), 'junction');
	try {
		const wanted = JSON.parse(await fsp.readFile(path.join(tree, 'package.json'), 'utf8')).dependencies ?? {};
		const have = JSON.parse(await fsp.readFile(path.join(repoRoot, 'package.json'), 'utf8')).dependencies ?? {};
		if (JSON.stringify(Object.entries(wanted).sort()) !== JSON.stringify(Object.entries(have).sort())) {
			return ['the requested version lists other dependencies than this copy; it ran on this copy\'s node_modules'];
		}
	}
	catch {
		return ['could not compare the dependency lists'];
	}
	return [];
}

function freeBytes(dir, statfs = fs.statfsSync) {
	const stats = statfs(dir);
	return Number(stats.bavail) * Number(stats.bsize);
}

function usageText() {
	return [
		'usage: node scripts/repro.js <url> --ref <sha|current> [--max-bytes N] [--timeout SECONDS] [--min-free-mb N]',
		'                             [--source auto|git|github] [--pretty] [--keep]',
		'Downloads one link at one version of the bot and prints what came out as JSON. Never uploads, never uses Discord.',
	].join('\n');
}

// The staging tree holds a link to the real node_modules. It is taken off on its own before the directory is
// deleted, so a recursive delete can never follow it into the bot's dependencies.
function removeLinkSync(target) {
	let isLink;
	try {
		isLink = fs.lstatSync(target).isSymbolicLink();
	}
	catch {
		return;
	}
	if (!isLink) return;
	try {
		fs.unlinkSync(target);
	}
	catch {
		fs.rmdirSync(target);
	}
}

function removeStagingSync(staging) {
	removeLinkSync(path.join(staging, 'tree', 'node_modules'));
	fs.rmSync(staging, { recursive: true, force: true });
}

// What is cleaned up when the process is stopped early (SIGINT, SIGTERM, the watchdog).
const active = { staging: null, child: null };

function emergencyCleanup() {
	const { child, staging } = active;
	active.child = null;
	active.staging = null;
	if (child?.pid) {
		try {
			if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { timeout: 10 * 1000 });
			else process.kill(-child.pid, 'SIGKILL');
		}
		catch {
			child.kill('SIGKILL');
		}
	}
	if (staging) removeStagingSync(staging);
}

// deps are injectable for tests. --timeout is the budget of the whole run, set-up included.
async function main(argv, deps = {}) {
	const {
		repoRoot = REPO_ROOT,
		stdout = process.stdout,
		env = process.env,
		fetchImpl,
		statfs,
		runnerPath,
		loadMedia = () => require(path.join(REPO_ROOT, 'services', 'media.js')),
		readFromBot = () => readBotEnviron(repoRoot),
		now = Date.now,
		tmpdir = os.tmpdir(),
		watchdogMs,
		onWatchdog,
	} = deps;
	let options;
	let staging = null;
	let keepStaging = false;
	let watchdog = null;
	const secretValues = [];
	const print = (value, pretty) => {
		const text = JSON.stringify(value, null, pretty ? 2 : undefined);
		stdout.write(`${redact(text, secretValues)}\n`);
	};
	const startedAll = now();
	try {
		options = parseArgs(argv);
		if (options.help) {
			stdout.write(`${usageText()}\n`);
			return EXIT.OK;
		}
		keepStaging = options.keep;
		validateUrl(options.url);
		const site = loadMedia().findSupportedSite(options.url);
		if (!site) throw new ScriptError('UNSUPPORTED_LINK', 'the link is not on the list of supported sites', EXIT.USAGE);

		const free = freeBytes(tmpdir, statfs);
		if (free < options.minFreeMb * 1000 * 1000) {
			throw new ScriptError('LOW_DISK', `only ${Math.round(free / 1000 / 1000)} MB free in ${tmpdir} (need ${options.minFreeMb} MB); not running`);
		}

		await sweepStale(tmpdir, now);
		staging = await fsp.mkdtemp(path.join(tmpdir, 'repro-'));
		active.staging = staging;
		watchdog = setTimeout(
			onWatchdog ?? (() => {
				emergencyCleanup();
				print({ ok: false, measured: false, script_error: { code: 'WATCHDOG', message: 'the run did not finish in time and was stopped' } });
				process.exit(124);
			}),
			watchdogMs ?? (options.timeoutSeconds + WATCHDOG_EXTRA_SECONDS) * 1000,
		);
		watchdog.unref();
		const tree = path.join(staging, 'tree');
		const stagingTmp = path.join(staging, 'tmp');
		await fsp.mkdir(tree);
		await fsp.mkdir(stagingTmp);

		const version = await prepareTree({ options, repoRoot, staging, tree, fetchImpl });
		const notes = options.ref === 'current' ? ['ran the copy this script belongs to (no extraction)'] : [];
		if (version.note) notes.push(version.note);
		if (options.ref !== 'current') notes.push(...(await linkDependencies({ repoRoot, tree: version.tree })));

		const childEnv = buildChildEnv(env, stagingTmp, readFromBot());
		secretValues.push(...collectRedactions(childEnv));
		if (!SECRET_ENV_KEYS.every((key) => childEnv[key])) {
			notes.push('LINKHUB_API_URL / LINKHUB_API_KEY were not found: only the local (non-LinkHub) route can run');
		}

		const timeoutSeconds = Math.max(5, options.timeoutSeconds - Math.ceil((now() - startedAll) / 1000));
		const started = now();
		const childOutcome = await runChild({
			tree: version.tree,
			url: options.url,
			maxBytes: options.maxBytes,
			timeoutSeconds,
			env: childEnv,
			runnerPath,
			onChild: (child) => {
				active.child = child;
			},
		});
		active.child = null;
		const report = buildReport({ options, siteName: site.name, version, childOutcome, elapsedMs: now() - started, notes, timeoutSeconds });
		if (keepStaging) report.notes.push(`staging directory kept: ${staging}`);
		print(report, options.pretty);
		return EXIT.OK;
	}
	catch (error) {
		const known = error instanceof ScriptError;
		print({
			ok: false,
			measured: false,
			script_error: { code: known ? error.code : 'UNEXPECTED', message: String(error.message).slice(0, 400) },
		}, options?.pretty);
		return known ? error.exitCode : EXIT.SETUP;
	}
	finally {
		if (watchdog) clearTimeout(watchdog);
		active.child = null;
		if (staging && !keepStaging) removeStagingSync(staging);
		active.staging = null;
	}
}

module.exports = {
	main,
	parseArgs,
	validateUrl,
	extractContentId,
	buildChildEnv,
	collectRedactions,
	readBotEnviron,
	parseEnviron,
	redact,
	sweepStale,
	removeStagingSync,
	analyzeLog,
	buildReport,
	runChild,
	assertSafeTarEntries,
	findArchiveTop,
	readArchiveSha,
	freeBytes,
	emergencyCleanup,
	ScriptError,
	EXIT,
	PLAIN_ENV_KEYS,
	SECRET_ENV_KEYS,
};

if (require.main === module) {
	const stop = (code) => () => {
		emergencyCleanup();
		process.exit(code);
	};
	process.on('SIGINT', stop(EXIT.SIGINT));
	process.on('SIGTERM', stop(EXIT.SIGTERM));
	main(process.argv.slice(2)).then((code) => {
		process.exitCode = code;
	});
}
