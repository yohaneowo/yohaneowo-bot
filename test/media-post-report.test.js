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
	assert.equal(last.content.split('\n')[0], `-# <${URL_A}>`, 'the link is on the first line');
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
		assert.equal(updates.at(-1), `-# <${URL_A}>\n❌ 解析失败了 😢`);
		assert.equal(fs.existsSync(path.join(dataDir, 'bot-reports.json')), false);
	}
	finally {
		process.env.FEEDBACK_WEBHOOK_URL = saved.url;
		process.env.FEEDBACK_WEBHOOK_SECRET = saved.secret;
		resetFeatureForTests();
	}
});

// Stable #3 (2026-11-21): a 263-second video asked for with /x could not be compressed under 9.8 MB; the answer
// said to watch it on the site but did not show the link, and with /x there is no message of the person's either.
test('a video too long to compress, asked for with /x: the answer shows the link, then the reason', async () => {
	const { UserFacingError } = require('../services/sites/errors');
	fakeMedia.impl = async () => {
		throw Object.assign(new UserFacingError('影片太长，压缩后会太糊，建议直接到 Facebook 观看'), { code: 'VIDEO_TOO_LONG' });
	};
	const { updates, promise } = run({ logContext: { source: 'command', group_external_id: 'guild-1', user_external_id: 'user-1', user_name: 'tester' } });
	assert.equal(await promise, false);
	assert.equal(updates.at(-1).content, `-# <${URL_A}>\n⚠️ 影片太长，压缩后会太糊，建议直接到 Facebook 观看`);
	assert.equal(updates.at(-1).components.length, 1, 'the 回报 button is still there');
});

test('in a channel the failure line names who shared the link, like a posted result', async () => {
	fakeMedia.impl = async () => {
		throw new Error('boom');
	};
	const { updates, promise } = run({ sharerId: '123456789012345678' });
	assert.equal(await promise, false);
	assert.equal(updates.at(-1).content.split('\n')[0], `-# <@123456789012345678> 分享 · <${URL_A}>`);
});

test('a failure message can be reported later even without a record: its first line gives the link back', async () => {
	fakeMedia.impl = async () => {
		throw new Error('boom');
	};
	const { updates, promise } = run();
	await promise;
	const { CAPTION_LINK_FOR_TESTS } = require('../services/botReport');
	assert.equal(CAPTION_LINK_FOR_TESTS.exec(updates.at(-1).content.split('\n')[0])?.[1], URL_A);
});

test('when two downloads are already running, the "too busy" answer also shows the link', async () => {
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	fakeMedia.impl = async () => {
		await gate;
		throw new Error('done');
	};
	const first = run();
	const second = run();
	const third = run();
	assert.equal(await third.promise, false);
	assert.equal(third.updates.at(-1), `-# <${URL_A}>\n⏳ 目前处理中的链接太多，请稍后再试`);
	release();
	await Promise.all([first.promise, second.promise]);
});

test('a Discord edit that returns nothing does not break posting', async () => {
	fakeMedia.impl = good();
	const { promise } = run({ update: async () => undefined });
	assert.equal(await promise, true);
	assert.equal(getFeature().store.stats().contexts, 0);
});
