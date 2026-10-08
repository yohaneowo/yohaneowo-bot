const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

// Step-by-step logs for link parsing. Each link gets a job with a short id, and every line is
// prefixed with the site, the id and the time since the job started:
//   [TikTok#3fa2 +4.1s] downloaded 1080x1920 h264, 23.4 MB
// so concurrent downloads stay apart and the slow or failing step is easy to spot.
// The job is carried by AsyncLocalStorage, so site fetchers just call mediaLog.info().
const storage = new AsyncLocalStorage();

function formatMb(bytes) {
	if (bytes < 1000 * 1000) return `${Math.round(bytes / 1000)} KB`;
	return `${(bytes / 1000 / 1000).toFixed(1)} MB`;
}

function createJob(siteName) {
	return { site: siteName, id: crypto.randomBytes(2).toString('hex'), startedAt: Date.now() };
}

function prefix(job) {
	if (!job) return '[media]';
	return `[${job.site}#${job.id} +${((Date.now() - job.startedAt) / 1000).toFixed(1)}s]`;
}

// A logger fixed to one job, for steps that run outside runInJob (e.g. uploading the result).
function jobLogger(job) {
	return {
		info: (...args) => console.log(prefix(job), ...args),
		warn: (...args) => console.warn(prefix(job), ...args),
	};
}

function runInJob(job, fn) {
	return storage.run(job, fn);
}

// Logs to whichever job the current call belongs to.
const mediaLog = {
	info: (...args) => console.log(prefix(storage.getStore()), ...args),
	warn: (...args) => console.warn(prefix(storage.getStore()), ...args),
};

module.exports = {
	mediaLog,
	createJob,
	jobLogger,
	runInJob,
	formatMb,
};
