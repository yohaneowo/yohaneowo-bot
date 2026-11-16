// Builds tiny .torrent files for tests (bencode writer + the info hash they hash to).
const crypto = require('node:crypto');

function bencode(value) {
	if (typeof value === 'number') return Buffer.from(`i${value}e`);
	if (typeof value === 'string' || Buffer.isBuffer(value)) {
		const buf = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
		return Buffer.concat([Buffer.from(`${buf.length}:`), buf]);
	}
	if (Array.isArray(value)) return Buffer.concat([Buffer.from('l'), ...value.map(bencode), Buffer.from('e')]);
	const keys = Object.keys(value).sort();
	return Buffer.concat([
		Buffer.from('d'),
		...keys.flatMap((key) => [bencode(key), bencode(value[key])]),
		Buffer.from('e'),
	]);
}

function makeTorrent(info, extra = {}) {
	return {
		buffer: bencode({ announce: 'udp://tracker.example.test:1337/announce', ...extra, info }),
		infohash: crypto.createHash('sha1').update(bencode(info)).digest('hex'),
	};
}

module.exports = { bencode, makeTorrent };
