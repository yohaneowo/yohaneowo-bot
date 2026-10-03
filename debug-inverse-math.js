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
	console.log(JSON.stringify(positions.map((p) => {
		const contracts = Number(p.contracts ?? p.size ?? 0);
		const markPrice = Number(p.markPrice ?? 0);
		const contractSize = Number(p.contractSize ?? 1);
		const coinQty = Math.abs(contracts) * contractSize / (markPrice || 1);
		const usdByCoin = coinQty * (markPrice || 1);
		return {
			symbol: p.symbol,
			contracts,
			size: p.size,
			markPrice,
			contractSize,
			notional: p.notional,
			positionValue: p.positionValue,
			coinQty,
			usdByCoin,
		};
	}), null, 2));
})();
