const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp';
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000;
const COMPRESS_TIMEOUT_MS = 5 * 60 * 1000;
const MIN_VIDEO_KBPS = 300;
const AUDIO_KBPS = 96;

const TIKTOK_URL_PATTERN =
	/https?:\/\/(?:(?:www|m)\.)?(?:tiktok\.com\/(?:@[\w.-]+\/video\/\d+|t\/[\w-]+|v\/\d+)|(?:vm|vt)\.tiktok\.com\/[\w-]+)\/?/gi;

function extractTikTokUrls(text) {
	return [...new Set(String(text ?? '').match(TIKTOK_URL_PATTERN) ?? [])];
}

// True when the text is nothing but TikTok links (query strings included), so deleting it loses nothing.
function isOnlyTikTokUrls(text) {
	const withoutUrls = String(text ?? '').replace(new RegExp(`${TIKTOK_URL_PATTERN.source}\\S*`, 'gi'), '');
	return withoutUrls.trim() === '' && extractTikTokUrls(text).length > 0;
}

// Prefer H.264 (plays inline everywhere in Discord), then the highest resolution that fits.
function buildFormatSelector(maxBytes) {
	return [
		`b[vcodec^=h264][filesize<${maxBytes}]`,
		`b[vcodec^=h264][filesize_approx<${maxBytes}]`,
		`b[filesize<${maxBytes}]`,
		`b[filesize_approx<${maxBytes}]`,
		'b',
	].join('/');
}

// Runs yt-dlp with --dump-json --no-simulate. It prints the info JSON once extraction is done
// and before the download starts, so onExtracted fires at the parse -> download transition.
function runYtDlp(args, onExtracted) {
	return new Promise((resolve, reject) => {
		const child = spawn(YTDLP_PATH, args, { windowsHide: true });
		let stdout = '';
		let stderr = '';
		let extracted = false;
		const timer = setTimeout(() => child.kill(), DOWNLOAD_TIMEOUT_MS);

		child.stdout.on('data', (chunk) => {
			stdout += chunk;
			if (!extracted && stdout.includes('\n')) {
				extracted = true;
				onExtracted?.();
			}
		});
		child.stderr.on('data', (chunk) => {
			stderr = (stderr + chunk).slice(-4000);
		});
		child.on('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on('close', (code, signal) => {
			clearTimeout(timer);
			if (code === 0) {
				resolve(stdout);
				return;
			}
			const lastLine = stderr.trim().split('\n').pop();
			reject(new Error(lastLine || `yt-dlp exited with ${signal ?? `code ${code}`}`));
		});
	});
}

async function findDownloadedFile(dir) {
	const files = await fs.readdir(dir);
	const video = files.find((file) => file.startsWith('video.') && !file.endsWith('.part'));
	if (!video) {
		throw new Error('yt-dlp finished but no video file was found');
	}
	return path.join(dir, video);
}

async function compressToFit(inputPath, outputPath, durationSeconds, maxBytes) {
	if (!(durationSeconds > 0)) {
		throw new Error('Video is too large and its duration is unknown, cannot compress');
	}

	let videoKbps = Math.floor((maxBytes * 8 * 0.9) / durationSeconds / 1000) - AUDIO_KBPS;

	// The encoder can overshoot the target bitrate, so retry with a proportionally lower one.
	for (let attempt = 0; attempt < 3; attempt++) {
		if (videoKbps < MIN_VIDEO_KBPS) {
			throw new Error('Video is too long to fit within the Discord upload limit');
		}

		await execFileAsync(
			FFMPEG_PATH,
			[
				'-y',
				'-i', inputPath,
				'-c:v', 'libx264',
				'-preset', 'veryfast',
				'-b:v', `${videoKbps}k`,
				'-maxrate', `${videoKbps}k`,
				'-bufsize', `${videoKbps * 2}k`,
				'-c:a', 'aac',
				'-b:a', `${AUDIO_KBPS}k`,
				'-movflags', '+faststart',
				outputPath,
			],
			{ timeout: COMPRESS_TIMEOUT_MS },
		);

		const { size } = await fs.stat(outputPath);
		if (size <= maxBytes) {
			return outputPath;
		}
		videoKbps = Math.floor(videoKbps * (maxBytes / size) * 0.9);
	}

	throw new Error('Compressed video still exceeds the Discord upload limit');
}

// Downloads a TikTok video into a fresh temp dir. Caller must call cleanup() when done.
// onStage is called with 'downloading' and (if needed) 'compressing' as the work progresses.
async function downloadTikTok(url, maxBytes, onStage) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tiktok-'));
	const cleanup = () => fs.rm(dir, { recursive: true, force: true });

	try {
		const stdout = await runYtDlp(
			[
				'--no-playlist',
				'--no-warnings',
				'--dump-json',
				'--no-simulate',
				'-f', buildFormatSelector(maxBytes),
				'-S', 'res,br',
				'-o', path.join(dir, 'video.%(ext)s'),
				'--',
				url,
			],
			() => onStage?.('downloading'),
		);
		const info = JSON.parse(stdout.trim().split('\n').pop());

		let filePath = await findDownloadedFile(dir);
		let compressed = false;
		const { size } = await fs.stat(filePath);
		if (size > maxBytes) {
			onStage?.('compressing');
			filePath = await compressToFit(filePath, path.join(dir, 'compressed.mp4'), info.duration, maxBytes);
			compressed = true;
		}

		return {
			filePath,
			cleanup,
			compressed,
			title: info.title || info.description || '',
			uploader: info.uploader || info.creator || '',
			webpageUrl: info.webpage_url || url,
			height: info.height,
			vcodec: info.vcodec,
		};
	}
	catch (error) {
		await cleanup();
		throw error;
	}
}

module.exports = {
	extractTikTokUrls,
	isOnlyTikTokUrls,
	downloadTikTok,
};
