const { AsyncLocalStorage } = require('node:async_hooks');

// The time budget of one link. chain.js runs every rung inside runWithSignal(), and the slow steps
// (LinkHub requests, yt-dlp, ffprobe, ffmpeg) read the signal through currentSignal() /
// timeoutSignal(), so a spent budget really stops them without threading a parameter through every
// site fetcher. Steps that never look at it (the link-preview fetches of Facebook and Instagram,
// X's and Threads' own requests) keep their own timeouts and end the rung on their own.
const storage = new AsyncLocalStorage();

class DeadlineError extends Error {
	constructor(rungName) {
		super(`time budget spent while running ${rungName}`);
		this.name = 'DeadlineError';
		this.code = 'MEDIA_TIMEOUT';
	}
}

function runWithSignal(signal, fn) {
	return storage.run(signal, fn);
}

function currentSignal() {
	return storage.getStore() ?? null;
}

// An operation's own timeout, also cut short when the rung's budget is spent.
function timeoutSignal(ms) {
	const own = AbortSignal.timeout(ms);
	const rung = currentSignal();
	return rung ? AbortSignal.any([own, rung]) : own;
}

module.exports = {
	DeadlineError,
	runWithSignal,
	currentSignal,
	timeoutSignal,
};
