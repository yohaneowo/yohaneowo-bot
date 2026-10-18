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

// /anime recommend: admin keeps the pools, the quota and the Trakt writes (admin's
// movie/anime_recommend.py); this file is the Discord side, shaped like the movie picks
// (services/movies/picks.js): the card, its buttons and the rating menu. Custom ids start with
// "apick:" so they never collide with the movie cards' "pick:".
const SITE_URL = process.env.SITE_URL || 'https://yohaneowo.com';
const CONNECT_URL = `${SITE_URL}/connect/discord`;
const SETTINGS_URL = `${SITE_URL}/settings`;
const ACCENT_COLOR = 0x6fc3a0;
const part = (value) => encodeURIComponent(value);

// AniList's genres (the value admin filters on) with their Chinese names.
const GENRES = [
	['Action', '动作'], ['Adventure', '冒险'], ['Comedy', '喜剧'], ['Drama', '剧情'], ['Ecchi', '卖肉'],
	['Fantasy', '奇幻'], ['Horror', '恐怖'], ['Mahou Shoujo', '魔法少女'], ['Mecha', '机战'], ['Music', '音乐'],
	['Mystery', '悬疑'], ['Psychological', '心理'], ['Romance', '恋爱'], ['Sci-Fi', '科幻'], ['Slice of Life', '日常'],
	['Sports', '运动'], ['Supernatural', '超自然'], ['Thriller', '惊悚'],
];
const GENRE_NAMES = Object.fromEntries(GENRES);
const DECADES = [1980, 1990, 2000, 2010, 2020];
const FORMATS = [['TV', '电视版'], ['MOVIE', '剧场版'], ['ONA', '网络版']];
const LENGTHS = [['short', '一季内（≤ 13 集）'], ['cour2', '两季长度（14–26 集）'], ['long', '长篇（> 26 集）']];
const FORMAT_NAMES = { TV: '电视版', TV_SHORT: '电视短篇', MOVIE: '剧场版', ONA: '网络版' };
const SEASON_NAMES = { WINTER: '冬', SPRING: '春', SUMMER: '夏', FALL: '秋' };

// The filters each pick was asked with, so 换一部 keeps them (pickId → filters).
const filtersByPick = new Map();
const cardsByPick = new Map();

const LIMIT_TEASES = [
	'今天的次数和奖励次数都用完了，先挑一部追吧，明天再来 📺',
	'额度用完了。推荐不是无限刷的，去追番 👀',
];

// The day's picks left, then the bonus picks (100 to start, never reset; the owner adds more).
function quotaLine(card) {
	const daily = card.remainingToday ?? 0;
	const bonus = card.bonusLeft ?? 0;
	if (daily > 0) return `今天还能换 ${daily} 次${bonus > 0 ? `，另有 ${bonus} 次奖励次数` : ''}`;
	if (bonus > 0) return `今天的次数用完了，接下来用奖励次数（还有 ${bonus} 次）`;
	return '今天的额度用完了';
}

const canPickAgain = (card) => (card.remainingToday ?? 0) > 0 || (card.bonusLeft ?? 0) > 0;
const UNRATED_TEASES = [
	(title) => `看完《${title}》却没评分？那我怎么知道你喜不喜欢 🥲 现在补一个：`,
	(title) => `《${title}》追完不打分，下次推错可别怪我 😤 选个分数：`,
];

function errorKind(error) {
	const match = /HTTP (\d+)(?::\s*(\w+))?/.exec(error?.message ?? '');
	return match ? { status: Number(match[1]), code: match[2] } : null;
}

// Why a pick could not be made, as a sentence for the person (null for unexpected errors).
function explain(error) {
	const kind = errorKind(error);
	if (!kind) return null;
	if (kind.status === 404 && kind.code !== 'nothingToPick' && kind.code !== 'pickNotFound') return `还没有你的观影档案。点这个链接用 Discord 登录网站、授权 Trakt，弄好再回来按一次：${CONNECT_URL}`;
	if (kind.status === 403) return `这个功能要先授权 Trakt（想看、看过了会直接写进你的 Trakt）。点这个链接，到观影页按「授权 Trakt」：${CONNECT_URL}`;
	if (kind.status === 429) return LIMIT_TEASES[Math.floor(Math.random() * LIMIT_TEASES.length)];
	if (kind.code === 'nothingToPick') return '这个条件下找不到可以推荐的动漫，换个类型、年代或长度试试。';
	if (kind.code === 'pickNotFound') return '这部在 Trakt 上找不到对应的季，没办法写入。';
	if (kind.status === 502) return `Trakt 不认这个授权了，请到观影页重新授权：${CONNECT_URL}`;
	if (kind.status === 503) return 'Trakt、AniList 或 Bangumi 暂时连不上，稍后再试。';
	return null;
}

const STAGE_TEXT = {
	lists: '⏳ 正在读取你的 Trakt 想看与隐藏名单…',
	profile: '⏳ 正在整理你的动漫口味…',
	pools: '⏳ 正在建候选池：续作 / 猜你喜欢 / 跨界 / 新坑 / 新番…',
	card: '⏳ 正在挑一部…',
};
const PROGRESS_INTERVAL_MS = 2500;
const PICK_TIMEOUT_MS = 300000;
const ignore = () => undefined;

function requestPick(userId, filters, skip) {
	return movieRequest('POST', `/anime-picks/${part(userId)}`, { ...filters, ...(skip ? { skip } : {}) }, PICK_TIMEOUT_MS);
}

function listPicks(userId) {
	return movieRequest('GET', `/anime-picks/${part(userId)}`, undefined, 15000);
}

async function recoverPick(userId, since) {
	const listed = await listPicks(userId).catch(() => null);
	const fresh = (listed?.picks ?? []).find((p) => !p.action && p.card && p.shownAt && Date.parse(`${p.shownAt}Z`) >= since - 60000);
	if (!fresh) return null;
	return { ...fresh.card, pickId: fresh.pickId, mode: fresh.mode, modeLabel: fresh.modeLabel, reason: fresh.reason, remainingToday: listed.remainingToday, bonusLeft: listed.bonus };
}

function isTimeout(error) {
	return error?.name === 'TimeoutError' || /timeout|aborted/i.test(error?.message ?? '');
}

function requestProgress(userId) {
	return movieRequest('GET', `/anime-picks/${part(userId)}/progress`, undefined, 5000);
}

// Runs the pick while `show(text)` gets the current stage every few seconds (the first pick of
// the day builds the pools, which takes a while).
async function pickWithProgress(userId, filters, skip, show) {
	const started = Date.now();
	const pending = requestPick(userId, filters, skip).catch(async (error) => {
		if (!isTimeout(error)) throw error;
		const recovered = await recoverPick(userId, started);
		if (!recovered) throw error;
		console.warn(`[anime] Pick for ${userId} took longer than ${PICK_TIMEOUT_MS / 1000}s; recovered it from the pick list.`);
		return recovered;
	});
	let settled = false;
	const settle = () => {
		settled = true;
	};
	pending.then(settle, settle);
	let lastText = null;
	while (!settled) {
		await new Promise((resolve) => setTimeout(resolve, PROGRESS_INTERVAL_MS));
		if (settled) break;
		const stage = await requestProgress(userId).then((p) => p?.stage ?? null).catch(() => null);
		const elapsed = Math.round((Date.now() - started) / 1000);
		const text = `${STAGE_TEXT[stage] ?? STAGE_TEXT.card}${elapsed >= 10 ? ` (${elapsed} 秒)` : ''}`;
		if (text !== lastText) {
			lastText = text;
			await show(text).catch(ignore);
		}
	}
	return pending;
}

function markWant(userId, pickId) {
	return movieRequest('POST', `/anime-picks/${part(userId)}/${part(pickId)}/watchlist`, {});
}

function markWatched(userId, pickId, rating) {
	return movieRequest('POST', `/anime-picks/${part(userId)}/${part(pickId)}/watched`, rating == null ? {} : { rating });
}

function unrate(userId, pickId) {
	return movieRequest('POST', `/anime-picks/${part(userId)}/${part(pickId)}/unrate`, {});
}

function cardText(card, filters) {
	const when = card.season && card.year ? `${card.year} ${SEASON_NAMES[card.season] ?? ''}` : card.year ? String(card.year) : null;
	const meta = [
		[FORMAT_NAMES[card.format] ?? card.format, card.episodes ? `${card.episodes} 集` : null, card.status === 'RELEASING' ? '连载中' : null].filter(Boolean).join(' '),
		card.studios?.length ? card.studios.slice(0, 2).join('、') : null,
		card.genres?.length ? card.genres.slice(0, 3).map((g) => GENRE_NAMES[g] ?? g).join(' / ') : null,
	].filter(Boolean);
	const asked = [
		filters.genre ? GENRE_NAMES[filters.genre] ?? filters.genre : null,
		filters.decade ? `${filters.decade} 年代` : null,
		filters.format ? FORMATS.find(([value]) => value === filters.format)?.[1] : null,
		filters.length ? LENGTHS.find(([value]) => value === filters.length)?.[1] : null,
		filters.airing ? '只要新番' : null,
	].filter(Boolean);
	const native = card.titleNative && card.titleNative !== card.title ? ` ${card.titleNative}` : '';
	const scores = [
		card.bangumiScore != null ? `Bangumi ${Number(card.bangumiScore).toFixed(1)}` : null,
		card.malScore != null ? `MAL ${Number(card.malScore).toFixed(2)}` : null,
		card.anilistScore != null ? `AniList ${Number(card.anilistScore).toFixed(1)}` : null,
	].filter(Boolean).join(' · ');
	const link = card.links?.bangumi ?? card.links?.anilist;
	const summary = card.summary ? (card.summary.length > 260 ? `${card.summary.slice(0, 260)}…` : card.summary) : null;
	return [
		`## 🎲 动漫推荐 · ${card.modeLabel ?? card.mode}${asked.length ? `\n-# 条件：${asked.join(' · ')}` : ''}`,
		`### [${card.title}](${link})${when ? `（${when}）` : ''}${native}`,
		meta.length ? `-# ${meta.join(' · ')}` : null,
		`> ${card.reason}${card.ai ? ' ✨' : ''}${card.inWatchlist ? '\n> 已在你的想看列表' : ''}`,
		summary,
		[
			scores || null,
			card.trakt ? null : 'Trakt 上找不到对应的季，这部只能看链接',
			card.mode === 'airing' && !filters.airing ? `不想在推荐里看到新番？到网站设定关掉：${SETTINGS_URL}` : null,
			card.usedBonus ? '这次用了 1 次奖励次数' : null,
			quotaLine(card),
		].filter(Boolean).map((text) => `-# ${text}`).join('\n'),
	]
		.filter(Boolean)
		.join('\n');
}

// Buttons carry the pick and its owner, so only the person who asked can press them. 想看 needs
// a Trakt target; 看过了 one whose episodes are known.
function buttons(card, userId, chosen) {
	const id = (action) => `apick:${action}:${card.pickId}:${userId}`;
	const style = (action, active) => (chosen === action ? ButtonStyle.Success : active);
	const row = new ActionRowBuilder();
	if (card.trakt) row.addComponents(new ButtonBuilder().setCustomId(id('want')).setLabel('想看').setEmoji('👍').setStyle(style('want', ButtonStyle.Primary)).setDisabled(Boolean(chosen)));
	if (card.trakt?.watchable) row.addComponents(new ButtonBuilder().setCustomId(id('seen')).setLabel('看过了').setEmoji('✅').setStyle(style('seen', ButtonStyle.Secondary)).setDisabled(Boolean(chosen)));
	row.addComponents(new ButtonBuilder().setCustomId(id('next')).setLabel('换一部').setEmoji('🔁').setStyle(ButtonStyle.Secondary).setDisabled(Boolean(chosen) || !canPickAgain(card)));
	if (card.links?.bangumi) row.addComponents(new ButtonBuilder().setLabel('Bangumi').setStyle(ButtonStyle.Link).setURL(card.links.bangumi));
	row.addComponents(new ButtonBuilder().setLabel(card.trakt ? 'Trakt' : 'AniList').setEmoji('🔗').setStyle(ButtonStyle.Link).setURL(card.trakt?.url ?? card.links.anilist));
	return row;
}

function cardMessage(card, filters, userId, chosen = null) {
	const text = new TextDisplayBuilder().setContent(cardText(card, filters));
	const container = new ContainerBuilder().setAccentColor(ACCENT_COLOR);
	if (card.cover) container.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text).setThumbnailAccessory(new ThumbnailBuilder().setURL(card.cover)));
	else container.addTextDisplayComponents(text);
	container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
	container.addActionRowComponents(buttons(card, userId, chosen));
	return { content: '', embeds: [], components: [container], flags: MessageFlags.IsComponentsV2 };
}

function remember(card, filters) {
	cardsByPick.set(card.pickId, card);
	filtersByPick.set(card.pickId, filters);
	if (cardsByPick.size > 500) {
		const oldest = cardsByPick.keys().next().value;
		cardsByPick.delete(oldest);
		filtersByPick.delete(oldest);
	}
}

async function recommend(userId, filters, show) {
	const card = await pickWithProgress(userId, filters, null, show);
	remember(card, filters);
	console.info(`[anime] Pick for ${userId}: ${card.mode} → ${card.title} (${card.anilistId}), ${card.remainingToday} left today`);
	return { payload: cardMessage(card, filters, userId), pickId: card.pickId };
}

function rememberMessage(pickId, message) {
	const card = cardsByPick.get(pickId);
	if (card && message?.id) card.messageId = message.id;
}

function ratedMessage(title, rating, pickId, userId, changed, result = null) {
	const own = result?.own !== false;
	const written = own ? '已标记看过并写进 Trakt。' : '已标记看过。';
	const quota = result?.refunded
		? `这次不算额度，${quotaLine(result)}。`
		: own && !changed && result?.remainingToday != null ? `${quotaLine(result)}。` : '';
	const lead = !own ? `你之前给过《${title}》${rating} 分，` : `${changed ? '改好了' : '记下了'}：《${title}》${rating} 分，`;
	// Trakt keeps the show's rating apart from its seasons'; admin sets it to their average.
	const show = result?.showRating != null ? `整部作品的评分也更新为 ${result.showRating} 分（各季平均）。` : '';
	const actions = own
		? [
			new ButtonBuilder().setCustomId(`apick:rerate:${pickId}:${userId}`).setLabel('修改评分').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
			new ButtonBuilder().setCustomId(`apick:unrate:${pickId}:${userId}`).setLabel('删除评分').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
		]
		: [];
	return { content: `✅ ${lead}${written}${show}${quota}`, components: actions.length ? [new ActionRowBuilder().addComponents(...actions)] : [] };
}

function ratingMenu(pickId, userId) {
	const menu = new StringSelectMenuBuilder()
		.setCustomId(`apick:rate:${pickId}:${userId}`)
		.setPlaceholder('选一个分数（1–10）')
		.addOptions(...[10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((n) => new StringSelectMenuOptionBuilder().setLabel(`${n} 分`).setValue(String(n)).setEmoji(n >= 8 ? '🌟' : n >= 6 ? '👍' : '😐')));
	return [
		new ActionRowBuilder().addComponents(menu),
		new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`apick:cancelrate:${pickId}:${userId}`).setLabel('取消').setEmoji('✖️').setStyle(ButtonStyle.Secondary)),
	];
}

async function handleAnimePickInteraction(interaction) {
	const [, action, pickId, ownerId] = interaction.customId.split(':');
	if (interaction.user.id !== ownerId) {
		await interaction.reply({ content: '这是别人的推荐，用 `/anime recommend` 拿一部你自己的。', flags: MessageFlags.Ephemeral });
		return;
	}
	const card = cardsByPick.get(pickId);
	const filters = filtersByPick.get(pickId) ?? {};
	if (action === 'next') {
		await interaction.deferUpdate();
		let note = null;
		const show = async (text) => {
			if (note) await interaction.webhook.editMessage(note.id, { content: text });
			else note = await interaction.followUp({ content: text, flags: MessageFlags.Ephemeral });
		};
		try {
			const next = await pickWithProgress(ownerId, filters, pickId, show);
			remember(next, filters);
			rememberMessage(next.pickId, interaction.message);
			console.info(`[anime] Next pick for ${ownerId}: ${next.mode} → ${next.title} (${next.anilistId}), ${next.remainingToday} left today`);
			await interaction.editReply(cardMessage(next, filters, ownerId));
			if (note) await interaction.webhook.deleteMessage(note.id).catch(ignore);
		}
		catch (error) {
			const text = explain(error);
			if (!text) throw error;
			if (note) await interaction.webhook.editMessage(note.id, { content: text });
			else await interaction.followUp({ content: text, flags: MessageFlags.Ephemeral });
		}
		return;
	}
	if (action === 'rerate') {
		await interaction.update({ content: `换个分数给《${card?.title ?? '这部'}》：`, components: ratingMenu(pickId, ownerId) });
		return;
	}
	if (action === 'cancelrate') {
		await interaction.update({ content: '已取消，没有写入任何东西。', components: [] });
		return;
	}
	if (action === 'unrate') {
		await interaction.deferUpdate();
		let result;
		try {
			result = await unrate(ownerId, pickId);
		}
		catch (error) {
			const text = explain(error);
			if (!text) throw error;
			await interaction.followUp({ content: text, flags: MessageFlags.Ephemeral });
			return;
		}
		console.info(`[anime] Unrated for ${ownerId}: ${result.title ?? pickId}, ${result.remainingToday} left today`);
		await interaction.editReply({
			content: `🗑️ 已删除《${result.title ?? '这部'}》的评分和这次的观看记录，退还的额度也收回了（${quotaLine(result)}）。${result.showRating != null ? `整部作品的评分现在是 ${result.showRating} 分。` : ''}`,
			components: [],
		});
		if (card) await interaction.message?.channel?.messages?.fetch?.(card.messageId).then((m) => m.edit(cardMessage(card, filters, ownerId))).catch(ignore);
		return;
	}
	if (action === 'rate') {
		const rating = Number(interaction.values?.[0]);
		const changed = /^✅/.test(interaction.message?.content ?? '') || /换个分数/.test(interaction.message?.content ?? '');
		await interaction.deferUpdate();
		let result;
		try {
			result = await markWatched(ownerId, pickId, rating);
		}
		catch (error) {
			const text = explain(error);
			if (!text) throw error;
			await interaction.followUp({ content: text, flags: MessageFlags.Ephemeral });
			return;
		}
		const title = result?.title ?? card?.title ?? '这部';
		console.info(`[anime] Rated for ${ownerId}: ${title} → ${rating}${changed ? ' (changed)' : ''}${result?.refunded ? ' (refunded)' : ''}`);
		await interaction.editReply(ratedMessage(title, rating, pickId, ownerId, changed, result));
		return;
	}
	await interaction.deferUpdate();
	try {
		if (action === 'want') {
			await markWant(ownerId, pickId);
			console.info(`[anime] Want for ${ownerId}: ${card?.title ?? pickId}`);
			if (card) await interaction.editReply(cardMessage(card, filters, ownerId, 'want'));
			await interaction.followUp({ content: `👍 《${card?.title ?? '这部'}》已加进你的 Trakt 想看列表。` });
		}
		else if (action === 'seen') {
			const result = await markWatched(ownerId, pickId, null);
			const title = result?.title ?? card?.title ?? '这部';
			if (result.rated) {
				console.info(`[anime] Seen for ${ownerId}: ${title} (already rated ${result.rating})`);
				if (card) await interaction.editReply(cardMessage(card, filters, ownerId, 'seen'));
				await interaction.followUp(ratedMessage(title, result.rating, pickId, ownerId, false, result));
			}
			else {
				await interaction.followUp({
					content: UNRATED_TEASES[Math.floor(Math.random() * UNRATED_TEASES.length)](title),
					components: ratingMenu(pickId, ownerId),
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

// The owner's /anime-bonus: add (or take back) someone's bonus picks.
function grantBonus(userId, amount) {
	return movieRequest('POST', `/anime-picks/${part(userId)}/bonus`, { amount });
}

module.exports = { GENRES, DECADES, FORMATS, LENGTHS, grantBonus, recommend, rememberMessage, explain, handleAnimePickInteraction };
