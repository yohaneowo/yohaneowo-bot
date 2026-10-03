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
			const embed = createPortfolioEmbed(snapshot, 'Portfolio Snapshot');
			await interaction.editReply({ embeds: [embed] });
		}
		catch (error) {
			console.error(error);
			await interaction.editReply({ content: `Portfolio query failed: ${error.message}` });
		}
	},
};
