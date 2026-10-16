const { callAi, aiEnabled } = require('../aiUsage');

// The movie features' Claude calls, through admin's AI gateway: admin holds the key and records
// every call (failures too: they're billed) under whichever caller the code runs for (aiUsage.js).
const REQUEST_TIMEOUT_MS = 130 * 1000;

// Resolves to the parsed response body.
async function callClaude({ model, system, prompt, feature, maxTokens, tools }) {
	const { status, body: payload } = await callAi('messages', {
		feature,
		timeoutMs: REQUEST_TIMEOUT_MS,
		body: {
			model,
			max_tokens: maxTokens,
			system,
			...(tools ? { tools, tool_choice: { type: 'auto' } } : {}),
			messages: [{ role: 'user', content: prompt }],
		},
	});
	if (status == null) throw new Error('Anthropic API unreachable');
	if (status < 200 || status >= 300) {
		throw new Error(`Anthropic API returned HTTP ${status}: ${payload?.error?.message ?? 'no details'}`);
	}
	return payload;
}

// A call answered through a tool, for JSON. Newer models don't accept a forced tool_choice, so the
// prompt has to ask for the tool. Resolves to the tool's input.
async function callTool({ tool, ...options }) {
	const payload = await callClaude({ ...options, tools: [tool] });
	const input = payload.content?.find((block) => block.type === 'tool_use' && block.name === tool.name)?.input;
	if (!input) {
		const preamble = payload.content?.find((block) => block.type === 'text')?.text ?? '';
		if (preamble) console.warn(`[movie] AI wrote ${preamble.length} characters instead of calling ${tool.name}`);
		throw new Error(`AI answered without calling ${tool.name} (stop_reason ${payload.stop_reason})`);
	}
	return input;
}

// A plain text answer.
async function callText(options) {
	const payload = await callClaude(options);
	const text = (payload.content ?? [])
		.filter((block) => block.type === 'text')
		.map((block) => block.text)
		.join('')
		.trim();
	if (!text) throw new Error(`AI gave no text (stop_reason ${payload.stop_reason})`);
	return text;
}

module.exports = {
	aiEnabled,
	callTool,
	callText,
};
