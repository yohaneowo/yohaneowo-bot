const {
	SlashCommandBuilder,
	ApplicationIntegrationType,
	InteractionContextType,
	MessageFlags,
} = require('discord.js');
const { SUPPORTED_SITES, findSupportedSite } = require('../../services/media');
const { postMediaForInteraction } = require('../../services/mediaPost');

module.exports = {
	// Registered globally so it can be used as a user-installed app (e.g. in DMs with friends).
	global: true,
	data: new SlashCommandBuilder()
		.setName('x')
		.setDescription('解析链接并上传影片')
		.addStringOption((option) =>
			option.setName('url').setDescription('影片链接').setRequired(true),
		)
		.setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
		.setContexts(
			InteractionContextType.Guild,
			InteractionContextType.BotDM,
			InteractionContextType.PrivateChannel,
		),

	async execute(interaction) {
		const url = interaction.options.getString('url').trim();
		if (!findSupportedSite(url)) {
			await interaction.reply({
				content: `不支持这个链接。目前支持：${SUPPORTED_SITES.map((site) => site.name).join('、')}`,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		await postMediaForInteraction(interaction, [url]);
	},
};
