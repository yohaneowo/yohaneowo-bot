// Run as a separate Node process by test/ytdlp-stub.test.js: compresses a file that is over the
// limit with an ffmpeg stub that never finishes, spends the link's time budget after 300 ms, and
// reports how it ended and whether the ffmpeg process is gone.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fitVideoToLimit } = require('../../services/sites/video');
const { runWithSignal } = require('../../services/sites/deadline');

const LIMIT = 12_000_000;

(async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cancel-ffmpeg-'));
	const input = path.join(dir, 'input.mp4');
	fs.writeFileSync(input, Buffer.alloc(LIMIT + 1, 1));
	const controller = new AbortController();
	setTimeout(() => controller.abort(new Error('budget spent')), 300);
	const started = Date.now();
	let outcome;
	try {
		// A 100 s clip at this limit needs ~770 kbps, above the 700 kbps floor, so ffmpeg is really started.
		await runWithSignal(controller.signal, () =>
			fitVideoToLimit(input, dir, LIMIT, undefined, 100, async () => ({ duration: 100, width: 1, height: 1, codec: 'h264' })),
		);
		outcome = { rejected: false };
	}
	catch (error) {
		outcome = { rejected: true, message: error.message, code: error.code };
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
