const {
	SlashCommandBuilder,
	ApplicationIntegrationType,
	InteractionContextType,
} = require('discord.js');
const { getFeature } = require('../../services/botReport');

// /report <link>: for a problem there is no bot message to point at (the bot never answered, or the message
// was deleted). The link has to be one this user asked the bot to parse recently, otherwise the report is
// only kept and not queued for reproduction.
module.exports = {
	global: true,
	data: new SlashCommandBuilder()
		.setName('report')
		.setDescription('回报 bot 的问题（bot 没有回覆、或原讯息已经删了的时候用）')
		.addStringOption((option) =>
			option.setName('url').setDescription('出问题的链接').setRequired(true).setMaxLength(2048),
		)
		.setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
		.setContexts(
			InteractionContextType.Guild,
			InteractionContextType.BotDM,
			InteractionContextType.PrivateChannel,
		),

	async execute(interaction) {
		await getFeature().handleCommand(interaction);
	},
};
