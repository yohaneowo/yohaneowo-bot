const { REST, Routes } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

// Commands marked `global: true` (user-installable ones like /x) are registered globally;
// everything else (e.g. /portfolio) stays in GUILD_ID only so other servers never see it.
const guildCommands = [];
const globalCommands = [];
// Grab all the command folders from the commands directory you created earlier
const foldersPath = path.join(__dirname, 'commands');
const commandFolders = fs.readdirSync(foldersPath);

for (const folder of commandFolders) {
	// Grab all the command files from the commands directory you created earlier
	const commandsPath = path.join(foldersPath, folder);
	const commandFiles = fs.readdirSync(commandsPath).filter((file) => file.endsWith('.js'));
	// Grab the SlashCommandBuilder#toJSON() output of each command's data for deployment
	for (const file of commandFiles) {
		const filePath = path.join(commandsPath, file);
		const command = require(filePath);
		if ('data' in command && 'execute' in command) {
			(command.global ? globalCommands : guildCommands).push(command.data.toJSON());
		}
		else {
			console.log(
				`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`,
			);
		}
	}
}

// Construct and prepare an instance of the REST module
const rest = new REST().setToken(process.env.TOKEN);

// and deploy your commands!
(async () => {
	try {
		// The put method fully replaces each scope with the current set
		const guildData = await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
			body: guildCommands,
		});
		console.log(`Reloaded ${guildData.length} guild commands: ${guildData.map((c) => c.name).join(', ')}`);

		const globalData = await rest.put(Routes.applicationCommands(clientId), {
			body: globalCommands,
		});
		console.log(`Reloaded ${globalData.length} global commands: ${globalData.map((c) => c.name).join(', ')}`);
	}
	catch (error) {
		// And of course, make sure you catch and log any errors!
		console.error(error);
	}
})();
