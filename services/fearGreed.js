const FEAR_GREED_URL = 'https://api.alternative.me/fng/?limit=2';

const CLASSIFICATIONS = {
	'Extreme Fear': { label: '极度恐惧', emoji: '😱' },
	Fear: { label: '恐惧', emoji: '😨' },
	Neutral: { label: '中性', emoji: '😐' },
	Greed: { label: '贪婪', emoji: '😏' },
	'Extreme Greed': { label: '极度贪婪', emoji: '🤑' },
};

async function fetchFearGreedIndex() {
	try {
		const response = await fetch(FEAR_GREED_URL, { signal: AbortSignal.timeout(10000) });
		if (!response.ok) {
			throw new Error(`alternative.me returned HTTP ${response.status}`);
		}

		const payload = await response.json();
		const [today, yesterday] = payload?.data ?? [];
		const value = Number(today?.value);
		if (!Number.isFinite(value)) {
			throw new Error('Fear & Greed data is missing or invalid');
		}

		const previousValue = Number(yesterday?.value);
		return {
			value,
			classification: today.value_classification,
			previousValue: Number.isFinite(previousValue) ? previousValue : null,
		};
	}
	catch (error) {
		console.warn('Failed to fetch Fear & Greed index:', error.message);
		return null;
	}
}

function formatFearGreed(fearGreed) {
	const { label, emoji } = CLASSIFICATIONS[fearGreed.classification] ?? {
		label: fearGreed.classification,
		emoji: '📊',
	};
	const lines = [`${emoji} **${fearGreed.value}** · ${label}`];

	if (fearGreed.previousValue !== null) {
		const diff = fearGreed.value - fearGreed.previousValue;
		const arrow = diff > 0 ? '↑' : diff < 0 ? '↓' : '→';
		lines.push(`昨日 ${fearGreed.previousValue}（${arrow}${Math.abs(diff)}）`);
	}

	return lines.join('\n');
}

module.exports = {
	fetchFearGreedIndex,
	formatFearGreed,
};
