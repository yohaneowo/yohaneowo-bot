const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ContainerBuilder,
	MessageFlags,
	SectionBuilder,
	SeparatorBuilder,
	SeparatorSpacingSize,
	TextDisplayBuilder,
	ThumbnailBuilder,
} = require('discord.js');
const tmdb = require('./tmdb');
const { aiEnabled } = require('./claude');

// The daily recommendation DM, in Discord's Components V2 layout so each movie keeps its poster,
// its featured people (with photos) and its own buttons together. One message holds a few movies;
// larger days are split across messages (V2 allows 40 components and 4000 characters of text).
const MAX_COMPONENTS = 40;
const MAX_TEXT_LENGTH = 3800;
const ACCENT_COLOR = 0xe5a00d;
const EMOJI = { now: '🎬', upcoming: '🗓️', reminder: '🍿' };

function shortDate(date) {
	return date ? `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}` : '未定';
}

function feedbackButtons(tmdbId, type, chosen, rewatch) {
	const button = (action, label, emoji) =>
		new ButtonBuilder()
			.setCustomId(`movie:${action}:${tmdbId}`)
			.setLabel(label)
			.setEmoji(emoji)
			.setStyle(chosen === action ? ButtonStyle.Success : ButtonStyle.Secondary)
			.setDisabled(Boolean(chosen));
	// Nobody has seen a movie that isn't out yet, and a rewatch was recommended because they saw it.
	return [
		button('want', '想看', '👍'),
		button('skip', '没兴趣', '👎'),
		...(type === 'upcoming' || rewatch ? [] : [button('seen', '看过了', '✅')]),
	];
}

// A text block, with an image beside it when there is one (a Section needs an accessory).
function block(text, imageUrl) {
	const display = new TextDisplayBuilder().setContent(text);
	if (!imageUrl) return { components: [display], count: 1, text };
	return {
		components: [new SectionBuilder().addTextDisplayComponents(display).setThumbnailAccessory(new ThumbnailBuilder().setURL(imageUrl))],
		count: 3,
		text,
	};
}

const FORMAT_LABELS = { 'Dolby Cinema': '杜比影院', '70mm': '70mm 胶卷', HFR: '高帧率' };

// "🎞️ IMAX（IMAX 摄影机拍摄）· 杜比影院 · 4DX", or null when no format is known (read from
// Wikipedia by the AI, see wikipedia.js).
function formatsLine(record) {
	const labels = (record.formats ?? []).map((format) => FORMAT_LABELS[format] ?? format);
	if (record.filmedInImax) {
		const imax = labels.findIndex((label) => label.startsWith('IMAX'));
		if (imax >= 0) labels[imax] += '（IMAX 摄影机拍摄）';
		else labels.unshift('IMAX 摄影机拍摄');
	}
	return labels.length ? `-# 🎞️ ${labels.join(' · ')}` : null;
}

// Discord shows a masked link inside a heading as raw [text](url), so the title is plain text;
// the original title and re-release note go on a small line under it.
function movieText({ details, releaseDate, rereleaseYear }, record, type) {
	const subtitle = [
		details.original_title !== details.title ? details.original_title : null,
		rereleaseYear ? `${rereleaseYear} 年作品重映` : null,
	].filter(Boolean);
	// The release date sits next to the title; the emoji tells in cinemas / upcoming / reminder apart.
	// Rewatches (a loved film back in cinemas) say 重映 and get their own emoji.
	const when = record.rewatch
		? { now: `${shortDate(releaseDate)} 起重映`, upcoming: `${shortDate(releaseDate)} 重映`, reminder: '重映开始了' }[type]
		: { now: `${shortDate(releaseDate)} 起上映`, upcoming: `${shortDate(releaseDate)} 上映`, reminder: '已上映' }[type];
	const facts = [
		(details.genres ?? []).map((genre) => genre.name).join('/'),
		details.runtime ? `${details.runtime} 分钟` : null,
		tmdb.directors(details)[0] ? `导演 ${tmdb.directors(details)[0].name}` : null,
		details.vote_count >= 30 ? `TMDB ${details.vote_average.toFixed(1)}` : null,
		record.predictedRating ? `预测你 ${record.predictedRating} 分` : null,
	].filter(Boolean);
	return [
		`### ${record.rewatch ? '🔁' : EMOJI[type]} ${details.title} · ${when}`,
		subtitle.length ? `-# ${subtitle.join(' · ')}` : null,
		type === 'reminder' ? (record.rewatch ? '之前提醒过的重映现在开始了。' : '之前推荐过的这部现在上映了。') : null,
		record.reason ? `**${record.reason}**` : null,
		formatsLine(record),
		`-# ${facts.join(' · ')}`,
	]
		.filter(Boolean)
		.join('\n');
}

function personText(person) {
	const role = person.role === 'director' ? '🎥 导演' : `🎭 ${person.character ? `饰 ${person.character}` : '主演'}`;
	const films = person.films.map((film) => `《${film.title}》${film.rating} 分`).join('、');
	return `**${person.name}** · ${role}\n-# 你评过分的作品：${films}`;
}

// The blocks for one movie card, with their component count and text length.
function cardParts(card) {
	const { entry, record, type } = card;
	const parts = [block(movieText(entry, record, type), tmdb.posterUrl(entry.details))];
	for (const person of record.featuredPeople ?? []) parts.push(block(personText(person), person.photo));

	// A release reminder offers fresh buttons: someone who said "want" may now have seen it.
	const buttons = feedbackButtons(entry.details.id, type, type === 'reminder' ? null : record.feedback, record.rewatch);
	const trailer = tmdb.trailerUrl(entry.details);
	// 「AI 怎么看」 stays usable after a feedback press (markFeedback leaves it alone).
	if (aiEnabled) buttons.push(new ButtonBuilder().setCustomId(`movie:ask:${entry.details.id}`).setLabel('AI 怎么看').setEmoji('💬').setStyle(ButtonStyle.Primary));
	// The title already links to TMDB; one link button keeps four cards within one message.
	if (trailer) buttons.push(new ButtonBuilder().setLabel('预告片').setEmoji('▶️').setStyle(ButtonStyle.Link).setURL(trailer));
	parts.push({ components: [new ActionRowBuilder().addComponents(...buttons)], count: 1 + buttons.length, text: '' });

	return {
		components: parts.flatMap((part) => part.components),
		count: parts.reduce((sum, part) => sum + part.count, 0),
		textLength: parts.reduce((sum, part) => sum + part.text.length, 0),
	};
}

// cards: [{ entry, record, type: 'now' | 'upcoming' | 'reminder' }]; name: the recipient's Discord
// display name, for the footer. Resolves to an array of { payload, cards } messages, each card in
// exactly one message.
function buildDigestMessages(cards, date, name) {
	const header = (index, total) =>
		`## 🍿 院线片单更新了\n-# ${shortDate(date)} · 有 ${cards.length} 部可能合你胃口${total > 1 ? ` · ${index}/${total}` : ''}`;
	// The recipient's name closes the message; without one there is no footer.
	const footer = name ? `-# ${name} 的专属推荐` : '';
	// Header (and footer) text displays and the container itself; each card adds its own separator.
	const fixedCount = footer ? 3 : 2;

	const groups = [];
	let current = { cards: [], parts: [], count: fixedCount, textLength: header(9, 9).length + footer.length };
	for (const card of cards) {
		const parts = cardParts(card);
		const cost = parts.count + 1;
		if (current.cards.length && (current.count + cost > MAX_COMPONENTS || current.textLength + parts.textLength > MAX_TEXT_LENGTH)) {
			groups.push(current);
			current = { cards: [], parts: [], count: fixedCount, textLength: header(9, 9).length + footer.length };
		}
		current.cards.push(card);
		current.parts.push(parts);
		current.count += cost;
		current.textLength += parts.textLength;
	}
	if (current.cards.length) groups.push(current);

	return groups.map((group, index) => {
		const container = new ContainerBuilder().setAccentColor(ACCENT_COLOR);
		container.addTextDisplayComponents(new TextDisplayBuilder().setContent(header(index + 1, groups.length)));
		for (const parts of group.parts) {
			container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large));
			for (const component of parts.components) {
				if (component instanceof SectionBuilder) container.addSectionComponents(component);
				else if (component instanceof ActionRowBuilder) container.addActionRowComponents(component);
				else container.addTextDisplayComponents(component);
			}
		}
		if (footer) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(footer));
		return { payload: { flags: MessageFlags.IsComponentsV2, components: [container] }, cards: group.cards };
	});
}

// After a feedback press: the same message with that movie's buttons disabled and the chosen one
// highlighted. Works on the raw component JSON so the rest of the layout is untouched.
function markFeedback(messageComponents, tmdbId, action) {
	const update = (component) => {
		if (/^movie:(want|skip|seen):/.test(component.custom_id ?? '') && component.custom_id.endsWith(`:${tmdbId}`)) {
			const chosen = component.custom_id.startsWith(`movie:${action}:`);
			return { ...component, disabled: true, style: chosen ? ButtonStyle.Success : ButtonStyle.Secondary };
		}
		const next = { ...component };
		if (Array.isArray(component.components)) next.components = component.components.map(update);
		if (component.accessory) next.accessory = update(component.accessory);
		return next;
	};
	return messageComponents.map((component) => update(component.toJSON ? component.toJSON() : component));
}

module.exports = {
	buildDigestMessages,
	markFeedback,
};
