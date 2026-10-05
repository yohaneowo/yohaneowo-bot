// Require the necessary discord.js classes
const fs = require('node:fs');
const path = require('node:path');
const cron = require('node-cron');
const { Client, Collection, Events, GatewayIntentBits, MessageFlags } = require('discord.js');
const { getPortfolioSnapshot, createPortfolioEmbed } = require('./services/portfolio');

const statusNotifyUserId = process.env.MASTER_ID || process.env.DISCORD_STATUS_NOTIFY_USER_ID;
const statusNotificationCooldownMs = 3 * 60 * 60 * 1000;
const clientIntents = [GatewayIntentBits.Guilds];
if (statusNotifyUserId) {
	clientIntents.push(GatewayIntentBits.GuildPresences);
}

// Create a new client instance
const client = new Client({ intents: clientIntents });
let lastStatusNotificationAt = 0;
let isSendingStatusNotification = false;

async function sendDailyPortfolioReport() {
	const channelId = process.env.PORTFOLIO_CHANNEL_ID;
	if (!channelId) {
		console.warn('PORTFOLIO_CHANNEL_ID is not set. Daily portfolio report is disabled.');
		return;
	}

	try {
		const channel = await client.channels.fetch(channelId);
		if (!channel || !channel.isTextBased()) {
			console.warn(`Channel ${channelId} is not a valid text channel.`);
			return;
		}

		const snapshot = await getPortfolioSnapshot('all');
		const embed = createPortfolioEmbed(
			snapshot,
			'每日资产报告',
			client.user.displayAvatarURL({ size: 256 }),
		);
		await channel.send({ embeds: [embed] });
		console.log('Daily portfolio report sent.');
	}
	catch (error) {
		console.error('Failed to send daily portfolio report:', error);
	}
}

// When the client is ready, run this code (only once).
// The distinction between `client: Client<boolean>` and `readyClient: Client<true>` is important for TypeScript developers.
// It makes some properties non-nullable.
client.once(Events.ClientReady, async (readyClient) => {
	console.log(`Ready! Logged in as ${readyClient.user.tag}`);
	if (statusNotifyUserId) {
		console.log('Idle-to-online DM notifications are enabled.');
	}

	const cronExpression = process.env.PORTFOLIO_CRON || '0 9 * * *';
	cron.schedule(
		cronExpression,
		async () => {
			await sendDailyPortfolioReport();
		},
		{ timezone: 'Asia/Shanghai' },
	);

	if (process.env.SEND_PORTFOLIO_ON_BOOT === 'true') {
		await sendDailyPortfolioReport();
	}
});

if (statusNotifyUserId) {
	client.on(Events.PresenceUpdate, async (oldPresence, newPresence) => {
		if (
			newPresence?.userId !== statusNotifyUserId ||
			oldPresence?.status !== 'idle' ||
			newPresence.status !== 'online' ||
			isSendingStatusNotification ||
			Date.now() - lastStatusNotificationAt < statusNotificationCooldownMs
		) {
			return;
		}

		isSendingStatusNotification = true;
		try {
			const user = await client.users.fetch(statusNotifyUserId);
			const snapshot = await getPortfolioSnapshot('all');
			const embed = createPortfolioEmbed(
				snapshot,
				'全部资产快照',
				user.displayAvatarURL({ size: 256 }),
			);
			await user.send({ embeds: [embed] });
			lastStatusNotificationAt = Date.now();
			console.log('Idle-to-online ALL portfolio DM sent.');
		}
		catch (error) {
			console.warn('Failed to send idle-to-online DM notification:', error.message);
		}
		finally {
			isSendingStatusNotification = false;
		}
	});
}

client.commands = new Collection();
const foldersPath = path.join(__dirname, 'commands');
const commandFolders = fs.readdirSync(foldersPath);
for (const folder of commandFolders) {
	const commandsPath = path.join(foldersPath, folder);
	const commandFiles = fs.readdirSync(commandsPath).filter((file) => file.endsWith('.js'));
	for (const file of commandFiles) {
		const filePath = path.join(commandsPath, file);
		const command = require(filePath);
		// Set a new item in the Collection with the key as the command name and the value as the exported module
		if ('data' in command && 'execute' in command) {
			client.commands.set(command.data.name, command);
		}
		else {
			console.log(
				`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`,
			);
		}
	}
}

client.on(Events.InteractionCreate, async (interaction) => {
	if (!interaction.isChatInputCommand()) return;
	const command = interaction.client.commands.get(interaction.commandName);

	if (!command) {
		console.error(`No command matching ${interaction.commandName} was found.`);
		return;
	}

	try {
		await command.execute(interaction);
	}
	catch (error) {
		console.error(error);
		if (interaction.replied || interaction.deferred) {
			await interaction.followUp({
				content: 'There was an error while executing this command!',
				flags: MessageFlags.Ephemeral,
			});
		}
		else {
			await interaction.reply({
				content: 'There was an error while executing this command!',
				flags: MessageFlags.Ephemeral,
			});
		}
	}
});
// Log in to Discord with your client's token
client.login(process.env.TOKEN);
