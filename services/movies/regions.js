// Regions a subscriber can pick for /movie subscribe (TMDB's cinema listings are per country).
// Built from Intl's region names, so every ISO 3166 country is searchable by Chinese name (simplified
// or traditional: most subscribers in Taiwan / Hong Kong type traditional), English name or code.
// The ones most subscribers want are listed first.
const PRIORITY = ['TW', 'MY', 'JP', 'HK', 'MO', 'SG', 'KR', 'CN', 'US', 'GB', 'CA', 'AU'];
// Codes Intl knows that aren't countries (or have no cinema listings of their own).
const EXCLUDED = new Set(['EU', 'EZ', 'UN', 'ZZ', 'QO', 'XA', 'XB', 'AC', 'CP', 'DG', 'EA', 'IC', 'TA']);
// Shorter than Intl's official names ("中国香港特别行政区").
const SHORT_NAMES = { HK: '香港', MO: '澳门' };
const SHORT_TRADITIONAL_NAMES = { HK: '香港', MO: '澳門' };
// Other common names: Intl's traditional names follow Taiwan usage (南韓, 澳洲), Hong Kong says 韓國.
const ALIASES = { KR: ['韓國', '南韩'], KP: ['朝鮮', '北韩'], AU: ['澳洲'], NZ: ['纽西兰'] };
const MAX_CHOICES = 25;

const chineseNames = new Intl.DisplayNames(['zh-Hans'], { type: 'region', fallback: 'none' });
const traditionalNames = new Intl.DisplayNames(['zh-Hant'], { type: 'region', fallback: 'none' });
const englishNames = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });

function flag(code) {
	return String.fromCodePoint(...[...code].map((letter) => 0x1f1e6 + letter.charCodeAt(0) - 65));
}

const REGIONS = (() => {
	const regions = [];
	for (let first = 65; first <= 90; first++) {
		for (let second = 65; second <= 90; second++) {
			const code = String.fromCharCode(first, second);
			const name = chineseNames.of(code);
			if (!name || EXCLUDED.has(code)) continue;
			regions.push({
				code,
				name: SHORT_NAMES[code] ?? name,
				traditional: SHORT_TRADITIONAL_NAMES[code] ?? traditionalNames.of(code) ?? '',
				english: englishNames.of(code) ?? '',
				aliases: ALIASES[code] ?? [],
			});
		}
	}
	const rank = (code) => (PRIORITY.includes(code) ? PRIORITY.indexOf(code) : PRIORITY.length);
	return regions.sort((a, b) => rank(a.code) - rank(b.code) || a.code.localeCompare(b.code));
})();
const REGION_CODES = new Set(REGIONS.map((region) => region.code));

function isRegion(code) {
	return REGION_CODES.has(code);
}

// Autocomplete choices for what the user has typed so far (any Chinese name, English name or code).
function regionChoices(query) {
	const text = query.trim().toLowerCase();
	const matches = text
		? REGIONS.filter(
			(region) =>
				region.code.toLowerCase().startsWith(text) ||
				region.name.includes(query.trim()) ||
				region.traditional.includes(query.trim()) ||
				region.aliases.some((alias) => alias.includes(query.trim())) ||
				region.english.toLowerCase().includes(text),
		)
		: REGIONS;
	return matches.slice(0, MAX_CHOICES).map((region) => ({ name: `${flag(region.code)} ${region.name}（${region.code}）`, value: region.code }));
}

function regionLabel(code) {
	const region = REGIONS.find((item) => item.code === code);
	return region ? `${flag(code)} ${region.name}` : code;
}

module.exports = {
	isRegion,
	regionChoices,
	regionLabel,
};
