// Reports groups, activity and logs to yohaneowo-admin's internal API (/api/v1/bot/internal/*).
// Off unless ADMIN_API_URL and ADMIN_API_TOKEN are set. Every call is best-effort: when the
// admin is down the bot logs a warning and carries on, it never waits on or fails because of it.
const util = require('node:util');
const { AsyncLocalStorage } = require('node:async_hooks');

const ADMIN_API_URL = (process.env.ADMIN_API_URL ?? '').replace(/\/+$/, '');
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN ?? '';
const REQUEST_TIMEOUT_MS = 5 * 1000;
// Activity only needs to be roughly right, so each group reports at most this often.
const ACTIVITY_INTERVAL_MS = 10 * 60 * 1000;
// Logs are queued and sent in batches. While the admin is unreachable they wait in memory
// (oldest dropped past LOG_QUEUE_LIMIT) and are retried after LOG_RETRY_MS.
const LOG_FLUSH_MS = 3 * 1000;
const LOG_RETRY_MS = 30 * 1000;
const LOG_BATCH_SIZE = 500;
const LOG_QUEUE_LIMIT = 5000;
const MAX_LOG_TEXT_LENGTH = 10000;
const LOG_PATHS = { parse: '/parse-log/report', runtime: '/runtime-log/report' };

const enabled = Boolean(ADMIN_API_URL && ADMIN_API_TOKEN);
const lastActivityAt = new Map();
// Which site's link is being parsed, so runtime logs printed along the way can be filtered by site.
const logScope = new AsyncLocalStorage();
const logQueues = { parse: [], runtime: [] };
let flushTimer = null;
let flushing = null;

// Bound before installConsoleCapture() patches console, so this module's own warnings
// never feed back into the runtime log queue.
const warn = console.warn.bind(console);

// Resolves to { ok, data, retryable }. 4xx means the admin rejected the payload, so
// retrying the same thing would never succeed.
async function send(path, body) {
	try {
		const response = await fetch(`${ADMIN_API_URL}/api/v1/bot/internal${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'X-Bot-Token': ADMIN_API_TOKEN },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		const json = await response.json().catch(() => null);
		if (response.ok && json?.success) return { ok: true, data: json.data };
		warn(`Admin API ${path} failed:`, json?.msg ?? `HTTP ${response.status}`);
		return { ok: false, retryable: response.status >= 500 };
	}
	catch (error) {
		warn(`Admin API ${path} failed:`, error.message);
		return { ok: false, retryable: true };
	}
}

// Resolves to the response's data, or null when the call is disabled or failed.
async function post(path, body) {
	if (!enabled) return null;
	const result = await send(path, body);
	return result.ok ? result.data : null;
}

// group: { external_id, name, icon_url, member_count }

// Every group the bot is in on this platform; ones missing from the list are marked as left.
function syncGroups(platform, groups) {
	return post('/group/sync', { platform, groups });
}

function reportJoin(platform, group) {
	return post('/group/join', { platform, ...group });
}

function reportLeave(platform, externalId) {
	return post('/group/leave', { platform, external_id: externalId });
}

// Throttled per group. When the admin has never seen the group (e.g. the bot joined before
// reporting existed), loadGroup is called to fetch its details and register it.
async function reportActivity(platform, externalId, loadGroup) {
	if (!enabled) return;
	const key = `${platform}:${externalId}`;
	const now = Date.now();
	if (now - (lastActivityAt.get(key) ?? 0) < ACTIVITY_INTERVAL_MS) return;
	lastActivityAt.set(key, now);

	const known = await post('/group/activity', { platform, external_id: externalId });
	if (known === false && loadGroup) {
		const group = await loadGroup().catch((error) => {
			warn(`Loading ${key} for the admin failed:`, error.message);
			return null;
		});
		if (group && (await reportJoin(platform, group))) {
			await post('/group/activity', { platform, external_id: externalId });
		}
	}
}

function truncate(text) {
	if (typeof text !== 'string' || text.length <= MAX_LOG_TEXT_LENGTH) return text;
	return `${text.slice(0, MAX_LOG_TEXT_LENGTH)}…（已截断，原长 ${text.length} 字）`;
}

function scheduleFlush(delayMs) {
	if (flushTimer) return;
	flushTimer = setTimeout(flushLogs, delayMs);
	flushTimer.unref();
}

function enqueueLog(kind, entry) {
	if (!enabled) return;
	const queue = logQueues[kind];
	queue.push({ ...entry, occurred_at: new Date().toISOString() });
	if (queue.length > LOG_QUEUE_LIMIT) queue.splice(0, queue.length - LOG_QUEUE_LIMIT);
	scheduleFlush(LOG_FLUSH_MS);
}

async function sendQueuedLogs() {
	let retryLater = false;
	for (const [kind, queue] of Object.entries(logQueues)) {
		while (queue.length && !retryLater) {
			const batch = queue.splice(0, LOG_BATCH_SIZE);
			const result = await send(LOG_PATHS[kind], { logs: batch });
			if (!result.ok && result.retryable) {
				queue.unshift(...batch);
				retryLater = true;
			}
		}
	}
	if (Object.values(logQueues).some((queue) => queue.length)) {
		scheduleFlush(retryLater ? LOG_RETRY_MS : LOG_FLUSH_MS);
	}
}

// Concurrent callers share the flush already in progress.
function flushLogs() {
	clearTimeout(flushTimer);
	flushTimer = null;
	flushing ??= sendQueuedLogs().finally(() => {
		flushing = null;
	});
	return flushing;
}

// entry: { platform, source: 'auto' | 'command', group_external_id, user_external_id, user_name,
//          url, site, result: 'success' | 'failed' | 'busy', error_message, duration_ms,
//          file_count, compressed }
// The admin rejects a whole batch if any field is over its column size, so clip them here.
function reportParse(entry) {
	enqueueLog('parse', {
		...entry,
		url: entry.url.slice(0, 2048),
		user_name: entry.user_name?.slice(0, 128) ?? null,
		error_message: truncate(entry.error_message),
	});
}

// Runs fn with site attached to every runtime log it prints, including from awaited calls.
function withLogSite(site, fn) {
	return logScope.run({ site: site ?? null }, fn);
}

// Mirrors console.log/info/warn/error into the runtime log. source is 'discord' or 'line'.
// The console still prints as before, so `docker logs` keeps the full output.
function installConsoleCapture(source) {
	if (!enabled) return;
	const levels = { log: 'info', info: 'info', warn: 'warn', error: 'error' };
	for (const [method, level] of Object.entries(levels)) {
		const original = console[method].bind(console);
		console[method] = (...args) => {
			original(...args);
			enqueueLog('runtime', {
				source,
				level,
				site: logScope.getStore()?.site ?? null,
				message: truncate(util.format(...args)),
			});
		};
	}
	// Send what is queued before the process exits (docker stop / Ctrl+C), giving up after a few seconds.
	for (const signal of ['SIGTERM', 'SIGINT']) {
		process.once(signal, () => {
			setTimeout(() => process.exit(0), REQUEST_TIMEOUT_MS).unref();
			// The second flush sends anything logged while an earlier flush was in flight.
			flushLogs()
				.then(flushLogs)
				.finally(() => process.exit(0));
		});
	}
}

module.exports = {
	adminApiEnabled: enabled,
	syncGroups,
	reportJoin,
	reportLeave,
	reportActivity,
	reportParse,
	withLogSite,
	installConsoleCapture,
};
