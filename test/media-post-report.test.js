// postMedia (services/mediaPost.js) and the "report a bot problem" feature: the result the bot posts is
// remembered, and a failure message gets the 回报 button. media.js and adminApi.js are fakes.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The feature's data directory and settings are read when its modules load, so they are set first.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-post-report-'));
process.env.DATA_DIR = dataDir;
process.env.FEEDBACK_WEBHOOK_URL = 'https://openbot.example/hooks/feedback';
process.env.FEEDBACK_WEBHOOK_SECRET = 'secret';
process.env.SOURCE_COMMIT = '5adaaefaef72d497b4d5fad6cb6bfc8eecf4e6d8';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const mediaPath = require.resolve('../services/media');
const adminPath = require.resolve('../services/adminApi');
const reports = [];
const fakeMedia = {
	impl: async () => {
		throw new Error('no fake installed');
	},
	downloadMedia: (...args) => fakeMedia.impl(...args),
	findSupportedSite: () => ({ name: 'YouTube' }),
};
require.cache[mediaPath] = { id: mediaPath, filename: mediaPath, loaded: true, exports: fakeMedia };
require.cache[adminPath] = {
	id: adminPath,
	filename: adminPath,
	loaded: true,
	exports: { reportParse: (entry) => reports.push(entry), withLogSite: (site, fn) => fn() },
};

const { postMedia } = require('../services/mediaPost');
const { getFeature, resetFeatureForTests } = require('../services/botReport');
const { EmptyFileError } = require('../services/sites/video');

const URL_A = 'https://www.youtube.com/shorts/HPawwstzIU0';
const fakeLog = { info: () => undefined, warn: () => undefined };

beforeEach(() => {
	reports.length = 0;
	resetFeatureForTests();
	fs.rmSync(path.join(dataDir, 'bot-reports.json'), { force: true });
});
after(() => {
	fs.rmSync(dataDir, { recursive: true, force: true });
});

function run(extra = {}) {
	const updates = [];
	const ids = [];
	const promise = postMedia({
		url: URL_A,
		maxBytes: 10_000_000,
		update: async (payload) => {
			updates.push(payload);
			ids.push(`bot-message-${ids.length + 1}`);
			return { id: ids.at(-1), channelId: 'channel-1' };
		},
		logContext: { source: 'auto', group_external_id: 'guild-1', user_external_id: 'user-1', user_name: 'tester' },
		...extra,
	});
	return { updates, ids, promise };
}

function good(stats = { bytes: 9020128, durationSec: 121.17 }, layer = 'local') {
	return async () => ({
		files: [{ path: 'x.mp4', name: 'video.mp4' }],
		author: '',
		text: '',
		compressed: false,
		site: 'YouTube',
		stats,
		layer,
		log: fakeLog,
		cleanup: async () => undefined,
	});
}

test('a posted result is remembered with bytes, seconds, layer, version and the message that carries it', async () => {
	fakeMedia.impl = good();
	const { updates, ids, promise } = run();
	assert.equal(await promise, true);
	assert.equal(updates.at(-1).files.length, 1);

	const row = getFeature().store.findContextByMessage(ids.at(-1));
	assert.ok(row, `contexts: ${JSON.stringify(getFeature().store.stats())}`);
	assert.deepEqual(
		[row.outcome, row.site, row.user_id, row.guild_id, row.bytes, row.duration_sec, row.layer, row.version, row.url],
		['success', 'YouTube', 'user-1', 'guild-1', 9020128, 121.17, 'local', '5adaaefaef72', URL_A],
	);
});

test('a failure message carries the 回报 button, and the failure is remembered with what was tried', async () => {
	fakeMedia.impl = async () => {
		throw Object.assign(new EmptyFileError('tried=linkhub,local; site_consecutive=1; 0 bytes'), { tried: ['linkhub', 'local'] });
	};
	const { updates, ids, promise } = run();
	assert.equal(await promise, false);

	const last = updates.at(-1);
	assert.equal(typeof last, 'object');
	assert.match(last.content, /下载到的影片是空的或已损坏/);
	assert.equal(last.components.length, 1);
	assert.equal(last.components[0].toJSON().components[0].custom_id, 'fb:open');

	const row = getFeature().store.findContextByMessage(ids.at(-1));
	assert.ok(row, `contexts: ${JSON.stringify(getFeature().store.stats())}`);
	assert.deepEqual([row.outcome, row.bytes, row.layer, row.error_code], ['failed', 0, 'linkhub>local', 'EMPTY_FILE']);
	assert.equal(reports.at(-1).result, 'failed', 'the admin log is written as before');
});

test('a result that was not posted at all has no button and no row', async () => {
	fakeMedia.impl = good();
	const { updates, promise } = run({ update: async (payload) => {
		if (payload && payload.files) throw new Error('Discord rejected the upload');
		return { id: 'status', channelId: 'c' };
	} });
	assert.equal(await promise, false);
	assert.equal(getFeature().store.findContextByMessage('status')?.outcome, 'failed');
	assert.equal(updates.length, 0);
});

test('with the feature off the failure message is the plain text it always was, and nothing is stored', async () => {
	const saved = { url: process.env.FEEDBACK_WEBHOOK_URL, secret: process.env.FEEDBACK_WEBHOOK_SECRET };
	delete process.env.FEEDBACK_WEBHOOK_URL;
	delete process.env.FEEDBACK_WEBHOOK_SECRET;
	resetFeatureForTests();
	try {
		fakeMedia.impl = async () => {
			throw new Error('解析失败');
		};
		const { updates, promise } = run();
		assert.equal(await promise, false);
		assert.equal(updates.at(-1), '❌ 解析失败了 😢');
		assert.equal(fs.existsSync(path.join(dataDir, 'bot-reports.json')), false);
	}
	finally {
		process.env.FEEDBACK_WEBHOOK_URL = saved.url;
		process.env.FEEDBACK_WEBHOOK_SECRET = saved.secret;
		resetFeatureForTests();
	}
});

test('a Discord edit that returns nothing does not break posting', async () => {
	fakeMedia.impl = good();
	const { promise } = run({ update: async () => undefined });
	assert.equal(await promise, true);
	assert.equal(getFeature().store.stats().contexts, 0);
});
