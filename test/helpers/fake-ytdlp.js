#!/usr/bin/env node
// A stand-in for yt-dlp, used through YTDLP_PATH by test/ytdlp-stub.test.js. It records how it was
// called and, for the first STUB_FAILURES calls, "downloads" an empty file the way a broken
// download does; after that it writes a real two-second mp4 (made with ffmpeg) so the bot's
// ffprobe check passes. It prints the --dump-json line yt-dlp prints once extraction is done.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const args = process.argv.slice(2);
const stateFile = process.env.STUB_STATE;
const failures = Number(process.env.STUB_FAILURES ?? 0);
const calls = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8').split('\n').filter(Boolean).length : 0;

const template = args[args.indexOf('-o') + 1];
const outDir = path.dirname(template);
fs.appendFileSync(stateFile, `${JSON.stringify({ args, filesAlreadyThere: fs.readdirSync(outDir) })}\n`);

const out = template.replace('%(ext)s', 'mp4');
if (process.env.STUB_HANG) {
	// Never finish, like a stuck download; the pid lets the test check the process was killed.
	fs.writeFileSync(process.env.STUB_PID_FILE, String(process.pid));
	setInterval(() => undefined, 1000);
}
else {
	if (calls < failures) {
		fs.writeFileSync(out, '');
	}
	else {
		const made = spawnSync(
			'ffmpeg',
			['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=15', '-t', '2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-y', out],
			{ encoding: 'utf8' },
		);
		if (made.status !== 0) {
			console.error(`ffmpeg failed: ${made.stderr}`);
			process.exit(1);
		}
	}
	console.log(JSON.stringify({ format_id: '18', duration: 2, uploader: 'Stub', uploader_id: '@Stub', title: 'stub video' }));
}
