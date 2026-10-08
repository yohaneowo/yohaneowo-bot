const {
	SlashCommandBuilder,
	ApplicationIntegrationType,
	ChannelType,
	InteractionContextType,
	MessageFlags,
	PermissionFlagsBits,
} = require('discord.js');
const { createHub } = require('../../services/voiceHubs');

const DEFAULT_HUB_NAME = '➕ 建立语音频道';

module.exports = {
	// Global so it works in every server the bot is in (not only GUILD_ID); server-only.
	global: true,
	data: new SlashCommandBuilder()
		.setName('voice-hub')
		.setDescription('建立动态语音入口：有人进入就开一个新的语音频道并移过去')
		.addStringOption((option) =>
			option.setName('name').setDescription(`入口频道名称（默认「${DEFAULT_HUB_NAME}」）`).setMaxLength(100),
		)
		.addChannelOption((option) =>
			option
				.setName('category')
				.setDescription('放在哪个分类（默认是目前频道所在的分类）')
				.addChannelTypes(ChannelType.GuildCategory),
		)
		.setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
		.setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
		.setContexts(InteractionContextType.Guild),

	async execute(interaction) {
		const name = interaction.options.getString('name')?.trim() || DEFAULT_HUB_NAME;
		const current = interaction.channel?.isThread() ? interaction.channel.parent : interaction.channel;
		const parent = interaction.options.getChannel('category') ?? current?.parent ?? null;

		try {
			const hub = await createHub(interaction.guild, { name, parent });
			await interaction.reply({
				content: `已建立 ${hub}。有人进入时会开一个新的语音频道并移过去，新频道没人后 10 秒自动删除。\n不需要时直接删除 ${hub} 即可。`,
				flags: MessageFlags.Ephemeral,
			});
		}
		catch (error) {
			console.warn('[voice] Could not create a hub:', error.message);
			await interaction.reply({
				content: '建立失败，请确认 bot 有「管理频道」权限。',
				flags: MessageFlags.Ephemeral,
			});
		}
	},
};
