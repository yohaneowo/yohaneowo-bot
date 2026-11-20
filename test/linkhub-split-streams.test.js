// LinkHub items whose video and audio come as separate streams (2026-11-18 to 11-20: every Facebook reel the
// stable bot posted had no sound). No network: fetch is replaced by a fake gateway.
process.env.LINKHUB_API_URL = 'http://linkhub.test';
process.env.LINKHUB_API_KEY = 'test-key';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { downloadItem, fetchViaLinkHub, pickVideoFormat } = require('../services/sites/linkhub');
const { createFallbackChain, createRepairState } = require('../services/sites/chain');

const FB_URL = 'https://www.facebook.com/share/r/19xsPYpwC5/';
let dir;
let fetched;
const realFetch = globalThis.fetch;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkhub-split-test-'));
	fetched = [];
});
afterEach(() => {
	globalThis.fetch = realFetch;
	fs.rmSync(dir, { recursive: true, force: true });
});

const download = (id) => `http://linkhub.test/v1/download?t=${id}`;

// The formats LinkHub's yt-dlp adapter returned for FB_URL (measured in dev 2026-11-20; ids shortened, order kept:
// tallest first). hd / sd are single files with sound, but yt-dlp does not know their codecs, so both flags are false.
function facebookReel() {
	const avc = (id, height) => ({ id, url: download(id), downloadUrl: download(id), ext: 'mp4', height, hasVideo: true, hasAudio: false, videoCodec: 'av01.0.08M.08.0.111.01.01.01.0' });
	return {
		type: 'video',
		durationSec: 80,
		formats: [
			avc('202v', 1920),
			avc('870v', 1280),
			avc('203v', 1280),
			{ id: '594a', url: download('594a'), downloadUrl: download('594a'), ext: 'm4a', hasVideo: false, hasAudio: true, audioCodec: 'mp4a.40.5' },
			{ id: 'sd', url: download('sd'), downloadUrl: download('sd'), ext: 'mp4', hasVideo: false, hasAudio: false },
			{ id: 'hd', url: download('hd'), downloadUrl: download('hd'), ext: 'mp4', hasVideo: false, hasAudio: false },
		],
	};
}

function fakeGateway(item) {
	globalThis.fetch = async (input) => {
		const url = new URL(String(input));
		fetched.push(url.pathname + url.search);
		if (url.pathname === '/v1/parse') {
			return new Response(JSON.stringify({ ok: true, post: { title: '' }, items: [item], meta: { platform: 'facebook', adapter: 'ytdlp' } }), { headers: { 'content-type': 'application/json' } });
		}
		return new Response(Buffer.alloc(20000, 1), { headers: { 'content-type': 'video/mp4' } });
	};
}

test('the old pick for this reel is the tallest video-only stream (what was posted without sound)', () => {
	const picked = pickVideoFormat(facebookReel().formats, 49_000_000);
	assert.equal(picked.id, '202v');
	assert.equal(picked.hasAudio, false);
});

test('a video-only pick when the item also has an audio-only stream fails instead of downloading a silent file', async () => {
	fakeGateway(null);
	await assert.rejects(downloadItem(facebookReel(), dir, 1, 49_000_000), (error) => {
		assert.equal(error.code, 'SPLIT_STREAMS');
		assert.match(error.message, /202v/);
		return true;
	});
	assert.deepEqual(fetched, [], 'nothing was downloaded');
});

test('a video-only stream is still used when the item has no audio stream at all', async () => {
	fakeGateway(null);
	const item = facebookReel();
	item.formats = item.formats.filter((format) => !(format.hasAudio === true && format.hasVideo === false));
	const file = await downloadItem(item, dir, 1, 49_000_000);
	assert.equal(file.isVideo, true);
	assert.deepEqual(fetched, ['/v1/download?t=202v']);
});

test('only a format marked as audio counts as a separate audio stream (unknown flags do not)', async () => {
	fakeGateway(null);
	const item = facebookReel();
	item.formats = item.formats
		.filter((format) => !(format.hasAudio === true && format.hasVideo === false))
		.concat({ id: 'unknown', url: download('unknown'), downloadUrl: download('unknown'), ext: 'mp4', hasVideo: false });
	const file = await downloadItem(item, dir, 1, 49_000_000);
	assert.equal(file.isVideo, true);
	assert.deepEqual(fetched, ['/v1/download?t=202v']);
});

test('a combined format is picked as before and nothing fails', async () => {
	fakeGateway(null);
	const item = facebookReel();
	item.formats.push({ id: 'both', url: download('both'), downloadUrl: download('both'), ext: 'mp4', hasVideo: true, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac' });
	const file = await downloadItem(item, dir, 1, 49_000_000);
	assert.equal(file.isVideo, true);
	assert.deepEqual(fetched, ['/v1/download?t=both']);
});

test('in the chain, LinkHub fails on the split reel and the site\'s own parser delivers the video', async () => {
	fakeGateway(facebookReel());
	let localCalls = 0;
	const local = async (url, rungDir) => {
		localCalls += 1;
		const filePath = path.join(rungDir, 'video.mp4');
		fs.writeFileSync(filePath, Buffer.alloc(20000, 2));
		return { files: [{ path: filePath, name: 'video.mp4' }], author: '', text: '', compressed: false };
	};
	const chain = createFallbackChain({
		site: 'Facebook',
		rungs: [
			{ name: 'linkhub', repair: false, enabled: () => true, run: fetchViaLinkHub },
			{ name: 'local', repair: false, enabled: () => true, run: local },
		],
		state: createRepairState(() => 1_000_000),
		now: () => 1_000_000,
		isBusy: () => false,
		probe: async () => ({ duration: 80, codec: 'h264' }),
	});
	const result = await chain(FB_URL, dir, 49_000_000);
	assert.equal(result.layer, 'local');
	assert.equal(localCalls, 1);
	assert.deepEqual(fetched, ['/v1/parse?raw=1'], 'LinkHub was asked, but its video-only stream was not downloaded');
});
