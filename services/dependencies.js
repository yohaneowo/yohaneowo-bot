// Builds the dependency list reported to yohaneowo-admin's「项目依赖」page: every package in
// package.json (with the version actually installed), the command-line tools the bot shells out
// to, and the external services listed in dependencies.json. The admin checks each one upstream.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const ROOT = path.join(__dirname, '..');
const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp';
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';

async function readJson(file) {
	return JSON.parse(await fs.readFile(file, 'utf8'));
}

// Reads node_modules directly: some packages' "exports" field blocks require('<pkg>/package.json').
async function installedNpmVersion(name) {
	try {
		return (await readJson(path.join(ROOT, 'node_modules', name, 'package.json'))).version ?? null;
	}
	catch {
		return null;
	}
}

// First line of a tool's version output, or null when the tool isn't installed.
async function toolVersion(command, args, pattern) {
	try {
		const { stdout } = await execFileAsync(command, args, { timeout: 10 * 1000, windowsHide: true });
		const firstLine = stdout.split('\n')[0].trim();
		return (pattern ? firstLine.match(pattern)?.[1] : firstLine) || null;
	}
	catch {
		return null;
	}
}

async function collectDependencies() {
	const [pkg, declared] = await Promise.all([
		readJson(path.join(ROOT, 'package.json')),
		readJson(path.join(ROOT, 'dependencies.json')),
	]);

	const npm = await Promise.all(
		Object.keys(pkg.dependencies ?? {}).map(async (name) => ({
			name,
			category: 'npm 套件',
			kind: 'npm',
			source: name,
			usage: declared.npm?.[name] ?? null,
			installed_version: await installedNpmVersion(name),
		})),
	);

	const [ytdlp, ffmpeg] = await Promise.all([
		toolVersion(YTDLP_PATH, ['--version']),
		// "ffmpeg version 6.1.1 Copyright ..." / "ffmpeg version n7.1-..." -> 6.1.1 / n7.1
		toolVersion(FFMPEG_PATH, ['-version'], /^ffmpeg version (\S+)/),
	]);
	const tools = [
		{
			name: 'yt-dlp',
			category: '工具',
			kind: 'pypi',
			source: 'yt-dlp',
			usage: 'TikTok、Facebook、YouTube、X 等影片下载（网站改版时最需要跟上新版）',
			installed_version: ytdlp,
		},
		{ name: 'ffmpeg', category: '工具', kind: 'none', source: '', usage: '影片压缩与预览图', installed_version: ffmpeg },
		{ name: 'Node.js', category: '工具', kind: 'none', source: '', usage: '运行环境', installed_version: process.versions.node },
	];
	const external = (declared.external ?? []).map((dep) => ({ category: '外部服务', ...dep }));
	const critical = new Set(declared.critical ?? []);
	for (const dep of [...npm, ...tools]) dep.critical = critical.has(dep.name);

	return [...npm, ...tools, ...external];
}

module.exports = { collectDependencies };
