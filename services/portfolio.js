const ccxt = require('ccxt');
const { EmbedBuilder } = require('discord.js');

const EXCHANGE_MAP = {
	binance: { envPrefix: 'BINANCE' },
	bybit: { envPrefix: 'BYBIT' },
	pionex: { envPrefix: 'PIONEX' },
};

function safeNumber(value) {
	const num = Number(value);
	return Number.isFinite(num) ? num : 0;
}

function formatCurrency(value) {
	return Number(value).toLocaleString('en-US', {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});
}

function makeExchangeClient(exchangeName) {
	const normalizedName = String(exchangeName).toLowerCase();
	const exchangeClass = ccxt[normalizedName];

	if (!exchangeClass) {
		throw new Error(`Unsupported exchange: ${exchangeName}`);
	}

	const envPrefix = EXCHANGE_MAP[normalizedName]?.envPrefix;
	const client = new exchangeClass({
		enableRateLimit: true,
		timeout: 10000,
	});

	if (envPrefix) {
		const apiKey = process.env[`${envPrefix}_API_KEY`];
		const secret = process.env[`${envPrefix}_SECRET`];
		const passphrase = process.env[`${envPrefix}_PASSPHRASE`];

		if (apiKey) client.apiKey = apiKey;
		if (secret) client.secret = secret;
		if (passphrase) client.password = passphrase;
	}

	return client;
}

async function fetchUsdtToTwdRate() {
	const fallbackRate = 32.7;
	const urls = [
		'https://max-api.maicoin.com/api/v1/markets/USDTTWD/ticker',
		'https://max-api.maicoin.com/api/v1/ticker?pair=USDT_TWD',
		'https://max-api.maicoin.com/api/v1/markets/USDTTWD/ticker',
	];

	for (const url of urls) {
		try {
			if (typeof fetch !== 'function') continue;
			const response = await fetch(url);
			if (!response.ok) continue;
			const data = await response.json();
			const rate = safeNumber(
				data?.last ??
				data?.price ??
				data?.ticker?.last ??
				data?.data?.last ??
				data?.result?.last,
			);
			if (rate > 0) {
				return rate;
			}
		}
		catch {
			// Try the next URL if one fails.
		}
	}

	return fallbackRate;
}

async function estimateAssetValue(exchange, asset, amount) {
	const normalizedAsset = String(asset).toUpperCase();
	const numericAmount = safeNumber(amount);

	if (numericAmount <= 0) {
		return 0;
	}

	const stableCoins = new Set(['USDT', 'USDC', 'BUSD', 'TUSD', 'FDUSD', 'DAI']);
	if (stableCoins.has(normalizedAsset)) {
		return numericAmount;
	}

	const candidates = [`${normalizedAsset}/USDT`, `${normalizedAsset}/USD`, `${normalizedAsset}/USDC`];

	for (const symbol of candidates) {
		try {
			const ticker = await exchange.fetchTicker(symbol);
			const price = safeNumber(ticker?.last ?? ticker?.close ?? ticker?.bid ?? ticker?.ask);
			if (price > 0) {
				return numericAmount * price;
			}
		}
		catch {
			// Ignore unsupported symbols and continue.
		}
	}

	return 0;
}

async function fetchSpotPortfolio(exchangeName) {
	const client = makeExchangeClient(exchangeName);
	await client.loadMarkets();

	const balance = await client.fetchBalance();
	const allAssets = balance?.total ?? {};
	const holdings = [];
	let totalValue = 0;

	for (const [asset, rawTotal] of Object.entries(allAssets)) {
		const amount = safeNumber(rawTotal);
		if (!amount || amount <= 0) continue;

		const normalizedAsset = String(asset).toUpperCase();
		const value = await estimateAssetValue(client, normalizedAsset, amount);
		if (value > 0) {
			totalValue += value;
			holdings.push({
				asset: normalizedAsset,
				amount,
				value,
			});
		}
	}

	holdings.sort((a, b) => b.value - a.value);

	return {
		exchange: exchangeName,
		type: 'spot',
		total: Number(totalValue.toFixed(2)),
		holdings,
		generatedAt: new Date().toISOString(),
	};
}

async function fetchCoinWalletEquity(exchangeName) {
	const client = makeExchangeClient(exchangeName);
	await client.loadMarkets();

	const balanceCandidates = [
		{ type: 'delivery' },
		{ type: 'inverse' },
		{ type: 'swap', subType: 'inverse' },
		{ type: 'future', subType: 'inverse' },
		{},
	];

	let wallet = null;
	for (const params of balanceCandidates) {
		try {
			const candidate = await client.fetchBalance(params);
			if (candidate && candidate.total && Object.keys(candidate.total).length > 0) {
				wallet = candidate;
				break;
			}
		}
		catch {
			// Try the next balance shape.
		}
	}

	if (!wallet) {
		return { total: 0, holdings: [] };
	}

	const holdings = [];
	let totalValue = 0;
	for (const [asset, rawTotal] of Object.entries(wallet.total ?? {})) {
		const amount = safeNumber(rawTotal);
		if (!amount || amount <= 0) continue;

		const normalizedAsset = String(asset).toUpperCase();
		const stableCoins = new Set(['USDT', 'USDC', 'BUSD', 'TUSD', 'FDUSD', 'DAI']);
		const value = stableCoins.has(normalizedAsset)
			? amount
			: await estimateAssetValue(client, normalizedAsset, amount);

		if (value > 0) {
			totalValue += value;
			holdings.push({
				asset: normalizedAsset,
				amount,
				value,
			});
		}
	}

	return {
		exchange: exchangeName,
		type: 'coin-wallet',
		total: Number(totalValue.toFixed(2)),
		holdings,
		generatedAt: new Date().toISOString(),
	};
}

function getFuturesPositionQueries(exchangeName) {
	const normalizedName = String(exchangeName).toLowerCase();

	if (normalizedName === 'binance') {
		return [
			{ type: 'usdt', params: { type: 'future', subType: 'linear' } },
			{ type: 'coin', params: { type: 'future', subType: 'inverse' } },
		];
	}

	if (normalizedName === 'bybit') {
		return [
			{ type: 'usdt', params: { type: 'linear' } },
			{ type: 'coin', params: { type: 'inverse' } },
		];
	}

	return [{ type: 'unknown', params: {} }];
}

function getPositionNotional(position) {
	const directNotional = safeNumber(
		position?.notional ??
		position?.info?.notionalValue ??
		position?.info?.notional ??
		position?.positionValue ??
		position?.info?.positionValue,
	);
	if (directNotional > 0) {
		return directNotional;
	}

	const size = safeNumber(position?.contracts ?? position?.info?.positionAmt ?? position?.size ?? 0);
	const markPrice = safeNumber(position?.markPrice ?? position?.info?.markPrice ?? position?.lastPrice ?? 0);
	const contractSize = safeNumber(position?.contractSize ?? position?.info?.contractSize ?? 1);
	const symbolText = String(position?.symbol ?? position?.info?.symbol ?? '').toUpperCase();

	if (size === 0 || markPrice <= 0) {
		return 0;
	}

	if (/USD|USDT|PERP/i.test(symbolText) && /USD|PERP/i.test(symbolText) && !/USDT/i.test(symbolText)) {
		return Math.abs(size) * contractSize / markPrice;
	}

	return Math.abs(size) * markPrice;
}

async function fetchFuturesPortfolio(exchangeName) {
	const client = makeExchangeClient(exchangeName);
	await client.loadMarkets();

	const holdings = [];
	let totalValue = 0;
	let usdtMaturedValue = 0;
	let coinMaturedValue = 0;
	let coinExposureValue = 0;

	const queries = getFuturesPositionQueries(exchangeName);

	for (const query of queries) {
		try {
			const positions = await client.fetchPositions(undefined, query.params);
			for (const position of positions ?? []) {
				const size = safeNumber(position?.contracts ?? position?.info?.positionAmt ?? position?.size ?? 0);
				const markPrice = safeNumber(position?.markPrice ?? position?.info?.markPrice ?? position?.lastPrice ?? 0);
				if (size === 0 || markPrice <= 0) continue;

				const notional = getPositionNotional(position);
				if (notional <= 0) continue;

				totalValue += notional;
				if (query.type === 'coin') {
					coinMaturedValue += notional;
					coinExposureValue += notional;
				}
				else {
					usdtMaturedValue += notional;
				}

				holdings.push({
					asset: String(position?.symbol ?? 'UNKNOWN').toUpperCase(),
					amount: size,
					value: Number(notional.toFixed(2)),
					marginType: query.type,
				});
			}
		}
		catch (error) {
			console.warn(`Futures position query failed for ${exchangeName} (${query.type}):`, error.message);
		}
	}

	return {
		exchange: exchangeName,
		type: 'futures',
		total: Number(totalValue.toFixed(2)),
		usdtTotal: Number(usdtMaturedValue.toFixed(2)),
		coinTotal: Number(coinMaturedValue.toFixed(2)),
		coinExposureTotal: Number(coinExposureValue.toFixed(2)),
		holdings,
		generatedAt: new Date().toISOString(),
	};
}

async function getPortfolioSnapshot(exchangeName = 'all') {
	const targets =
		exchangeName === 'all' ? Object.keys(EXCHANGE_MAP) : [String(exchangeName).toLowerCase()];

	const results = [];
	let spotTotal = 0;
	let futuresTotal = 0;
	let futuresUsdtTotal = 0;
	let futuresCoinTotal = 0;
	let futuresCoinExposureTotal = 0;
	let coinWalletTotal = 0;

	for (const target of targets) {
		try {
			const spotPortfolio = await fetchSpotPortfolio(target);
			results.push(spotPortfolio);
			spotTotal += spotPortfolio.total;
		}
		catch (error) {
			console.warn(`Spot portfolio unavailable for ${target}:`, error.message);
		}

		try {
			const futuresPortfolio = await fetchFuturesPortfolio(target);
			results.push(futuresPortfolio);
			futuresTotal += futuresPortfolio.total;
			futuresUsdtTotal += futuresPortfolio.usdtTotal;
			futuresCoinTotal += futuresPortfolio.coinTotal;
			futuresCoinExposureTotal += futuresPortfolio.coinExposureTotal;
		}
		catch (error) {
			console.warn(`Futures portfolio unavailable for ${target}:`, error.message);
		}

		try {
			const coinWalletPortfolio = await fetchCoinWalletEquity(target);
			results.push(coinWalletPortfolio);
			coinWalletTotal += coinWalletPortfolio.total;
		}
		catch (error) {
			console.warn(`Coin wallet equity unavailable for ${target}:`, error.message);
		}
	}

	const twdRate = await fetchUsdtToTwdRate();
	const totalUsdt = Number((spotTotal + futuresUsdtTotal + coinWalletTotal).toFixed(2));
	const totalTwd = Number((totalUsdt * twdRate).toFixed(2));

	return {
		exchanges: results,
		spotTotal: Number(spotTotal.toFixed(2)),
		futuresTotal: Number(futuresTotal.toFixed(2)),
		futuresUsdtTotal: Number(futuresUsdtTotal.toFixed(2)),
		futuresCoinTotal: Number(futuresCoinTotal.toFixed(2)),
		futuresCoinExposureTotal: Number(futuresCoinExposureTotal.toFixed(2)),
		coinWalletTotal: Number(coinWalletTotal.toFixed(2)),
		total: totalUsdt,
		twdRate: Number(twdRate.toFixed(4)),
		totalTwd: totalTwd,
		generatedAt: new Date().toISOString(),
	};
}

function createPortfolioEmbed(snapshot, title = 'Portfolio Snapshot') {
	const embed = new EmbedBuilder()
		.setColor(0x5865f2)
		.setTitle(title)
		.setDescription(
			`Updated: ${new Date(snapshot.generatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
		);

	if (!snapshot?.exchanges?.length) {
		return embed.addFields({
			name: 'Status',
			value: 'No exchange data available.',
			inline: false,
		});
	}

	for (const item of snapshot.exchanges) {
		if (!item) continue;
		const name = `${String(item.exchange || 'Unknown').toUpperCase()} ${String(item.type || 'unknown').toUpperCase()}`;
		const value = `USDT ${formatCurrency(item.total ?? 0)}`;
		embed.addFields({
			name,
			value,
			inline: true,
		});
	}

	embed.addFields({
		name: 'SPOT TOTAL',
		value: `USDT ${formatCurrency(snapshot.spotTotal ?? 0)}`,
		inline: false,
	});

	embed.addFields({
		name: 'USDT 本位合约',
		value: `USDT ${formatCurrency(snapshot.futuresUsdtTotal ?? 0)}`,
		inline: false,
	});

	embed.addFields({
		name: '币本位钱包权益',
		value: `USDT ${formatCurrency(snapshot.coinWalletTotal ?? 0)}`,
		inline: false,
	});

	embed.addFields({
		name: '币本位名义价值',
		value: `USDT ${formatCurrency(snapshot.futuresCoinExposureTotal ?? 0)}`,
		inline: false,
	});

	embed.addFields({
		name: 'FUTURES TOTAL',
		value: `USDT ${formatCurrency(snapshot.futuresTotal ?? 0)}`,
		inline: false,
	});

	embed.addFields({
		name: 'TOTAL (USDT)',
		value: `USDT ${formatCurrency(snapshot.total ?? 0)}`,
		inline: false,
	});

	embed.addFields({
		name: 'TOTAL (TWD)',
		value: `TWD ${formatCurrency(snapshot.totalTwd ?? 0)}\nRate: 1 USDT = ${formatCurrency(snapshot.twdRate ?? 32.7)} TWD`,
		inline: false,
	});

	return embed;
}

module.exports = {
	EXCHANGE_MAP,
	getPortfolioSnapshot,
	createPortfolioEmbed,
};
