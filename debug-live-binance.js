const ccxt = require('ccxt');

(async () => {
	const ex = new ccxt.binance({
		enableRateLimit: true,
		timeout: 20000,
		apiKey: process.env.BINANCE_API_KEY,
		secret: process.env.BINANCE_SECRET,
		password: process.env.BINANCE_PASSPHRASE,
	});

	const positions = await ex.fetchPositions(undefined, { type: 'future', subType: 'inverse' });
	console.log('BINANCE_INVERSE_COUNT', Array.isArray(positions) ? positions.length : 0);

	if (Array.isArray(positions)) {
		for (const p of positions) {
			console.log(JSON.stringify({
				symbol: p.symbol,
				contracts: p.contracts,
				size: p.size,
				markPrice: p.markPrice,
				notional: p.notional,
				positionValue: p.positionValue,
				infoNotional: p.info && p.info.notionalValue,
				infoPositionAmt: p.info && p.info.positionAmt,
				marginType: p.marginType || (p.info && p.info.marginType),
			}, null, 2));
		}
	}
})();
