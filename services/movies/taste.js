const { directors, topCast } = require('./tmdb');
const { getTaste } = require('./store');

// A user's taste from their Trakt ratings and watches, used to pre-rank new movies before the AI
// judges the best few. admin's statistics sync builds it (module_bot/movie/sync/taste.py) together
// with the website snapshot; the bot reads the stored copy, at most a day old. Two signals per genre:
//   - interest: how much of what they watch is in that genre (a genre they never watch scores
//     nothing, however neutral their ratings would be);
//   - affinity: how they rate it, relative to their own average (someone who rates everything 8
//     likes a 7 less than someone whose average is 6).
// The ranking only decides what the AI looks at first; it never rejects a movie on its own.
// Reviews only count once enough people voted.
const MIN_VOTES = 30;
// A genre counts as one they like (for the rule-only reason) from this share of their watches.
const LIKED_GENRE_SHARE = 0.1;
// A director or actor counts as a favourite with at least this many rated films, averaging at
// least this far above the user's own mean.
const FAVOURITE_MIN_FILMS = 2;
const FAVOURITE_MIN_ABOVE_MEAN = 0.3;
const MAX_FAVOURITES = 4;

// The stored profile with its lookups rebuilt: { mean, showMean, showRatingCount, ratingCount,
// watchedCount, knownCount, historyItems, seenIds: Set, ratingByTmdb: Map, genres: Map, people: Map,
// ratings: [{ rating, movie: { ids: { tmdb }, title } }] }. null before the first sync finished.
async function loadTaste(userId) {
	const stored = await getTaste(userId);
	if (!stored?.taste) return null;
	const data = stored.taste;
	return {
		mean: data.mean,
		showMean: data.showMean,
		showRatingCount: data.showRatingCount,
		ratingCount: data.ratingCount,
		watchedCount: data.watchedCount,
		knownCount: data.knownCount,
		historyItems: data.historyItems,
		seenIds: new Set(data.seenIds),
		// For re-releases of films the user already loved (recommender.js findRewatches).
		ratingByTmdb: new Map(data.ratings.map((entry) => [entry.tmdb, entry.rating])),
		genres: new Map(data.genres),
		people: new Map(data.people),
		ratings: data.ratings.map((entry) => ({ rating: entry.rating, movie: { ids: { tmdb: entry.tmdb }, title: entry.title } })),
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
	// Titles were resolved (TMDB title first) when admin stored the profile.
	const titleOf = (entry) => entry.movie.title;
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
	loadTaste,
	scoreMovie,
	favouritePeople,
	describeTaste,
};
