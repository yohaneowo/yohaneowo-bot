const { AsyncLocalStorage } = require('node:async_hooks');
const { aiGatewayRequest, adminApiEnabled } = require('./adminApi');

// Every AI API call (Claude, Voyage…) goes through yohaneowo-admin's gateway: admin holds the keys,
// calls the provider and writes the AI调用日志 itself (which feature, model, tokens, time, and whose
// cost it is). Whose cost: code that acts for someone wraps the work in withAiCaller(); calls
// outside any caller, or explicitly in SYSTEM_CALLER, are shared costs (e.g. vectors for new movies
// that every subscriber reuses) and land on "system".
const PROJECT = 'yohaneowo-bot';
const SYSTEM_CALLER = { platform: 'system' };

const callerScope = new AsyncLocalStorage();

// caller: { platform: 'discord' | 'line' | 'system', id, name, avatarUrl, trigger: 'daily' | 'command' | … }
function withAiCaller(caller, fn) {
	return callerScope.run(caller, fn);
}

// kind: 'messages' (Claude Messages API body) or 'embeddings' (Voyage body). The body goes to the
// provider unchanged. Resolves to { status, body }: the provider's status (null when unreachable).
function callAi(kind, { feature, body, timeoutMs }) {
	const caller = callerScope.getStore() ?? SYSTEM_CALLER;
	return aiGatewayRequest(`/${kind}`, {
		project: PROJECT,
		feature,
		caller: {
			platform: caller.platform,
			id: caller.platform === 'system' ? null : caller.id ?? null,
			name: caller.name ?? null,
			avatar_url: caller.avatarUrl ?? null,
			trigger: caller.trigger ?? null,
		},
		body,
	}, timeoutMs);
}

module.exports = {
	SYSTEM_CALLER,
	withAiCaller,
	callAi,
	aiEnabled: adminApiEnabled,
};
