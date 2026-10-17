const { MessageFlags, RESTJSONErrorCodes } = require('discord.js');
const tmdb = require('./tmdb');
const { fetchMovieStatus, traktEnabled } = require('./trakt');
const { loadTaste, scoreMovie, favouritePeople } = require('./taste');
const { findSimilarHistory } = require('./similar');
const { aiEnabled, judgeCandidates, extractFormats } = require('./judge');
const { formatSentencesOrNone } = require('./wikipedia');
const { buildDigestMessages, markFeedback } = require('./message');
const store = require('./store');
const { handleAskButton } = require('./ask');
const { withAiCaller } = require('../aiUsage');

// Daily movie recommendations for /movie subscribers, sent as one digest DM. Each run, per subscriber:
//   1. reminders: movies recommended while upcoming that have now opened;
//   2. movies in cinemas that were never judged are ranked and judged;
//   3. so are newly listed upcoming movies (recommended ones get a reminder on release).
// Rule scores pick the best few candidates (the rest wait for later runs, never rejected by
// rules alone). The AI (when set up) gets each one's most similar titles from the user's history
// and their favourite people in it, makes the call, writes the reason and picks who to feature.
// Every judged movie is remembered, so nothing is judged or sent twice.
// New recommendations per user per day, counted separately for movies in cinemas and upcoming
// ones (so upcoming ones still get announced ahead of release). Release reminders don't count.
const MAX_PER_DAY = Number(process.env.MOVIE_MAX_PER_DAY) || 3;
const TIMEZONE = process.env.MOVIE_TIMEZONE || 'Asia/Taipei';
// Candidates per kind (in cinemas / upcoming) the AI judges each run; the rest wait for later runs.
const AI_CANDIDATES_PER_KIND = 6;
// A re-release of a film the user rated at least this (and REWATCH_ABOVE_MEAN over their own
// average) is recommended as a chance to see it again on the big screen, without asking the AI.
const REWATCH_MIN_RATING = 9;
const REWATCH_ABOVE_MEAN = 0.5;
// Rewatches don't use the daily quotas, but a day of many re-releases shouldn't flood the DM.
const MAX_REWATCHES_PER_RUN = 5;
// Without the AI, rule scores decide alone.
const RULE_RECOMMEND_SCORE = 1;
const DETAIL_FETCH_CONCURRENCY = 4;

const running = new Set();

function today() {
	// sv-SE formats dates as YYYY-MM-DD.
	return new Date().toLocaleDateString('sv-SE', { timeZone: TIMEZONE });
}

async function mapConcurrent(items, fn) {
	const results = new Map();
	const queue = [...items];
	await Promise.all(
		Array.from({ length: DETAIL_FETCH_CONCURRENCY }, async () => {
			while (queue.length) {
				const item = queue.shift();
				try {
					results.set(item, await fn(item));
				}
				catch (error) {
					console.warn(`[movie] ${error.message}`);
				}
			}
		}),
	);
	return results;
}

// Everything showing or coming in a region, with details; shared by that region's subscribers.
async function loadRegion(region) {
	const { movies, nowPlayingIds } = await tmdb.fetchRegionMovies(region);
	const details = await mapConcurrent(
		movies.map((movie) => movie.id),
		(id) => tmdb.fetchMovieDetails(id),
	);
	const date = today();
	const entries = [...details.values()].map((movieDetails) => {
		const releaseDate = tmdb.regionReleaseDate(movieDetails, region, date);
		const isOut = nowPlayingIds.has(movieDetails.id) || (releaseDate && releaseDate <= date);
		const rereleaseYear = tmdb.rereleaseOf(movieDetails, region, releaseDate);
		return { details: movieDetails, releaseDate, rereleaseYear, kind: isOut ? 'now' : 'upcoming' };
	});
	console.log(`[movie] ${region}: ${entries.filter((e) => e.kind === 'now').length} in cinemas, ${entries.filter((e) => e.kind === 'upcoming').length} upcoming`);
	return { region, entries, byId: new Map(entries.map((entry) => [entry.details.id, entry])) };
}

// Resolves to true when the DM was delivered.
async function sendDm(client, userId, payload) {
	try {
		const user = await client.users.fetch(userId);
		await user.send(payload);
		return true;
	}
	catch (error) {
		const reason = error.code === RESTJSONErrorCodes.CannotSendMessagesToThisUser ? 'their DMs are closed to the bot' : error.message;
		console.warn(`[movie] Could not DM ${userId}: ${reason}`);
		return false;
	}
}

// ─── One subscriber ───

function feedbackTitles(movies) {
	const titles = { want: [], skip: [] };
	for (const record of Object.values(movies)) {
		if (record.feedback === 'want' || record.feedback === 'skip') titles[record.feedback].push(record.title);
	}
	return titles;
}

function sentToday(movies, kind) {
	const date = today();
	return Object.values(movies).filter(
		(record) =>
			record.sentAt &&
			record.sentKind === kind &&
			new Date(record.sentAt).toLocaleDateString('sv-SE', { timeZone: TIMEZONE }) === date,
	).length;
}

function templateReason(match) {
	const parts = [];
	if (match.likedPeople.length) parts.push(`有你评分高的${match.likedPeople.slice(0, 2).join('、')}`);
	if (match.likedGenres.length) parts.push(`你偏爱的${match.likedGenres.slice(0, 3).join('、')}类型`);
	return parts.length ? `${parts.join('，')}` : '和你的观看记录相近';
}

// Release reminders: cards for movies recommended while upcoming that are out now.
// Formats are often announced close to release, after an upcoming movie was judged: re-read the
// Wikipedia sentences for a reminder and, only if they changed, have the AI re-read the formats.
// Resolves to the (possibly updated) record; failures just keep what was known.
async function refreshFormats(userId, id, record, details) {
	if (!aiEnabled) return record;
	const { sentences, hash } = await formatSentencesOrNone(details);
	if (!hash || hash === record.formatsHash) return record;
	try {
		const { formats, filmedInImax } = await extractFormats(details, sentences);
		return await store.updateMovie(userId, id, { formats, filmedInImax, formatsHash: hash });
	}
	catch (error) {
		console.warn(`[movie] Re-reading formats for ${id} failed:`, error.message);
		return record;
	}
}

async function collectReminders(userId, movies, taste, regionData, date) {
	const cards = [];
	for (const [id, record] of Object.entries(movies)) {
		if (record.kind !== 'upcoming' || !record.sentAt || record.remindedAt) continue;
		// Seen movies get no reminder, except re-releases recommended precisely because they were loved.
		if (record.feedback === 'skip' || record.feedback === 'seen' || (taste.seenIds.has(Number(id)) && !record.rewatch)) continue;
		const known = regionData.byId.get(Number(id));
		if (known?.kind !== 'now' && !(record.releaseDate && record.releaseDate <= date)) continue;
		const details = known?.details ?? (await tmdb.fetchMovieDetails(id));
		const releaseDate = known?.releaseDate ?? tmdb.regionReleaseDate(details, regionData.region, date);
		if (known?.kind !== 'now' && releaseDate > date) {
			// Postponed: wait for the new date.
			await store.updateMovie(userId, id, { releaseDate });
			continue;
		}
		const entry = known ?? { details, releaseDate, rereleaseYear: tmdb.rereleaseOf(details, regionData.region, releaseDate) };
		cards.push({ id: Number(id), entry, record: await refreshFormats(userId, id, record, details), type: 'reminder' });
	}
	return cards;
}

// Ranks movies never judged before, judges the best few, and records the verdicts.
async function judgeFresh(userId, movies, taste, regionData) {
	const fresh = regionData.entries
		.filter((entry) => !movies[entry.details.id] && !taste.seenIds.has(entry.details.id))
		.map((entry) => ({ ...entry, match: scoreMovie(taste, entry.details), favourites: favouritePeople(taste, entry.details) }));
	const pick = (kind) =>
		fresh
			.filter((candidate) => candidate.kind === kind)
			.sort((a, b) => b.match.score - a.match.score)
			.slice(0, AI_CANDIDATES_PER_KIND);
	const candidates = [...pick('now'), ...pick('upcoming')];
	if (!candidates.length) return 0;

	let verdicts = null;
	if (aiEnabled) {
		const similar = await findSimilarHistory(taste, candidates.map((candidate) => candidate.details));
		for (const candidate of candidates) {
			candidate.similar = similar.get(candidate.details.id) ?? [];
			const { sentences, hash } = await formatSentencesOrNone(candidate.details);
			candidate.formatSentences = sentences;
			candidate.formatsHash = hash;
		}
		verdicts = await judgeCandidates(taste, candidates, feedbackTitles(movies));
	}

	let judged = 0;
	for (const candidate of candidates) {
		const verdict = verdicts
			? verdicts.get(candidate.details.id)
			: {
				recommend: candidate.match.score >= RULE_RECOMMEND_SCORE,
				predictedRating: null,
				reason: templateReason(candidate.match),
				featuredPersonIds: candidate.favourites.slice(0, 1).map((person) => person.id),
			};
		// The AI left it out: try again next run.
		if (!verdict) continue;
		await store.updateMovie(userId, candidate.details.id, {
			title: candidate.details.title,
			decision: verdict.recommend ? 'recommend' : 'reject',
			reason: verdict.reason,
			predictedRating: verdict.predictedRating,
			// Kept with the record so the release reminder can show them too.
			featuredPeople: candidate.favourites.filter((person) => verdict.featuredPersonIds.includes(person.id)),
			// Special formats read from Wikipedia (none without the AI); formatsHash lets a reminder tell if they changed.
			formats: verdict.formats ?? [],
			filmedInImax: Boolean(verdict.filmedInImax),
			formatsHash: candidate.formatsHash ?? null,
			kind: candidate.kind,
			releaseDate: candidate.releaseDate,
			evaluatedAt: new Date().toISOString(),
		});
		judged += 1;
	}
	return judged;
}

// Re-releases (the 2019 film back in cinemas) of films the user already rated highly. Seen movies
// are otherwise never candidates, but a loved one coming back to the big screen is worth a heads-up.
// Records them as recommendations straight away (the rating says it all), with formats read from
// Wikipedia when there are any: a re-release is often an IMAX or anniversary run.
async function findRewatches(userId, movies, taste, regionData) {
	const threshold = Math.max(REWATCH_MIN_RATING, taste.mean + REWATCH_ABOVE_MEAN);
	let found = 0;
	for (const entry of regionData.entries) {
		const id = entry.details.id;
		const rating = taste.ratingByTmdb.get(id);
		if (!entry.rereleaseYear || movies[id] || rating == null || rating < threshold) continue;
		const record = await store.updateMovie(userId, id, {
			title: entry.details.title,
			decision: 'recommend',
			rewatch: true,
			rating,
			reason: `你给它打过 ${rating} 分，这次重映可以在大银幕重温。`,
			predictedRating: null,
			featuredPeople: [],
			formats: [],
			filmedInImax: false,
			kind: entry.kind,
			releaseDate: entry.releaseDate,
			evaluatedAt: new Date().toISOString(),
		});
		await refreshFormats(userId, id, record, entry.details);
		found += 1;
	}
	return found;
}

// Recommended-but-unsent movies (including leftovers from earlier days), in cinemas first, then
// upcoming, each up to its daily quota; rewatches come on top of the quotas. An upcoming one that
// has opened since it was judged goes out as "in cinemas", which needs no release reminder.
function collectRecommendations(movies, taste, regionData) {
	const unsent = Object.entries(movies)
		.filter(([, record]) => record.decision === 'recommend' && !record.sentAt && !record.feedback)
		.map(([id, record]) => ({ id: Number(id), record, entry: regionData.byId.get(Number(id)) }))
		.filter(({ id, record, entry }) => entry && (record.rewatch || !taste.seenIds.has(id)))
		.sort((a, b) => (b.record.predictedRating ?? 0) - (a.record.predictedRating ?? 0));
	const cards = unsent
		.filter(({ record }) => record.rewatch)
		.sort((a, b) => b.record.rating - a.record.rating)
		.slice(0, MAX_REWATCHES_PER_RUN)
		.map((item) => ({ ...item, type: item.entry.kind }));
	for (const kind of ['now', 'upcoming']) {
		const quota = Math.max(0, MAX_PER_DAY - sentToday(movies, kind));
		const fresh = unsent.filter(({ record, entry }) => !record.rewatch && entry.kind === kind);
		for (const item of fresh.slice(0, quota)) cards.push({ ...item, type: kind });
	}
	return cards;
}

// Resolves to { recommended, reminded, judged }. trigger ('daily' | 'command') goes into the AI call log.
async function runForSubscriber(client, subscriber, regionData, trigger) {
	const { userId, traktUser } = subscriber;
	const name = subscriber.traktName ?? traktUser;
	const discordUser = await client.users.fetch(userId).catch(() => null);
	const displayName = discordUser?.globalName ?? discordUser?.username ?? null;
	// AI calls made for this subscriber are their cost (shared ones opt out in similar.js).
	const caller = { platform: 'discord', id: userId, name: displayName, avatarUrl: discordUser?.displayAvatarURL?.({ size: 64 }) ?? null, trigger };
	return withAiCaller(caller, () => store.withSubscription(subscriber, () => runSubscriberSteps(client, subscriber, regionData, { name, displayName })));
}

async function runSubscriberSteps(client, subscriber, regionData, { name, displayName }) {
	const { userId } = subscriber;
	const taste = await loadTaste(userId);
	// A new subscription's first sync hasn't finished yet; the next run will have it.
	if (!taste) {
		console.log('[movie] No taste profile yet; skipping this subscriber for now.');
		return { recommended: 0, reminded: 0, judged: 0 };
	}
	const movies = await store.userMovies(userId);
	const date = today();

	const reminders = await collectReminders(userId, movies, taste, regionData, date);
	const judged = (await judgeFresh(userId, movies, taste, regionData)) + (await findRewatches(userId, movies, taste, regionData));
	const cards = [...reminders, ...collectRecommendations(await store.userMovies(userId), taste, regionData)];

	// Cards are marked sent only once their message got through, so a failed DM retries next run.
	const result = { recommended: 0, reminded: 0, judged };
	for (const { payload, cards: sentCards } of buildDigestMessages(cards, date, displayName)) {
		const current = await store.getSubscriber(userId);
		if (!current || current.revision !== subscriber.revision) return result;
		if (!(await sendDm(client, userId, payload))) continue;
		const now = new Date().toISOString();
		for (const card of sentCards) {
			if (card.type === 'reminder') {
				await store.updateMovie(userId, card.id, { remindedAt: now });
				result.reminded += 1;
			}
			else {
				await store.updateMovie(userId, card.id, {
					kind: card.type,
					// Rewatches don't count toward the daily quotas.
					sentKind: card.record.rewatch ? 'rewatch' : card.type,
					sentAt: now,
					...(card.type === 'now' ? { remindedAt: now } : {}),
				});
				result.recommended += 1;
			}
		}
	}

	console.log(`[movie] ${name} (${userId}): judged ${result.judged}, recommended ${result.recommended}, reminded ${result.reminded}`);
	return result;
}

async function runGuarded(client, subscriber, regionData, trigger) {
	if (running.has(subscriber.userId)) return null;
	running.add(subscriber.userId);
	try {
		return await runForSubscriber(client, subscriber, regionData, trigger);
	}
	finally {
		running.delete(subscriber.userId);
	}
}

// ─── Entry points ───

async function runDaily(client) {
	const byRegion = new Map();
	for (const subscriber of await store.listSubscribers()) {
		byRegion.set(subscriber.region, [...(byRegion.get(subscriber.region) ?? []), subscriber]);
	}
	for (const [region, subscribers] of byRegion) {
		try {
			const regionData = await loadRegion(region);
			for (const subscriber of subscribers) {
				await runGuarded(client, subscriber, regionData, 'daily').catch((error) =>
					console.warn(`[movie] Run for ${subscriber.traktName ?? subscriber.traktUser} failed:`, error.message),
				);
			}
		}
		catch (error) {
			console.warn(`[movie] Loading ${region} failed:`, error.message);
		}
	}
}

// For /movie check. Resolves to the run result, or null when a run is already in progress.
async function runNow(client, userId) {
	const subscriber = await store.getSubscriber(userId);
	if (!subscriber) throw new Error('Movie subscription is no longer active.');
	return runGuarded(client, { userId, ...subscriber }, await loadRegion(subscriber.region), 'command');
}

// Recommendation DM buttons (customId movie:<want|skip|seen|ask>:<tmdbId>). Feedback presses record the
// answer and disable that movie's buttons, leaving the rest of the digest as it was.
async function handleFeedbackButton(interaction) {
	const [, action, id] = interaction.customId.split(':');
	if (action === 'ask') {
		await handleAskButton(interaction, id);
		return;
	}
	await interaction.deferUpdate();
	if (!['want', 'skip', 'seen'].includes(action) || !(await store.userMovies(interaction.user.id))[id]) {
		await interaction.followUp({ content: '找不到这则推荐的记录。', flags: MessageFlags.Ephemeral });
		return;
	}
	const record = await store.updateMovie(interaction.user.id, id, { feedback: action });
	await interaction.editReply({ components: markFeedback(interaction.message.components, id, action) });
	if (action === 'seen') await nudgeToRate(interaction, id, record.title);
}

// Said "seen" but Trakt doesn't know: recommendations only include movies missing from their Trakt
// history, so this nearly always means it went unlogged. A rating is what teaches the recommender.
const UNLOGGED_NUDGES = [
	(title, url) => `看过了却没在 Trakt 留下任何记录？这样我只能靠猜了 🥲 去给《${title}》评个分吧：${url}`,
	(title, url) => `说看过了，Trakt 上却一片空白…证据呢 👀 补个《${title}》的评分：${url}`,
	(title, url) => `偷偷看完不留评分，下次推荐不准可别怪我 😤 《${title}》的评分在这里：${url}`,
];

async function nudgeToRate(interaction, tmdbId, title) {
	const subscriber = await store.getSubscriber(interaction.user.id);
	if (!subscriber) return;
	let content;
	try {
		const { rating, watched, url } = await fetchMovieStatus(subscriber.traktUser, tmdbId);
		if (rating != null) content = `✅ 你在 Trakt 给了《${title}》${rating} 分，之后的推荐会参考。`;
		else if (watched) content = `👀 Trakt 记录你看过《${title}》，但还没评分。评个分吧，这样我才知道你喜不喜欢：${url}`;
		else content = UNLOGGED_NUDGES[Math.floor(Math.random() * UNLOGGED_NUDGES.length)](title, url);
	}
	catch (error) {
		console.warn(`[movie] Trakt status for ${tmdbId} failed:`, error.message);
		content = `记得到 Trakt 给《${title}》评个分，推荐才会越来越准：https://trakt.tv/search?query=${encodeURIComponent(title)}`;
	}
	// Keep the link from unfurling into a big preview under the reply.
	await interaction.followUp({ content: content.replace(/(https:\/\/\S+)/, '<$1>'), flags: MessageFlags.Ephemeral });
}

module.exports = {
	moviesEnabled: tmdb.tmdbEnabled && traktEnabled,
	runDaily,
	runNow,
	handleFeedbackButton,
};
