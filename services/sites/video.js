const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { UserFacingError } = require('./errors');
const { currentSignal } = require('./deadline');
const { mediaLog, formatMb } = require('../mediaLog');

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
// A real video is never this small; anything under it is an empty or truncated download.
const MIN_VIDEO_BYTES = 10 * 1000;

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

// The retry rung (see chain.js) asks yt-dlp for a single, smaller file instead of a video + audio
// pair merged by ffmpeg, which also takes the merge step out of the picture. For YouTube it also
// switches client: in 2026-11 `mweb` returned the same 360p single file as the default client,
// `android_vr` listed it but failed to download, and `tv` / `ios` / `web_safari` gave no usable
// format. Re-check these when yt-dlp is upgraded.
const ALT_YOUTUBE_CLIENT = 'mweb';

function buildAltFormatSelector(maxBytes) {
	return [
		`b[ext=mp4][filesize<${maxBytes}]`,
		`b[ext=mp4][filesize_approx<${maxBytes}]`,
		`b[filesize<${maxBytes}]`,
		`b[filesize_approx<${maxBytes}]`,
		'b[ext=mp4]',
		'b',
	].join('/');
}

function isYouTubeUrl(url) {
	return /^https?:\/\/(?:[\w-]+\.)?(?:youtube\.com|youtu\.be)\//i.test(url);
}

// strategy: 'default' or 'alt' (the retry rung).
function buildYtDlpArgs({ url, dir, maxBytes, strategy = 'default' }) {
	const alt = strategy === 'alt';
	const args = [
		'--no-playlist',
		'--no-warnings',
		'--dump-json',
		'--no-simulate',
		'-f', alt ? buildAltFormatSelector(maxBytes) : buildFormatSelector(maxBytes),
		'-S', alt ? 'res:480,br' : 'res,br',
		'--merge-output-format', 'mp4',
		// YouTube needs a JS runtime; reuse the Node binary running this bot.
		'--js-runtimes', `node:${process.execPath}`,
	];
	if (alt && isYouTubeUrl(url)) args.push('--extractor-args', `youtube:player_client=${ALT_YOUTUBE_CLIENT}`);
	if (process.env.FFMPEG_PATH) args.push('--ffmpeg-location', FFMPEG_PATH);
	args.push('-o', path.join(dir, 'video.%(ext)s'), '--', url);
	return args;
}

// Runs yt-dlp with --dump-json --no-simulate. It prints the info JSON once extraction is done
// and before the download starts, so onExtracted fires at the parse -> download transition.
// The process is killed when the rung's time budget runs out (deadline.js).
function runYtDlp(args, onExtracted) {
	return new Promise((resolve, reject) => {
		const child = spawn(YTDLP_PATH, args, { windowsHide: true });
		let stdout = '';
		let stderr = '';
		let extracted = false;
		const timer = setTimeout(() => child.kill(), DOWNLOAD_TIMEOUT_MS);
		const budget = currentSignal();
		const onAbort = () => child.kill();
		if (budget?.aborted) onAbort();
		else budget?.addEventListener('abort', onAbort, { once: true });

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
			budget?.removeEventListener('abort', onAbort);
			reject(error);
		});
		child.on('close', (code, signal) => {
			clearTimeout(timer);
			budget?.removeEventListener('abort', onAbort);
			if (budget?.aborted) {
				reject(budget.reason ?? new Error('yt-dlp stopped: time budget spent'));
				return;
			}
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

// Reads resolution, codec and duration from the file itself: sites often report none of them
// (Instagram has no duration, Facebook's hd format no resolution). Resolves to null on failure.
async function probeVideo(filePath) {
	const budget = currentSignal();
	try {
		const { stdout } = await execFileAsync(
			FFPROBE_PATH,
			[
				'-v', 'error',
				'-select_streams', 'v:0',
				'-show_entries', 'stream=width,height,codec_name:format=duration',
				'-of', 'json',
				filePath,
			],
			{ timeout: 30 * 1000, ...(budget ? { signal: budget } : {}) },
		);
		const { streams, format } = JSON.parse(stdout);
		return {
			width: streams?.[0]?.width,
			height: streams?.[0]?.height,
			codec: streams?.[0]?.codec_name,
			duration: Number(format?.duration),
		};
	}
	catch (error) {
		// A spent time budget says nothing about the file either; let the rung fail as a timeout.
		if (budget?.aborted) throw error;
		mediaLog.warn(`ffprobe failed: ${error.message}`);
		// A missing binary says nothing about the file, so don't treat it as a broken download.
		return error.code === 'ENOENT' ? { unavailable: true } : null;
	}
}

// Thrown when a download "succeeded" but the file is empty, truncated or unreadable. The caller
// logs error_message "empty_file" and never counts it as posted (so the user's message is kept).
class EmptyFileError extends UserFacingError {
	constructor(detail) {
		super('下载到的影片是空的或已损坏，请稍后再试');
		this.name = 'EmptyFileError';
		this.code = 'EMPTY_FILE';
		this.detail = detail;
	}
}

// size: bytes on disk; probe: probeVideo() result (null = ffprobe could not read the file).
function assertUsableVideo(size, probe, label = 'video') {
	if (size < MIN_VIDEO_BYTES) {
		throw new EmptyFileError(`${label} is ${size} bytes (minimum ${MIN_VIDEO_BYTES})`);
	}
	if (probe?.unavailable) return;
	if (!probe || !(probe.duration > 0)) {
		throw new EmptyFileError(`${label} has no readable duration (${size} bytes)`);
	}
}

async function compressToFit(inputPath, outputPath, durationSeconds, maxBytes) {
	if (!(durationSeconds > 0)) {
		throw new Error('Video is too large and its duration is unknown, cannot compress');
	}

	let videoKbps = Math.floor((maxBytes * 8 * 0.9) / durationSeconds / 1000) - AUDIO_KBPS;

	// The encoder can overshoot the target bitrate, so retry with a proportionally lower one.
	for (let attempt = 0; attempt < 3; attempt++) {
		if (videoKbps < MIN_VIDEO_KBPS) {
			mediaLog.warn(`would need ${videoKbps} kbps for ${Math.round(durationSeconds)}s (minimum ${MIN_VIDEO_KBPS}), skipping`);
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
			{ timeout: COMPRESS_TIMEOUT_MS, ...(currentSignal() ? { signal: currentSignal() } : {}) },
		);

		const { size } = await fs.stat(outputPath);
		mediaLog.info(`ffmpeg attempt ${attempt + 1} at ${videoKbps} kbps -> ${formatMb(size)}`);
		if (size <= maxBytes) {
			return outputPath;
		}
		videoKbps = Math.floor(videoKbps * (maxBytes / size) * 0.9);
	}

	throw new Error('Compressed video still exceeds the Discord upload limit');
}

// Compresses a downloaded video when it exceeds maxBytes. Duration comes from the site when
// known, otherwise from the file itself.
// probe is injectable for tests.
async function fitVideoToLimit(filePath, dir, maxBytes, onStage, knownDuration, probeFn = probeVideo) {
	const { size } = await fs.stat(filePath);
	const probe = await probeFn(filePath);
	assertUsableVideo(size, probe);
	const duration = knownDuration > 0 ? knownDuration : probe?.duration;
	mediaLog.info(
		`video ${probe?.width ?? '?'}x${probe?.height ?? '?'} ${probe?.codec ?? '?'}, ` +
			`${duration > 0 ? `${Math.round(duration)}s` : 'unknown length'}, ${formatMb(size)}`,
	);
	if (size <= maxBytes) {
		return { filePath, compressed: false };
	}

	onStage?.('compressing');
	mediaLog.info(`over the ${formatMb(maxBytes)} limit, compressing`);
	const compressedPath = await compressToFit(filePath, path.join(dir, 'compressed.mp4'), duration, maxBytes);
	assertUsableVideo((await fs.stat(compressedPath)).size, await probeVideo(compressedPath), 'compressed video');
	return { filePath: compressedPath, compressed: true };
}

// Downloads a video with yt-dlp into dir, compressing it when it exceeds maxBytes.
// onStage is called with 'downloading' and (if needed) 'compressing' as the work progresses.
// options.strategy: 'alt' is the retry rung's different yt-dlp settings (see buildYtDlpArgs).
async function fetchVideo(url, dir, maxBytes, onStage, options = {}) {
	const strategy = options.strategy ?? 'default';
	mediaLog.info(strategy === 'alt' ? 'running yt-dlp (alternative strategy)' : 'running yt-dlp');
	const stdout = await runYtDlp(
		buildYtDlpArgs({ url, dir, maxBytes, strategy }),
		() => {
			mediaLog.info('yt-dlp extracted, downloading');
			onStage?.('downloading');
		},
	);
	const info = JSON.parse(stdout.trim().split('\n').pop());
	const downloadedPath = await findDownloadedFile(dir);
	mediaLog.info(`yt-dlp downloaded format ${info.format_id}`);

	const { filePath, compressed } = await fitVideoToLimit(downloadedPath, dir, maxBytes, onStage, info.duration);

	const uploader = info.uploader || info.creator || '';
	return {
		files: [{ path: filePath, name: 'video.mp4' }],
		author: uploader ? `@${uploader}` : '',
		text: info.title || info.description || '',
		compressed,
		// Raw yt-dlp metadata, for sites whose fields map differently (see instagram.js).
		info: {
			id: info.id,
			uploader: info.uploader,
			uploaderId: info.uploader_id,
			channel: info.channel,
			title: info.title,
			description: info.description,
		},
	};
}

module.exports = {
	EmptyFileError,
	MIN_VIDEO_BYTES,
	fetchVideo,
	fitVideoToLimit,
	probeVideo,
	assertUsableVideo,
	buildYtDlpArgs,
	buildAltFormatSelector,
};
