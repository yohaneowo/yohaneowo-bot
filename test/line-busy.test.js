// line.js cannot be loaded in a test (it needs the LINE secrets and starts a server), so this reads
// the source: the LINE process must tell the retry logic when its own job slots are taken, because
// it never loads mediaPost.js, which does that for the Discord bot.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'line.js'), 'utf8');

test('line.js installs a busy probe from its own job counter and limit', () => {
	assert.match(source, /require\('\.\/services\/sites\/chain'\)/);
	assert.match(source, /setBusyProbe\(\(\) => activeJobs >= MAX_CONCURRENT_JOBS\)/);
});

test('the probe uses the same counter and limit that line.js uses to turn links away', () => {
	assert.match(source, /if \(activeJobs >= MAX_CONCURRENT_JOBS\)/);
	assert.match(source, /activeJobs \+= 1/);
	assert.match(source, /activeJobs -= 1/);
});
