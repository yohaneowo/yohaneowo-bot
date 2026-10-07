const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

// LINE can't take uploads: it downloads images/videos from HTTPS URLs we serve.
// Each job gets an unguessable directory under PUBLIC_MEDIA_DIR, removed after MEDIA_TTL_MS.
const PUBLIC_MEDIA_DIR = process.env.LINE_MEDIA_DIR || path.join(os.tmpdir(), 'line-media');
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const MEDIA_TTL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

async function createVideoPreview(videoPath, previewPath) {
	await execFileAsync(
		FFMPEG_PATH,
		['-y', '-ss', '0', '-i', videoPath, '-frames:v', '1', '-vf', 'scale=\'min(640,iw)\':-2', '-q:v', '4', previewPath],
		{ timeout: 30 * 1000 },
	);
}

// Copies downloaded files into a fresh public directory and returns their URL paths.
// Videos also get a JPEG preview frame, which LINE requires.
async function publishFiles(files) {
	const token = crypto.randomBytes(16).toString('base64url');
	const dir = path.join(PUBLIC_MEDIA_DIR, token);
	await fs.mkdir(dir, { recursive: true });

	const published = [];
	for (const file of files) {
		await fs.copyFile(file.path, path.join(dir, file.name));
		const entry = { name: file.name, urlPath: `${token}/${file.name}` };
		if (file.name.endsWith('.mp4')) {
			const previewName = `${path.parse(file.name).name}-preview.jpg`;
			await createVideoPreview(path.join(dir, file.name), path.join(dir, previewName));
			entry.previewUrlPath = `${token}/${previewName}`;
		}
		published.push(entry);
	}
	return published;
}

async function removeExpiredMedia() {
	const entries = await fs.readdir(PUBLIC_MEDIA_DIR, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const dir = path.join(PUBLIC_MEDIA_DIR, entry.name);
		const { mtimeMs } = await fs.stat(dir);
		if (Date.now() - mtimeMs > MEDIA_TTL_MS) {
			await fs.rm(dir, { recursive: true, force: true });
		}
	}
}

function startMediaCleanup() {
	const run = () =>
		removeExpiredMedia().catch((error) => console.warn('Public media cleanup failed:', error.message));
	run();
	return setInterval(run, CLEANUP_INTERVAL_MS).unref();
}

module.exports = {
	PUBLIC_MEDIA_DIR,
	publishFiles,
	startMediaCleanup,
};
