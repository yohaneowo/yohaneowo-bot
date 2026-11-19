#!/usr/bin/env node
// The child process of scripts/repro.js. It loads the bot's own downloadMedia() from the version tree it
// is given (--tree), downloads one link into a temp dir, measures what came out and prints one
// "REPRO_RESULT <json>" line. It never uploads anything and never talks to Discord: the parent gives it a
// minimal environment without the bot token.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const FFPROBE_PATH = process.env.FFPROBE_PATH || 'ffprobe';

function readOption(name) {
	const index = process.argv.indexOf(name);
	return index === -1 ? null : process.argv[index + 1] ?? null;
}

// Width, height, codec and length of one file, read by ffprobe (null when it cannot be read).
async function probe(filePath) {
	try {
		const { stdout } = await execFileAsync(
			FFPROBE_PATH,
			[
				'-v', 'error',
				'-select_streams', 'v:0',
				'-show_entries', 'stream=width,height,codec_name:format=duration',
				'-of', 'json',
				filePath,
			],
			{ timeout: 30 * 1000 },
		);
		const { streams, format } = JSON.parse(stdout);
		const duration = Number(format?.duration);
		return {
			width: streams?.[0]?.width ?? null,
			height: streams?.[0]?.height ?? null,
			codec: streams?.[0]?.codec_name ?? null,
			duration_sec: duration > 0 ? Math.round(duration * 100) / 100 : null,
		};
	}
	catch {
		return { width: null, height: null, codec: null, duration_sec: null };
	}
}

function describeError(error) {
	return {
		code: error.code ?? null,
		name: error.name ?? 'Error',
		message: String(error.message ?? error).slice(0, 300),
		tried: Array.isArray(error.tried) ? error.tried : null,
		detail: error.detail ? String(error.detail).slice(0, 300) : null,
	};
}

async function measure(media) {
	const files = [];
	for (const file of media.files) {
		const { size } = fs.statSync(file.path);
		files.push({ name: file.name, bytes: size, ...(await probe(file.path)) });
	}
	const firstVideo = files.find((file) => file.duration_sec !== null);
	return {
		files,
		bytes_total: files.reduce((sum, file) => sum + file.bytes, 0),
		duration_sec: firstVideo ? firstVideo.duration_sec : null,
		compressed: Boolean(media.compressed),
		layer: media.layer ?? null,
		stages: media.stages ?? [],
	};
}

async function main() {
	const tree = readOption('--tree');
	const url = readOption('--url');
	const maxBytes = Number(readOption('--max-bytes'));
	if (!tree || !url || !(maxBytes > 0)) {
		console.log(`REPRO_RESULT ${JSON.stringify({ ok: false, error: { code: 'RUNNER_USAGE', message: 'bad arguments' } })}`);
		return;
	}

	let result;
	const stages = [];
	try {
		const media = require(path.join(tree, 'services', 'media.js'));
		if (!media.findSupportedSite(url)) {
			result = { ok: false, error: { code: 'UNSUPPORTED', name: 'Error', message: 'this version does not support the link' } };
		}
		else {
			const downloaded = await media.downloadMedia(url, maxBytes, (stage) => stages.push(stage));
			try {
				result = { ok: true, ...(await measure({ ...downloaded, stages })) };
			}
			finally {
				await downloaded.cleanup();
			}
		}
	}
	catch (error) {
		result = { ok: false, error: describeError(error), stages };
	}
	console.log(`REPRO_RESULT ${JSON.stringify(result)}`);
}

main()
	.catch((error) => {
		console.log(`REPRO_RESULT ${JSON.stringify({ ok: false, error: describeError(error) })}`);
	})
	.finally(() => process.exit(0));
