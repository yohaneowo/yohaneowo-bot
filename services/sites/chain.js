const fs = require('node:fs/promises');
const path = require('node:path');
const { UserFacingError } = require('./errors');
const { EmptyFileError } = require('./video');
const { DeadlineError, runWithSignal } = require('./deadline');
const linkhub = require('./linkhub');
const { mediaLog } = require('../mediaLog');

// One link is fetched through a short ladder of "rungs": LinkHub first (when configured), the
// site's own parser next, and for yt-dlp sites one more run with a different strategy (single
// file, smaller format, another YouTube client). A rung is tried only when the one before it
// failed, and the extra rung only after an empty or unreadable file ("empty_file"); every other
// failure (too long, login wall, unsupported ...) is final, since repeating it changes nothing.
//
// Bounds, so repairing can never loop or starve the two download slots:
// - the ladder is a fixed array walked once, and this is the only place that falls back;
// - the link has one time budget; the extra rung needs MIN_REMAINING_MS of it left, and every
//   slow step is cancelled when its rung's share is spent;
// - the extra rung is skipped while the other download slot is busy;
// - a site whose whole ladder keeps coming back empty pauses the extra rung for a while, and a link
//   that just failed completely is not retried for a few minutes.
const TOTAL_BUDGET_MS = 4 * 60 * 1000;
// A rung that must run (LinkHub, the site's own parser) gets at least this long even when the
// earlier rungs used up the budget.
const BASE_RUNG_MIN_MS = 60 * 1000;
const MIN_REMAINING_MS = 45 * 1000;
const BREAKER_WINDOW_MS = 10 * 60 * 1000;
const BREAKER_FAILURES = 2;
const COOLDOWN_MS = 5 * 60 * 1000;
const COOLDOWN_MAX_ENTRIES = 200;

// Query parameters that identify the content; everything else (tracking, share ids) is dropped
// so the same link pasted twice maps to one key.
const IDENTITY_PARAMS = ['v', 'p', 'id', 'story_fbid'];

function normalizeUrlKey(url) {
	try {
		const parsed = new URL(url);
		const host = parsed.hostname.toLowerCase().replace(/^(?:www|m|mobile)\./, '');
		const short = parsed.pathname.match(/^\/shorts\/([\w-]{11})/);
		if (host === 'youtube.com' && short) return `youtube:${short[1]}`;
		const query = IDENTITY_PARAMS.filter((name) => parsed.searchParams.has(name))
			.map((name) => `${name}=${parsed.searchParams.get(name)}`)
			.join('&');
		return `${host}${parsed.pathname.replace(/\/+$/, '')}${query ? `?${query}` : ''}`;
	}
	catch {
		return String(url);
	}
}

// In-memory only: a restart clears it. now() is injectable for tests.
function createRepairState(now = Date.now) {
	const failures = new Map();
	const consecutive = new Map();
	const cooldown = new Map();

	function prune(t) {
		for (const [key, until] of cooldown) {
			if (until <= t) cooldown.delete(key);
		}
		while (cooldown.size > COOLDOWN_MAX_ENTRIES) {
			cooldown.delete(cooldown.keys().next().value);
		}
	}

	return {
		isCoolingDown(key) {
			const t = now();
			prune(t);
			return (cooldown.get(key) ?? 0) > t;
		},
		// Two complete failures within BREAKER_WINDOW_MS of each other, and the latest one is still
		// inside the window: pause the extra rung for this site.
		isBreakerOpen(site) {
			const t = now();
			const list = failures.get(site) ?? [];
			return (
				list.length >= BREAKER_FAILURES &&
				list[1] - list[0] <= BREAKER_WINDOW_MS &&
				t - list[1] <= BREAKER_WINDOW_MS
			);
		},
		consecutiveFailures(site) {
			return consecutive.get(site) ?? 0;
		},
		recordFailure(site, key) {
			const t = now();
			failures.set(site, [...(failures.get(site) ?? []), t].slice(-BREAKER_FAILURES));
			consecutive.set(site, (consecutive.get(site) ?? 0) + 1);
			cooldown.delete(key);
			cooldown.set(key, t + COOLDOWN_MS);
			prune(t);
			return consecutive.get(site);
		},
		recordSuccess(site, key) {
			failures.delete(site);
			consecutive.delete(site);
			cooldown.delete(key);
		},
		size() {
			return cooldown.size;
		},
	};
}

const defaultState = createRepairState();

// mediaPost.js tells the chain when both download slots are in use.
let busyProbe = () => false;
function setBusyProbe(fn) {
	busyProbe = fn;
}

// Errors that end the ladder: repeating them with another route would give the same answer.
function isFinalError(error) {
	return error.code === 'VIDEO_TOO_LONG' || (error instanceof UserFacingError && error.code !== 'EMPTY_FILE');
}

// A rung can return files that were never size-checked (every site but the single-video path).
async function assertNoEmptyFiles(result) {
	for (const file of result.files ?? []) {
		const { size } = await fs.stat(file.path);
		if (size === 0) throw new EmptyFileError(`${file.name} is 0 bytes`);
	}
}

// rungs: [{ name, repair, enabled(), run(url, dir, maxBytes, onStage) }]. A rung works in its own
// directory, which is deleted when it fails, so a failed attempt never leaves files for the next.
function createFallbackChain({
	site,
	rungs,
	state = defaultState,
	now = Date.now,
	totalMs = TOTAL_BUDGET_MS,
	baseRungMinMs = BASE_RUNG_MIN_MS,
	minRemainingMs = MIN_REMAINING_MS,
	isBusy = () => busyProbe(),
}) {
	return async function runChain(url, dir, maxBytes, onStage) {
		const key = normalizeUrlKey(url);
		if (state.isCoolingDown(key)) {
			mediaLog.warn(`${key} failed completely a moment ago; not retrying yet`);
			const error = new EmptyFileError('cooldown: this link failed completely a few minutes ago');
			error.userMessage = '这个链接刚刚下载失败了，请几分钟后再试';
			throw error;
		}

		const startedAt = now();
		const budgetEnd = startedAt + totalMs;
		const tried = [];
		let sawEmpty = false;
		let emptyDetail = '';
		let lastError = null;

		for (const rung of rungs) {
			if (!rung.enabled()) continue;
			if (rung.repair) {
				if (!sawEmpty) continue;
				const remaining = budgetEnd - now();
				const skip =
					(state.isBreakerOpen(site) && 'breaker open for this site') ||
					(isBusy() && 'the other download slot is busy') ||
					(remaining < minRemainingMs && `only ${Math.round(remaining / 1000)}s of the time budget left`);
				if (skip) {
					mediaLog.warn(`skipping ${rung.name}: ${skip}`);
					continue;
				}
				onStage?.('retrying');
			}

			tried.push(rung.name);
			const rungDir = path.join(dir, `rung-${tried.length}`);
			await fs.mkdir(rungDir, { recursive: true });
			// A repair rung may not outlive the budget; a base rung always gets a minimum.
			const rungEnd = rung.repair ? budgetEnd : Math.max(budgetEnd, now() + baseRungMinMs);
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(new DeadlineError(rung.name)), Math.max(0, rungEnd - now()));
			const rungStartedAt = now();
			try {
				const result = await runWithSignal(controller.signal, () => rung.run(url, rungDir, maxBytes, onStage));
				await assertNoEmptyFiles(result);
				if (sawEmpty) {
					mediaLog.info(`recovered by ${rung.name} after ${tried.slice(0, -1).join(', ')} came back empty`);
				}
				state.recordSuccess(site, key);
				return result;
			}
			catch (error) {
				await fs.rm(rungDir, { recursive: true, force: true });
				lastError = controller.signal.aborted ? controller.signal.reason : error;
				if (lastError.code === 'EMPTY_FILE') {
					sawEmpty = true;
					emptyDetail = lastError.detail ?? lastError.message;
				}
				mediaLog.warn(
					`${rung.name} failed after ${((now() - rungStartedAt) / 1000).toFixed(1)}s: ${lastError.message}`,
				);
				if (isFinalError(lastError)) throw lastError;
			}
			finally {
				clearTimeout(timer);
			}
		}

		if (!sawEmpty) throw lastError;

		const count = state.recordFailure(site, key);
		const open = state.isBreakerOpen(site);
		mediaLog.warn(
			`${site}: every route came back empty (${tried.join(' > ')}); ${count} in a row for this site` +
				`${open ? '; the extra retry is paused for it' : ''}`,
		);
		const error = new EmptyFileError(`tried=${tried.join(',')}; site_consecutive=${count}; ${emptyDetail}`);
		error.tried = tried;
		throw error;
	};
}

// LinkHub first (when configured), then the site's own parser, then (yt-dlp sites only) the
// parser again with a different strategy after an empty file. Replaces the old withLinkHub().
function withFallbackChain(local, { site, alt } = {}) {
	const rungs = [
		{ name: 'linkhub', repair: false, enabled: () => linkhub.isConfigured(), run: linkhub.fetchViaLinkHub },
		{ name: 'local', repair: false, enabled: () => true, run: local },
	];
	if (alt) rungs.push({ name: 'local-alt', repair: true, enabled: () => true, run: alt });
	return createFallbackChain({ site, rungs });
}

module.exports = {
	withFallbackChain,
	createFallbackChain,
	createRepairState,
	normalizeUrlKey,
	setBusyProbe,
	TOTAL_BUDGET_MS,
};
