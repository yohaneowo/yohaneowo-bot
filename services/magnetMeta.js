const crypto = require('node:crypto');

// Looks up a magnet link's real name, size and file list. A magnet link only carries an info hash
// (and sometimes a display name), so the .torrent metadata is fetched from a public torrent cache.
// The download is trusted only when SHA-1 of its "info" dictionary equals the info hash, so a cache
// cannot hand back a different torrent. Lookups never throw: a miss just means no metadata.

const DEFAULT_SOURCE = 'https://itorrents.org/torrent/{HASH}.torrent';
const LOOKUP_TIMEOUT_MS = 8 * 1000;
const MAX_TORRENT_BYTES = 5 * 1000 * 1000;
const MAX_NESTING = 16;
const MAX_NAME_LENGTH = 300;
const MAX_LISTED_FILES = 8;

// Minimal bencode reader. Byte strings come back as Buffers, dictionary keys as latin1 strings.
// When `topLevel` is set, the byte range of the root dictionary's "info" value is recorded.
function readValue(buf, start, depth, span) {
	if (depth > MAX_NESTING || start >= buf.length) throw new Error('malformed bencode');
	const lead = buf[start];
	if (lead === 0x69) {
		const end = buf.indexOf(0x65, start);
		const digits = end === -1 ? '' : buf.toString('latin1', start + 1, end);
		if (!/^-?\d+$/.test(digits)) throw new Error('malformed integer');
		return [Number(digits), end + 1];
	}
	if (lead === 0x6c) {
		const list = [];
		let pos = start + 1;
		while (buf[pos] !== 0x65) {
			if (pos >= buf.length) throw new Error('unterminated list');
			const [value, next] = readValue(buf, pos, depth + 1, null);
			list.push(value);
			pos = next;
		}
		return [list, pos + 1];
	}
	if (lead === 0x64) {
		const dict = {};
		let pos = start + 1;
		while (buf[pos] !== 0x65) {
			if (pos >= buf.length) throw new Error('unterminated dictionary');
			const [key, afterKey] = readValue(buf, pos, depth + 1, null);
			if (!Buffer.isBuffer(key)) throw new Error('malformed dictionary key');
			const name = key.toString('latin1');
			const [value, next] = readValue(buf, afterKey, depth + 1, null);
			if (span && depth === 0 && name === 'info') span.info = [afterKey, next];
			dict[name] = value;
			pos = next;
		}
		return [dict, pos + 1];
	}
	const colon = buf.indexOf(0x3a, start);
	const lengthText = colon === -1 ? '' : buf.toString('latin1', start, colon);
	if (!/^\d+$/.test(lengthText)) throw new Error('malformed string');
	const end = colon + 1 + Number(lengthText);
	if (end > buf.length) throw new Error('string past end');
	return [buf.subarray(colon + 1, end), end];
}

function text(value) {
	return Buffer.isBuffer(value) ? value.toString('utf8').replace(/\s+/g, ' ').trim() : '';
}

// Returns { name, totalBytes, fileCount, files: [{ path, size }] } for a .torrent whose info hash
// matches `expectedInfohash` (40 lowercase hex); throws otherwise.
function parseTorrent(buf, expectedInfohash) {
	const span = {};
	const [root] = readValue(buf, 0, 0, span);
	const info = root?.info;
	if (!span.info || !info || Buffer.isBuffer(info) || Array.isArray(info) || typeof info !== 'object') {
		throw new Error('no info dictionary');
	}
	const actual = crypto.createHash('sha1').update(buf.subarray(span.info[0], span.info[1])).digest('hex');
	if (actual !== expectedInfohash) throw new Error('info hash mismatch');

	const name = text(info['name.utf-8'] ?? info.name).slice(0, MAX_NAME_LENGTH);
	let files;
	if (Array.isArray(info.files)) {
		files = info.files.map((file) => ({
			path: (file?.['path.utf-8'] ?? file?.path ?? []).map(text).join('/').slice(0, MAX_NAME_LENGTH),
			size: Number(file?.length) || 0,
		}));
	}
	else {
		files = [{ path: name, size: Number(info.length) || 0 }];
	}
	return {
		name,
		totalBytes: files.reduce((sum, file) => sum + file.size, 0),
		fileCount: files.length,
		files: files.slice(0, MAX_LISTED_FILES),
	};
}

async function readCapped(response, maxBytes) {
	const length = Number(response.headers.get('content-length'));
	if (length > maxBytes || !response.body) return null;
	const reader = response.body.getReader();
	const chunks = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.length;
		if (total > maxBytes) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks);
}

// Resolves to parseTorrent()'s result, or null when the cache has nothing usable.
async function fetchTorrentMeta(infohash, options = {}) {
	const {
		fetchImpl = fetch,
		source = DEFAULT_SOURCE,
		timeoutMs = LOOKUP_TIMEOUT_MS,
		maxBytes = MAX_TORRENT_BYTES,
	} = options;
	try {
		const response = await fetchImpl(source.replace('{HASH}', infohash.toUpperCase()), {
			headers: { 'user-agent': 'Mozilla/5.0 (compatible; yohaneowo-bot)' },
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) return null;
		const body = await readCapped(response, maxBytes);
		return body ? parseTorrent(body, infohash) : null;
	}
	catch (error) {
		console.warn(`Magnet metadata lookup failed for ${infohash}: ${error.message}`);
		return null;
	}
}

function formatBytes(bytes) {
	if (!(bytes > 0)) return '未知';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let value = bytes;
	let unit = 0;
	while (value >= 1000 && unit < units.length - 1) {
		value /= 1000;
		unit += 1;
	}
	return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

module.exports = { DEFAULT_SOURCE, parseTorrent, fetchTorrentMeta, formatBytes };
