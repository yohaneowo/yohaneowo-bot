const fs = require('node:fs');
const path = require('node:path');
const { ChannelType, Events } = require('discord.js');

// "Join to create" voice channels. A hub is a voice channel limited to one person: whoever joins
// it gets a new voice channel of their own (no user limit) and is moved there. Those rooms are
// deleted after staying empty for EMPTY_DELETE_MS.
// Hub and room ids (with their guild ids) are kept in a JSON file so both survive restarts.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'voice-hubs.json');
const EMPTY_DELETE_MS = 10 * 1000;

// channel id -> guild id
const hubs = new Map();
const rooms = new Map();
const deleteTimers = new Map();

function loadStore() {
	try {
		const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
		for (const [id, guildId] of Object.entries(data.hubs ?? {})) hubs.set(id, guildId);
		for (const [id, guildId] of Object.entries(data.rooms ?? {})) rooms.set(id, guildId);
	}
	catch (error) {
		if (error.code !== 'ENOENT') console.warn('[voice] Could not read the voice hub store:', error.message);
	}
}

function saveStore() {
	try {
		fs.mkdirSync(DATA_DIR, { recursive: true });
		const data = { hubs: Object.fromEntries(hubs), rooms: Object.fromEntries(rooms) };
		// Write then rename, so a crash mid-write never leaves a half-written file.
		const tempPath = `${STORE_PATH}.tmp`;
		fs.writeFileSync(tempPath, JSON.stringify(data, null, '\t'));
		fs.renameSync(tempPath, STORE_PATH);
	}
	catch (error) {
		console.warn('[voice] Could not save the voice hub store:', error.message);
	}
}

function cancelDelete(channelId) {
	clearTimeout(deleteTimers.get(channelId));
	deleteTimers.delete(channelId);
}

function forget(channelId) {
	cancelDelete(channelId);
	const wasHub = hubs.delete(channelId);
	const wasRoom = rooms.delete(channelId);
	if (wasHub || wasRoom) saveStore();
}

async function createHub(guild, { name, parent }) {
	const hub = await guild.channels.create({
		name,
		type: ChannelType.GuildVoice,
		parent: parent ?? null,
		userLimit: 1,
	});
	hubs.set(hub.id, guild.id);
	saveStore();
	console.log(`[voice] Created hub "${hub.name}" in ${guild.name}`);
	return hub;
}

// Deletes a room once it has stayed empty for EMPTY_DELETE_MS; anyone joining meanwhile cancels it.
function scheduleDelete(room) {
	if (deleteTimers.has(room.id)) return;
	deleteTimers.set(
		room.id,
		setTimeout(async () => {
			deleteTimers.delete(room.id);
			const current = room.guild.channels.cache.get(room.id);
			if (!current) {
				forget(room.id);
				return;
			}
			if (current.members.size > 0) return;
			await current
				.delete('Dynamic voice channel stayed empty')
				.then(() => console.log(`[voice] Deleted empty room "${current.name}"`))
				.catch((error) => console.warn(`[voice] Could not delete room "${current.name}":`, error.message));
		}, EMPTY_DELETE_MS),
	);
}

// Opens a room next to the hub (same category, so it inherits its permissions) and moves the member in.
async function openRoomFor(member, hub) {
	const room = await hub.guild.channels.create({
		name: `${member.displayName} 的频道`,
		type: ChannelType.GuildVoice,
		parent: hub.parentId,
	});
	rooms.set(room.id, hub.guild.id);
	saveStore();
	console.log(`[voice] Opened room "${room.name}" from hub "${hub.name}"`);

	try {
		await member.voice.setChannel(room);
	}
	catch (error) {
		// They left the hub before the move: the room is empty, so let it expire.
		console.warn(`[voice] Could not move ${member.displayName} into "${room.name}":`, error.message);
		scheduleDelete(room);
	}
}

function handleVoiceStateUpdate(oldState, newState) {
	// Mute, deafen, streaming etc. also fire this event without changing channels.
	if (oldState.channelId === newState.channelId) return;

	if (newState.channelId && rooms.has(newState.channelId)) {
		cancelDelete(newState.channelId);
	}
	if (oldState.channel && rooms.has(oldState.channelId) && oldState.channel.members.size === 0) {
		scheduleDelete(oldState.channel);
	}
	if (newState.channel && hubs.has(newState.channelId) && newState.member) {
		openRoomFor(newState.member, newState.channel).catch((error) =>
			console.warn(`[voice] Could not open a room from hub "${newState.channel.name}":`, error.message),
		);
	}
}

// Catches up on what happened while the bot was offline: rooms left empty get deleted, people
// waiting in a hub get their room, and channels deleted meanwhile are forgotten.
function resumeAfterRestart(client) {
	for (const [channelId, guildId] of [...hubs, ...rooms]) {
		const guild = client.guilds.cache.get(guildId);
		// An unavailable guild (Discord outage) still has its channels; check again next restart.
		if (guild && !guild.available) continue;
		const channel = guild?.channels.cache.get(channelId);
		if (!channel) {
			forget(channelId);
			continue;
		}
		if (rooms.has(channelId) && channel.members.size === 0) {
			scheduleDelete(channel);
		}
		if (hubs.has(channelId)) {
			for (const member of channel.members.values()) {
				openRoomFor(member, channel).catch((error) =>
					console.warn(`[voice] Could not open a room from hub "${channel.name}":`, error.message),
				);
			}
		}
	}
}

// Needs the GuildVoiceStates intent.
function setupVoiceHubs(client) {
	loadStore();
	client.once(Events.ClientReady, () => resumeAfterRestart(client));
	client.on(Events.VoiceStateUpdate, handleVoiceStateUpdate);
	client.on(Events.ChannelDelete, (channel) => forget(channel.id));
}

module.exports = {
	setupVoiceHubs,
	createHub,
};
