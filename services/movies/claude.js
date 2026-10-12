const { recordAiCall } = require('../aiUsage');

// The movie features' Claude calls. Every call (failures too: they're billed) is recorded in the
// AI call log through recordAiCall, under whichever caller the code runs for (see aiUsage.js).
const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? '';
const REQUEST_TIMEOUT_MS = 120 * 1000;

// Resolves to the parsed response body.
async function callClaude({ model, system, prompt, feature, maxTokens, tools }) {
	const startedAt = Date.now();
	let payload = null;
	let failure = null;
	try {
		const response = await fetch(API_URL, {
			method: 'POST',
			headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
			body: JSON.stringify({
				model,
				max_tokens: maxTokens,
				system,
				...(tools ? { tools, tool_choice: { type: 'auto' } } : {}),
				messages: [{ role: 'user', content: prompt }],
			}),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		payload = await response.json().catch(() => null);
		if (!response.ok) {
			throw new Error(`Anthropic API returned HTTP ${response.status}: ${payload?.error?.message ?? 'no details'}`);
		}
		return payload;
	}
	catch (error) {
		failure = error;
		throw error;
	}
	finally {
		const usage = payload?.usage ?? {};
		recordAiCall({
			feature,
			provider: 'anthropic',
			model,
			usage: {
				input: usage.input_tokens,
				output: usage.output_tokens,
				cacheRead: usage.cache_read_input_tokens,
				cacheWrite: usage.cache_creation_input_tokens,
			},
			durationMs: Date.now() - startedAt,
			error: failure,
		});
	}
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
	aiEnabled: Boolean(ANTHROPIC_API_KEY),
	callTool,
	callText,
};
