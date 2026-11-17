// Run as a separate Node process by test/ytdlp-stub.test.js: one YouTube link through the real
// fallback chain (no LinkHub), with YTDLP_PATH pointing at the fake yt-dlp. Prints one result line.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withFallbackChain } = require('../../services/sites/chain');
const { fetchYouTubeShort } = require('../../services/sites/youtube');

const chain = withFallbackChain(fetchYouTubeShort, {
	site: 'YouTube',
	alt: (url, dir, maxBytes, onStage) => fetchYouTubeShort(url, dir, maxBytes, onStage, { strategy: 'alt' }),
});

(async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-driver-'));
	const stages = [];
	let summary;
	try {
		const result = await chain(process.argv[2], dir, 9_800_000, (stage) => stages.push(stage));
		summary = {
			ok: true,
			files: result.files.map((file) => ({ name: file.name, size: fs.statSync(file.path).size })),
			stages,
		};
	}
	catch (error) {
		summary = { ok: false, code: error.code, tried: error.tried, detail: error.detail, stages };
	}
	finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	console.log(`DRIVER_RESULT ${JSON.stringify(summary)}`);
})();
