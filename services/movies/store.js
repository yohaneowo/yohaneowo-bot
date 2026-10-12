const fs = require('node:fs');
const path = require('node:path');

// Subscriptions and what was decided/sent per user, in data/movies.json (a volume in Docker):
// {
//   subscribers: { [discordUserId]: { traktUser (the profile slug), traktName, region, subscribedAt } },
//   movies: { [discordUserId]: { [tmdbId]: MovieRecord } },
// }
// MovieRecord: { title, decision: 'recommend' | 'reject', reason, predictedRating, kind: 'now' | 'upcoming',
//                releaseDate, evaluatedAt, sentAt?, remindedAt?, feedback?: 'want' | 'skip' | 'seen' }
// TMDB details of movies in people's histories are cached in data/tmdb-cache.json; they don't change.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'movies.json');
const CACHE_PATH = path.join(DATA_DIR, 'tmdb-cache.json');

function readJson(filePath, fallback) {
	try {
		return JSON.parse(fs.readFileSync(filePath, 'utf8'));
	}
	catch (error) {
		if (error.code !== 'ENOENT') console.warn(`[movie] Could not read ${path.basename(filePath)}:`, error.message);
		return fallback;
	}
}

// Write then rename, so a crash mid-write never leaves a half-written file.
function writeJson(filePath, data) {
	try {
		fs.mkdirSync(DATA_DIR, { recursive: true });
		fs.writeFileSync(`${filePath}.tmp`, JSON.stringify(data));
		fs.renameSync(`${filePath}.tmp`, filePath);
	}
	catch (error) {
		console.warn(`[movie] Could not save ${path.basename(filePath)}:`, error.message);
	}
}

const state = readJson(STORE_PATH, {});
state.subscribers ??= {};
state.movies ??= {};
const detailCache = readJson(CACHE_PATH, {});

function save() {
	writeJson(STORE_PATH, state);
}

function saveDetailCache() {
	writeJson(CACHE_PATH, detailCache);
}

function getSubscriber(userId) {
	return state.subscribers[userId] ?? null;
}

function listSubscribers() {
	return Object.entries(state.subscribers).map(([userId, subscriber]) => ({ userId, ...subscriber }));
}

function subscribe(userId, traktUser, traktName, region) {
	state.subscribers[userId] = { traktUser, traktName, region, subscribedAt: new Date().toISOString() };
	save();
}

// Decisions are kept, so subscribing again later doesn't resend old recommendations.
function unsubscribe(userId) {
	delete state.subscribers[userId];
	save();
}

function userMovies(userId) {
	return (state.movies[userId] ??= {});
}

function updateMovie(userId, tmdbId, fields) {
	const movies = userMovies(userId);
	movies[tmdbId] = { ...movies[tmdbId], ...fields };
	save();
	return movies[tmdbId];
}

module.exports = {
	getSubscriber,
	listSubscribers,
	subscribe,
	unsubscribe,
	userMovies,
	updateMovie,
	detailCache,
	saveDetailCache,
};
