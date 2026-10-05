const { SlashCommandBuilder } = require('discord.js');
const { getPortfolioSnapshot, createPortfolioEmbed } = require('../../services/portfolio');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('portfolio')
		.setDescription('Check total asset value across your exchange accounts.')
		.addStringOption((option) =>
			option
				.setName('exchange')
				.setDescription('Choose the exchange to query')
				.addChoices(
					{ name: 'All', value: 'all' },
					{ name: 'Binance', value: 'binance' },
					{ name: 'Bybit', value: 'bybit' },
					{ name: 'Pionex', value: 'pionex' },
				)
				.setRequired(false),
		),

	async execute(interaction) {
		const exchange = interaction.options.getString('exchange') || 'all';
		await interaction.deferReply();

		try {
			const snapshot = await getPortfolioSnapshot(exchange);
			const titles = {
				all: '全部资产快照',
				binance: '币安资产快照',
				bybit: 'Bybit 资产快照',
				pionex: '派网资产快照',
			};
			const embed = createPortfolioEmbed(
				snapshot,
				titles[exchange] ?? '资产快照',
				interaction.user.displayAvatarURL({ size: 256 }),
			);
			await interaction.editReply({ embeds: [embed] });
		}
		catch (error) {
			console.error(error);
			await interaction.editReply({ content: `Portfolio query failed: ${error.message}` });
		}
	},
};
