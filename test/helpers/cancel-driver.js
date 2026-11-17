// Run as a separate Node process by test/ytdlp-stub.test.js: starts fetchVideo against a yt-dlp stub
// that never finishes, spends the rung's time budget after 300 ms, and reports how it ended.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fetchVideo } = require('../../services/sites/video');
const { runWithSignal } = require('../../services/sites/deadline');

(async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cancel-driver-'));
	const controller = new AbortController();
	setTimeout(() => controller.abort(new Error('budget spent')), 300);
	const started = Date.now();
	let outcome;
	try {
		await runWithSignal(controller.signal, () => fetchVideo(process.argv[2], dir, 9_800_000, undefined));
		outcome = { rejected: false };
	}
	catch (error) {
		outcome = { rejected: true, message: error.message };
	}
	const elapsed = Date.now() - started;
	await new Promise((resolve) => setTimeout(resolve, 300));
	let childAlive = true;
	try {
		process.kill(Number(fs.readFileSync(process.env.STUB_PID_FILE, 'utf8')), 0);
	}
	catch (error) {
		childAlive = error.code !== 'ESRCH';
	}
	fs.rmSync(dir, { recursive: true, force: true });
	console.log(`DRIVER_RESULT ${JSON.stringify({ ...outcome, elapsed, childAlive })}`);
	process.exit(0);
})();
