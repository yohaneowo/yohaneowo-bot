// Explicit, dev-only import. No automatic import or fallback on normal bot startup.
const fs = require('node:fs');
const path = require('node:path');
const store = require('../services/movies/store');
const { movieRequest } = require('../services/adminApi');

async function main() {
	if (!process.argv.includes('--confirm-dev') || !['localhost', '127.0.0.1'].includes(new URL(process.env.ADMIN_API_URL).hostname)) {
		throw new Error('Import requires --confirm-dev and a localhost admin URL.');
	}
	const root = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
	const source = path.join(root, 'movies.json');
	const legacy = JSON.parse(fs.readFileSync(source, 'utf8'));
	const backup = source + '.before-admin-' + Date.now() + '.bak';
	fs.copyFileSync(source, backup, fs.constants.COPYFILE_EXCL);
	let subscriptions = 0, records = 0;
	for (const [id, subscriber] of Object.entries(legacy.subscribers ?? {})) {
		const result = await movieRequest('POST', `/imports/subscribers/${id}`, { traktUser: subscriber.traktUser, traktName: subscriber.traktName ?? subscriber.traktUser, region: subscriber.region, subscribedAt: subscriber.subscribedAt });
		if (result.created) subscriptions++;
	}
	for (const [id, movies] of Object.entries(legacy.movies ?? {})) {
		// Retain recommendation histories for unsubscribed users without reactivating them.
		if (!legacy.subscribers?.[id] && !(await store.getSubscriber(id))) {
			await movieRequest('POST', `/imports/owner/${id}`);
		}
		const existing = await store.userMovies(id);
		for (const [tmdbId, record] of Object.entries(movies)) {
			if (existing[tmdbId]) continue;
			await store.updateMovie(id, tmdbId, record);
			records++;
		}
	}
	const cachePath = path.join(root, 'tmdb-cache.json');
	if (fs.existsSync(cachePath)) {
		const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
		const existing = await store.readCache('tmdb', Object.keys(cache));
		await store.writeCache('tmdb', Object.fromEntries(Object.entries(cache).filter(([key]) => !existing[key])));
	}
	const wikiPath = path.join(root, 'wiki-formats.json');
	if (fs.existsSync(wikiPath)) {
		const items = JSON.parse(fs.readFileSync(wikiPath, 'utf8'));
		const existing = await store.readCache('wikipedia', Object.keys(items));
		await store.writeCache('wikipedia', Object.fromEntries(Object.entries(items).filter(([key]) => !existing[key])));
	}
	const vectorsPath = path.join(root, 'embeddings.json');
	if (fs.existsSync(vectorsPath)) {
		const vectors = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));
		const items = Object.fromEntries(Object.entries(vectors.items ?? {}).map(([key, value]) => [vectors.model + ':' + vectors.dimensions + ':' + key, value]));
		const existing = await store.readCache('embeddings', Object.keys(items));
		await store.writeCache('embeddings', Object.fromEntries(Object.entries(items).filter(([key]) => !existing[key])));
	}
	console.log(JSON.stringify({ importedSubscriptions: subscriptions, importedRecords: records, backupCreated: true }));
}
main().catch((error) => {
	console.error('Import failed:', error.message);
	process.exitCode = 1;
});
