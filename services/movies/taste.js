const { fetchMovieDetails, directors, topCast } = require('./tmdb');
const { detailCache, saveDetailCache } = require('./store');

// A user's taste from their Trakt ratings and watches, used to pre-rank new movies before the AI
// judges the best few. Two signals per genre:
//   - interest: how much of what they watch is in that genre (a genre they never watch scores
//     nothing, however neutral their ratings would be);
//   - affinity: how they rate it, relative to their own average (someone who rates everything 8
//     likes a 7 less than someone whose average is 6).
// The ranking only decides what the AI looks at first; it never rejects a movie on its own.
const MAX_HISTORY_DETAILS = 200;
const DETAIL_FETCH_CONCURRENCY = 4;
// Watched without a rating: some interest, much weaker than a good rating.
const WATCHED_WEIGHT = 0.3;
// Reviews only count once enough people voted.
const MIN_VOTES = 30;
// A genre counts as one they like (for the rule-only reason) from this share of their watches.
const LIKED_GENRE_SHARE = 0.1;
// A director or actor counts as a favourite with at least this many rated films, averaging at
// least this far above the user's own mean.
const FAVOURITE_MIN_FILMS = 2;
const FAVOURITE_MIN_ABOVE_MEAN = 0.3;
const MAX_FAVOURITES = 4;
const MAX_HISTORY_SHOWS = 200;

// Only what the taste profile and the AI prompt need, so the cache stays small.
function slimDetails(details) {
	return {
		title: details.title,
		originalTitle: details.original_title,
		year: details.release_date?.slice(0, 4) ?? null,
		genres: (details.genres ?? []).map((genre) => genre.name),
		genreIds: (details.genres ?? []).map((genre) => genre.id),
		directors: directors(details).map((person) => ({ id: person.id, name: person.name })),
		cast: topCast(details).map((person) => ({ id: person.id, name: person.name })),
	};
}

async function loadHistoryDetails(tmdbIds) {
	const missing = [...new Set(tmdbIds)].filter((id) => id && !detailCache[id]);
	const queue = [...missing];
	await Promise.all(
		Array.from({ length: DETAIL_FETCH_CONCURRENCY }, async () => {
			while (queue.length) {
				const id = queue.shift();
				try {
					detailCache[id] = slimDetails(await fetchMovieDetails(id));
				}
				catch (error) {
					console.warn(`[movie] TMDB details for ${id} failed:`, error.message);
				}
			}
		}),
	);
	if (missing.length) saveDetailCache();
}

// traktMovies: { ratings, watched, showRatings } from trakt.js.
async function buildTaste(traktMovies) {
	const { ratings, watched, showRatings = [] } = traktMovies;
	const mean = ratings.length ? ratings.reduce((sum, entry) => sum + entry.rating, 0) / ratings.length : 7;
	const ratedIds = new Set(ratings.map((entry) => entry.movie.ids.tmdb));

	// Most recent first: tastes drift, and the latest history is what new releases compete with.
	const history = new Map();
	for (const entry of ratings) history.set(entry.movie.ids.tmdb, { rating: entry.rating, at: entry.ratedAt });
	for (const entry of watched) {
		if (!history.has(entry.movie.ids.tmdb)) history.set(entry.movie.ids.tmdb, { rating: null, at: entry.lastWatchedAt });
	}
	const sample = [...history.entries()]
		.filter(([id]) => id)
		.sort(([, a], [, b]) => String(b.at).localeCompare(String(a.at)))
		.slice(0, MAX_HISTORY_DETAILS);
	await loadHistoryDetails(sample.map(([id]) => id));

	const genres = new Map();
	const people = new Map();
	let knownCount = 0;
	for (const [id, { rating }] of sample) {
		const details = detailCache[id];
		if (!details) continue;
		knownCount += 1;
		const weight = rating == null ? WATCHED_WEIGHT : rating - mean;
		details.genreIds.forEach((genreId, index) => {
			const genre = genres.get(genreId) ?? { name: details.genres[index], count: 0, weight: 0, ratedCount: 0 };
			genre.count += 1;
			if (rating != null) {
				genre.weight += weight;
				genre.ratedCount += 1;
			}
			genres.set(genreId, genre);
		});
		for (const [person, factor] of [...details.directors.map((p) => [p, 2]), ...details.cast.map((p) => [p, 1])]) {
			const entry = people.get(person.id) ?? { name: person.name, weight: 0, count: 0, films: [] };
			entry.weight += weight * factor;
			entry.count += 1;
			// The evidence shown next to a favourite's photo.
			if (rating != null && !entry.films.some((film) => film.id === id)) entry.films.push({ id, title: details.title, rating });
			people.set(person.id, entry);
		}
	}

	// Everything the content vectors compare new releases against (similar.js): the sampled movies
	// and the rated shows, with the user's rating when there is one.
	const traktTitles = new Map([...ratings, ...watched].map((entry) => [entry.movie.ids.tmdb, entry.movie.title]));
	const showMean = showRatings.length ? showRatings.reduce((sum, entry) => sum + entry.rating, 0) / showRatings.length : null;
	const historyItems = [
		...sample.map(([id, { rating }]) => ({ type: 'movie', id, title: detailCache[id]?.title ?? traktTitles.get(id), rating })),
		...[...showRatings]
			.filter((entry) => entry.show.ids.tmdb)
			.sort((a, b) => String(b.ratedAt).localeCompare(String(a.ratedAt)))
			.slice(0, MAX_HISTORY_SHOWS)
			.map((entry) => ({ type: 'tv', id: entry.show.ids.tmdb, title: entry.show.title, rating: Math.round(entry.rating * 10) / 10 })),
	];

	return {
		mean,
		showMean,
		showRatingCount: showRatings.length,
		historyItems,
		ratingCount: ratings.length,
		watchedCount: watched.length,
		knownCount,
		seenIds: new Set([...ratings, ...watched].map((entry) => entry.movie.ids.tmdb).filter(Boolean)),
		// For re-releases of films the user already loved (recommender.js findRewatches).
		ratingByTmdb: new Map(ratings.map((entry) => [entry.movie.ids.tmdb, entry.rating])),
		genres,
		people,
		ratings,
		recentWatched: watched
			.filter((entry) => !ratedIds.has(entry.movie.ids.tmdb))
			.sort((a, b) => String(b.lastWatchedAt).localeCompare(String(a.lastWatchedAt))),
	};
}

// Pre-ranking score, higher is a better fit (roughly -2..+8). Also returns the matches that
// explain it (used for the reason when there is no AI).
function scoreMovie(taste, details) {
	const genres = details.genres ?? [];
	const share = (genre) => (taste.genres.get(genre.id)?.count ?? 0) / Math.max(1, taste.knownCount);
	const shares = genres.map(share);
	const average = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

	const interestScore = shares.length ? 2 * average(shares) + 2 * Math.max(...shares) : 0;
	// Shrink toward 0 for genres rated only a few times.
	const affinityScore = average(
		genres.map((genre) => {
			const entry = taste.genres.get(genre.id);
			return entry ? entry.weight / (entry.ratedCount + 3) : 0;
		}),
	);

	const matchedPeople = [...directors(details), ...topCast(details)]
		.map((person) => ({ name: person.name, entry: taste.people.get(person.id) }))
		.filter((match) => match.entry && match.entry.weight > 0);
	const peopleScore = Math.min(
		3,
		matchedPeople.reduce((sum, match) => sum + match.entry.weight / (match.entry.count + 1), 0),
	);

	const qualityScore = details.vote_count >= MIN_VOTES ? (details.vote_average - 6.5) * 0.5 : 0;
	// Small nudge toward films people are actually going to see over tiny limited releases.
	const popularityScore = 0.5 * Math.log10(1 + (details.popularity ?? 0));

	return {
		score: interestScore + affinityScore + peopleScore + qualityScore + popularityScore,
		likedGenres: genres
			.filter((genre) => share(genre) >= LIKED_GENRE_SHARE && (taste.genres.get(genre.id)?.weight ?? 0) >= 0)
			.map((genre) => genre.name),
		likedPeople: matchedPeople.map((match) => match.name),
	};
}

// Directors and leading actors of a movie the user has rated well before, with the films as
// evidence and the role they play here. At most MAX_FAVOURITES, best-loved first.
function favouritePeople(taste, details) {
	const roles = [
		...directors(details).map((person) => ({ person, role: 'director' })),
		...topCast(details).map((person) => ({ person, role: 'cast', character: person.character })),
	];
	const found = new Map();
	for (const { person, role, character } of roles) {
		const films = (taste.people.get(person.id)?.films ?? []).filter((film) => film.id !== details.id);
		const average = films.reduce((sum, film) => sum + film.rating, 0) / (films.length || 1);
		if (films.length < FAVOURITE_MIN_FILMS || average < taste.mean + FAVOURITE_MIN_ABOVE_MEAN || found.has(person.id)) continue;
		found.set(person.id, {
			id: person.id,
			name: person.name,
			role,
			character: character || null,
			photo: person.profile_path ? `https://image.tmdb.org/t/p/w185${person.profile_path}` : null,
			films: [...films].sort((a, b) => b.rating - a.rating).slice(0, 3),
			average,
		});
	}
	return [...found.values()].sort((a, b) => b.average - a.average).slice(0, MAX_FAVOURITES);
}

// A short overview of the user's taste for the AI; the per-movie context comes from similar.js.
function describeTaste(taste) {
	const titleOf = (entry) => detailCache[entry.movie.ids.tmdb]?.title ?? entry.movie.title;
	const sorted = [...taste.ratings].sort((a, b) => b.rating - a.rating);
	const showLine = taste.showRatingCount ? `；剧集评分 ${taste.showRatingCount} 部，平均 ${taste.showMean.toFixed(1)} 分（各季评分的平均）` : '';
	const lowest = sorted.slice(-6).reverse().filter((entry) => entry.rating < taste.mean);
	return [
		`电影评分 ${taste.ratingCount} 部，平均 ${taste.mean.toFixed(1)} 分（满分 10）；看过 ${taste.watchedCount} 部${showLine}。`,
		`电影评分最高：${sorted.slice(0, 12).map((entry) => `${titleOf(entry)} ${entry.rating}`).join('、')}`,
		`电影评分最低：${lowest.map((entry) => `${titleOf(entry)} ${entry.rating}`).join('、') || '无'}`,
	].join('\n');
}

module.exports = {
	buildTaste,
	scoreMovie,
	favouritePeople,
	describeTaste,
};
