const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ContainerBuilder,
	MessageFlags,
	SectionBuilder,
	SeparatorBuilder,
	SeparatorSpacingSize,
	StringSelectMenuBuilder,
	StringSelectMenuOptionBuilder,
	TextDisplayBuilder,
	ThumbnailBuilder,
} = require('discord.js');
const { movieRequest } = require('../adminApi');

// /movie recommend: admin keeps the candidate pools, the quota and the Trakt writes (see admin's
// movie/recommend.py); this file is the Discord side: the card, its buttons and the rating menu.
const SITE_URL = process.env.SITE_URL || 'https://yohaneowo.com';
const CONNECT_URL = `${SITE_URL}/moviehub`;
const ACCENT_COLOR = 0xe5a00d;
const part = (value) => encodeURIComponent(value);

// TMDB's movie genres, as /movie recommend's choices.
const GENRES = [
	[28, '动作'], [12, '冒险'], [16, '动画'], [35, '喜剧'], [80, '犯罪'], [99, '纪录'], [18, '剧情'],
	[10751, '家庭'], [14, '奇幻'], [36, '历史'], [27, '恐怖'], [10402, '音乐'], [9648, '悬疑'], [10749, '爱情'],
	[878, '科幻'], [53, '惊悚'], [10752, '战争'], [37, '西部'],
];
const DECADES = [1950, 1960, 1970, 1980, 1990, 2000, 2010, 2020];
const MODE_LABELS = { comfort: '猜你喜欢', bridge: '跨出一步', explore: '开新坑' };

// The filters each pick was asked with, so 换一部 keeps them (pickId → filters).
const filtersByPick = new Map();

const LIMIT_TEASES = [
	'今天的三部都用完了，先挑一部看吧，明天再来 🎬',
	'额度用完了。推荐不是无限刷的，去看片 👀',
];
const UNRATED_TEASES = [
	(title) => `看过了《${title}》却没评分？那我怎么知道你喜不喜欢 🥲 现在补一个：`,
	(title) => `《${title}》看完不打分，下次推错可别怪我 😤 选个分数：`,
	(title) => `Trakt 上《${title}》一片空白…证据呢 👀 给个分：`,
];

function errorKind(error) {
	const match = /HTTP (\d+)(?::\s*(\w+))?/.exec(error?.message ?? '');
	return match ? { status: Number(match[1]), code: match[2] } : null;
}

// Why a pick could not be made, as a sentence for the person (null for unexpected errors).
function explain(error) {
	const kind = errorKind(error);
	if (!kind) return null;
	if (kind.status === 404 && kind.code !== 'nothingToPick' && kind.code !== 'pickNotFound') return `还没有你的观影档案。先到网站用 Discord 登录并连上 Trakt：${CONNECT_URL}`;
	if (kind.status === 403) return `这个功能要先在网站授权 Trakt（想看、看过了会直接写进你的 Trakt）：${CONNECT_URL}`;
	if (kind.status === 429) return LIMIT_TEASES[Math.floor(Math.random() * LIMIT_TEASES.length)];
	if (kind.code === 'nothingToPick') return '这个条件下找不到可以推荐的片，换个类型或年代试试。';
	if (kind.code === 'pickNotFound') return '找不到这则推荐的记录。';
	if (kind.status === 502) return `Trakt 不认这个授权了，请到网站重新授权：${CONNECT_URL}`;
	if (kind.status === 503) return 'Trakt 或 TMDB 暂时连不上，稍后再试。';
	return null;
}

function requestPick(userId, filters, skip) {
	// The pools may be built on the first call of the day: allow a couple of minutes.
	return movieRequest('POST', `/picks/${part(userId)}`, { ...filters, ...(skip ? { skip } : {}) }, 180000);
}

function markWant(userId, pickId) {
	return movieRequest('POST', `/picks/${part(userId)}/${part(pickId)}/watchlist`, {});
}

function markWatched(userId, pickId, rating) {
	return movieRequest('POST', `/picks/${part(userId)}/${part(pickId)}/watched`, rating == null ? {} : { rating });
}

function cardText(card, filters) {
	const meta = [
		card.genres?.length ? card.genres.slice(0, 3).join(' / ') : null,
		card.runtime ? `${card.runtime} 分钟` : null,
		card.director ? `导演 ${card.director}` : null,
		card.cast?.length ? `主演 ${card.cast.join('、')}` : null,
	].filter(Boolean);
	const asked = [
		filters.genre ? GENRES.find(([id]) => id === filters.genre)?.[1] : null,
		filters.decade ? `${filters.decade} 年代` : null,
		filters.maxRuntime ? `${filters.maxRuntime} 分钟内` : null,
	].filter(Boolean);
	const original = card.originalTitle && card.originalTitle !== card.title ? ` ${card.originalTitle}` : '';
	const score = card.voteAverage != null ? `TMDB ${Number(card.voteAverage).toFixed(1)}${card.voteCount ? `（${card.voteCount.toLocaleString('en-US')} 票）` : ''}` : null;
	return [
		`## 🎲 随机推荐 · ${MODE_LABELS[card.mode] ?? card.mode}${asked.length ? `\n-# 条件：${asked.join(' · ')}` : ''}`,
		`### [《${card.title}》](https://www.themoviedb.org/movie/${card.tmdbId})${card.year ? `（${card.year}）` : ''}${original}`,
		meta.length ? `-# ${meta.join(' · ')}` : null,
		`> ${card.reason}${card.inWatchlist ? '\n> 已在你的想看列表' : ''}`,
		card.overview ? (card.overview.length > 300 ? `${card.overview.slice(0, 300)}…` : card.overview) : null,
		[score, card.remainingToday > 0 ? `今天还能换 ${card.remainingToday} 次` : '今天的额度用完了'].filter(Boolean).map((text) => `-# ${text}`).join('\n'),
	]
		.filter(Boolean)
		.join('\n');
}

// Buttons carry the pick and its owner, so only the person who asked can press them.
function buttons(card, userId, chosen) {
	const id = (action) => `pick:${action}:${card.pickId}:${userId}`;
	const style = (action, active) => (chosen === action ? ButtonStyle.Success : active);
	return new ActionRowBuilder().addComponents(
		new ButtonBuilder().setCustomId(id('want')).setLabel('想看').setEmoji('👍').setStyle(style('want', ButtonStyle.Primary)).setDisabled(Boolean(chosen)),
		new ButtonBuilder().setCustomId(id('seen')).setLabel('看过了').setEmoji('✅').setStyle(style('seen', ButtonStyle.Secondary)).setDisabled(Boolean(chosen)),
		new ButtonBuilder().setCustomId(id('next')).setLabel('换一部').setEmoji('🔁').setStyle(ButtonStyle.Secondary).setDisabled(Boolean(chosen) || !(card.remainingToday > 0)),
		new ButtonBuilder().setLabel('Trakt').setEmoji('🔗').setStyle(ButtonStyle.Link).setURL(`https://trakt.tv/search/tmdb/${card.tmdbId}?id_type=movie`),
	);
}

function cardMessage(card, filters, userId, chosen = null) {
	const text = new TextDisplayBuilder().setContent(cardText(card, filters));
	const container = new ContainerBuilder().setAccentColor(ACCENT_COLOR);
	if (card.poster) container.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text).setThumbnailAccessory(new ThumbnailBuilder().setURL(card.poster)));
	else container.addTextDisplayComponents(text);
	container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
	container.addActionRowComponents(buttons(card, userId, chosen));
	return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

// The pick and its message carry each other: the card is kept per message to redraw buttons.
const cardsByPick = new Map();

function remember(card, filters) {
	cardsByPick.set(card.pickId, card);
	filtersByPick.set(card.pickId, filters);
	// Picks are three a day; the maps stay small, but never let them grow for weeks.
	if (cardsByPick.size > 500) {
		const oldest = cardsByPick.keys().next().value;
		cardsByPick.delete(oldest);
		filtersByPick.delete(oldest);
	}
}

// /movie recommend: resolves to the reply payload.
async function recommend(userId, filters) {
	const card = await requestPick(userId, filters);
	remember(card, filters);
	return cardMessage(card, filters, userId);
}

function ratingMenu(pickId, userId) {
	const menu = new StringSelectMenuBuilder()
		.setCustomId(`pick:rate:${pickId}:${userId}`)
		.setPlaceholder('选一个分数（1–10）')
		.addOptions(...[10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((n) => new StringSelectMenuOptionBuilder().setLabel(`${n} 分`).setValue(String(n)).setEmoji(n >= 8 ? '🌟' : n >= 6 ? '👍' : '😐')));
	return new ActionRowBuilder().addComponents(menu);
}

// Buttons (pick:want / pick:seen / pick:next) and the rating menu (pick:rate).
async function handlePickInteraction(interaction) {
	const [, action, pickId, ownerId] = interaction.customId.split(':');
	if (interaction.user.id !== ownerId) {
		await interaction.reply({ content: '这是别人的推荐，用 `/movie recommend` 拿一部你自己的。', flags: MessageFlags.Ephemeral });
		return;
	}
	const card = cardsByPick.get(pickId);
	const filters = filtersByPick.get(pickId) ?? {};
	if (action === 'next') {
		await interaction.deferUpdate();
		try {
			const next = await requestPick(ownerId, filters, pickId);
			remember(next, filters);
			await interaction.editReply(cardMessage(next, filters, ownerId));
		}
		catch (error) {
			const text = explain(error);
			if (!text) throw error;
			await interaction.followUp({ content: text, flags: MessageFlags.Ephemeral });
		}
		return;
	}
	if (action === 'rate') {
		const rating = Number(interaction.values?.[0]);
		await interaction.deferUpdate();
		try {
			await markWatched(ownerId, pickId, rating);
		}
		catch (error) {
			const text = explain(error);
			if (!text) throw error;
			await interaction.followUp({ content: text, flags: MessageFlags.Ephemeral });
			return;
		}
		await interaction.editReply({ content: `✅ 记下了：《${card?.title ?? '这部'}》${rating} 分，已标记看过并写进 Trakt。`, components: [] });
		return;
	}
	await interaction.deferUpdate();
	try {
		if (action === 'want') {
			await markWant(ownerId, pickId);
			if (card) await interaction.editReply(cardMessage(card, filters, ownerId, 'want'));
			await interaction.followUp({ content: `👍 《${card?.title ?? '这部'}》已加进你的 Trakt 想看列表。` });
		}
		else if (action === 'seen') {
			const result = await markWatched(ownerId, pickId, null);
			if (result.rated) {
				if (card) await interaction.editReply(cardMessage(card, filters, ownerId, 'seen'));
				await interaction.followUp({ content: `✅ 你给过《${card?.title ?? '这部'}》${result.rating} 分，已标记看过。` });
			}
			else {
				// Not rated: the card waits; the rating menu finishes the job.
				await interaction.followUp({
					content: UNRATED_TEASES[Math.floor(Math.random() * UNRATED_TEASES.length)](card?.title ?? '这部'),
					components: [ratingMenu(pickId, ownerId)],
				});
			}
		}
	}
	catch (error) {
		const text = explain(error);
		if (!text) throw error;
		await interaction.followUp({ content: text, flags: MessageFlags.Ephemeral });
	}
}

module.exports = { GENRES, DECADES, recommend, explain, handlePickInteraction };
