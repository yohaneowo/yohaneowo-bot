const fs = require('node:fs');
const path = require('node:path');

// What the bot remembers for the "report a bot problem" feature, in one JSON file next to the other runtime
// data (data/, a persistent volume in Docker, so it survives restarts and redeploys):
// - contexts: one row per result the bot posted (message id, link, site, outcome, bytes, seconds, layer,
//   version). The admin's parse log cannot be queried with the bot's token, and the two real bugs were both
//   logged there as "success", so the bot keeps its own record;
// - reports: what users submitted, with a ticket number.
// The whole file is rewritten after every change (write to a temp file, then rename), so a crash never leaves
// half a file. A write that fails is logged and the feature carries on in memory.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE_NAME = 'bot-reports.json';
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULTS = {
	contextTtlMs: 14 * DAY_MS,
	maxContexts: 2000,
	reportTtlMs: 180 * DAY_MS,
	maxReports: 1000,
};

function emptyData() {
	return { version: 1, nextReportId: 1, contexts: [], reports: [] };
}

function isValidShape(value) {
	return (
		value && typeof value === 'object' &&
		Number.isInteger(value.nextReportId) &&
		Array.isArray(value.contexts) &&
		Array.isArray(value.reports)
	);
}

function createStore(options = {}) {
	const {
		dir = DATA_DIR,
		now = Date.now,
		fsImpl = fs,
		log = console,
		contextTtlMs = DEFAULTS.contextTtlMs,
		maxContexts = DEFAULTS.maxContexts,
		reportTtlMs = DEFAULTS.reportTtlMs,
		maxReports = DEFAULTS.maxReports,
	} = options;
	const file = path.join(dir, FILE_NAME);

	function load() {
		let raw;
		try {
			raw = fsImpl.readFileSync(file, 'utf8');
		}
		catch (error) {
			if (error.code !== 'ENOENT') log.warn(`[report] Could not read ${FILE_NAME}: ${error.message}`);
			return emptyData();
		}
		try {
			const parsed = JSON.parse(raw);
			if (isValidShape(parsed)) return parsed;
			throw new Error('unexpected shape');
		}
		catch (error) {
			// Keep the unreadable file for a person to look at, and start clean.
			const aside = `${file}.corrupt-${now()}`;
			let kept = true;
			try {
				fsImpl.renameSync(file, aside);
			}
			catch {
				kept = false;
			}
			log.warn(`[report] ${FILE_NAME} is unreadable (${error.message}); started empty${kept ? `, the old file is kept as ${path.basename(aside)}` : ''}`);
			return emptyData();
		}
	}

	let data = load();

	function prune() {
		const t = now();
		data.contexts = data.contexts.filter((context) => t - context.at < contextTtlMs).slice(-maxContexts);
		data.reports = data.reports.filter((report) => t - report.created_at < reportTtlMs).slice(-maxReports);
	}

	function save() {
		prune();
		const temp = `${file}.tmp`;
		try {
			fsImpl.mkdirSync(dir, { recursive: true });
			fsImpl.writeFileSync(temp, JSON.stringify(data));
			fsImpl.renameSync(temp, file);
			return true;
		}
		catch (error) {
			log.warn(`[report] Could not write ${FILE_NAME}: ${error.message}`);
			return false;
		}
	}

	return {
		file,

		recordContext(context) {
			data.contexts = data.contexts.filter((existing) => existing.message_id !== context.message_id);
			data.contexts.push({ ...context, at: context.at ?? now() });
			return save();
		},

		findContextByMessage(messageId) {
			return data.contexts.findLast((context) => context.message_id === messageId) ?? null;
		},

		// The newest result of this link that this user asked for, within the window.
		findRecentContext({ userId, urlKey, withinMs }) {
			const t = now();
			return data.contexts.findLast((context) => context.user_id === userId && context.url_key === urlKey && t - context.at < withinMs) ?? null;
		},

		createReport(fields) {
			const report = {
				...fields,
				id: data.nextReportId,
				created_at: now(),
				reporters: [fields.user_id],
				count: 1,
				delivery: { status: fields.eligible ? 'pending' : 'skipped', attempts: 0, last_at: null, last_error: null },
			};
			data.nextReportId += 1;
			data.reports.push(report);
			save();
			return report;
		},

		getReport(id) {
			return data.reports.find((report) => report.id === id) ?? null;
		},

		findReportByInteraction(interactionId) {
			return data.reports.find((report) => report.interaction_ids?.includes(interactionId)) ?? null;
		},

		// The same link and symptom, from the same bot version, still inside the window.
		findDuplicate({ urlKey, symptom, version, windowMs }) {
			const t = now();
			return data.reports.findLast((report) => (
				report.url_key === urlKey && report.symptom === symptom && report.bot_version === version && t - report.created_at < windowMs
			)) ?? null;
		},

		addReporter(id, userId, interactionId) {
			const report = this.getReport(id);
			if (!report) return null;
			report.count += 1;
			if (!report.reporters.includes(userId)) report.reporters.push(userId);
			report.interaction_ids = [...(report.interaction_ids ?? []), interactionId];
			save();
			return report;
		},

		// Reports a user opened (not merged into someone else's) since the given time.
		countOpenedBy(userId, sinceMs) {
			const t = now();
			return data.reports.filter((report) => report.user_id === userId && t - report.created_at < sinceMs).length;
		},

		setDelivery(id, patch) {
			const report = this.getReport(id);
			if (!report) return null;
			report.delivery = { ...report.delivery, ...patch };
			save();
			return report;
		},

		// Reports that still have to be sent: never sent, or the last send failed.
		undelivered(maxAgeMs) {
			const t = now();
			return data.reports.filter((report) => (
				report.eligible && ['pending', 'failed'].includes(report.delivery.status) && t - report.created_at < maxAgeMs
			));
		},

		stats() {
			let bytes;
			try {
				bytes = fsImpl.statSync(file).size;
			}
			catch {
				bytes = 0;
			}
			return { contexts: data.contexts.length, reports: data.reports.length, file_bytes: bytes };
		},

		// For tests and tooling: start from what is on disk.
		reload() {
			data = load();
		},
	};
}

module.exports = {
	createStore,
	FILE_NAME,
	DEFAULTS,
	DAY_MS,
};
