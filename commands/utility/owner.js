const {
	SlashCommandBuilder,
	ApplicationIntegrationType,
	InteractionContextType,
	MessageFlags,
	PermissionFlagsBits,
} = require('discord.js');
const { movieRequest } = require('../../services/adminApi');

// Features with bonus picks (admin's bonus.FEATURES); add one here when a feature gets a bonus.
const FEATURES = [['anime', '动漫推荐']];
const featureName = (feature) => FEATURES.find(([value]) => value === feature)?.[1] ?? feature;

// The bot's owner (the application's owner, or its team's members): only they may use /owner.
async function isOwner(interaction) {
	const application = await interaction.client.application.fetch();
	const owner = application.owner;
	if (!owner) return false;
	const ids = owner.members ? [...owner.members.keys()] : [owner.id];
	return ids.includes(interaction.user.id);
}

function featureLines(features) {
	return features.map((f) => `• ${featureName(f.feature)}：今天还剩 ${f.remainingToday} / ${f.quota} 次，奖励次数 ${f.bonus} 次`);
}

async function bonus(interaction, target) {
	const feature = interaction.options.getString('feature', true);
	const amount = interaction.options.getInteger('amount', true);
	const result = await movieRequest('POST', `/owner/${encodeURIComponent(target.id)}/bonus`, { feature, amount });
	console.info(`[owner] Bonus for ${target.id} (${feature}): ${amount >= 0 ? '+' : ''}${amount} → ${result.bonus}`);
	const verb = amount >= 0 ? `加了 ${amount}` : `扣回 ${-amount}`;
	return `已给 <@${target.id}> 的${featureName(feature)}${verb} 次奖励次数，现在共有 ${result.bonus} 次。`;
}

async function check(interaction, target) {
	const result = await movieRequest('GET', `/owner/${encodeURIComponent(target.id)}`);
	return [`<@${target.id}>（Trakt：${result.traktName ?? result.traktUser}）`, ...featureLines(result.features ?? [])].join('\n');
}

// /owner: the owner's tools. bonus adds (or takes back) bonus picks of a feature; check shows
// someone's quotas. Hidden from non-admins in servers, and checked against the owner when run.
module.exports = {
	global: true,
	data: new SlashCommandBuilder()
		.setName('owner')
		.setDescription('（站长）管理用户的次数')
		.addSubcommand((sub) =>
			sub
				.setName('bonus')
				.setDescription('给某人某个功能加奖励次数（负数是扣回）')
				.addUserOption((option) => option.setName('user').setDescription('给谁').setRequired(true))
				.addStringOption((option) => option.setName('feature').setDescription('哪个功能').setRequired(true).addChoices(...FEATURES.map(([value, name]) => ({ name, value }))))
				.addIntegerOption((option) => option.setName('amount').setDescription('加几次（负数是扣回）').setRequired(true).setMinValue(-10000).setMaxValue(10000)),
		)
		.addSubcommand((sub) =>
			sub
				.setName('check')
				.setDescription('查某人各功能今天剩几次、奖励次数还有多少')
				.addUserOption((option) => option.setName('user').setDescription('查谁').setRequired(true)),
		)
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
		const run = interaction.options.getSubcommand() === 'bonus' ? bonus : check;
		try {
			await interaction.editReply({ content: await run(interaction, target), allowedMentions: { parse: [] } });
		}
		catch (error) {
			if (/HTTP 404/.test(error?.message ?? '')) {
				await interaction.editReply({ content: `<@${target.id}> 还没有观影档案。`, allowedMentions: { parse: [] } });
				return;
			}
			console.warn('[owner] Failed:', error.message);
			await interaction.editReply('操作失败了，请稍后再试。');
		}
	},
};
