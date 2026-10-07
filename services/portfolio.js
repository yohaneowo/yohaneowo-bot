const ccxt = require('ccxt');
const crypto = require('node:crypto');
const { EmbedBuilder } = require('discord.js');
const { fetchFearGreedIndex, formatFearGreed } = require('./fearGreed');
const { fetchMstrMnav, formatMstrMnav } = require('./mstr');

const EXCHANGE_MAP = {
	binance: { envPrefix: 'BINANCE', inverseBalanceParams: { type: 'delivery' } },
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

function formatUsdtAndTwd(value, rate, includeRate = false) {
	const lines = [`USDT ${formatCurrency(value)}`];
	if (value >= 1) {
		const rateText = includeRate ? ` (1 USDT = ${formatCurrency(rate)} TWD)` : '';
		lines.push(`TWD ${formatCurrency(value * rate)}${rateText}`);
	}
	return lines.join('\n');
}

function addAssetField(embed, name, value, rate, details = []) {
	const amount = safeNumber(value);
	if (amount < 1) return;

	embed.addFields({
		name,
		value: [formatUsdtAndTwd(amount, rate), ...details].join('\n'),
		inline: false,
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
	const fallbackRate = 31.809;

	try {
		const response = await fetch('https://max-api.maicoin.com/api/v2/tickers');
		if (!response.ok) {
			throw new Error(`MAX API returned HTTP ${response.status}`);
		}

		const data = await response.json();
		const ticker = data?.usdttwd;
		const rate = safeNumber(ticker?.buy ?? ticker?.last ?? ticker?.sell);
		if (rate > 0) {
			return rate;
		}
		throw new Error('MAX USDT/TWD ticker is missing or invalid');
	}
	catch (error) {
		console.warn(`Failed to fetch MAX USDT/TWD rate; using fallback ${fallbackRate}:`, error.message);
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

	const exchangeSpecificCandidates =
		exchange.id === 'binance' && normalizedAsset === 'EQ_MSTR' ? ['MSTRB/USDT'] : [];
	const candidates = [
		...exchangeSpecificCandidates,
		`${normalizedAsset}/USDT`,
		`${normalizedAsset}/USD`,
		`${normalizedAsset}/USDC`,
	];

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

async function fetchBybitFundingPortfolio() {
	const client = makeExchangeClient('bybit');
	await client.loadMarkets();

	const balance = await client.fetchBalance({ type: 'funding' });
	const holdings = [];
	let totalValue = 0;

	for (const [asset, rawTotal] of Object.entries(balance?.total ?? {})) {
		const amount = safeNumber(rawTotal);
		if (amount <= 0) continue;

		const normalizedAsset = String(asset).toUpperCase();
		const value = await estimateAssetValue(client, normalizedAsset, amount);
		if (value <= 0) continue;

		totalValue += value;
		holdings.push({
			asset: normalizedAsset,
			amount,
			value,
		});
	}

	return {
		exchange: 'bybit',
		type: 'funding',
		total: Number(totalValue.toFixed(2)),
		holdings,
		generatedAt: new Date().toISOString(),
	};
}

async function fetchBinanceFundingPortfolio() {
	const client = makeExchangeClient('binance');
	await client.loadMarkets();

	const balance = await client.fetchBalance({ type: 'funding' });
	const holdings = [];
	let totalValue = 0;

	for (const [asset, rawTotal] of Object.entries(balance?.total ?? {})) {
		const amount = safeNumber(rawTotal);
		if (amount <= 0) continue;

		const normalizedAsset = String(asset).toUpperCase();
		const value = await estimateAssetValue(client, normalizedAsset, amount);
		if (value <= 0) continue;

		totalValue += value;
		holdings.push({
			asset: normalizedAsset,
			amount,
			value,
		});
	}

	return {
		exchange: 'binance',
		type: 'funding',
		total: Number(totalValue.toFixed(2)),
		holdings,
		generatedAt: new Date().toISOString(),
	};
}

async function fetchPionexPortfolio() {
	const apiKey = process.env.PIONEX_API_KEY;
	const secret = process.env.PIONEX_SECRET;
	if (!apiKey || !secret) {
		throw new Error('PIONEX_API_KEY and PIONEX_SECRET must be configured');
	}

	const path = '/api/v1/wallet/balancesFull';
	const query = `timestamp=${Date.now()}`;
	const signature = crypto
		.createHmac('sha256', secret)
		.update(`GET${path}?${query}`)
		.digest('hex');
	const response = await fetch(`https://api.pionex.com${path}?${query}`, {
		headers: {
			'PIONEX-KEY': apiKey,
			'PIONEX-SIGNATURE': signature,
		},
	});
	if (!response.ok) {
		throw new Error(`Pionex API returned HTTP ${response.status}`);
	}

	const payload = await response.json();
	if (!payload?.result) {
		throw new Error(`Pionex API error ${payload?.code ?? 'UNKNOWN'}: ${payload?.message ?? 'Request failed'}`);
	}

	const data = payload.data ?? {};
	return {
		exchange: 'pionex',
		type: 'account',
		total: safeNumber(data.totalInUsdt),
		botAccountTotal: safeNumber(data.botAccount?.totalInUsdt),
		traderAccountTotal: safeNumber(data.traderAccount?.totalInUsdt),
		generatedAt: new Date().toISOString(),
	};
}

async function fetchInverseContractWalletEquity(exchangeName) {
	const normalizedName = String(exchangeName).toLowerCase();
	const balanceParams = EXCHANGE_MAP[normalizedName]?.inverseBalanceParams;
	if (!balanceParams) {
		throw new Error(`Inverse-contract wallet balance is not configured for ${normalizedName}`);
	}

	const client = makeExchangeClient(normalizedName);
	await client.loadMarkets();

	const wallet = await client.fetchBalance(balanceParams);

	const holdings = [];
	let totalValue = 0;
	const stableCoins = new Set(['USDT', 'USDC', 'BUSD', 'TUSD', 'FDUSD', 'DAI']);
	for (const [asset, rawTotal] of Object.entries(wallet.total ?? {})) {
		const amount = safeNumber(rawTotal);
		if (!amount || amount <= 0) continue;

		const normalizedAsset = String(asset).toUpperCase();
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
		exchange: normalizedName,
		type: 'inverse-contract-wallet',
		total: Number(totalValue.toFixed(2)),
		holdings,
		generatedAt: new Date().toISOString(),
	};
}

async function fetchBybitEarnPortfolio() {
	const client = makeExchangeClient('bybit');
	await client.loadMarkets();

	const holdings = [];
	let totalValue = 0;
	for (const category of ['FlexibleSaving', 'OnChain']) {
		try {
			const response = await client.privateGetV5EarnPosition({ category });
			for (const position of response?.result?.list ?? []) {
				const amount = safeNumber(position?.amount);
				if (amount <= 0) continue;

				const asset = String(position?.coin ?? '').toUpperCase();
				if (!asset) continue;

				const value = await estimateAssetValue(client, asset, amount);
				if (value <= 0) continue;

				totalValue += value;
				holdings.push({
					asset,
					amount,
					value,
					category,
				});
			}
		}
		catch (error) {
			console.warn(`Bybit Earn ${category} positions unavailable:`, error.message);
		}
	}

	return {
		exchange: 'bybit',
		type: 'earn',
		total: Number(totalValue.toFixed(2)),
		holdings,
		generatedAt: new Date().toISOString(),
	};
}

async function fetchBinanceEarnPortfolio() {
	const client = makeExchangeClient('binance');
	await client.loadMarkets();

	const holdings = [];
	let totalValue = 0;
	const earnTypes = [
		{ category: 'flexible', method: 'sapiGetSimpleEarnFlexiblePosition' },
		{ category: 'locked', method: 'sapiGetSimpleEarnLockedPosition' },
	];

	for (const earnType of earnTypes) {
		let current = 1;
		const pageSize = 100;
		while (true) {
			const response = await client[earnType.method]({ current, size: pageSize });
			const positions = response?.rows ?? [];
			for (const position of positions) {
				const amount = safeNumber(position?.totalAmount);
				const asset = String(position?.asset ?? '').toUpperCase();
				if (amount <= 0 || !asset) continue;

				const value = await estimateAssetValue(client, asset, amount);
				if (value <= 0) continue;

				totalValue += value;
				holdings.push({
					asset,
					amount,
					value,
					category: earnType.category,
				});
			}

			const totalPositions = safeNumber(response?.total);
			if (positions.length < pageSize || current * pageSize >= totalPositions) break;
			current += 1;
		}
	}

	return {
		exchange: 'binance',
		type: 'earn',
		total: Number(totalValue.toFixed(2)),
		holdings,
		generatedAt: new Date().toISOString(),
	};
}

function getFuturesPositionQueries(exchangeName) {
	const normalizedName = String(exchangeName).toLowerCase();

	if (normalizedName === 'binance') {
		return [{ type: 'usdt', params: { type: 'future', subType: 'linear' } }];
	}

	if (normalizedName === 'bybit') {
		return [{ type: 'usdt', params: { type: 'linear' } }];
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
				usdtMaturedValue += notional;

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
	let inverseContractWalletTotal = 0;
	let earnTotal = 0;
	let fundingTotal = 0;
	let pionexTotal = 0;
	let pionexBotAccountTotal = 0;
	let pionexTraderAccountTotal = 0;

	for (const target of targets) {
		if (target !== 'pionex') {
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
			}
			catch (error) {
				console.warn(`Futures portfolio unavailable for ${target}:`, error.message);
			}
		}

		if (target === 'pionex') {
			try {
				const pionexPortfolio = await fetchPionexPortfolio();
				results.push(pionexPortfolio);
				pionexTotal += pionexPortfolio.total;
				pionexBotAccountTotal += pionexPortfolio.botAccountTotal;
				pionexTraderAccountTotal += pionexPortfolio.traderAccountTotal;
			}
			catch (error) {
				console.warn('Pionex account balance unavailable:', error.message);
			}
		}

		if (target === 'bybit') {
			try {
				const fundingPortfolio = await fetchBybitFundingPortfolio();
				results.push(fundingPortfolio);
				fundingTotal += fundingPortfolio.total;
			}
			catch (error) {
				console.warn('Bybit Funding account unavailable:', error.message);
			}

			try {
				const earnPortfolio = await fetchBybitEarnPortfolio();
				results.push(earnPortfolio);
				earnTotal += earnPortfolio.total;
			}
			catch (error) {
				console.warn('Bybit Earn portfolio unavailable:', error.message);
			}
		}

		if (target === 'binance') {
			try {
				const fundingPortfolio = await fetchBinanceFundingPortfolio();
				results.push(fundingPortfolio);
				fundingTotal += fundingPortfolio.total;
			}
			catch (error) {
				console.warn('Binance Funding account unavailable:', error.message);
			}

			try {
				const earnPortfolio = await fetchBinanceEarnPortfolio();
				results.push(earnPortfolio);
				earnTotal += earnPortfolio.total;
			}
			catch (error) {
				console.warn('Binance Earn portfolio unavailable:', error.message);
			}
		}

		if (EXCHANGE_MAP[target]?.inverseBalanceParams) {
			try {
				const inverseContractPortfolio = await fetchInverseContractWalletEquity(target);
				results.push(inverseContractPortfolio);
				inverseContractWalletTotal += inverseContractPortfolio.total;
			}
			catch (error) {
				console.warn(`${target} inverse-contract wallet unavailable:`, error.message);
			}
		}
	}

	const [twdRate, fearGreed, mstrMnav] = await Promise.all([
		fetchUsdtToTwdRate(),
		fetchFearGreedIndex(),
		fetchMstrMnav(),
	]);
	const totalUsdt = Number((spotTotal + futuresUsdtTotal + inverseContractWalletTotal + earnTotal + fundingTotal + pionexTotal).toFixed(2));
	const totalTwd = Number((totalUsdt * twdRate).toFixed(2));

	return {
		exchanges: results,
		spotTotal: Number(spotTotal.toFixed(2)),
		futuresTotal: Number(futuresTotal.toFixed(2)),
		futuresUsdtTotal: Number(futuresUsdtTotal.toFixed(2)),
		inverseContractWalletTotal: Number(inverseContractWalletTotal.toFixed(2)),
		earnTotal: Number(earnTotal.toFixed(2)),
		fundingTotal: Number(fundingTotal.toFixed(2)),
		pionexTotal: Number(pionexTotal.toFixed(2)),
		pionexBotAccountTotal: Number(pionexBotAccountTotal.toFixed(2)),
		pionexTraderAccountTotal: Number(pionexTraderAccountTotal.toFixed(2)),
		total: totalUsdt,
		twdRate: Number(twdRate.toFixed(4)),
		fearGreed,
		mstrMnav,
		totalTwd: totalTwd,
		generatedAt: new Date().toISOString(),
	};
}

function createPortfolioEmbed(snapshot, title = '资产快照', avatarUrl) {
	const embed = new EmbedBuilder()
		.setColor(0x5865f2)
		.setTitle(title)
		.setDescription(
			`Updated: ${new Date(snapshot.generatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
		);
	if (avatarUrl) {
		embed.setThumbnail(avatarUrl);
	}

	if (!snapshot?.exchanges?.length) {
		return embed.addFields({
			name: 'Status',
			value: 'No exchange data available.',
			inline: false,
		});
	}

	const twdRate = snapshot.twdRate ?? 32.7;
	if (snapshot.fearGreed) {
		embed.addFields({
			name: '恐惧贪婪指数',
			value: formatFearGreed(snapshot.fearGreed),
			inline: false,
		});
	}
	if (snapshot.mstrMnav) {
		embed.addFields({
			name: 'MSTR mNAV（普通股·扣除优先求偿）',
			value: formatMstrMnav(snapshot.mstrMnav),
			inline: false,
		});
	}

	addAssetField(embed, '现货资产', snapshot.spotTotal, twdRate);
	addAssetField(embed, '资金账户资产', snapshot.fundingTotal, twdRate);
	addAssetField(embed, '派网机器人账户', snapshot.pionexBotAccountTotal, twdRate);
	addAssetField(embed, '派网交易账户', snapshot.pionexTraderAccountTotal, twdRate);

	addAssetField(embed, '理财资产', snapshot.earnTotal, twdRate);
	addAssetField(embed, 'U本位合约资产', snapshot.futuresUsdtTotal, twdRate);
	addAssetField(embed, '币本位合约资产', snapshot.inverseContractWalletTotal, twdRate);

	embed.addFields({
		name: 'TOTAL',
		value: formatUsdtAndTwd(snapshot.total ?? 0, twdRate, true),
		inline: false,
	});

	return embed;
}

module.exports = {
	EXCHANGE_MAP,
	getPortfolioSnapshot,
	createPortfolioEmbed,
};
