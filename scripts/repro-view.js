// The "judge view" of one reproduction run: the part of scripts/repro.js's report that the agent who
// judges the result is allowed to read. Nothing in it comes from outside text (a page title, an error
// message, a file name, a link someone posted): every field is a number, a fixed word or an id checked
// against a strict pattern, and every log line is rebuilt from such pieces. Anything that does not fit is
// left out (and counted), never copied. The full report, with the raw log, stays with the person who audits.
//
// Pure functions, no I/O: scripts/repro.js adds `judge_view` to its output; the dispatch service on the
// host forwards only that field.
const SCHEMA = 'judge_view/1';
const MAX_LOG_LINES = 30;
const SITE_NAMES = new Set(['TikTok', 'Facebook', 'Instagram', '小红书', 'YouTube', 'B站', 'Threads', 'X']);
const LAYER_NAMES = new Set(['linkhub', 'local', 'local-first', 'local-alt']);
const VERSION_SOURCES = new Set(['git', 'github', 'current']);
const CONTENT_ID_SOURCES = new Set(['link', 'redirect', 'unresolved']);
const LAYER_SOURCES = new Set(['reported', 'inferred']);
const ID_PATTERN = /^[\w-]{1,40}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REF_PATTERN = /^(?:[0-9a-f]{7,40}|current)$/;
const STAGES = new Set(['downloading', 'compressing']);
// Words that can come from somewhere else (LinkHub's answer, a file's metadata, an error code a service sent
// back) are kept only when they are on these lists; anything else becomes a fixed marker. A pattern such as
// "letters and digits" is not enough: it lets a word like "ignoreallrules" through.
const ERROR_CODES = new Set([
	// the bot and the reproduction scripts
	'EMPTY_FILE', 'VIDEO_TOO_LONG', 'MEDIA_TIMEOUT', 'REPRO_TIMEOUT', 'RUNNER_NO_RESULT', 'RUNNER_USAGE', 'UNSUPPORTED',
	'UNSUPPORTED_LINK', 'USAGE', 'LOW_DISK', 'BAD_ARCHIVE', 'BAD_TREE', 'UNSAFE_ARCHIVE', 'ARCHIVE_TOO_LARGE', 'NO_GIT',
	'NO_NODE_MODULES', 'VERSION_NOT_FOUND', 'WATCHDOG', 'UNEXPECTED',
	// GIF downloads through LinkHub (services/sites/linkhub.js)
	'NETWORK', 'NOT_GIF', 'GIF_TOO_LARGE',
	// Node's own network and file errors
	'ENOENT', 'EACCES', 'ENOSPC', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ABORT_ERR',
	'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
]);
const CODECS = new Set(['h264', 'hevc', 'vp8', 'vp9', 'av1', 'mpeg4', 'gif', 'png', 'mjpeg', 'webp', 'aac', 'opus', 'mp3']);
const LINKHUB_PLATFORMS = new Set(['youtube', 'tiktok', 'instagram', 'facebook', 'twitter', 'x', 'bilibili', 'xiaohongshu', 'threads']);
const LINKHUB_ADAPTERS = new Set(['cobalt', 'ytdlp', 'direct']);
const FORMAT_ID = /^\d{1,5}(?:\+\d{1,5})?$/;
const OTHER = '[other]';

function count(value) {
	return Number.isInteger(value) && value >= 0 ? value : null;
}

function amount(value) {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function oneOf(set, value) {
	return typeof value === 'string' && set.has(value) ? value : null;
}

function matching(pattern, value) {
	return typeof value === 'string' && pattern.test(value) ? value : null;
}

// One rung name, or several joined with ">" (a failure lists the rungs it went through).
function layer(value) {
	const parts = Array.isArray(value) ? value : typeof value === 'string' && value ? value.split('>') : null;
	if (!parts || parts.length === 0 || parts.length > 4) return null;
	return parts.every((name) => LAYER_NAMES.has(name)) ? parts.join('>') : null;
}

function errorCode(error) {
	if (!error) return null;
	return oneOf(ERROR_CODES, error.code) ?? 'OTHER';
}

// A word from a log line: kept when it is on the list, else the fixed marker.
function listed(set, value) {
	return set.has(value) ? value : OTHER;
}

// --- log lines: [<site>#<job id> +<seconds>s] <body>, rebuilt from validated pieces
const PREFIX = /^\[([^\s#\]]{1,20})#([0-9a-f]{1,8}) \+(\d{1,5}\.\d)s\] (.*)$/;
const RUNG_NAME = '(?:local-first|local-alt|linkhub|local)';
const RUNG = `(${RUNG_NAME})`;
const RUNGS_COMMA = `(${RUNG_NAME}(?:, ${RUNG_NAME}){0,3})`;
const RUNGS_ARROW = `(${RUNG_NAME}(?: > ${RUNG_NAME}){0,3})`;
const SIZE = '(\\d{1,6}(?:\\.\\d)?) (KB|MB)';
const HOST = '(?:[a-z0-9.-]{1,253}|\\[host\\])';

// [pattern, rebuild(match)]. The rebuilt text uses only what the pattern captured; every capture is digits,
// a fixed alternative of the pattern, or a word checked against one of the lists above (else "[other]");
// free text in a line is replaced by a fixed marker or the line is dropped.
const TEMPLATES = [
	[/^LinkHub: ([a-z0-9]{1,20}|\[other\]) via ([a-z0-9-]{1,20}|\[other\])( \(cached\))?, (\d{1,3}) item\(s\)(, direct links unusable \(gateway downloads\))?$/,
		(m) => `LinkHub: ${listed(LINKHUB_PLATFORMS, m[1])} via ${listed(LINKHUB_ADAPTERS, m[2])}${m[3] ?? ''}, ${m[4]} item(s)${m[5] ?? ''}`],
	[new RegExp(`^downloaded (GIF )?${SIZE} via LinkHub \\(HTTP (\\d{3}), content-length (\\d{1,12}|n/a), (\\d{1,12}) bytes\\)$`),
		(m) => `downloaded ${m[1] ?? ''}${m[2]} ${m[3]} via LinkHub (HTTP ${m[4]}, content-length ${m[5]}, ${m[6]} bytes)`],
	[new RegExp(`^downloaded (GIF )?${SIZE} (?:via|from) ${HOST} \\(HTTP (\\d{3}), content-length (\\d{1,12}|n/a), (\\d{1,12}) bytes\\)$`),
		(m) => `downloaded ${m[1] ?? ''}${m[2]} ${m[3]} from [host] (HTTP ${m[4]}, content-length ${m[5]}, ${m[6]} bytes)`],
	[new RegExp(`^downloaded (GIF )?${SIZE} (?:via (LinkHub)|(?:via|from) ${HOST})$`),
		(m) => `downloaded ${m[1] ?? ''}${m[2]} ${m[3]} ${m[4] ? 'via LinkHub' : 'from [host]'}`],
	[/^running yt-dlp( \(alternative strategy\))?$/, (m) => `running yt-dlp${m[1] ?? ''}`],
	[/^yt-dlp extracted, downloading$/, () => 'yt-dlp extracted, downloading'],
	[/^yt-dlp downloaded format ([\w+-]{1,30}|\[other\])$/, (m) => `yt-dlp downloaded format ${FORMAT_ID.test(m[1]) ? m[1] : OTHER}`],
	[new RegExp(`^video (\\d{1,5}|\\?)x(\\d{1,5}|\\?) ([a-z0-9_]{1,20}|\\?|\\[other\\]), (?:(\\d{1,6})s|unknown length), ${SIZE}$`),
		(m) => `video ${m[1]}x${m[2]} ${m[3] === '?' ? '?' : listed(CODECS, m[3])}, ${m[4] ? `${m[4]}s` : 'unknown length'}, ${m[5]} ${m[6]}`],
	[new RegExp(`^parsed: (\\d{1,3}) file\\(s\\), ${SIZE}(, compressed)?(, note ".*"|, note \\[omitted\\])?$`),
		(m) => `parsed: ${m[1]} file(s), ${m[2]} ${m[3]}${m[4] ?? ''}${m[5] ? ', note [omitted]' : ''}`],
	[new RegExp(`^recovered by ${RUNG} after ${RUNGS_COMMA} came back empty$`), (m) => `recovered by ${m[1]} after ${m[2]} came back empty`],
	[new RegExp(`^${RUNG} failed after (\\d{1,5}\\.\\d)s: `), (m) => `${m[1]} failed after ${m[2]}s: [message omitted]`],
	[new RegExp(`^not starting ${RUNG}: only (\\d{1,5})s of the time budget left$`), (m) => `not starting ${m[1]}: only ${m[2]}s of the time budget left`],
	[new RegExp(`^skipping ${RUNG}: (breaker open for this site|the other download slot is busy)$`), (m) => `skipping ${m[1]}: ${m[2]}`],
	[new RegExp(`^(?:[^\\s:]{1,20}: )?every route came back empty \\(${RUNGS_ARROW}\\); (\\d{1,5}) in a row for this site`),
		(m) => `every route came back empty (${m[1]}); ${m[2]} in a row for this site`],
	[new RegExp(`^(?:[^\\s:]{1,20}: )?empty file and the retry was not possible \\(${RUNGS_ARROW}\\); nothing recorded$`),
		(m) => `empty file and the retry was not possible (${m[1]}); nothing recorded`],
	[new RegExp(`^over the ${SIZE} limit, compressing$`), (m) => `over the ${m[1]} ${m[2]} limit, compressing`],
	[new RegExp(`^ffmpeg attempt (\\d{1,2}) at (\\d{1,6}) kbps -> ${SIZE}$`), (m) => `ffmpeg attempt ${m[1]} at ${m[2]} kbps -> ${m[3]} ${m[4]}`],
	[/^would need (\d{1,7}) kbps for (\d{1,6})s \(minimum (\d{1,7})\), skipping$/, (m) => `would need ${m[1]} kbps for ${m[2]}s (minimum ${m[3]}), skipping`],
	[new RegExp(`^skipping item (\\d{1,3}) \\(${SIZE}\\): over the upload limit$`), (m) => `skipping item ${m[1]} (${m[2]} ${m[3]}): over the upload limit`],
	[/^(video|photo|animated_gif) (\d{1,3}): picked (\d{2,5}x\d{2,5}|\?) \((\d{1,7}) kbps\)$/, (m) => `${m[1]} ${m[2]}: picked ${m[3]} (${m[4]} kbps)`],
	[/^link preview: title (\d{1,5}) chars, image (yes|no)$/, (m) => `link preview: title ${m[1]} chars, image ${m[2]}`],
	// Older versions logged the page title itself; the line is kept only as "a preview was read".
	[/^link preview: title (?:".*"|\[omitted\]), image (yes|no)$/, (m) => `link preview: title [omitted], image ${m[1]}`],
	[/^GIF unavailable \(([A-Za-z0-9_]{0,40})\): .*; using the mp4$/, (m) => `GIF unavailable (${errorCode({ code: m[1] })}): [message omitted]; using the mp4`],
	[/falling back to the local parser$/, () => 'falling back to the local parser'],
];

function rebuildLine(line) {
	if (typeof line !== 'string') return null;
	const prefix = PREFIX.exec(line);
	if (!prefix || !SITE_NAMES.has(prefix[1])) return null;
	for (const [pattern, rebuild] of TEMPLATES) {
		const match = pattern.exec(prefix[4]);
		if (match) return `[${prefix[1]} +${prefix[3]}s] ${rebuild(match)}`;
	}
	return null;
}

// A line as it appears in a judge view ("[<site> +<seconds>s] <body>"), checked by rebuilding it: only a line
// that this module itself could have produced comes back unchanged. scripts/repro-check.js uses it, so a
// result whose log lines were edited after the run is rejected.
const SHOWN_LINE = /^\[([^\s#\]]{1,20}) \+(\d{1,5}\.\d)s\] (.*)$/;

function isRebuiltLine(line) {
	const shown = typeof line === 'string' ? SHOWN_LINE.exec(line) : null;
	return Boolean(shown) && rebuildLine(`[${shown[1]}#0 +${shown[2]}s] ${shown[3]}`) === line;
}

// The last MAX_LOG_LINES lines that fit a template, and how many lines were left out.
function judgeLogLines(lines) {
	const kept = [];
	let dropped = 0;
	for (const line of Array.isArray(lines) ? lines : []) {
		const rebuilt = rebuildLine(line);
		if (rebuilt === null) dropped += 1;
		else kept.push(rebuilt);
	}
	const shown = kept.slice(-MAX_LOG_LINES);
	return { lines: shown, dropped: dropped + (kept.length - shown.length) };
}

function judgeFiles(files) {
	if (!Array.isArray(files)) return [];
	return files.slice(0, 10).map((file) => ({
		bytes: count(file?.bytes),
		duration_sec: amount(file?.duration_sec),
		width: count(file?.width),
		height: count(file?.height),
		codec: file?.codec === null || file?.codec === undefined ? null : listed(CODECS, file.codec),
	}));
}

function judgeDownloads(downloads) {
	const source = downloads ?? {};
	return {
		linkhub: count(source.linkhub),
		ytdlp: count(source.ytdlp),
		direct: count(source.direct),
		total: count(source.total),
		linkhub_parses: count(source.linkhub_parses),
		via_linkhub: source.via_linkhub === true,
	};
}

function idMatch(contentId, mediaId) {
	if (!contentId || !mediaId) return null;
	return contentId === mediaId;
}

// report: what buildReport() returns (or a script-error report: { ok: false, measured: false, script_error }).
// logLines: every line the run printed, not only the tail in the report.
function buildJudgeView(report, logLines = report?.log_tail) {
	const result = report?.result ?? null;
	const error = report?.error ?? report?.script_error ?? null;
	const contentId = matching(ID_PATTERN, report?.content_id);
	const mediaId = matching(ID_PATTERN, result?.media_id);
	const log = judgeLogLines(logLines);
	return {
		schema: SCHEMA,
		ok: report?.ok === true,
		measured: report?.measured === true,
		timed_out: error?.code === 'REPRO_TIMEOUT',
		error_code: errorCode(error),
		tried: layer(error?.tried),
		site: oneOf(SITE_NAMES, report?.site),
		requested_ref: matching(REF_PATTERN, report?.ref),
		version_sha: matching(SHA_PATTERN, report?.version_sha),
		version_source: oneOf(VERSION_SOURCES, report?.version_source),
		bytes_total: count(result?.bytes_total),
		duration_sec: amount(result?.duration_sec),
		files: judgeFiles(result?.files),
		compressed: result ? result.compressed === true : null,
		layer: layer(result?.layer),
		layer_source: oneOf(LAYER_SOURCES, result?.layer_source),
		stages: Array.isArray(result?.stages) ? result.stages.filter((stage) => STAGES.has(stage)).slice(0, 10) : [],
		downloads: judgeDownloads(report?.downloads),
		elapsed_ms: count(report?.elapsed_ms),
		content_id: contentId,
		content_id_source: oneOf(CONTENT_ID_SOURCES, report?.content_id_source),
		media_id: mediaId,
		id_match: idMatch(contentId, mediaId),
		log_lines: log.lines,
		log_lines_dropped: log.dropped,
	};
}

// The exact keys of a judge view and of its nested objects: scripts/repro-check.js rejects any other key.
const VIEW_KEYS = Object.keys(buildJudgeView(null, [])).sort();
const FILE_KEYS = Object.keys(judgeFiles([{}])[0]).sort();
const DOWNLOAD_KEYS = Object.keys(judgeDownloads(null)).sort();

function sameKeys(value, keys) {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.join(',');
}

const isCount = (value) => value === null || count(value) !== null;
const isAmount = (value) => value === null || amount(value) !== null;
const isIn = (set, value) => value === null || (typeof value === 'string' && set.has(value));
const isMatch = (pattern, value) => value === null || (typeof value === 'string' && pattern.test(value));

// Checks a judge view received from elsewhere (a bot.repro_result event): exactly the keys buildJudgeView
// makes, and every value one that buildJudgeView could have produced. Returns the problems found ([] = fine).
function validateJudgeView(view) {
	if (!sameKeys(view, VIEW_KEYS)) return ['the judge view does not have exactly the expected keys'];
	const problems = [];
	const expect = (ok, what) => {
		if (!ok) problems.push(what);
	};
	expect(view.schema === SCHEMA, 'schema');
	for (const key of ['ok', 'measured', 'timed_out']) expect(typeof view[key] === 'boolean', key);
	expect(view.error_code === null || view.error_code === 'OTHER' || isIn(ERROR_CODES, view.error_code), 'error_code');
	expect(view.tried === null || layer(view.tried) === view.tried, 'tried');
	expect(isIn(SITE_NAMES, view.site), 'site');
	expect(isMatch(REF_PATTERN, view.requested_ref), 'requested_ref');
	expect(isMatch(SHA_PATTERN, view.version_sha), 'version_sha');
	expect(isIn(VERSION_SOURCES, view.version_source), 'version_source');
	expect(isCount(view.bytes_total), 'bytes_total');
	expect(isAmount(view.duration_sec), 'duration_sec');
	expect(Array.isArray(view.files) && view.files.length <= 10 && view.files.every((file) => (
		sameKeys(file, FILE_KEYS) && isCount(file.bytes) && isAmount(file.duration_sec) && isCount(file.width) && isCount(file.height) &&
		(file.codec === null || file.codec === OTHER || CODECS.has(file.codec))
	)), 'files');
	expect(view.compressed === null || typeof view.compressed === 'boolean', 'compressed');
	expect(view.layer === null || layer(view.layer) === view.layer, 'layer');
	expect(isIn(LAYER_SOURCES, view.layer_source), 'layer_source');
	expect(Array.isArray(view.stages) && view.stages.length <= 10 && view.stages.every((stage) => STAGES.has(stage)), 'stages');
	expect(sameKeys(view.downloads, DOWNLOAD_KEYS) && ['linkhub', 'ytdlp', 'direct', 'total', 'linkhub_parses'].every((key) => isCount(view.downloads[key])) &&
		typeof view.downloads.via_linkhub === 'boolean', 'downloads');
	expect(isCount(view.elapsed_ms), 'elapsed_ms');
	expect(isMatch(ID_PATTERN, view.content_id), 'content_id');
	expect(isIn(CONTENT_ID_SOURCES, view.content_id_source), 'content_id_source');
	expect(isMatch(ID_PATTERN, view.media_id), 'media_id');
	expect(view.id_match === idMatch(view.content_id, view.media_id), 'id_match');
	expect(Array.isArray(view.log_lines) && view.log_lines.length <= MAX_LOG_LINES && view.log_lines.every(isRebuiltLine), 'log_lines');
	expect(count(view.log_lines_dropped) !== null, 'log_lines_dropped');
	return problems.map((key) => `judge_view.${key} is not a value the reproduction script produces`);
}

module.exports = {
	SCHEMA,
	SITE_NAMES,
	LAYER_NAMES,
	ERROR_CODES,
	CODECS,
	VIEW_KEYS,
	FILE_KEYS,
	DOWNLOAD_KEYS,
	TEMPLATES,
	buildJudgeView,
	validateJudgeView,
	judgeLogLines,
	rebuildLine,
	isRebuiltLine,
	layer,
	errorCode,
};
