const {
	SlashCommandBuilder,
	ApplicationIntegrationType,
	InteractionContextType,
	MessageFlags,
	PermissionFlagsBits,
} = require('discord.js');
const picks = require('../../services/anime/picks');

// The bot's owner (the application's owner, or its team's members): only they may grant.
async function isOwner(interaction) {
	const application = await interaction.client.application.fetch();
	const owner = application.owner;
	if (!owner) return false;
	const ids = owner.members ? [...owner.members.keys()] : [owner.id];
	return ids.includes(interaction.user.id);
}

// /anime-bonus: the owner adds bonus picks to someone's /anime recommend (100 to start, never
// reset by the day). A negative amount takes some back. Hidden from non-admins in servers.
module.exports = {
	global: true,
	data: new SlashCommandBuilder()
		.setName('anime-bonus')
		.setDescription('（站长）给某人加动漫推荐的奖励次数')
		.addUserOption((option) => option.setName('user').setDescription('给谁').setRequired(true))
		.addIntegerOption((option) => option.setName('amount').setDescription('加几次（负数是扣回）').setRequired(true).setMinValue(-10000).setMaxValue(10000))
		.setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
		.setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
		.setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel),

	async execute(interaction) {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });
		if (!(await isOwner(interaction).catch(() => false))) {
			await interaction.editReply('只有站长能用这个指令。');
			return;
		}
		const target = interaction.options.getUser('user', true);
		const amount = interaction.options.getInteger('amount', true);
		try {
			const result = await picks.grantBonus(target.id, amount);
			console.info(`[anime] Bonus for ${target.id}: ${amount >= 0 ? '+' : ''}${amount} → ${result.bonus}`);
			await interaction.editReply({
				content: `${amount >= 0 ? '已给' : '已从'} <@${target.id}> ${amount >= 0 ? '加' : '扣回'} ${Math.abs(amount)} 次奖励次数，现在共有 ${result.bonus} 次。`,
				allowedMentions: { parse: [] },
			});
		}
		catch (error) {
			if (/HTTP 404/.test(error?.message ?? '')) {
				await interaction.editReply({ content: `<@${target.id}> 还没有观影档案，没办法加次数。`, allowedMentions: { parse: [] } });
				return;
			}
			console.warn('[anime] Bonus failed:', error.message);
			await interaction.editReply('加次数失败了，请稍后再试。');
		}
	},
};
