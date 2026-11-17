// How the yt-dlp command line is built. The default strategy must stay exactly what it was before
// the retry ladder existed; the alternative strategy only changes what it is meant to.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildYtDlpArgs, buildAltFormatSelector } = require('../services/sites/video');

const MAX = 9_800_000;
const DIR = path.join('tmp', 'rung-1');
const YT = 'https://www.youtube.com/shorts/HPawwstzIU0';

function after(args, flag) {
	return args[args.indexOf(flag) + 1];
}

test('default strategy: the same arguments as before the retry ladder (nothing alternative leaks in)', () => {
	const args = buildYtDlpArgs({ url: YT, dir: DIR, maxBytes: MAX });
	assert.deepEqual(args.slice(0, 4), ['--no-playlist', '--no-warnings', '--dump-json', '--no-simulate']);
	assert.equal(after(args, '-S'), 'res,br');
	assert.equal(after(args, '--merge-output-format'), 'mp4');
	assert.equal(after(args, '--js-runtimes'), `node:${process.execPath}`);
	assert.equal(args.includes('--extractor-args'), false);
	assert.equal(after(args, '-o'), path.join(DIR, 'video.%(ext)s'));
	assert.deepEqual(args.slice(-2), ['--', YT]);
	// The old selector merged video + audio when no single file fits.
	assert.match(after(args, '-f'), /\+ba/);
});

test('alt strategy: a single smaller file, no video+audio merge, and the mweb client for YouTube', () => {
	const args = buildYtDlpArgs({ url: YT, dir: DIR, maxBytes: MAX, strategy: 'alt' });
	const selector = after(args, '-f');
	assert.equal(selector, buildAltFormatSelector(MAX));
	assert.equal(selector.includes('+'), false, 'no "+": nothing for ffmpeg to merge');
	assert.match(selector, /^b\[ext=mp4\]\[filesize<9800000\]\//);
	assert.equal(after(args, '-S'), 'res:480,br');
	assert.equal(after(args, '--extractor-args'), 'youtube:player_client=mweb');
	assert.deepEqual(args.slice(-2), ['--', YT]);
});

test('alt strategy leaves other sites on their normal client', () => {
	for (const url of [
		'https://www.tiktok.com/@scout2015/video/6718335390845095173',
		'https://www.bilibili.com/video/BV17YdXY4Ewj',
	]) {
		const args = buildYtDlpArgs({ url, dir: DIR, maxBytes: MAX, strategy: 'alt' });
		assert.equal(args.includes('--extractor-args'), false, url);
		assert.equal(after(args, '-S'), 'res:480,br');
	}
});

test('a youtu.be link also gets the YouTube client switch', () => {
	const args = buildYtDlpArgs({ url: 'https://youtu.be/HPawwstzIU0', dir: DIR, maxBytes: MAX, strategy: 'alt' });
	assert.equal(after(args, '--extractor-args'), 'youtube:player_client=mweb');
});
