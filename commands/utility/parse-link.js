const {
	ContextMenuCommandBuilder,
	ApplicationCommandType,
	ApplicationIntegrationType,
	InteractionContextType,
	MessageFlags,
} = require('discord.js');
const { SUPPORTED_SITES, extractMediaUrls } = require('../../services/media');
const { postMediaForInteraction } = require('../../services/mediaPost');

module.exports = {
	// Registered globally so it can be used as a user-installed app (e.g. in DMs with friends).
	global: true,
	data: new ContextMenuCommandBuilder()
		.setName('解析链接')
		.setType(ApplicationCommandType.Message)
		.setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
		.setContexts(
			InteractionContextType.Guild,
			InteractionContextType.BotDM,
			InteractionContextType.PrivateChannel,
		),

	async execute(interaction) {
		const urls = extractMediaUrls(interaction.targetMessage.content).slice(0, 3);
		if (!urls.length) {
			await interaction.reply({
				content: `这条消息里没有支持的链接。目前支持：${SUPPORTED_SITES.map((site) => site.name).join('、')}`,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		await postMediaForInteraction(interaction, urls);
	},
};
