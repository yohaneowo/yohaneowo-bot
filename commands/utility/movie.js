const {
	SlashCommandBuilder,
	ApplicationIntegrationType,
	InteractionContextType,
	MessageFlags,
} = require('discord.js');
const store = require('../../services/movies/store');
const { fetchUserMovies, parseTraktUser, TraktUserError } = require('../../services/movies/trakt');
const { moviesEnabled, runNow } = require('../../services/movies/recommender');
const { isRegion, regionChoices, regionLabel } = require('../../services/movies/regions');

// /movie check runs the whole pipeline (TMDB, Trakt, AI), so keep it from being spammed.
const CHECK_COOLDOWN_MS = 10 * 60 * 1000;
const lastCheckAt = new Map();

async function subscribe(interaction) {
	const traktUser = parseTraktUser(interaction.options.getString('trakt'));
	// Required, with no default: a wrong region means recommending films that aren't showing there.
	const region = interaction.options.getString('region', true).trim().toUpperCase();
	if (!traktUser) {
		await interaction.editReply('请贴上你的 Trakt 个人页链接（App 里「分享个人资料」的网址），或填用户名。');
		return;
	}
	// Autocomplete only suggests; someone can still send free text.
	if (!isRegion(region)) {
		await interaction.editReply('请从选单里选择地区：输入国家名称或代码就会出现，例如「台湾」「香港」「JP」。');
		return;
	}

	let history;
	try {
		history = await fetchUserMovies(traktUser);
	}
	catch (error) {
		await interaction.editReply(error instanceof TraktUserError ? `订阅失败：${error.message}。` : '暂时连不上 Trakt，请稍后再试。');
		if (!(error instanceof TraktUserError)) console.warn('[movie] Trakt check failed:', error.message);
		return;
	}

	// Keyed by the profile slug (stable); the username is only for display.
	const traktName = history.profile.username;
	await store.subscribe(interaction.user.id, history.profile.slug, traktName, region);
	// Recommendations arrive by DM, so make sure one can actually get through now.
	const dmOk = await interaction.user
		.send(`🎬 已订阅电影推荐（Trakt：${traktName}，地区：${regionLabel(region)}）。每天会根据你的观看记录挑新片私信给你。`)
		.then(() => true)
		.catch(() => false);
	await interaction.editReply(
		[
			`已订阅：Trakt「${traktName}」（评分 ${history.ratings.length} 部、看过 ${history.watched.length} 部），地区 ${regionLabel(region)}。`,
			history.ratings.length < 10 ? '评分的电影还不多，推荐会比较不准；在 Trakt 多评几部会更好。' : null,
			dmOk ? '推荐会每天私信给你，想马上试试可以用 `/movie check`。' : '⚠️ 私信发送失败：请允许这个 bot 私信你（或把它安装到你的帐号），不然收不到推荐。',
		]
			.filter(Boolean)
			.join('\n'),
	);
}

async function status(interaction) {
	const subscriber = await store.getSubscriber(interaction.user.id);
	if (!subscriber) {
		await interaction.editReply('你还没有订阅，用 `/movie subscribe` 开始。');
		return;
	}
	const records = Object.values(await store.userMovies(interaction.user.id));
	const sent = records.filter((record) => record.sentAt).sort((a, b) => b.sentAt.localeCompare(a.sentAt));
	const waitingRelease = sent.filter((record) => record.kind === 'upcoming' && !record.remindedAt && !['skip', 'seen'].includes(record.feedback));
	await interaction.editReply(
		[
			`Trakt：「${subscriber.traktName ?? subscriber.traktUser}」，地区：${regionLabel(subscriber.region)}`,
			`已判断 ${records.length} 部，推荐过 ${sent.length} 部，等上映提醒 ${waitingRelease.length} 部。`,
			sent.length ? `最近推荐：${sent.slice(0, 5).map((record) => `《${record.title}》`).join('、')}` : null,
		]
			.filter(Boolean)
			.join('\n'),
	);
}

async function check(interaction) {
	if (!(await store.getSubscriber(interaction.user.id))) {
		await interaction.editReply('你还没有订阅，用 `/movie subscribe` 开始。');
		return;
	}
	const waitMs = (lastCheckAt.get(interaction.user.id) ?? 0) + CHECK_COOLDOWN_MS - Date.now();
	if (waitMs > 0) {
		await interaction.editReply(`刚检查过，${Math.ceil(waitMs / 60000)} 分钟后再试。`);
		return;
	}
	lastCheckAt.set(interaction.user.id, Date.now());

	await interaction.editReply('🔍 正在检查新片并判断，可能要一两分钟…');
	try {
		const result = await runNow(interaction.client, interaction.user.id);
		if (!result) {
			await interaction.editReply('上一次检查还在进行中，请稍后再看。');
			return;
		}
		await interaction.editReply(
			result.recommended || result.reminded
				? `检查完成：推荐 ${result.recommended} 部、上映提醒 ${result.reminded} 部，已私信给你。`
				: `检查完成：这次判断了 ${result.judged} 部，没有特别适合你的新片。`,
		);
	}
	catch (error) {
		console.warn('[movie] Manual check failed:', error.message);
		await interaction.editReply(error instanceof TraktUserError ? `检查失败：${error.message}。` : '检查失败了，请稍后再试。');
	}
}

module.exports = {
	// Global and user-installable: subscribe from anywhere; recommendations come by DM.
	global: true,
	data: new SlashCommandBuilder()
		.setName('movie')
		.setDescription('根据 Trakt 观看记录推荐新上映的电影')
		.addSubcommand((sub) =>
			sub
				.setName('subscribe')
				.setDescription('订阅每天的新片推荐（私信）')
				.addStringOption((option) => option.setName('trakt').setDescription('Trakt 个人页链接（App 里分享个人资料的网址）或用户名，帐号需公开').setRequired(true))
				.addStringOption((option) =>
					option
						.setName('region')
						.setDescription('看电影的地区：输入国家名称或代码后从选单选择，例如 台湾、香港、JP')
						.setRequired(true)
						.setAutocomplete(true),
				),
		)
		.addSubcommand((sub) => sub.setName('unsubscribe').setDescription('取消订阅'))
		.addSubcommand((sub) => sub.setName('status').setDescription('查看订阅设定和最近的推荐'))
		.addSubcommand((sub) => sub.setName('check').setDescription('现在就检查一次新片'))
		.setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
		.setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel),

	async autocomplete(interaction) {
		const focused = interaction.options.getFocused(true);
		if (focused.name === 'region') await interaction.respond(regionChoices(focused.value));
	},

	async execute(interaction) {
		if (!moviesEnabled) {
			await interaction.reply({ content: '电影推荐还没有设定好（缺少 TMDB 或 Trakt 的 API key）。', flags: MessageFlags.Ephemeral });
			return;
		}
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });
		const subcommand = interaction.options.getSubcommand();
		if (subcommand === 'subscribe') {await subscribe(interaction);}
		else if (subcommand === 'status') {await status(interaction);}
		else if (subcommand === 'check') {await check(interaction);}
		else {
			await store.unsubscribe(interaction.user.id);
			await interaction.editReply('已取消订阅，不会再收到推荐。');
		}
	},
};
