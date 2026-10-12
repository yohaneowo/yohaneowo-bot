const { AsyncLocalStorage } = require('node:async_hooks');
const { reportAiCall } = require('./adminApi');

// Records every AI API call (Claude, Voyage…) for yohaneowo-admin's AI调用日志: which feature,
// which model, how many tokens, how long, and whose cost it is. The admin prices the tokens.
// Whose cost: code that acts for someone wraps the work in withAiCaller(); calls outside any
// caller, or explicitly in SYSTEM_CALLER, are shared costs (e.g. vectors for new movies that
// every subscriber reuses) and land on "system".
const PROJECT = 'yohaneowo-bot';
const SYSTEM_CALLER = { platform: 'system' };

const callerScope = new AsyncLocalStorage();

// caller: { platform: 'discord' | 'line' | 'system', id, name, avatarUrl, trigger: 'daily' | 'command' | … }
function withAiCaller(caller, fn) {
	return callerScope.run(caller, fn);
}

// usage: { input, output, cacheRead, cacheWrite } token counts as the API reported them.
function recordAiCall({ feature, provider, model, usage = {}, durationMs, error }) {
	const caller = callerScope.getStore() ?? SYSTEM_CALLER;
	reportAiCall({
		project: PROJECT,
		feature,
		provider,
		model,
		trigger: caller.trigger ?? null,
		user_platform: caller.platform,
		user_external_id: caller.platform === 'system' ? null : caller.id ?? null,
		user_name: caller.name ?? null,
		user_avatar_url: caller.avatarUrl ?? null,
		input_tokens: usage.input ?? 0,
		output_tokens: usage.output ?? 0,
		cache_read_tokens: usage.cacheRead ?? 0,
		cache_write_tokens: usage.cacheWrite ?? 0,
		duration_ms: durationMs == null ? null : Math.round(durationMs),
		success: !error,
		error_message: error ? String(error.message ?? error) : null,
	});
}

module.exports = {
	SYSTEM_CALLER,
	withAiCaller,
	recordAiCall,
};
