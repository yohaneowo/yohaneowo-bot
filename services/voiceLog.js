const { Events } = require('discord.js');
const { adminApiEnabled, reportVoiceSession } = require('./adminApi');
const { isHub } = require('./voiceHubs');

// Records who was in which voice channel for the admin's 语音记录 page: one entry per continuous
// stay in one channel, reported when it ends (leaving, switching channel, or the bot shutting down).
// Bots aren't recorded, and neither are /voice-hub entrances: people are moved out of those within
// a second, so the stay starts in the room they're moved to. Off unless the admin API is set up.

// `${guildId}:${userId}` -> the open stay
const openStays = new Map();

function stayKey(state) {
	return `${state.guild.id}:${state.id}`;
}

function open(state, joinedEstimated = false) {
	if (!state.channel || isHub(state.channelId) || state.member?.user.bot) return;
	openStays.set(stayKey(state), {
		guildId: state.guild.id,
		channelId: state.channelId,
		channelName: state.channel.name,
		userId: state.id,
		userName: state.member?.displayName ?? null,
		// The server-specific avatar when they set one, like Discord shows in that server.
		userAvatarUrl: state.member?.displayAvatarURL({ size: 64 }) ?? null,
		joinedAt: new Date(),
		joinedEstimated,
	});
}

function close(key, reason) {
	const stay = openStays.get(key);
	if (!stay) return;
	openStays.delete(key);
	const leftAt = new Date();
	reportVoiceSession({
		guild_external_id: stay.guildId,
		channel_external_id: stay.channelId,
		channel_name: stay.channelName,
		user_external_id: stay.userId,
		user_name: stay.userName,
		user_avatar_url: stay.userAvatarUrl,
		joined_at: stay.joinedAt.toISOString(),
		joined_time_estimated: stay.joinedEstimated,
		left_at: leftAt.toISOString(),
		duration_seconds: Math.round((leftAt - stay.joinedAt) / 1000),
		end_reason: reason,
	});
}

function handleVoiceStateUpdate(oldState, newState) {
	// Mute, deafen, streaming etc. also fire this event without changing channels.
	if (oldState.channelId === newState.channelId) return;
	close(stayKey(oldState), newState.channelId ? 'move' : 'leave');
	open(newState);
}

// Whoever is already in voice when the bot starts gets a stay starting now, flagged as estimated.
function openCurrentStays(client) {
	for (const guild of client.guilds.cache.values()) {
		for (const state of guild.voiceStates.cache.values()) {
			if (!openStays.has(stayKey(state))) open(state, true);
		}
	}
}

// Needs the GuildVoiceStates intent.
function setupVoiceLog(client) {
	if (!adminApiEnabled) return;
	client.once(Events.ClientReady, () => openCurrentStays(client));
	client.on(Events.VoiceStateUpdate, handleVoiceStateUpdate);
	// adminApi's own SIGTERM/SIGINT handler sends the queue and exits; it sends whatever is queued
	// while it runs, so the stays closed here still go out.
	for (const signal of ['SIGTERM', 'SIGINT']) {
		process.once(signal, () => {
			for (const key of [...openStays.keys()]) close(key, 'restart');
		});
	}
}

module.exports = {
	setupVoiceLog,
};
