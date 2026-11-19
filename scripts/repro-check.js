#!/usr/bin/env node
// Read-only check of one `bot.repro_result` event (the result the reproduction service sends for a ticket).
// It reads the files it is given and nothing else: no network, no downloads, no writes.
//
//   node scripts/repro-check.js <event.json> --feedback <feedback.json> --pubkey <key file>
//        --ticket-created <ISO time> [--seen <exec-ids.txt>] [--originals <dir>] [--now <ISO time>]
//        [--max-age-days 7] [--key-id repro-results-1] [--skip-signature]
//
// <event.json>      the event body ({ type, data }) or only its data
// --feedback        the bot.feedback_report of the same ticket (body or data)
// --ticket-created  when that bot.feedback_report arrived (the event carries no time of its own); every run
//                   must start after it
// --pubkey          the service's Ed25519 public key: SPKI PEM, an OpenSSH "ssh-ed25519 ..." line, or 32 bytes in base64
// --seen            exec ids already seen in other tickets, one per line (rule 5)
// --originals       a directory with the original run files (<exec_id>.json, from the host) to compare with
//
// Prints one JSON object: every rule with ok/detail, and a verdict: "judge" (all rules pass and the result is
// complete), "wait" (all rules pass but the runs are not all done yet), "reject" (a rule failed: do not use
// this result). Exit code 0 judge, 1 reject, 2 wait, 64 bad arguments.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { validateJudgeView } = require('./repro-view');

const EVENT_TYPE = 'bot.repro_result';
const SCHEMA = 'repro_result/1';
const DEFAULT_KEY_ID = 'repro-results-1';
const DEFAULT_MAX_AGE_DAYS = 7;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const EXIT = { JUDGE: 0, REJECT: 1, WAIT: 2, USAGE: 64 };
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const SHA40 = /^[0-9a-f]{40}$/;
const HEX_REF = /^[0-9a-f]{7,40}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const TICKET_KEY = /^([a-z0-9]{1,16})-(\d{1,9})-([a-z0-9]{6})$/;
const RETRY_RC = new Set([124, 3]);
const STATUSES = new Set(['complete', 'partial', 'quota_deferred', 'rejected', 'system_failed']);
const SLOTS = { initial: [1, 2, 3, 4], verify: [1, 2] };
// The DER prefix that turns 32 raw Ed25519 public-key bytes into an SPKI structure.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

class UsageError extends Error {}

// Objects with their keys sorted (by UTF-16 code unit, the same as code point for the ASCII keys used here),
// arrays in order, no whitespace: the bytes the service signs.
function canonicalize(value) {
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
	if (value && typeof value === 'object') {
		return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
	}
	return JSON.stringify(value);
}

function readSshField(buffer, offset) {
	if (offset + 4 > buffer.length) throw new UsageError('the OpenSSH key is truncated');
	const length = buffer.readUInt32BE(offset);
	if (offset + 4 + length > buffer.length) throw new UsageError('the OpenSSH key is truncated');
	return { value: buffer.subarray(offset + 4, offset + 4 + length), next: offset + 4 + length };
}

function parsePublicKey(text) {
	const trimmed = String(text).trim();
	let raw;
	if (trimmed.startsWith('-----BEGIN PUBLIC KEY-----')) {
		const key = crypto.createPublicKey(trimmed);
		if (key.asymmetricKeyType !== 'ed25519') throw new UsageError('the public key is not an Ed25519 key');
		return key;
	}
	if (trimmed.startsWith('ssh-ed25519 ')) {
		const blob = Buffer.from(trimmed.split(/\s+/)[1] ?? '', 'base64');
		const type = readSshField(blob, 0);
		if (type.value.toString() !== 'ssh-ed25519') throw new UsageError('the OpenSSH key is not ssh-ed25519');
		raw = readSshField(blob, type.next).value;
	}
	else {
		raw = Buffer.from(trimmed, 'base64');
	}
	if (raw.length !== 32) throw new UsageError('the public key is not 32 bytes of Ed25519');
	return crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

function unwrap(body, type) {
	if (body && typeof body === 'object' && 'data' in body && 'type' in body) {
		return { data: body.data, type: body.type };
	}
	return { data: body, type };
}

function time(value) {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
}

// Each rule returns { ok, detail } (ok null = could not be checked, which counts as a failure unless allowed).
function checkSignature(data, { publicKey, keyId, skip }) {
	if (skip) return { ok: null, detail: 'signature not checked (--skip-signature): rely on the dedicated webhook routine' };
	const sign = data?.sign;
	if (!sign || sign.alg !== 'ed25519' || sign.key_id !== keyId || typeof sign.sig !== 'string') {
		return { ok: false, detail: `sign must be { alg: "ed25519", key_id: "${keyId}", sig: <base64> }` };
	}
	const unsigned = { ...data };
	delete unsigned.sign;
	const valid = crypto.verify(null, Buffer.from(canonicalize(unsigned), 'utf8'), publicKey, Buffer.from(sign.sig, 'base64'));
	return valid ? { ok: true, detail: 'Ed25519 signature over the canonical data is valid' } : { ok: false, detail: 'the signature does not match the data' };
}

function checkTicket(data, feedback) {
	const problems = [];
	const key = TICKET_KEY.exec(data?.ticket_key ?? '');
	if (!key) problems.push('ticket_key is not <instance>-<report id>-<6 characters>');
	else if (Number(key[2]) !== data.report_id) problems.push('ticket_key does not carry this report_id');
	if (data?.report_id !== feedback?.report_id) problems.push(`report_id ${data?.report_id} is not the ticket's ${feedback?.report_id}`);
	if (data?.requested_url !== feedback?.url) problems.push('requested_url is not the url of the ticket');
	if (data?.incident_ref !== feedback?.bot_version) problems.push('incident_ref is not the bot_version of the ticket');
	return problems.length ? { ok: false, detail: problems.join('; ') } : { ok: true, detail: `ticket ${data.ticket_key} (report #${data.report_id})` };
}

function expectedRef(data, slot) {
	if (data.phase === 'verify') return data.verify_ref;
	return slot <= 2 ? data.incident_ref : 'current';
}

function checkSlots(data) {
	const problems = [];
	const slots = SLOTS[data?.phase];
	if (!slots) return { ok: false, detail: `phase must be initial or verify, not ${JSON.stringify(data?.phase)}` };
	if (data.phase === 'verify' && !SHA40.test(data.verify_ref ?? '')) problems.push('a verify result needs a 40-character verify_ref');
	if (!HEX_REF.test(data.incident_ref ?? '')) problems.push('incident_ref is not a commit id');
	const runs = Array.isArray(data.runs) ? data.runs : [];
	const complete = data.status === 'complete';
	for (const slot of slots) {
		const first = runs.filter((run) => run?.slot === slot && run.retry === false);
		const retries = runs.filter((run) => run?.slot === slot && run.retry === true);
		if (first.length > 1) problems.push(`slot ${slot} has ${first.length} first attempts`);
		if (first.length === 0 && (complete || retries.length > 0)) problems.push(`slot ${slot} has no first attempt`);
		if (retries.length > 1) problems.push(`slot ${slot} has ${retries.length} retries (at most one)`);
		for (const run of [...first, ...retries]) {
			if (run.requested_ref !== expectedRef(data, slot)) problems.push(`slot ${slot}: requested_ref ${run.requested_ref} should be ${expectedRef(data, slot)}`);
			if (run.judge_view?.requested_ref !== run.requested_ref) problems.push(`slot ${slot}: the run's own requested_ref differs`);
		}
		const retry = retries[0];
		if (retry && first[0]) {
			if (!RETRY_RC.has(first[0].rc)) problems.push(`slot ${slot}: a retry after rc ${first[0].rc} (only after 124 or 3)`);
			if (retry.retry_of !== first[0].exec_id) problems.push(`slot ${slot}: retry_of does not point to the first attempt`);
		}
		// A complete result has done every retry it owes: after rc 124 or 3 the slot is tried once more.
		if (complete && first[0] && RETRY_RC.has(first[0].rc) && !retry) problems.push(`slot ${slot}: rc ${first[0].rc} without the retry it calls for`);
		// In a complete result the run that counts for the slot (the retry if there is one) was measured.
		const counted = retry ?? first[0];
		if (complete && counted && (counted.judge_view?.measured !== true || !SHA40.test(counted.judge_view?.version_sha ?? ''))) {
			problems.push(`slot ${slot}: the run that counts was not measured or has no version`);
		}
	}
	const unknown = runs.filter((run) => !slots.includes(run?.slot) || typeof run?.retry !== 'boolean');
	if (unknown.length) problems.push(`${unknown.length} run(s) with an unknown slot or without retry true/false`);
	if (runs.some((run) => !run?.judge_view || typeof run.judge_view !== 'object')) problems.push('a run has no judge_view');
	return problems.length ? { ok: false, detail: problems.join('; ') } : { ok: true, detail: `${runs.length} run(s) in slots ${slots.join(', ')}` };
}

function checkVersions(data) {
	const problems = [];
	const runs = Array.isArray(data?.runs) ? data.runs : [];
	if (runs.some((run) => run?.requested_ref === 'current') && !SHA40.test(data?.current_sha ?? '')) problems.push('current_sha is missing for the runs of the current version');
	for (const run of runs) {
		const actual = run?.judge_view?.version_sha;
		if (!SHA40.test(actual ?? '')) {
			if (run?.judge_view?.measured === true) problems.push(`${run?.exec_id}: no version_sha`);
			continue;
		}
		const wanted = run.requested_ref === 'current' ? data.current_sha : run.requested_ref;
		if (typeof wanted !== 'string' || !actual.startsWith(wanted)) problems.push(`${run.exec_id}: ran ${actual.slice(0, 12)}, asked for ${String(wanted).slice(0, 12)}`);
	}
	return problems.length ? { ok: false, detail: problems.join('; ') } : { ok: true, detail: 'every measured run ran the version it asked for' };
}

function checkExecIds(data, seen) {
	const problems = [];
	const ids = (Array.isArray(data?.runs) ? data.runs : []).map((run) => run?.exec_id);
	if (ids.some((id) => !ULID.test(id ?? ''))) problems.push('an exec_id is not a ULID');
	if (new Set(ids).size !== ids.length) problems.push('an exec_id appears twice');
	const reused = ids.filter((id) => seen.has(id));
	if (reused.length) problems.push(`exec_id(s) already seen in another ticket: ${reused.join(', ')}`);
	return problems.length ? { ok: false, detail: problems.join('; ') } : { ok: true, detail: `${ids.length} distinct exec_id(s), none seen before` };
}

function checkTimes(data, { now, maxAgeMs, ticketCreated }) {
	const problems = [];
	const runs = Array.isArray(data?.runs) ? data.runs : [];
	const byId = new Map(runs.map((run) => [run?.exec_id, run]));
	for (const run of runs) {
		const started = time(run?.started_at);
		const finished = time(run?.finished_at);
		if (started === null || finished === null) {
			problems.push(`${run?.exec_id}: started_at / finished_at are not ISO times with a zone`);
			continue;
		}
		if (!(started < finished)) problems.push(`${run.exec_id}: did not finish after it started`);
		if (finished > now + CLOCK_SKEW_MS) problems.push(`${run.exec_id}: finished in the future`);
		if (started < now - maxAgeMs) problems.push(`${run.exec_id}: older than ${Math.round(maxAgeMs / 86400000)} days`);
		if (ticketCreated !== null && !(started > ticketCreated)) problems.push(`${run.exec_id}: did not start after the ticket was created`);
		if (run.retry === true) {
			const original = byId.get(run.retry_of);
			const originalEnd = time(original?.finished_at);
			if (originalEnd === null || !(started > originalEnd)) problems.push(`${run.exec_id}: the retry did not start after the first attempt finished`);
		}
	}
	// Without the time the ticket arrived, "this run belongs to this ticket" cannot be shown: no verdict.
	if (ticketCreated === null) problems.push('the time the ticket was created is not given (--ticket-created)');
	return problems.length ? { ok: false, detail: problems.join('; ') } : { ok: true, detail: 'times are in order and recent' };
}

// Exactly the fields the service sends, at every level: a signed result cannot carry anything else (a note,
// a message, a title), and every value in a run's judge view must be one the reproduction script produces.
const DATA_KEYS = ['current_sha', 'incident_ref', 'manifest_sha256', 'phase', 'report_id', 'requested_url', 'runs', 'schema', 'sign', 'status', 'ticket_key'];
const RUN_KEYS = ['exec_id', 'finished_at', 'judge_view', 'rc', 'requested_ref', 'retry', 'run_sha256', 'slot', 'started_at'];

function exactKeys(value, keys) {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function checkFields(data) {
	const problems = [];
	const dataKeys = data?.phase === 'verify' ? [...DATA_KEYS, 'verify_ref'] : DATA_KEYS;
	if (!exactKeys(data, dataKeys)) problems.push(`data must have exactly: ${dataKeys.join(', ')}`);
	if (!exactKeys(data?.sign, ['alg', 'key_id', 'sig'])) problems.push('sign must have exactly alg, key_id, sig');
	if (typeof data?.report_id !== 'number' || !Number.isInteger(data.report_id)) problems.push('report_id is not a whole number');
	if (typeof data?.requested_url !== 'string' || data.requested_url.length > 200) problems.push('requested_url is not a link');
	if (!SHA256_HEX.test(data?.manifest_sha256 ?? '')) problems.push('manifest_sha256 is not a sha256');
	if (!Array.isArray(data?.runs) || data.runs.length > 8) problems.push('runs must be a list of at most 8');
	(Array.isArray(data?.runs) ? data.runs : []).forEach((run, index) => {
		const runKeys = run?.retry === true ? [...RUN_KEYS, 'retry_of'] : RUN_KEYS;
		if (!exactKeys(run, runKeys)) problems.push(`runs[${index}] must have exactly: ${runKeys.join(', ')}`);
		if (!Number.isInteger(run?.rc)) problems.push(`runs[${index}].rc is not a whole number`);
		if (!SHA256_HEX.test(run?.run_sha256 ?? '')) problems.push(`runs[${index}].run_sha256 is not a sha256`);
		for (const problem of validateJudgeView(run?.judge_view)) problems.push(`runs[${index}]: ${problem}`);
	});
	return problems.length ? { ok: false, detail: problems.join('; ') } : { ok: true, detail: 'exactly the expected fields, every value one the script produces' };
}

function checkStatus(data) {
	if (!STATUSES.has(data?.status)) return { ok: false, detail: `unknown status ${JSON.stringify(data?.status)}` };
	return { ok: true, detail: data.status === 'complete' ? 'complete: can be judged' : `${data.status}: not judged yet` };
}

function checkOriginals(data, dir) {
	if (!dir) return null;
	const problems = [];
	for (const run of Array.isArray(data?.runs) ? data.runs : []) {
		if (!SHA256_HEX.test(run?.run_sha256 ?? '')) {
			problems.push(`${run?.exec_id}: run_sha256 is missing`);
			continue;
		}
		const file = path.join(dir, `${path.basename(String(run.exec_id))}.json`);
		let raw;
		try {
			raw = fs.readFileSync(file);
		}
		catch {
			problems.push(`${run.exec_id}: original not found`);
			continue;
		}
		if (crypto.createHash('sha256').update(raw).digest('hex') !== run.run_sha256) {
			problems.push(`${run.exec_id}: the original does not match run_sha256`);
			continue;
		}
		let original;
		try {
			original = JSON.parse(raw.toString('utf8'));
		}
		catch {
			problems.push(`${run.exec_id}: the original is not JSON`);
			continue;
		}
		if (canonicalize(original.judge_view) !== canonicalize(run.judge_view)) problems.push(`${run.exec_id}: judge_view differs from the original`);
	}
	return problems.length ? { ok: false, detail: problems.join('; ') } : { ok: true, detail: 'every run matches its original on the host' };
}

function check(event, { feedback, publicKey, keyId = DEFAULT_KEY_ID, skipSignature = false, seen = new Set(), originals = null, now = Date.now(), maxAgeDays = DEFAULT_MAX_AGE_DAYS, ticketCreated = null }) {
	const { data, type } = unwrap(event);
	const { data: ticket } = unwrap(feedback);
	const checks = [
		{ rule: 'type', ...(type === undefined || type === EVENT_TYPE ? { ok: true, detail: EVENT_TYPE } : { ok: false, detail: `event type ${type}` }) },
		{ rule: 'schema', ...(data?.schema === SCHEMA ? { ok: true, detail: SCHEMA } : { ok: false, detail: `schema ${JSON.stringify(data?.schema)}` }) },
		{ rule: 'fields', ...checkFields(data) },
		{ rule: '1 signature', ...checkSignature(data, { publicKey, keyId, skip: skipSignature }) },
		{ rule: '2 ticket', ...checkTicket(data, ticket) },
		{ rule: '3 slots and retries', ...checkSlots(data) },
		{ rule: '4 versions', ...checkVersions(data) },
		{ rule: '5 exec ids', ...checkExecIds(data, seen) },
		{ rule: '6 times', ...checkTimes(data, { now, maxAgeMs: maxAgeDays * 86400000, ticketCreated }) },
		{ rule: '7 status', ...checkStatus(data) },
	];
	const originalsCheck = checkOriginals(data, originals);
	if (originalsCheck) checks.push({ rule: 'originals', ...originalsCheck });
	const failed = checks.filter((entry) => entry.ok === false);
	let verdict = 'reject';
	if (failed.length === 0) verdict = data.status === 'complete' ? 'judge' : 'wait';
	return { verdict, ticket_key: data?.ticket_key ?? null, phase: data?.phase ?? null, status: data?.status ?? null, checks };
}

function parseArgs(argv) {
	const options = { files: [], maxAgeDays: DEFAULT_MAX_AGE_DAYS, keyId: DEFAULT_KEY_ID, skipSignature: false };
	const valueOf = (index) => {
		if (index + 1 >= argv.length) throw new UsageError(`${argv[index]} needs a value`);
		return argv[index + 1];
	};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		const flags = { '--feedback': 'feedback', '--pubkey': 'pubkey', '--seen': 'seen', '--originals': 'originals', '--ticket-created': 'ticketCreated', '--now': 'now', '--key-id': 'keyId', '--max-age-days': 'maxAgeDays' };
		if (arg === '--skip-signature') {
			options.skipSignature = true;
		}
		else if (arg === '--help' || arg === '-h') {
			options.help = true;
		}
		else if (flags[arg]) {
			options[flags[arg]] = valueOf(index);
			index += 1;
		}
		else if (arg.startsWith('--')) {
			throw new UsageError(`unknown option ${arg}`);
		}
		else {
			options.files.push(arg);
		}
	}
	if (options.help) return options;
	if (options.files.length !== 1) throw new UsageError('give exactly one event file');
	if (!options.feedback) throw new UsageError('--feedback is required');
	if (!options.ticketCreated) throw new UsageError('--ticket-created is required (when the bot.feedback_report of this ticket arrived)');
	if (!options.pubkey && !options.skipSignature) throw new UsageError('--pubkey is required (or --skip-signature)');
	options.maxAgeDays = Number(options.maxAgeDays);
	if (!(options.maxAgeDays > 0)) throw new UsageError('--max-age-days must be a positive number');
	for (const name of ['now', 'ticketCreated']) {
		if (options[name] !== undefined && time(options[name]) === null) throw new UsageError(`--${name === 'now' ? 'now' : 'ticket-created'} must be an ISO time with a zone`);
	}
	return options;
}

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	}
	catch (error) {
		throw new UsageError(`cannot read ${path.basename(file)} as JSON (${error.code ?? 'parse error'})`);
	}
}

function main(argv, { stdout = process.stdout } = {}) {
	try {
		const options = parseArgs(argv);
		if (options.help) {
			stdout.write('usage: node scripts/repro-check.js <event.json> --feedback <feedback.json> --pubkey <key> [--seen <file>] [--originals <dir>] [--ticket-created <ISO>] [--now <ISO>] [--max-age-days N] [--key-id ID] [--skip-signature]\n');
			return EXIT.JUDGE;
		}
		const seen = options.seen
			? new Set(fs.readFileSync(options.seen, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean))
			: new Set();
		const result = check(readJson(options.files[0]), {
			feedback: readJson(options.feedback),
			publicKey: options.pubkey ? parsePublicKey(fs.readFileSync(options.pubkey, 'utf8')) : null,
			keyId: options.keyId,
			skipSignature: options.skipSignature,
			seen,
			originals: options.originals ?? null,
			now: options.now ? time(options.now) : Date.now(),
			maxAgeDays: options.maxAgeDays,
			ticketCreated: options.ticketCreated ? time(options.ticketCreated) : null,
		});
		stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		return { judge: EXIT.JUDGE, wait: EXIT.WAIT, reject: EXIT.REJECT }[result.verdict];
	}
	catch (error) {
		const known = error instanceof UsageError;
		stdout.write(`${JSON.stringify({ verdict: 'error', error: known ? error.message : 'unexpected error' })}\n`);
		return EXIT.USAGE;
	}
}

module.exports = { check, canonicalize, parsePublicKey, main, EXIT, SCHEMA, EVENT_TYPE };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
