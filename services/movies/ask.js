const { MessageFlags } = require('discord.js');
const tmdb = require('./tmdb');
const store = require('./store');
const { loadTaste, describeTaste } = require('./taste');
const { findSimilarHistory } = require('./similar');
const { fetchArticleSections } = require('./wikipedia');
const { aiEnabled, callText } = require('./claude');
const { withAiCaller } = require('../aiUsage');

// The 「💬 AI 怎么看」 button on a recommendation: what the card doesn't say, from material the AI
// is handed (most of these films are newer than its training, so nothing comes from its memory):
// where it might not suit this user, what to know first (sequel? adaptation?), what critics and
// audiences say (Wikipedia's reception section often quotes Rotten Tomatoes), and how the user
// rated the director's / leads' other films. Answered privately; recorded in the AI call log as
// movie-ask under the user who pressed it.
const MODEL = process.env.MOVIE_AI_MODEL || 'claude-sonnet-5-5';
const MAX_ASKS_PER_DAY = Number(process.env.MOVIE_ASK_PER_DAY) || 20;
// Pressing again shortly after shows the same answer instead of paying for a new one.
const ANSWER_CACHE_MS = 24 * 60 * 60 * 1000;
const MAX_REVIEWS = 3;
const MAX_REVIEW_LENGTH = 300;
const MAX_LEADS = 3;
const MAX_MESSAGE_LENGTH = 2000;

const SYSTEM_PROMPT = `你是一位懂电影、也了解这位用户口味的朋友。用户正在看你之前推荐的一部电影的卡片，按了「AI 怎么看」，想多了解一点再决定要不要去看。

卡片上已经写了：片名、上映日期、类型、片长、导演、推荐理由、特殊版本，以及片中用户喜欢的影人和评分。这些不要重复。

请根据下面提供的资料，写用户在卡片上看不到、但对决定有帮助的内容，分成这几项（某项没有资料就整项省略，不要硬凑）：
🎭 可能不对胃口的地方：对照用户评分低的作品，老实说这部片哪里可能踩雷。没有明显风险就说「看不出明显的雷」。
📚 看之前知道一下：是不是续集、需不需要先看前作、改编自什么、风格和节奏偏向哪一种。
🗣️ 大家怎么说：影评和观众评价的重点，包括称赞和批评的地方。资料里有烂番茄分数或影评共识就带上。
🎥 主创的其他作品：导演或主演过去的作品里，用户看过并评分的有哪些、给了几分。

规则：
- 只能根据提供的资料。这部片多半比你的训练资料还新，资料里没有的事不要编，也不要用「据说」带过。
- 不剧透：不提剧情转折和结局。
- 用「你」称呼用户，口吻像朋友聊天，诚实，好坏都讲。
- 全部用简体中文，除了片名和人名不夹英文。每项一到两句，整则 200 字以内。
- 每项用上面的表情符号和标题开头，项目之间空一行；不要加总标题或结语。`;

const askCounts = new Map();
const answers = new Map();

function underDailyLimit(userId) {
	const day = new Date().toISOString().slice(0, 10);
	const entry = askCounts.get(userId);
	return !entry || entry.day !== day || entry.count < MAX_ASKS_PER_DAY;
}

function countAsk(userId) {
	const day = new Date().toISOString().slice(0, 10);
	const entry = askCounts.get(userId);
	askCounts.set(userId, entry?.day === day ? { day, count: entry.count + 1 } : { day, count: 1 });
}

// Each source is optional: a missing article or a TMDB hiccup just leaves that part out.
async function optional(promise, fallback) {
	return promise.catch((error) => {
		console.warn('[movie] AI 怎么看: a source failed:', error.message);
		return fallback;
	});
}

async function buildPrompt(subscriber, details, record) {
	const taste = await loadTaste(subscriber.userId);
	if (!taste) throw new Error('No taste profile yet (first statistics sync not finished).');
	const [similar, sections, reviews, collection] = await Promise.all([
		optional(findSimilarHistory(taste, [details]).then((map) => map.get(details.id) ?? []), []),
		optional(fetchArticleSections(details), { production: '', reception: '' }),
		optional(tmdb.fetchReviews(details.id), []),
		details.belongs_to_collection ? optional(tmdb.fetchCollection(details.belongs_to_collection.id), []) : [],
	]);

	const peopleLines = [
		...tmdb.directors(details).map((person) => ({ person, role: '导演' })),
		...tmdb.topCast(details, MAX_LEADS).map((person) => ({ person, role: '主演' })),
	]
		.map(({ person, role }) => {
			const films = (taste.people.get(person.id)?.films ?? []).filter((film) => film.id !== details.id);
			return films.length ? `${role} ${person.name}：${films.map((film) => `${film.title} ${film.rating} 分`).join('、')}` : null;
		})
		.filter(Boolean);
	const similarLine = similar
		.map((item) => `${item.title}（${item.type === 'tv' ? '剧集' : '电影'}，${item.rating == null ? '看过未评分' : `评分 ${item.rating}`}）`)
		.join('；');
	const collectionLine = collection.length
		? `属于「${details.belongs_to_collection.name}」系列：` +
			collection
				.map((part) => {
					const rating = taste.ratingByTmdb.get(part.id);
					const mark = part.id === details.id ? '（就是这部）' : rating != null ? `（用户评分 ${rating}）` : taste.seenIds.has(part.id) ? '（用户看过）' : '';
					return `${part.title}（${String(part.release_date ?? '').slice(0, 4) || '未定'}）${mark}`;
				})
				.join('、')
		: '不属于系列作品';
	const keywords = (details.keywords?.keywords ?? []).slice(0, 12).map((keyword) => keyword.name);
	const reviewLines = reviews
		.slice(0, MAX_REVIEWS)
		.map((review) => `- ${review.author_details?.rating ? `（${review.author_details.rating}/10）` : ''}${review.content.replace(/\s+/g, ' ').slice(0, MAX_REVIEW_LENGTH)}`);

	return [
		'## 用户的口味',
		describeTaste(taste),
		similarLine ? `和这部片最像的、用户看过的作品：${similarLine}` : null,
		peopleLines.length ? `导演 / 主演的其他作品中用户评过分的：\n${peopleLines.join('\n')}` : '导演 / 主演的其他作品，用户都没有评过分',
		'',
		'## 这部片',
		`${details.title}（${details.original_title}，${String(details.release_date ?? '').slice(0, 4)}），原始语言 ${details.original_language}`,
		`卡片上的推荐理由（不要重复）：${record.reason ?? '无'}`,
		`简介：${details.overview || '无'}`,
		keywords.length ? `关键词：${keywords.join(', ')}` : null,
		collectionLine,
		sections.production ? `维基百科「制作」段落：${sections.production}` : '维基百科没有「制作」段落',
		sections.reception ? `维基百科「评价」段落：${sections.reception}` : '维基百科没有「评价」段落',
		reviewLines.length ? `TMDB 观众评论摘录：\n${reviewLines.join('\n')}` : 'TMDB 没有观众评论',
	]
		.filter((line) => line !== null)
		.join('\n');
}

async function answer(interaction, subscriber, tmdbId, record) {
	const details = await tmdb.fetchMovieDetails(tmdbId);
	const caller = {
		platform: 'discord',
		id: interaction.user.id,
		name: interaction.user.globalName ?? interaction.user.username,
		avatarUrl: interaction.user.displayAvatarURL({ size: 64 }),
		trigger: 'button',
	};
	const text = await withAiCaller(caller, async () =>
		callText({ model: MODEL, system: SYSTEM_PROMPT, prompt: await buildPrompt(subscriber, details, record), feature: 'movie-ask', maxTokens: 1200 }),
	);
	return `### 💬 AI 怎么看《${details.title}》\n${text}\n-# 资料来自 TMDB、维基百科`.slice(0, MAX_MESSAGE_LENGTH);
}

// Button customId movie:ask:<tmdbId>.
// fallbackRecord: for a /movie recommend card, which has no daily record (title and reason).
async function handleAskButton(interaction, tmdbId, fallbackRecord = null) {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });
	const userId = interaction.user.id;
	const record = (await store.userMovies(userId))[tmdbId] ?? fallbackRecord;
	const subscriber = await store.getSubscriber(userId);
	if (!aiEnabled || !subscriber || !record) {
		await interaction.editReply({ content: aiEnabled ? '找不到这则推荐的记录。' : 'AI 还没有设定好。' });
		return;
	}

	const key = `${userId}:${tmdbId}`;
	const cached = answers.get(key);
	if (cached && Date.now() - cached.at < ANSWER_CACHE_MS) {
		await interaction.editReply({ content: cached.text });
		return;
	}
	if (!underDailyLimit(userId)) {
		await interaction.editReply({ content: `今天已经问了 ${MAX_ASKS_PER_DAY} 次，明天再来吧。` });
		return;
	}

	// Gathering the material and the AI answer take 10-20 seconds; Discord wants a reply within 3.
	// Say so plainly (a deferred reply only shows "thinking…"), then replace it with the answer.
	await interaction.editReply({ content: '💬 正在整理这部片的资料和评价，大约需要 10–20 秒…' });
	countAsk(userId);
	try {
		const text = await answer(interaction, subscriber, tmdbId, record);
		answers.set(key, { text, at: Date.now() });
		await interaction.editReply(text);
	}
	catch (error) {
		console.warn(`[movie] AI 怎么看 for ${tmdbId} failed:`, error.message);
		await interaction.editReply('暂时没办法回答，请稍后再试。');
	}
}

module.exports = {
	handleAskButton,
};
