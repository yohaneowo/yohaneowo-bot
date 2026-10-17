// Trakt: a public user's watched movies and ratings. Public profiles only need the app's
// Client ID (no OAuth); private profiles answer 401/403. Requests go through admin
// (POST /sources/trakt), which holds the Client ID and counts usage.
const { movieRequest, adminApiEnabled } = require('../adminApi');

const REQUEST_TIMEOUT_MS = 30 * 1000;
// Lists like /watched come back 100 items per page; follow the pages up to this many.
const PAGE_LIMIT = 100;
const MAX_PAGES = 50;

class TraktUserError extends Error {}

// { pageCount, body } of one GET; path may carry a query string.
async function request(path) {
	const [pathname, query = ''] = path.split('?');
	const params = Object.fromEntries(new URLSearchParams(query));
	const { status, pageCount, body } = await movieRequest('POST', '/sources/trakt', { path: pathname, params }, REQUEST_TIMEOUT_MS);
	if (status === 404) throw new TraktUserError('找不到这个 Trakt 用户');
	if (status === 401 || status === 403) throw new TraktUserError('这个 Trakt 帐号不是公开的');
	if (status < 200 || status >= 300) throw new Error(`Trakt ${pathname} returned HTTP ${status}`);
	return { pageCount, body };
}

async function trakt(path) {
	return (await request(path)).body;
}

// Every item of a list, across pages. Paginated lists say so in X-Pagination-Page-Count;
// unpaginated ones (e.g. ratings) return everything in one go.
async function traktAll(path) {
	const items = [];
	for (let page = 1; page <= MAX_PAGES; page++) {
		const response = await request(`${path}${path.includes('?') ? '&' : '?'}page=${page}&limit=${PAGE_LIMIT}`);
		items.push(...response.body);
		const pageCount = response.pageCount ?? 1;
		if (pageCount > MAX_PAGES) throw new TraktUserError('观看记录超过当前同步上限，未保存不完整统计');
		if (page >= pageCount) break;
	}
	return items;
}

// Accepts a profile link as the Trakt app shares it (https://app.trakt.tv/profile/<slug>, or the
// older https://trakt.tv/users/<slug>) or a bare username/slug. Returns the slug, or null.
// Shared links are the easy way in: usernames are often non-Latin and hard to type.
function parseTraktUser(input) {
	const text = input.trim();
	const fromLink = text.match(/trakt\.tv\/(?:profile|users)\/([^/?#\s]+)/i)?.[1];
	const slug = fromLink ? decodeURIComponent(fromLink) : text.replace(/^@/, '');
	return slug && !/[/?#\s]/.test(slug) ? slug : null;
}

// { slug, username } of a public profile; throws TraktUserError if missing or private.
async function fetchProfile(slug) {
	const profile = await trakt(`/users/${encodeURIComponent(slug)}`);
	if (profile.private) throw new TraktUserError('这个 Trakt 帐号不是公开的');
	return { slug: profile.ids?.slug ?? slug, username: profile.username ?? slug };
}

// People mostly rate shows per season. One rating per show: the average of its seasons, or the
// whole-show rating when no season is rated.
function combineShowRatings(seasonRatings, wholeShowRatings) {
	const shows = new Map();
	for (const entry of seasonRatings) {
		const show = shows.get(entry.show.ids.trakt) ?? { show: entry.show, seasonRatings: [], ratedAt: entry.rated_at };
		show.seasonRatings.push(entry.rating);
		if (entry.rated_at > show.ratedAt) show.ratedAt = entry.rated_at;
		shows.set(entry.show.ids.trakt, show);
	}
	for (const entry of wholeShowRatings) {
		if (!shows.has(entry.show.ids.trakt)) shows.set(entry.show.ids.trakt, { show: entry.show, seasonRatings: [entry.rating], ratedAt: entry.rated_at });
	}
	return [...shows.values()].map(({ show, seasonRatings: ratings, ratedAt }) => ({
		show,
		rating: ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length,
		seasons: ratings.length,
		ratedAt,
	}));
}

// { profile, ratings: [{ rating, ratedAt, movie }], watched: [{ plays, lastWatchedAt, movie }],
//   showRatings: [{ rating, seasons, ratedAt, show }] }
// movie / show: { title, year, ids: { trakt, slug, imdb, tmdb } }
async function fetchUserMovies(slug) {
	// The lists below answer an empty 200 for users that don't exist, so check the profile first.
	const profile = await fetchProfile(slug);
	const user = encodeURIComponent(profile.slug);
	const [ratings, watched, seasonRatings, wholeShowRatings] = await Promise.all([
		traktAll(`/users/${user}/ratings/movies`),
		traktAll(`/users/${user}/watched/movies`),
		traktAll(`/users/${user}/ratings/seasons`),
		traktAll(`/users/${user}/ratings/shows`),
	]);
	return {
		profile,
		ratings: ratings.map((entry) => ({ rating: entry.rating, ratedAt: entry.rated_at, movie: entry.movie })),
		watched: watched.map((entry) => ({ plays: entry.plays, lastWatchedAt: entry.last_watched_at, movie: entry.movie })),
		showRatings: combineShowRatings(seasonRatings, wholeShowRatings),
	};
}

// Where a user stands with one movie on Trakt, for the 「看过了」 button: their rating (or null),
// whether it's in their watch history, and the movie's Trakt page for rating it.
// Resolves to { rating, watched, url }.
async function fetchMovieStatus(userSlug, tmdbId) {
	const user = encodeURIComponent(userSlug);
	const [found, ratings, watched] = await Promise.all([
		trakt(`/search/tmdb/${tmdbId}?type=movie`),
		traktAll(`/users/${user}/ratings/movies`),
		traktAll(`/users/${user}/watched/movies`),
	]);
	const movieSlug = found.find((result) => result.type === 'movie')?.movie?.ids?.slug;
	const isThis = (entry) => entry.movie?.ids?.tmdb === Number(tmdbId);
	return {
		rating: ratings.find(isThis)?.rating ?? null,
		watched: watched.some(isThis),
		url: movieSlug ? `https://trakt.tv/movies/${movieSlug}` : `https://trakt.tv/search?query=${encodeURIComponent(String(tmdbId))}`,
	};
}

module.exports = {
	traktEnabled: adminApiEnabled,
	fetchMovieStatus,
	TraktUserError,
	parseTraktUser,
	fetchUserMovies,
};
