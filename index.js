// Require the necessary discord.js classes
const fs = require('node:fs');
const path = require('node:path');
const cron = require('node-cron');
const { Client, Collection, Events, GatewayIntentBits, MessageFlags, Partials } = require('discord.js');
const { getPortfolioSnapshot, createPortfolioEmbed } = require('./services/portfolio');
const { extractTikTokUrls, isOnlyTikTokUrls, downloadTikTok } = require('./services/tiktok');

const statusNotifyUserId = process.env.MASTER_ID || process.env.DISCORD_STATUS_NOTIFY_USER_ID;
const statusNotificationCooldownMs = 3 * 60 * 60 * 1000;
// Requires the privileged Message Content intent to be enabled in the Developer Portal.
const tiktokDownloadEnabled = process.env.TIKTOK_DOWNLOAD === 'true';
const maxConcurrentTikTokDownloads = 2;
const clientIntents = [GatewayIntentBits.Guilds];
const clientPartials = [];
if (statusNotifyUserId) {
	clientIntents.push(GatewayIntentBits.GuildPresences);
}
if (tiktokDownloadEnabled) {
	clientIntents.push(
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.DirectMessages,
		GatewayIntentBits.MessageContent,
	);
	// DM channels are not cached, so they arrive as partials.
	clientPartials.push(Partials.Channel);
}

// Create a new client instance
const client = new Client({ intents: clientIntents, partials: clientPartials });
let activeTikTokDownloads = 0;
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
	if (tiktokDownloadEnabled) {
		console.log('TikTok auto-download is enabled.');
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

// Bot upload limit follows the server boost tier; DMs and unboosted servers allow 10 MB.
function getUploadLimitBytes(guild) {
	const limitMb = { 2: 50, 3: 100 }[guild?.premiumTier] ?? 10;
	return Math.floor(limitMb * 1000 * 1000 * 0.98);
}

// The original link message may get deleted, so the caption carries the sharer and the link.
function formatTikTokCaption(video, message, url) {
	const title = video.title.length > 300 ? `${video.title.slice(0, 300)}…` : video.title;
	const lines = [video.uploader ? `**@${video.uploader}**` : null, title || null];
	const sharer = message.guild ? `<@${message.author.id}> 分享 · ` : '';
	lines.push(`-# ${sharer}<${url}>${video.compressed ? ' · 原片超过上传上限，已压缩' : ''}`);
	return lines.filter(Boolean).join('\n');
}

const tiktokStageText = {
	downloading: '⬇️ 下载中…',
	compressing: '🗜️ 影片超过上传上限，压缩中…',
};

// Replies with a status message, edits it as the job progresses, then turns it into the video.
// Returns true once the video has been posted.
async function replyWithTikTokVideo(message, url) {
	const status = await message.reply({
		content: '🔍 收到链接，解析中…',
		allowedMentions: { repliedUser: false },
	});

	// Serialize edits so a slow edit can't land after a newer one.
	let pendingEdit = Promise.resolve();
	const setStatus = (content) => {
		pendingEdit = pendingEdit
			.then(() => status.edit(content))
			.catch((error) => console.warn('TikTok status edit failed:', error.message));
		return pendingEdit;
	};

	let video;
	try {
		video = await downloadTikTok(url, getUploadLimitBytes(message.guild), (stage) =>
			setStatus(tiktokStageText[stage]),
		);
		await setStatus('⬆️ 上传中…');
		await status.edit({
			content: formatTikTokCaption(video, message, url),
			files: [{ attachment: video.filePath, name: 'tiktok.mp4' }],
			allowedMentions: { parse: [] },
		});
		return true;
	}
	catch (error) {
		console.warn(`TikTok download failed for ${url}:`, error.message);
		await pendingEdit;
		await setStatus('❌ TikTok 影片解析失败了 😢');
		return false;
	}
	finally {
		await video?.cleanup();
	}
}

if (tiktokDownloadEnabled) {
	client.on(Events.MessageCreate, async (message) => {
		if (message.author.bot) return;

		const allUrls = extractTikTokUrls(message.content);
		const urls = allUrls.slice(0, 3);
		if (!urls.length || activeTikTokDownloads >= maxConcurrentTikTokDownloads) return;

		activeTikTokDownloads += 1;
		try {
			let allPosted = true;
			for (const url of urls) {
				const posted = await replyWithTikTokVideo(message, url).catch((error) => {
					console.warn(`TikTok status reply failed for ${url}:`, error.message);
					return false;
				});
				allPosted &&= posted;
			}

			// Only delete when every link was posted and the message had nothing else in it.
			// Needs Manage Messages in servers; bots can never delete a user's DM messages.
			const handledAll = allPosted && urls.length === allUrls.length;
			if (handledAll && message.deletable && isOnlyTikTokUrls(message.content)) {
				await message
					.delete()
					.catch((error) => console.warn('Failed to delete TikTok link message:', error.message));
			}
		}
		finally {
			activeTikTokDownloads -= 1;
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
