const crypto = require('node:crypto');
const { readCache, writeCache } = require('./store');
const { callAi, aiEnabled } = require('../aiUsage');

// Content vectors for movies and TV shows (Voyage AI). A title's vector depends only on its TMDB
// text, never on anyone's ratings, so each is computed once and shared by every subscriber; it is
// recomputed only when that text changes (e.g. an upcoming movie gets a fuller synopsis) or the
// model/dimensions change. Persisted in admin; the local copy is disposable. Requests go through
// admin's AI gateway, which holds the Voyage key and records each billed call.
const MODEL = process.env.MOVIE_EMBEDDING_MODEL || 'voyage-3.5';
const DIMENSIONS = 512;
const REQUEST_TIMEOUT_MS = 70 * 1000;
// Accounts without a payment method are limited to ~10K tokens/minute, so batches stay small
// and rate-limit answers are waited out.
const MAX_BATCH_TOKENS = 8000;
const MAX_BATCH_ITEMS = 64;
const RATE_LIMIT_WAIT_MS = 65 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_OVERVIEW_LENGTH = 1200;

const cache = { items: {} };
const cacheKey = (key) => MODEL + ':' + DIMENSIONS + ':' + key;
async function loadCache(keys) {
	const missing = keys.filter((key) => !cache.items[key]);
	const saved = await readCache('embeddings', missing.map(cacheKey));
	for (const key of missing) if (saved[cacheKey(key)]) cache.items[key] = saved[cacheKey(key)];
	return cache;
}

// The text a vector is made from, from English TMDB details (the most complete language, and the
// one Trakt titles use). type is 'movie' or 'tv'.
function embeddingText(details, type) {
	const isTv = type === 'tv';
	const title = isTv ? details.name : details.title;
	const year = (isTv ? details.first_air_date : details.release_date)?.slice(0, 4);
	const keywords = (isTv ? details.keywords?.results : details.keywords?.keywords) ?? [];
	const makers = isTv
		? (details.created_by ?? []).map((person) => person.name)
		: (details.credits?.crew ?? []).filter((person) => person.job === 'Director').map((person) => person.name);
	return [
		`${isTv ? 'TV series' : 'Movie'}: ${title}${year ? ` (${year})` : ''}`,
		`Original language: ${details.original_language ?? 'unknown'}`,
		`Genres: ${(details.genres ?? []).map((genre) => genre.name).join(', ') || 'unknown'}`,
		keywords.length ? `Keywords: ${keywords.slice(0, 20).map((keyword) => keyword.name).join(', ')}` : null,
		makers.length ? `${isTv ? 'Created by' : 'Directed by'}: ${makers.join(', ')}` : null,
		`Cast: ${(details.credits?.cast ?? []).slice(0, 6).map((person) => person.name).join(', ') || 'unknown'}`,
		details.tagline ? `Tagline: ${details.tagline}` : null,
		`Overview: ${(details.overview ?? '').slice(0, MAX_OVERVIEW_LENGTH) || 'none'}`,
	]
		.filter(Boolean)
		.join('\n');
}

function hashText(text) {
	return crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
}

// Rough token count, only to keep batches under the per-minute limit.
function estimateTokens(text) {
	return Math.ceil(text.length / 3);
}

// Rate-limited attempts aren't billed (admin doesn't record them); they're waited out here.
async function requestEmbeddings(texts) {
	for (let attempt = 1; ; attempt++) {
		const { status, body: payload } = await callAi('embeddings', {
			feature: 'movie-embedding',
			timeoutMs: REQUEST_TIMEOUT_MS,
			body: { input: texts, model: MODEL, input_type: 'document', output_dimension: DIMENSIONS },
		});
		if (status === 429 && attempt < MAX_ATTEMPTS) {
			console.warn(`[movie] Voyage rate limit hit; waiting ${RATE_LIMIT_WAIT_MS / 1000}s (attempt ${attempt})`);
			await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_WAIT_MS));
			continue;
		}
		if (status == null) throw new Error('Voyage unreachable');
		if (status < 200 || status >= 300) throw new Error(`Voyage returned HTTP ${status}: ${payload?.detail ?? 'no details'}`);
		return payload.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
	}
}

// items: [{ key, text }]. Resolves to Map(key -> vector). Only new or changed texts are sent.
async function embed(items) {
	const store = await loadCache(items.map((item) => item.key));
	const pending = items.filter((item) => store.items[item.key]?.hash !== hashText(item.text));
	let batch = [];
	let batchTokens = 0;
	const flush = async () => {
		if (!batch.length) return;
		const vectors = await requestEmbeddings(batch.map((item) => item.text));
		batch.forEach((item, index) => {
			// 4 decimals keep the file small without changing similarities in any meaningful way.
			store.items[item.key] = { hash: hashText(item.text), vector: vectors[index].map((value) => Math.round(value * 1e4) / 1e4) };
		});
		await writeCache('embeddings', Object.fromEntries(batch.map((item) => [cacheKey(item.key), store.items[item.key]])));
		batch = [];
		batchTokens = 0;
	};
	for (const item of pending) {
		const tokens = estimateTokens(item.text);
		if (batch.length && (batchTokens + tokens > MAX_BATCH_TOKENS || batch.length >= MAX_BATCH_ITEMS)) await flush();
		batch.push(item);
		batchTokens += tokens;
	}
	await flush();
	if (pending.length) console.log(`[movie] Embedded ${pending.length} title(s) with ${MODEL}`);
	return new Map(items.map((item) => [item.key, store.items[item.key]?.vector]).filter(([, vector]) => vector));
}

// Vectors already in the cache, without fetching anything (keys like 'movie:603').
function cachedVector(key) {
	return cache.items[key]?.vector ?? null;
}

function cosine(a, b) {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	return dot / Math.sqrt(normA * normB);
}

module.exports = {
	embeddingsEnabled: aiEnabled,
	embeddingText,
	embed,
	cachedVector,
	cosine,
};
