const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Which special formats a movie was made in (IMAX, Dolby Cinema, 4DX, ScreenX…). No format
// owner's site can be read by a bot (IMAX, CJ 4DPLEX and IMDb all block it), but the English
// Wikipedia article of a big release usually says it in its release section. Here we only pick
// out the sentences that mention a format; the AI (judge.js) decides from them which formats the
// film was really released in, so passing mentions ("beat the IMAX record of…") don't count.
// TMDB details carry the Wikidata id, which leads to the right article without guessing titles.
const USER_AGENT = 'yohaneowo-bot/1.0 (https://github.com/yohaneowo/yohaneowo-bot)';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const CACHE_PATH = path.join(DATA_DIR, 'wiki-formats.json');
// Formats are often announced close to release, so cached results are refreshed after this.
const CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15 * 1000;
// Wikimedia answers "too many requests" to fast clients; space requests out.
const REQUEST_GAP_MS = 400;
const RATE_LIMIT_WAIT_MS = 5 * 1000;
const MAX_SENTENCES = 6;
const MAX_SENTENCE_LENGTH = 300;
const FORMAT_PATTERN = /\bIMAX\b|Dolby Cinema|Dolby Vision|\b4DX\b|ScreenX|MX4D|D-?BOX|RealD|\b3D\b|\b70 ?mm\b|high frame rate|\bHFR\b|premium large format/i;

let cache = null;
let queue = Promise.resolve();

function loadCache() {
	if (cache) return cache;
	try {
		cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
	}
	catch {
		cache = {};
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
		console.warn('[movie] Could not save the Wikipedia format cache:', error.message);
	}
}

// One Wikimedia request at a time, REQUEST_GAP_MS apart; retries once when rate-limited
// (which comes back as a plain-text body instead of JSON).
function wikimedia(url) {
	const run = async () => {
		for (let attempt = 1; ; attempt++) {
			const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
			const text = await response.text();
			await new Promise((resolve) => setTimeout(resolve, REQUEST_GAP_MS));
			try {
				return JSON.parse(text);
			}
			catch {
				if (attempt >= 2) throw new Error(`Wikimedia answered HTTP ${response.status}: ${text.slice(0, 80)}`);
				await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_WAIT_MS));
			}
		}
	};
	const result = queue.then(run, run);
	// The next request waits for this one either way; its failure is the caller's to handle.
	queue = result.catch(() => null);
	return result;
}

async function englishTitle(wikidataId) {
	const data = await wikimedia(`https://www.wikidata.org/w/api.php?action=wbgetentities&props=sitelinks&sitefilter=enwiki&format=json&ids=${encodeURIComponent(wikidataId)}`);
	return data.entities?.[wikidataId]?.sitelinks?.enwiki?.title ?? null;
}

async function articleText(title) {
	const data = await wikimedia(
		`https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&titles=${encodeURIComponent(title)}`,
	);
	return Object.values(data.query?.pages ?? {})[0]?.extract ?? '';
}

function formatSentences(text) {
	return [
		...new Set(
			text
				.split(/(?<=[.!?])\s+|\n+/)
				.map((sentence) => sentence.trim())
				.filter((sentence) => sentence && FORMAT_PATTERN.test(sentence))
				.map((sentence) => sentence.slice(0, MAX_SENTENCE_LENGTH)),
		),
	].slice(0, MAX_SENTENCES);
}

// The Wikipedia sentences about formats for a movie (TMDB details with external_ids), cached.
// Resolves to { sentences, hash } — sentences is empty when there's no article or no mention.
async function fetchFormatSentences(details) {
	const store = loadCache();
	const cached = store[details.id];
	if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;

	let sentences = [];
	const wikidataId = details.external_ids?.wikidata_id;
	if (wikidataId) {
		const title = await englishTitle(wikidataId);
		if (title) sentences = formatSentences(await articleText(title));
	}
	const entry = {
		sentences,
		hash: sentences.length ? crypto.createHash('sha1').update(sentences.join('\n')).digest('hex').slice(0, 12) : null,
		fetchedAt: Date.now(),
	};
	store[details.id] = entry;
	saveCache();
	return entry;
}

// The "Production" and "Reception" sections of a movie's English Wikipedia article (for 「AI 怎么看」),
// each cut to a length worth sending; empty strings when there's no article or no such section.
// Reception often quotes the Rotten Tomatoes score and critics' consensus.
const SECTION_LENGTHS = { production: 1200, reception: 1800 };
const SECTION_PATTERNS = {
	production: /^(production|development|filming|writing|pre-production|casting)/i,
	reception: /^(reception|critical (response|reception)|release and reception|response)/i,
};

async function fetchArticleSections(details) {
	const sections = { production: '', reception: '' };
	const wikidataId = details.external_ids?.wikidata_id;
	const title = wikidataId ? await englishTitle(wikidataId) : null;
	if (!title) return sections;
	// Plain-text extracts mark sections as "== Heading ==" lines.
	const parts = (await articleText(title)).split(/^==+\s*(.+?)\s*==+\s*$/m);
	for (let index = 1; index < parts.length; index += 2) {
		const heading = parts[index];
		const body = parts[index + 1]?.trim() ?? '';
		for (const [key, pattern] of Object.entries(SECTION_PATTERNS)) {
			if (pattern.test(heading) && body && sections[key].length < SECTION_LENGTHS[key]) {
				sections[key] = `${sections[key]}\n${body}`.trim().slice(0, SECTION_LENGTHS[key]);
			}
		}
	}
	return sections;
}

// Like fetchFormatSentences, but a failure (Wikipedia down, rate-limited) just means no data.
async function formatSentencesOrNone(details) {
	try {
		return await fetchFormatSentences(details);
	}
	catch (error) {
		console.warn(`[movie] Wikipedia formats for ${details.id} failed:`, error.message);
		return { sentences: [], hash: null };
	}
}

module.exports = {
	formatSentencesOrNone,
	fetchArticleSections,
};
