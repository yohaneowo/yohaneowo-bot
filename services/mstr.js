// Strategy (MSTR) data from strategy.com's public dashboard API.
// netBtcPerShareUsd is the BTC NAV per share left for common holders after debt and
// preferred claims (cash added back), so price / netBtcPerShareUsd is the net common-stock mNAV.
// btcPerShareUsd is the gross figure (all BTC, nothing deducted).
const MSTR_KPI_URL = 'https://api.strategy.com/btc/mstrKpiData';
const BITCOIN_KPI_URL = 'https://api.strategy.com/btc/bitcoinKpis';

function parseNumber(value) {
	const num = Number(String(value ?? '').replace(/,/g, ''));
	return Number.isFinite(num) ? num : NaN;
}

async function fetchJson(url) {
	const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
	if (!response.ok) {
		throw new Error(`${url} returned HTTP ${response.status}`);
	}
	return response.json();
}

async function fetchMstrMnav() {
	try {
		const [mstrPayload, bitcoinPayload] = await Promise.all([
			fetchJson(MSTR_KPI_URL),
			fetchJson(BITCOIN_KPI_URL),
		]);
		const mstr = mstrPayload?.[0];
		const bitcoin = bitcoinPayload?.results;

		const price = parseNumber(mstr?.price);
		const netBtcPerShare = parseNumber(bitcoin?.netBtcPerShareUsd);
		if (!(price > 0) || !(netBtcPerShare > 0)) {
			throw new Error('MSTR price or net BTC per share is missing or invalid');
		}

		const grossBtcPerShare = parseNumber(bitcoin?.btcPerShareUsd);

		return {
			mnav: price / netBtcPerShare,
			grossMnav: grossBtcPerShare > 0 ? price / grossBtcPerShare : NaN,
			evMnav: parseNumber(bitcoin?.mNav),
			price,
			priceChangePercent: parseNumber(mstr?.priceVarPerc),
			netBtcPerShare,
			btcHoldings: parseNumber(bitcoin?.btcHoldings),
		};
	}
	catch (error) {
		console.warn('Failed to fetch MSTR mNAV:', error.message);
		return null;
	}
}

function formatMstrMnav(data) {
	const change = Number.isFinite(data.priceChangePercent)
		? `（${data.priceChangePercent > 0 ? '+' : ''}${data.priceChangePercent.toFixed(2)}%）`
		: '';
	const lines = [
		`**${data.mnav.toFixed(2)}x** · MSTR $${data.price.toFixed(2)}${change} / 每股净 BTC $${data.netBtcPerShare.toFixed(2)}`,
	];

	const references = [];
	if (Number.isFinite(data.grossMnav)) {
		references.push(`毛值 ${data.grossMnav.toFixed(2)}x`);
	}
	if (Number.isFinite(data.evMnav)) {
		references.push(`官方 EV ${data.evMnav.toFixed(2)}x`);
	}
	if (Number.isFinite(data.btcHoldings)) {
		references.push(`持有 ${Math.round(data.btcHoldings).toLocaleString('en-US')} BTC`);
	}
	if (references.length) {
		lines.push(references.join(' · '));
	}

	return lines.join('\n');
}

module.exports = {
	fetchMstrMnav,
	formatMstrMnav,
};
