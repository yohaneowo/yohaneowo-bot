const { directors, topCast } = require('./tmdb');
const { describeTaste } = require('./taste');
const { aiEnabled, callTool } = require('./claude');

// Asks Claude which of the pre-ranked candidates this user would enjoy, why, and which of their
// favourite people (if any) to feature. Each candidate comes with targeted evidence: the user's
// most similar titles (similar.js) and their favourite director/actors in it (taste.js). Haiku
// was tried and judged noticeably less consistently, so Sonnet is the default. One call per user
// per run covers all candidates; the answer comes back as a tool call so it's valid JSON.
// The same call reads the special formats (IMAX, 4DX…) from Wikipedia sentences (wikipedia.js);
// only those sentences count, never the model's memory: most candidates are newer than its training.
// Off (rule scores decide) without ANTHROPIC_API_KEY.
const MODEL = process.env.MOVIE_AI_MODEL || 'claude-sonnet-5-5';
// Re-reading formats for a release reminder is a small reading task.
const FORMATS_MODEL = process.env.MOVIE_FORMATS_MODEL || 'claude-haiku-4-5-20251001';
const MAX_OVERVIEW_LENGTH = 250;
const MAX_FEATURED_PEOPLE = 2;

// Formats that need a version made for them (shown on the card). Dolby Atmos isn't listed:
// nearly every big release has it, so it tells nobody anything.
const FORMATS = ['IMAX', 'IMAX 3D', 'IMAX 70mm', 'Dolby Cinema', '4DX', 'ScreenX', 'ULTRA 4DX', 'MX4D', 'D-BOX', '3D', '70mm', 'HFR'];

const FORMAT_RULES = `特殊版本：有些候选电影附了「维基百科提到版本的句子」。只根据这些句子判断这部片正式发行了哪些版本（只能从这个清单选：${FORMATS.join('、')}），放进 formats；用 IMAX 摄影机拍摄的话 filmed_in_imax 为 true。
- 只算明确说「以某版本发行 / 上映」的；只是顺便提到（例如票房比较、其他电影的版本、动画的 3D 制作方式）不算。
- 没附句子的电影，formats 给空数组、filmed_in_imax 给 false。不要凭你自己的记忆补，这些多半是你训练资料之后的新片。`;

const SYSTEM_PROMPT = `你是一位懂电影、了解用户口味的推荐人。你会拿到一位用户的口味概要，以及这位用户所在地区刚上映或即将上映的几部电影。每部电影附有两份证据：这位用户看过的作品里和它最像的几部（含评分），以及片中这位用户评价很高的导演或演员。
请逐部判断这位用户会不会喜欢，只在你有把握对方会打出高于自己平均分的分数时才推荐；宁可少推，也不要乱推。证据里的相似作品评分低，或者明显不是对方会看的类型，就不要推荐。
剧集评分是各季评分的平均，标准和电影不同，要和对方的剧集平均分比较。
推荐理由会直接私信给这位用户，用「你」称呼对方。全部用简体中文：除了片名和人名，一个英文词都不要出现（类型、题材也要翻成中文，例如 zombie 写成丧尸，vs 写成对决）。推荐的理由 50 字以内，要具体，点出最有说服力的那一点（例如对方给哪部相似作品打了高分、喜欢哪位主创），不要拿 TMDB 评分当理由。不推荐的只写 15 字以内的原因。
如果片中有对方喜欢的导演或演员，而且确实是推荐的重点（主创或主角，不是客串），把他们的 person_id 放进 featured_person_ids（最多 ${MAX_FEATURED_PEOPLE} 位），卡片会另外附上照片和对方给过的评分，理由里不用逐一列出那些作品。
${FORMAT_RULES}
每部候选电影都要判断。不要先写分析文字，直接调用 submit_verdicts 工具一次提交全部结果。`;

const FORMAT_PROPERTIES = {
	formats: { type: 'array', items: { type: 'string', enum: FORMATS }, description: '确实发行过的特殊版本，没有就给空数组' },
	filmed_in_imax: { type: 'boolean', description: '是否用 IMAX 摄影机拍摄' },
};

const VERDICT_TOOL = {
	name: 'submit_verdicts',
	description: '提交每部候选电影的推荐判断',
	input_schema: {
		type: 'object',
		properties: {
			verdicts: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						tmdb_id: { type: 'integer' },
						recommend: { type: 'boolean' },
						predicted_rating: { type: 'number', description: '预测这位用户会打的分数（1-10，按对方自己的评分习惯）' },
						reason: { type: 'string', description: '简体中文，50 字以内' },
						featured_person_ids: { type: 'array', items: { type: 'integer' }, description: '要特别介绍的影人 person_id，没有就给空数组' },
						...FORMAT_PROPERTIES,
					},
					required: ['tmdb_id', 'recommend', 'predicted_rating', 'reason', 'featured_person_ids', 'formats', 'filmed_in_imax'],
				},
			},
		},
		required: ['verdicts'],
	},
};

const FORMATS_TOOL = {
	name: 'submit_formats',
	description: '提交这部电影确实发行过的特殊版本',
	input_schema: { type: 'object', properties: FORMAT_PROPERTIES, required: ['formats', 'filmed_in_imax'] },
};

function formatSentencesLine(sentences) {
	return sentences?.length ? `维基百科提到版本的句子：${sentences.map((sentence) => `「${sentence}」`).join(' ')}` : null;
}

// candidate: { details, kind, releaseDate, rereleaseYear, similar: [...], favourites: [...], formatSentences: [...] }
function describeCandidate({ details, kind, releaseDate, rereleaseYear, similar, favourites, formatSentences }) {
	const overview = (details.overview ?? '').slice(0, MAX_OVERVIEW_LENGTH);
	const keywords = (details.keywords?.keywords ?? []).slice(0, 8).map((keyword) => keyword.name);
	const similarLine = (similar ?? [])
		.map((item) => `${item.title}（${item.type === 'tv' ? '剧集' : '电影'}，${item.rating == null ? '看过未评分' : `评分 ${item.rating}`}）`)
		.join('；');
	const favouritesLine = favourites
		.map(
			(person) =>
				`[person_id ${person.id}] ${person.name}（${person.role === 'director' ? '导演' : '演员'}；对方评分：` +
				`${person.films.map((film) => `${film.title} ${film.rating}`).join('、')}）`,
		)
		.join('；');
	return [
		`[tmdb_id ${details.id}] ${details.title}${details.original_title !== details.title ? `（${details.original_title}）` : ''}`,
		`状态：${kind === 'now' ? '已上映' : `即将上映（${releaseDate}）`}${rereleaseYear ? `；${rereleaseYear} 年作品重映` : ''}`,
		`类型：${(details.genres ?? []).map((genre) => genre.name).join('/') || '未知'}；片长：${details.runtime || '?'} 分钟；原始语言：${details.original_language}`,
		`导演：${directors(details).map((person) => person.name).join('、') || '未知'}；主演：${topCast(details).map((person) => person.name).join('、') || '未知'}`,
		keywords.length ? `关键词：${keywords.join(', ')}` : null,
		details.vote_count >= 30 ? `TMDB 评分：${details.vote_average.toFixed(1)}（${details.vote_count} 票）` : 'TMDB 评分：票数还太少',
		`简介：${overview || '无'}`,
		similarLine ? `对方看过的最像的作品：${similarLine}` : null,
		favourites.length ? `片中对方喜欢的影人：${favouritesLine}` : null,
		formatSentencesLine(formatSentences),
	]
		.filter(Boolean)
		.join('\n');
}

// feedback: { want: [titles], skip: [titles] } from the user's earlier button presses.
function buildPrompt(taste, candidates, feedback) {
	return [
		'## 口味概要',
		describeTaste(taste),
		feedback.want.length ? `对之前这些推荐表示「想看」：${feedback.want.join('、')}` : null,
		feedback.skip.length ? `对之前这些推荐表示「没兴趣」：${feedback.skip.join('、')}` : null,
		'',
		'## 候选电影',
		candidates.map(describeCandidate).join('\n\n'),
	]
		.filter((line) => line !== null)
		.join('\n');
}

// Keeps only formats from the list (the schema asks for that, but don't trust it blindly).
function cleanFormats(formats) {
	return [...new Set((formats ?? []).filter((format) => FORMATS.includes(format)))];
}

// Resolves to Map(tmdbId -> { recommend, predictedRating, reason, featuredPersonIds, formats, filmedInImax }).
async function judgeCandidates(taste, candidates, feedback) {
	const input = await callTool({
		model: MODEL,
		system: SYSTEM_PROMPT,
		tool: VERDICT_TOOL,
		prompt: buildPrompt(taste, candidates, feedback),
		feature: 'movie-judge',
		maxTokens: 6000,
	});
	if (!Array.isArray(input.verdicts)) {
		// Nothing gets recorded, so the same candidates are judged again next run.
		throw new Error('AI answered without a verdicts list');
	}
	console.log(`[movie] AI judged ${input.verdicts.length} movie(s) with ${MODEL}`);
	return new Map(
		input.verdicts.map((verdict) => [
			verdict.tmdb_id,
			{
				recommend: verdict.recommend,
				predictedRating: verdict.predicted_rating,
				reason: verdict.reason,
				featuredPersonIds: (verdict.featured_person_ids ?? []).slice(0, MAX_FEATURED_PEOPLE),
				formats: cleanFormats(verdict.formats),
				filmedInImax: Boolean(verdict.filmed_in_imax),
			},
		]),
	);
}

// For a release reminder whose Wikipedia sentences changed since judging (formats are often
// announced close to release). Resolves to { formats, filmedInImax }.
async function extractFormats(details, sentences) {
	const input = await callTool({
		model: FORMATS_MODEL,
		system: `你会拿到一部电影和维基百科里提到版本的句子。${FORMAT_RULES}\n直接调用 submit_formats 工具提交结果。`,
		tool: FORMATS_TOOL,
		prompt: `${details.title}（${details.original_title}，${details.release_date?.slice(0, 4) ?? '?'}）\n${formatSentencesLine(sentences)}`,
		feature: 'movie-formats',
		maxTokens: 500,
	});
	return { formats: cleanFormats(input.formats), filmedInImax: Boolean(input.filmed_in_imax) };
}

module.exports = {
	aiEnabled,
	judgeCandidates,
	extractFormats,
};
