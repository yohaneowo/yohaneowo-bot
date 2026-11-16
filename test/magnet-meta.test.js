// Magnet title lookup: .torrent parsing and the cache fetch. No network: fetch is a fake.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseTorrent, fetchTorrentMeta, formatBytes } = require('../services/magnetMeta');
const { makeTorrent } = require('./helpers-torrent');

const MULTI = makeTorrent({
	name: 'Show [1080p]',
	'piece length': 16384,
	pieces: Buffer.alloc(20),
	files: [
		{ length: 1_500_000_000, path: ['Show [01].mkv'] },
		{ length: 43_000, path: ['subs', 'Show [01].ass'] },
	],
});
const SINGLE = makeTorrent({ name: 'single.mkv', length: 700_000, 'piece length': 16384, pieces: Buffer.alloc(20) });

test('parseTorrent reads a multi-file torrent', () => {
	const meta = parseTorrent(MULTI.buffer, MULTI.infohash);
	assert.equal(meta.name, 'Show [1080p]');
	assert.equal(meta.fileCount, 2);
	assert.equal(meta.totalBytes, 1_500_043_000);
	assert.deepEqual(meta.files[1], { path: 'subs/Show [01].ass', size: 43_000 });
});

test('parseTorrent reads a single-file torrent and prefers name.utf-8', () => {
	const meta = parseTorrent(SINGLE.buffer, SINGLE.infohash);
	assert.deepEqual([meta.name, meta.fileCount, meta.totalBytes], ['single.mkv', 1, 700_000]);
	const utf8 = makeTorrent({ name: 'garbled', 'name.utf-8': '中文名', length: 1, 'piece length': 1, pieces: Buffer.alloc(20) });
	assert.equal(parseTorrent(utf8.buffer, utf8.infohash).name, '中文名');
});

test('parseTorrent rejects a torrent whose hash differs and malformed data', () => {
	assert.throws(() => parseTorrent(MULTI.buffer, SINGLE.infohash), /mismatch/);
	assert.throws(() => parseTorrent(MULTI.buffer.subarray(0, 40), MULTI.infohash));
	assert.throws(() => parseTorrent(Buffer.from('not bencode'), MULTI.infohash));
	assert.throws(() => parseTorrent(Buffer.from('de'), MULTI.infohash), /info/);
	assert.throws(() => parseTorrent(Buffer.from('l'.repeat(40)), MULTI.infohash));
});

test('fetchTorrentMeta returns metadata from a matching cache response', async () => {
	let requested;
	const fetchImpl = async (url) => {
		requested = url;
		return new Response(MULTI.buffer, { status: 200 });
	};
	const meta = await fetchTorrentMeta(MULTI.infohash, { fetchImpl });
	assert.equal(meta.name, 'Show [1080p]');
	assert.ok(requested.endsWith(`${MULTI.infohash.toUpperCase()}.torrent`));
});

test('fetchTorrentMeta returns null for misses, wrong torrents, oversize bodies and errors', async () => {
	const respond = (build) => ({ fetchImpl: async () => build() });
	assert.equal(await fetchTorrentMeta(MULTI.infohash, respond(() => new Response('nope', { status: 404 }))), null);
	assert.equal(await fetchTorrentMeta(MULTI.infohash, respond(() => new Response(SINGLE.buffer))), null);
	assert.equal(await fetchTorrentMeta(MULTI.infohash, respond(() => new Response('<html>captcha</html>'))), null);
	assert.equal(
		await fetchTorrentMeta(MULTI.infohash, { ...respond(() => new Response(MULTI.buffer)), maxBytes: 50 }),
		null,
	);
	const failing = {
		fetchImpl: async () => {
			throw new Error('network down');
		},
	};
	assert.equal(await fetchTorrentMeta(MULTI.infohash, failing), null);
});

test('formatBytes uses decimal units', () => {
	assert.equal(formatBytes(0), '未知');
	assert.equal(formatBytes(999), '999 B');
	assert.equal(formatBytes(18_000_000_000), '18.0 GB');
	assert.equal(formatBytes(1_500_000), '1.5 MB');
});
