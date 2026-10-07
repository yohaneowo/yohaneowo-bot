const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { UserFacingError } = require('./errors');

const execFileAsync = promisify(execFile);

const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp';
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE_PATH = process.env.FFPROBE_PATH || 'ffprobe';
const DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000;
const COMPRESS_TIMEOUT_MS = 5 * 60 * 1000;
// Below this a compressed 720p video is too blurry to be worth posting; skip it instead.
// With a 10 MB limit that is roughly 90 seconds, with 50 MB about 7 minutes.
const MIN_VIDEO_KBPS = 700;
const AUDIO_KBPS = 96;

// Leaves room for the separate audio track when picking a video-only stream to merge.
const AUDIO_ALLOWANCE_BYTES = 2 * 1000 * 1000;

// Prefer a single H.264 file (plays inline everywhere in Discord) at the highest resolution that
// fits. Sites without combined files (YouTube) get H.264 video + m4a audio merged by ffmpeg.
// Last resort is the best available, compressed afterwards if too large.
function buildFormatSelector(maxBytes) {
	const videoBytes = Math.max(maxBytes - AUDIO_ALLOWANCE_BYTES, 1);
	const h264 = '[vcodec~=\'^(h264|avc1)\']';
	return [
		`b${h264}[filesize<${maxBytes}]`,
		`b${h264}[filesize_approx<${maxBytes}]`,
		`b[filesize<${maxBytes}]`,
		`b[filesize_approx<${maxBytes}]`,
		`bv*${h264}[filesize<${videoBytes}]+ba[ext=m4a]`,
		`bv*${h264}[filesize_approx<${videoBytes}]+ba[ext=m4a]`,
		'b',
		`bv*${h264}+ba[ext=m4a]`,
		'bv*+ba',
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

// Some sites (e.g. Instagram) report no duration, so read it from the downloaded file.
async function probeDuration(filePath) {
	const { stdout } = await execFileAsync(
		FFPROBE_PATH,
		['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath],
		{ timeout: 30 * 1000 },
	);
	return Number(stdout.trim());
}

async function compressToFit(inputPath, outputPath, durationSeconds, maxBytes) {
	if (!(durationSeconds > 0)) {
		throw new Error('Video is too large and its duration is unknown, cannot compress');
	}

	let videoKbps = Math.floor((maxBytes * 8 * 0.9) / durationSeconds / 1000) - AUDIO_KBPS;

	// The encoder can overshoot the target bitrate, so retry with a proportionally lower one.
	for (let attempt = 0; attempt < 3; attempt++) {
		if (videoKbps < MIN_VIDEO_KBPS) {
			// media.js rewrites this with the site name ("建议直接到 TikTok 观看").
			throw Object.assign(new UserFacingError('影片太长，压缩后会太糊，建议直接到原网站观看'), {
				code: 'VIDEO_TOO_LONG',
			});
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

// Compresses a downloaded video when it exceeds maxBytes. Duration comes from the site when
// known, otherwise from the file itself.
async function fitVideoToLimit(filePath, dir, maxBytes, onStage, knownDuration) {
	const { size } = await fs.stat(filePath);
	if (size <= maxBytes) {
		return { filePath, compressed: false };
	}

	onStage?.('compressing');
	const duration = knownDuration > 0 ? knownDuration : await probeDuration(filePath);
	const compressedPath = await compressToFit(filePath, path.join(dir, 'compressed.mp4'), duration, maxBytes);
	return { filePath: compressedPath, compressed: true };
}

// Downloads a video with yt-dlp into dir, compressing it when it exceeds maxBytes.
// onStage is called with 'downloading' and (if needed) 'compressing' as the work progresses.
async function fetchVideo(url, dir, maxBytes, onStage) {
	const stdout = await runYtDlp(
		[
			'--no-playlist',
			'--no-warnings',
			'--dump-json',
			'--no-simulate',
			'-f', buildFormatSelector(maxBytes),
			'-S', 'res,br',
			'--merge-output-format', 'mp4',
			// YouTube needs a JS runtime; reuse the Node binary running this bot.
			'--js-runtimes', `node:${process.execPath}`,
			...(process.env.FFMPEG_PATH ? ['--ffmpeg-location', FFMPEG_PATH] : []),
			'-o', path.join(dir, 'video.%(ext)s'),
			'--',
			url,
		],
		() => onStage?.('downloading'),
	);
	const info = JSON.parse(stdout.trim().split('\n').pop());

	const { filePath, compressed } = await fitVideoToLimit(await findDownloadedFile(dir), dir, maxBytes, onStage, info.duration);

	const uploader = info.uploader || info.creator || '';
	return {
		files: [{ path: filePath, name: 'video.mp4' }],
		author: uploader ? `@${uploader}` : '',
		text: info.title || info.description || '',
		compressed,
		// Raw yt-dlp metadata, for sites whose fields map differently (see instagram.js).
		info: {
			uploader: info.uploader,
			uploaderId: info.uploader_id,
			channel: info.channel,
			title: info.title,
			description: info.description,
		},
	};
}

module.exports = {
	fetchVideo,
	fitVideoToLimit,
};
