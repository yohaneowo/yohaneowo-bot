// TMDB (themoviedb.org): what's showing / coming in a region, and movie details.
// Requests go through admin (POST /sources/tmdb), which holds the key and counts usage in
// 接口管理 → 第三方接口; the bot no longer needs TMDB_API_TOKEN.
const { movieRequest, adminApiEnabled } = require('../adminApi');

const LANGUAGE = process.env.MOVIE_LANGUAGE || 'zh-TW';
// now_playing / upcoming are short lists per region; a few pages cover them.
const MAX_LIST_PAGES = 5;
// Release types that count as "in cinemas": 3 theatrical, 2 limited theatrical.
const THEATRICAL_TYPES = [3, 2];

const POSTER_BASE_URL = 'https://image.tmdb.org/t/p/w500';

// The films of a series (details.belongs_to_collection), oldest first, for 「需不需要先看前作」.
async function fetchCollection(collectionId) {
	const data = await tmdb(`/collection/${collectionId}`, { language: LANGUAGE });
	return (data.parts ?? []).sort((a, b) => String(a.release_date).localeCompare(String(b.release_date)));
}

// Audience reviews (mostly English); newest TMDB reviews come first.
async function fetchReviews(id) {
	const data = await tmdb(`/movie/${id}/reviews`);
	return data.results ?? [];
}

// English details for the content vectors (embeddings.js); type is 'movie' or 'tv'.
function fetchEnglishDetails(type, id) {
	return tmdb(`/${type}/${id}`, { language: 'en-US', append_to_response: 'credits,keywords' });
}

async function tmdb(path, params = {}) {
	const query = Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)]));
	const { status, body } = await movieRequest('POST', '/sources/tmdb', { path, params: query });
	if (status < 200 || status >= 300) {
		throw new Error(`TMDB ${path} returned HTTP ${status}`);
	}
	return body;
}

async function fetchList(path, region) {
	const movies = [];
	for (let page = 1; page <= MAX_LIST_PAGES; page++) {
		const data = await tmdb(path, { region, language: LANGUAGE, page });
		movies.push(...data.results);
		if (page >= data.total_pages) break;
	}
	return movies;
}

// Both lists, de-duplicated (TMDB often lists a movie in both around its release).
async function fetchRegionMovies(region) {
	const [nowPlaying, upcoming] = await Promise.all([
		fetchList('/movie/now_playing', region),
		fetchList('/movie/upcoming', region),
	]);
	const byId = new Map();
	for (const movie of [...nowPlaying, ...upcoming]) byId.set(movie.id, movie);
	return { movies: [...byId.values()], nowPlayingIds: new Set(nowPlaying.map((movie) => movie.id)) };
}

// Full details with credits, keywords, regional release dates and trailers.
function fetchMovieDetails(id) {
	return tmdb(`/movie/${id}`, {
		language: LANGUAGE,
		append_to_response: 'credits,keywords,release_dates,videos,external_ids',
		include_video_language: `${LANGUAGE.split('-')[0]},en,null`,
	});
}

// A release this recent still counts as the current run, rather than a later re-release.
const CURRENT_RUN_DAYS = 120;

function theatricalDates(details, region) {
	const regional = details.release_dates?.results?.find((entry) => entry.iso_3166_1 === region)?.release_dates ?? [];
	return [...new Set(regional.filter((entry) => THEATRICAL_TYPES.includes(entry.type)).map((entry) => entry.release_date.slice(0, 10)))].sort();
}

// The cinema release date in the region (YYYY-MM-DD) relevant on `today`: the latest one in the
// last CURRENT_RUN_DAYS, else the next upcoming one. Re-releases (e.g. an anniversary run) get
// their new date rather than the original. Falls back to the worldwide release date.
function regionReleaseDate(details, region, today) {
	const dates = theatricalDates(details, region);
	if (!dates.length) return details.release_date || null;
	const lastPast = dates.filter((date) => date <= today).at(-1);
	const next = dates.find((date) => date > today);
	const daysSince = lastPast ? (Date.parse(today) - Date.parse(lastPast)) / 86400000 : Infinity;
	return daysSince <= CURRENT_RUN_DAYS || !next ? lastPast : next;
}

// The year of the first release in the region when `releaseDate` is a later re-release, else null.
function rereleaseOf(details, region, releaseDate) {
	const first = theatricalDates(details, region)[0];
	return first && releaseDate && first < releaseDate && first.slice(0, 4) !== releaseDate.slice(0, 4) ? first.slice(0, 4) : null;
}

function directors(details) {
	return (details.credits?.crew ?? []).filter((person) => person.job === 'Director');
}

function topCast(details, count = 5) {
	return (details.credits?.cast ?? []).slice(0, count);
}

function trailerUrl(details) {
	const videos = details.videos?.results ?? [];
	const trailer =
		videos.find((video) => video.site === 'YouTube' && video.type === 'Trailer' && video.official) ??
		videos.find((video) => video.site === 'YouTube' && video.type === 'Trailer');
	return trailer ? `https://www.youtube.com/watch?v=${trailer.key}` : null;
}

function posterUrl(details) {
	return details.poster_path ? `${POSTER_BASE_URL}${details.poster_path}` : null;
}

module.exports = {
	tmdbEnabled: adminApiEnabled,
	fetchRegionMovies,
	fetchMovieDetails,
	fetchEnglishDetails,
	fetchCollection,
	fetchReviews,
	regionReleaseDate,
	rereleaseOf,
	directors,
	topCast,
	trailerUrl,
	posterUrl,
};
