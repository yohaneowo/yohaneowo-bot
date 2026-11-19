const {
	ContextMenuCommandBuilder,
	ApplicationCommandType,
	ApplicationIntegrationType,
	InteractionContextType,
} = require('discord.js');
const { getFeature } = require('../../services/botReport');

// Right-click a message the bot posted → Apps → 回报 bot 问题. The name is not "Report Message": that one is
// Discord's own command for reporting a message to Discord.
module.exports = {
	// Global, like 「解析链接」, so it also works where the bot is installed by a user (DMs with friends).
	global: true,
	data: new ContextMenuCommandBuilder()
		.setName('回报 bot 问题')
		.setType(ApplicationCommandType.Message)
		.setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
		.setContexts(
			InteractionContextType.Guild,
			InteractionContextType.BotDM,
			InteractionContextType.PrivateChannel,
		),

	async execute(interaction) {
		await getFeature().handleContextMenu(interaction);
	},
};
