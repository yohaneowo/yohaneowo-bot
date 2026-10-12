const tmdb = require('./tmdb');
const { embeddingsEnabled, embeddingText, embed, cachedVector, cosine } = require('./embeddings');
const { SYSTEM_CALLER, withAiCaller } = require('../aiUsage');

// For each candidate, the most similar titles in the user's own history (movies and rated shows),
// by content vector. This is the AI's per-movie evidence: "it's like these, which you rated so".
// Experiments showed vectors don't beat the rule ranking at picking candidates, but they find
// genuinely related titles (a sequel's earlier films, an anime film's series), so that is all
// they're used for. Without VOYAGE_API_KEY this returns nothing and the AI works from the summary.
const NEIGHBOURS = 5;
const DETAIL_CONCURRENCY = 4;

const keyOf = (type, id) => `${type}:${id}`;

async function textsFor(refs) {
	const texts = [];
	const queue = [...refs];
	await Promise.all(
		Array.from({ length: DETAIL_CONCURRENCY }, async () => {
			while (queue.length) {
				const ref = queue.shift();
				try {
					texts.push({ key: keyOf(ref.type, ref.id), text: embeddingText(await tmdb.fetchEnglishDetails(ref.type, ref.id), ref.type) });
				}
				catch (error) {
					console.warn(`[movie] English details for ${keyOf(ref.type, ref.id)} failed:`, error.message);
				}
			}
		}),
	);
	return texts;
}

// History vectors are made once and reused (old titles' text doesn't change); candidates are
// re-checked every run, so an upcoming movie's vector improves as TMDB fills in its details.
async function loadVectors(refs, refresh) {
	const missing = refresh ? refs : refs.filter((ref) => !cachedVector(keyOf(ref.type, ref.id)));
	if (missing.length) await embed(await textsFor(missing));
	return new Map(refs.map((ref) => [keyOf(ref.type, ref.id), cachedVector(keyOf(ref.type, ref.id))]).filter(([, vector]) => vector));
}

// Resolves to Map(candidate tmdb id -> [{ type, title, rating, similarity }]).
async function findSimilarHistory(taste, candidateDetails) {
	if (!embeddingsEnabled || !candidateDetails.length) return new Map();
	try {
		// The user's own history is their cost; new releases' vectors are shared by every subscriber.
		const history = await loadVectors(taste.historyItems, false);
		const candidates = await withAiCaller(SYSTEM_CALLER, () =>
			loadVectors(candidateDetails.map((details) => ({ type: 'movie', id: details.id })), true),
		);
		const result = new Map();
		for (const details of candidateDetails) {
			const vector = candidates.get(keyOf('movie', details.id));
			if (!vector) continue;
			result.set(
				details.id,
				taste.historyItems
					.filter((item) => !(item.type === 'movie' && item.id === details.id) && history.has(keyOf(item.type, item.id)))
					.map((item) => ({ ...item, similarity: cosine(vector, history.get(keyOf(item.type, item.id))) }))
					.sort((a, b) => b.similarity - a.similarity)
					.slice(0, NEIGHBOURS),
			);
		}
		return result;
	}
	catch (error) {
		// The AI can still judge from the taste summary.
		console.warn('[movie] Similar-title lookup failed:', error.message);
		return new Map();
	}
}

module.exports = {
	findSimilarHistory,
};
