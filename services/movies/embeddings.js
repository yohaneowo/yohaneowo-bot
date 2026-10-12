const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { recordAiCall } = require('../aiUsage');

// Content vectors for movies and TV shows (Voyage AI). A title's vector depends only on its TMDB
// text, never on anyone's ratings, so each is computed once and shared by every subscriber; it is
// recomputed only when that text changes (e.g. an upcoming movie gets a fuller synopsis) or the
// model/dimensions change. Stored in data/embeddings.json.
const API_URL = 'https://api.voyageai.com/v1/embeddings';
const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY ?? '';
const MODEL = process.env.MOVIE_EMBEDDING_MODEL || 'voyage-3.5';
const DIMENSIONS = 512;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const CACHE_PATH = path.join(DATA_DIR, 'embeddings.json');
const REQUEST_TIMEOUT_MS = 60 * 1000;
// Accounts without a payment method are limited to ~10K tokens/minute, so batches stay small
// and rate-limit answers are waited out.
const MAX_BATCH_TOKENS = 8000;
const MAX_BATCH_ITEMS = 64;
const RATE_LIMIT_WAIT_MS = 65 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_OVERVIEW_LENGTH = 1200;

let cache = null;

function loadCache() {
	if (cache) return cache;
	try {
		cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
	}
	catch {
		cache = null;
	}
	if (cache?.model !== MODEL || cache?.dimensions !== DIMENSIONS) {
		cache = { model: MODEL, dimensions: DIMENSIONS, items: {} };
	}
	return cache;
}

function saveCache() {
	try {
		fs.mkdirSync(DATA_DIR, { recursive: true });
		fs.writeFileSync(`${CACHE_PATH}.tmp`, JSON.stringify(cache));
		fs.renameSync(`${CACHE_PATH}.tmp`, CACHE_PATH);
	}
	catch (error) {
		console.warn('[movie] Could not save embeddings:', error.message);
	}
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

// Rate-limited attempts aren't billed, so only the final answer (success or error) is recorded.
async function requestEmbeddings(texts) {
	for (let attempt = 1; ; attempt++) {
		const startedAt = Date.now();
		const response = await fetch(API_URL, {
			method: 'POST',
			headers: { Authorization: `Bearer ${VOYAGE_API_KEY}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ input: texts, model: MODEL, input_type: 'document', output_dimension: DIMENSIONS }),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (response.status === 429 && attempt < MAX_ATTEMPTS) {
			console.warn(`[movie] Voyage rate limit hit; waiting ${RATE_LIMIT_WAIT_MS / 1000}s (attempt ${attempt})`);
			await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_WAIT_MS));
			continue;
		}
		const payload = await response.json().catch(() => null);
		const error = response.ok ? null : new Error(`Voyage returned HTTP ${response.status}: ${payload?.detail ?? 'no details'}`);
		recordAiCall({
			feature: 'movie-embedding',
			provider: 'voyage',
			model: MODEL,
			usage: { input: payload?.usage?.total_tokens },
			durationMs: Date.now() - startedAt,
			error,
		});
		if (error) throw error;
		return payload.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
	}
}

// items: [{ key, text }]. Resolves to Map(key -> vector). Only new or changed texts are sent.
async function embed(items) {
	const store = loadCache();
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
		saveCache();
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
	return loadCache().items[key]?.vector ?? null;
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
	embeddingsEnabled: Boolean(VOYAGE_API_KEY),
	embeddingText,
	embed,
	cachedVector,
	cosine,
};
