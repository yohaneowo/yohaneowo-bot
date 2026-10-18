const {
	SlashCommandBuilder,
	ApplicationIntegrationType,
	InteractionContextType,
	MessageFlags,
} = require('discord.js');
const { moviesEnabled } = require('../../services/movies/recommender');
const picks = require('../../services/anime/picks');

// /anime recommend: one anime a day ×3 from the person's taste (admin's anime_recommend.py).
// Whether this season's airing anime are included is the website's account setting; the
// airing option here asks for airing ones only.
async function recommend(interaction) {
	const filters = {
		genre: interaction.options.getString('genre') ?? undefined,
		decade: interaction.options.getInteger('decade') ?? undefined,
		format: interaction.options.getString('format') ?? undefined,
		length: interaction.options.getString('length') ?? undefined,
		airing: interaction.options.getBoolean('airing') ?? false,
	};
	try {
		const { payload, pickId } = await picks.recommend(interaction.user.id, filters, (text) => interaction.editReply(text));
		const message = await interaction.editReply(payload);
		picks.rememberMessage(pickId, message);
	}
	catch (error) {
		const text = picks.explain(error);
		if (!text) {
			console.warn('[anime] Recommend failed:', error.message);
			await interaction.editReply('推荐失败了，请稍后再试。');
			return;
		}
		await interaction.editReply(text);
	}
}

module.exports = {
	global: true,
	data: new SlashCommandBuilder()
		.setName('anime')
		.setDescription('根据你的追番记录推荐动漫')
		.addSubcommand((sub) =>
			sub
				.setName('recommend')
				.setDescription('随机推荐一部你没看过的动漫（每天 3 部，想看 / 看过了会写进 Trakt）')
				.addStringOption((option) => option.setName('genre').setDescription('只在这个类型里挑').addChoices(...picks.GENRES.map(([value, name]) => ({ name, value }))))
				.addIntegerOption((option) => option.setName('decade').setDescription('只挑这个年代的').addChoices(...picks.DECADES.map((decade) => ({ name: `${decade} 年代`, value: decade }))))
				.addStringOption((option) => option.setName('format').setDescription('电视版、剧场版或网络版').addChoices(...picks.FORMATS.map(([value, name]) => ({ name, value }))))
				.addStringOption((option) => option.setName('length').setDescription('长度').addChoices(...picks.LENGTHS.map(([value, name]) => ({ name, value }))))
				.addBooleanOption((option) => option.setName('airing').setDescription('只要本季新番（不受网站设定影响）')),
		)
		.setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
		.setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel),

	async execute(interaction) {
		if (!moviesEnabled) {
			await interaction.reply({ content: '推荐还没有设定好（缺少 TMDB 或 Trakt 的 API key）。', flags: MessageFlags.Ephemeral });
			return;
		}
		// Public on purpose: the card and its buttons stay in the channel, like /movie recommend.
		await interaction.deferReply();
		await recommend(interaction);
	},
};
