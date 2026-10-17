const {
	SlashCommandBuilder,
	ApplicationIntegrationType,
	InteractionContextType,
	MessageFlags,
} = require('discord.js');
const store = require('../../services/movies/store');
const { TraktUserError } = require('../../services/movies/trakt');
const { moviesEnabled, runNow } = require('../../services/movies/recommender');
const { regionLabel } = require('../../services/movies/regions');
const picks = require('../../services/movies/picks');

// Trakt details are entered on the website; a profile is found here through the Discord account linked there.
const SITE_URL = process.env.SITE_URL || 'https://yohaneowo.com';
const SETUP_URL = `${SITE_URL}/connect/discord`;
const NOT_SUBSCRIBED = `你还没有订阅。先在网站建立观影档案（${SETUP_URL}），再用 \`/movie subscribe\` 开启推荐。`;

// /movie check runs the whole pipeline (TMDB, Trakt, AI), so keep it from being spammed.
const CHECK_COOLDOWN_MS = 10 * 60 * 1000;
const lastCheckAt = new Map();

async function subscribe(interaction) {
	let subscriber;
	try {
		subscriber = await store.subscribe(interaction.user.id);
	}
	catch (error) {
		if (!store.isNoProfile(error)) throw error;
		await interaction.editReply(
			[
				'还没有你的观影档案。先到网站用 Discord 登录并连上 Trakt，再回来按一次 `/movie subscribe`：',
				SETUP_URL,
			].join('\n'),
		);
		return;
	}
	// Recommendations arrive by DM, so make sure one can actually get through now.
	const dmOk = await interaction.user
		.send(`🎬 已订阅电影推荐（Trakt：${subscriber.traktName ?? subscriber.traktUser}，地区：${regionLabel(subscriber.region)}）。每天会根据你的观看记录挑新片私信给你。`)
		.then(() => true)
		.catch(() => false);
	await interaction.editReply(
		[
			`已订阅：Trakt「${subscriber.traktName ?? subscriber.traktUser}」，地区 ${regionLabel(subscriber.region)}。要改 Trakt 帐号或地区，到网站的观影页改。`,
			dmOk ? '推荐会每天私信给你，想马上试试可以用 `/movie check`。' : '⚠️ 私信发送失败：请允许这个 bot 私信你（或把它安装到你的帐号），不然收不到推荐。',
		].join('\n'),
	);
}

async function recommend(interaction) {
	const filters = {
		genre: interaction.options.getInteger('genre') ?? undefined,
		decade: interaction.options.getInteger('decade') ?? undefined,
		maxRuntime: interaction.options.getInteger('max_runtime') ?? undefined,
	};
	try {
		await interaction.editReply(await picks.recommend(interaction.user.id, filters, (text) => interaction.editReply(text)));
	}
	catch (error) {
		const text = picks.explain(error);
		if (!text) {
			console.warn('[movie] Recommend failed:', error.message);
			await interaction.editReply('推荐失败了，请稍后再试。');
			return;
		}
		await interaction.editReply(text);
	}
}

async function status(interaction) {
	const subscriber = await store.getSubscriber(interaction.user.id);
	if (!subscriber) {
		await interaction.editReply(NOT_SUBSCRIBED);
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
		await interaction.editReply(NOT_SUBSCRIBED);
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
		// The Trakt account and region are set on the website (yohaneowo.com/moviehub); this only turns the DMs on.
		.addSubcommand((sub) => sub.setName('subscribe').setDescription('订阅每天的新片推荐（私信）；Trakt 帐号和地区在网站上设定'))
		.addSubcommand((sub) => sub.setName('unsubscribe').setDescription('停止每日推荐（网站上的观影档案保留）'))
		.addSubcommand((sub) => sub.setName('status').setDescription('查看订阅设定和最近的推荐'))
		.addSubcommand((sub) => sub.setName('check').setDescription('现在就检查一次新片'))
		.addSubcommand((sub) =>
			sub
				.setName('recommend')
				.setDescription('随机推荐一部你没看过的电影（每天 3 部，想看 / 看过了会写进 Trakt）')
				.addIntegerOption((option) => option.setName('genre').setDescription('只在这个类型里挑').addChoices(...picks.GENRES.map(([value, name]) => ({ name, value }))))
				.addIntegerOption((option) => option.setName('decade').setDescription('只挑这个年代的').addChoices(...picks.DECADES.map((decade) => ({ name: `${decade} 年代`, value: decade }))))
				.addIntegerOption((option) => option.setName('max_runtime').setDescription('最长片长（分钟）').setMinValue(30).setMaxValue(600)),
		)
		.setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
		.setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel),

	async execute(interaction) {
		if (!moviesEnabled) {
			await interaction.reply({ content: '电影推荐还没有设定好（缺少 TMDB 或 Trakt 的 API key）。', flags: MessageFlags.Ephemeral });
			return;
		}
		const subcommand = interaction.options.getSubcommand();
		if (subcommand === 'recommend') {
			// Public on purpose: the card and its buttons stay in the channel for everyone to see.
			await interaction.deferReply();
			await recommend(interaction);
			return;
		}
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });
		if (subcommand === 'subscribe') {await subscribe(interaction);}
		else if (subcommand === 'status') {await status(interaction);}
		else if (subcommand === 'check') {await check(interaction);}
		else {
			await store.unsubscribe(interaction.user.id);
			await interaction.editReply('已停止每日推荐。网站上的观影档案和统计还在，想再收推荐随时 `/movie subscribe`。');
		}
	},
};
