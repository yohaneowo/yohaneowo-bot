const { AsyncLocalStorage } = require('node:async_hooks');
const subscriptionContext = new AsyncLocalStorage();
const { movieRequest } = require('../adminApi');

// Admin is authoritative; nothing movie-related is kept in the bot.
const part = (value) => encodeURIComponent(value);

function getSubscriber(userId) {
	return movieRequest('GET', `/subscribers/${part(userId)}`);
}
function listSubscribers() {
	return movieRequest('GET', '/subscribers');
}
function subscribe(userId, traktUser, traktName, region, subscribedAt) {
	return movieRequest('PUT', `/subscribers/${part(userId)}`, { traktUser, traktName, region, subscribedAt });
}
function unsubscribe(userId) {
	return movieRequest('DELETE', `/subscribers/${part(userId)}`);
}
function userMovies(userId) {
	return movieRequest('GET', `/records/${part(userId)}`);
}
function updateMovie(userId, tmdbId, fields, revision) {
	return movieRequest('PATCH', `/records/${part(userId)}/${part(tmdbId)}`, { data: fields, revision: revision ?? subscriptionContext.getStore()?.revision });
}
async function readCache(namespace, keys) {
	const result = {};
	for (let i = 0; i < keys.length; i += 200) {
		Object.assign(result, await movieRequest('POST', `/cache/${namespace}/read`, { keys: keys.slice(i, i + 200).map(String) }));
	}
	return result;
}
async function writeCache(namespace, items) {
	const entries = Object.entries(items);
	for (let i = 0; i < entries.length; i += 100) {
		await movieRequest('PUT', `/cache/${namespace}`, { items: Object.fromEntries(entries.slice(i, i + 100)) });
	}
}
// The taste profile admin's statistics sync stored: { taste, syncedAt }, or null before the first sync.
function getTaste(userId) {
	return movieRequest('GET', `/taste/${part(userId)}`);
}
// IMDb / Rotten Tomatoes / Metacritic scores by IMDb ID. Admin queries OMDb and caches the answers.
async function fetchPublicRatings(imdbIds) {
	const result = {};
	const ids = [...new Set(imdbIds)];
	for (let i = 0; i < ids.length; i += 200) {
		Object.assign(result, await movieRequest('POST', '/ratings', { imdbIds: ids.slice(i, i + 200) }));
	}
	return result;
}
const withSubscription = (subscription, fn) => subscriptionContext.run(subscription, fn);
module.exports = { withSubscription, getSubscriber, listSubscribers, subscribe, unsubscribe, userMovies, updateMovie, getTaste, readCache, writeCache, fetchPublicRatings };
