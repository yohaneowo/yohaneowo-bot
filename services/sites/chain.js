const fs = require('node:fs/promises');
const path = require('node:path');
const { UserFacingError } = require('./errors');
const { EmptyFileError, probeVideo } = require('./video');
const { DeadlineError, runWithSignal } = require('./deadline');
const linkhub = require('./linkhub');
const { mediaLog } = require('../mediaLog');

// One link is fetched through a short ladder of "rungs": LinkHub first (when configured), the
// site's own parser next, and for yt-dlp sites one more run with a different strategy (single
// file, smaller format, another YouTube client). A rung is tried only when the one before it
// failed, and the extra rung only when the rung just before it came back with an empty or
// unreadable file ("empty_file"); every other failure (too long, login wall, unsupported ...) is
// final, since repeating it changes nothing.
//
// Bounds, so repairing can never loop or starve the two download slots:
// - the ladder is a fixed array walked once, and this is the only place that falls back;
// - the link has one time budget (TOTAL_BUDGET_MS); no rung after the first starts with less than
//   MIN_REMAINING_MS left, and when the budget is spent the slow steps (LinkHub requests, yt-dlp,
//   ffprobe, ffmpeg) are cancelled;
// - the extra rung is skipped while the other download slot is busy;
// - a site whose whole ladder keeps coming back empty pauses the extra rung for a while, and a link
//   that just failed completely is not retried for a few minutes. Only a ladder that was really
//   walked to its end counts: if the extra rung was skipped (busy, breaker, no time), nothing is
//   recorded, so a skipped retry never locks the user out.
const TOTAL_BUDGET_MS = 4 * 60 * 1000;
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

const VIDEO_FILE = /\.(?:mp4|m4v|mov|webm|mkv)$/i;

// A rung can return files nobody has looked at yet (every site but the single-video path, e.g. the
// videos of a post with several media): none may be empty, and a video must have a readable length.
// Without ffprobe there is nothing to judge, so such a file is accepted.
async function assertUsableResult(result, probe) {
	for (const file of result.files ?? []) {
		const { size } = await fs.stat(file.path);
		if (size === 0) throw new EmptyFileError(`${file.name} is 0 bytes`);
		if (!VIDEO_FILE.test(file.path)) continue;
		const info = await probe(file.path);
		if (info?.unavailable) continue;
		// info.codec is the first video stream's: an audio-only mp4 has a duration but nothing to show.
		if (!info || !(info.duration > 0) || !info.codec) {
			throw new EmptyFileError(`${file.name} has no readable video stream or duration (${size} bytes)`);
		}
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
	minRemainingMs = MIN_REMAINING_MS,
	isBusy = () => busyProbe(),
	probe = probeVideo,
}) {
	return async function runChain(url, dir, maxBytes, onStage) {
		const key = normalizeUrlKey(url);
		if (state.isCoolingDown(key)) {
			mediaLog.warn(`${key} failed completely a moment ago; not retrying yet`);
			const error = new EmptyFileError('cooldown: this link failed completely a few minutes ago');
			error.userMessage = '这个链接刚刚下载失败了，请几分钟后再试';
			throw error;
		}

		const budgetEnd = now() + totalMs;
		const tried = [];
		// Set when a rung was left out for lack of slots, time or the breaker: the ladder was not
		// walked to its end, so a failure must not count against the site or the link.
		let incomplete = false;
		let lastError = null;

		for (const rung of rungs) {
			if (!rung.enabled()) continue;
			if (rung.repair) {
				// Only straight after an empty file; a network error or a login wall says nothing about the file.
				if (lastError?.code !== 'EMPTY_FILE') continue;
				const skip =
					(state.isBreakerOpen(site) && 'breaker open for this site') ||
					(isBusy() && 'the other download slot is busy');
				if (skip) {
					mediaLog.warn(`skipping ${rung.name}: ${skip}`);
					incomplete = true;
					continue;
				}
			}
			const remaining = budgetEnd - now();
			if (tried.length > 0 && remaining < minRemainingMs) {
				mediaLog.warn(`not starting ${rung.name}: only ${Math.max(0, Math.round(remaining / 1000))}s of the time budget left`);
				incomplete = true;
				break;
			}
			if (rung.repair) onStage?.('retrying');

			tried.push(rung.name);
			const rungDir = path.join(dir, `rung-${tried.length}`);
			await fs.mkdir(rungDir, { recursive: true });
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(new DeadlineError(rung.name)), Math.max(0, budgetEnd - now()));
			const rungStartedAt = now();
			try {
				// The file check runs under the same budget (a stuck ffprobe is cancelled too), and a rung
				// that only finished after the budget was spent does not count as a success.
				const result = await runWithSignal(controller.signal, async () => {
					const fetched = await rung.run(url, rungDir, maxBytes, onStage);
					await assertUsableResult(fetched, probe);
					return fetched;
				});
				if (controller.signal.aborted) throw controller.signal.reason;
				if (tried.length > 1 && lastError?.code === 'EMPTY_FILE') {
					mediaLog.info(`recovered by ${rung.name} after ${tried.slice(0, -1).join(', ')} came back empty`);
				}
				state.recordSuccess(site, key);
				return result;
			}
			catch (error) {
				await fs.rm(rungDir, { recursive: true, force: true });
				lastError = controller.signal.aborted ? controller.signal.reason : error;
				mediaLog.warn(
					`${rung.name} failed after ${((now() - rungStartedAt) / 1000).toFixed(1)}s: ${lastError.message}`,
				);
				if (isFinalError(lastError)) throw lastError;
			}
			finally {
				clearTimeout(timer);
			}
		}

		// Anything but an empty file at the end (timeout, network error, ...) is reported as what it is.
		if (!lastError) throw new Error('no route is available for this link');
		if (lastError.code !== 'EMPTY_FILE') throw lastError;

		const count = incomplete ? state.consecutiveFailures(site) : state.recordFailure(site, key);
		mediaLog.warn(
			incomplete
				? `${site}: empty file and the retry was not possible (${tried.join(' > ')}); nothing recorded`
				: `${site}: every route came back empty (${tried.join(' > ')}); ${count} in a row for this site` +
					`${state.isBreakerOpen(site) ? '; the extra retry is paused for it' : ''}`,
		);
		const error = new EmptyFileError(
			`tried=${tried.join(',')}; site_consecutive=${count}${incomplete ? '; retry skipped' : ''}; ${lastError.detail ?? lastError.message}`,
		);
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
