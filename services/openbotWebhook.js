const crypto = require('node:crypto');

// The signed webhook every hand-off to OpenBot uses (magnet links, bot feedback reports): HMAC-SHA256 (hex)
// over "<timestamp>.<delivery id>.<body>" in three x-openbot-* headers. The caller picks the event type
// and the delivery id; OpenBot drops a delivery id it has already seen.
const DEFAULT_TIMEOUT_MS = 10 * 1000;
const DEFAULT_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 2000;

function signRequest(secret, timestamp, deliveryId, body) {
	return crypto.createHmac('sha256', secret).update(`${timestamp}.${deliveryId}.${body}`).digest('hex');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// config: { url, secret }. Retries only network errors and 5xx answers; a 4xx answer (bad signature, unknown
// routine, ...) will not get better and is thrown at once with `final` set. Retries share the delivery id.
// Resolves to { status } of the 2xx answer: OpenBot answers 202 when it accepted the event and 200 when it had
// already seen the delivery id (a duplicate: nothing is started), so callers that need a run must check it.
async function postSigned(config, { type, data, deliveryId }, options = {}) {
	const {
		fetchImpl = fetch,
		now = Date.now,
		wait = sleep,
		timeoutMs = DEFAULT_TIMEOUT_MS,
		attempts = DEFAULT_ATTEMPTS,
		retryDelayMs = DEFAULT_RETRY_DELAY_MS,
	} = options;
	const body = JSON.stringify({ type, data });
	let lastError;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		const timestamp = String(Math.floor(now() / 1000));
		try {
			const response = await fetchImpl(config.url, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-openbot-timestamp': timestamp,
					'x-openbot-delivery-id': deliveryId,
					'x-openbot-signature': `sha256=${signRequest(config.secret, timestamp, deliveryId, body)}`,
				},
				body,
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (response.ok) return { status: response.status };
			if (response.status < 500) throw Object.assign(new Error(`webhook answered ${response.status}`), { final: true });
			lastError = new Error(`webhook answered ${response.status}`);
		}
		catch (error) {
			if (error.final) throw error;
			lastError = error;
		}
		if (attempt < attempts) await wait(retryDelayMs);
	}
	throw lastError;
}

module.exports = {
	signRequest,
	postSigned,
};
