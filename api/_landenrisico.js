// FATF / EU hoog-risico landenlijsten voor Wwft compliance
// Bronnen: FATF Grey & Black list, EU delegated regulation 2016/1675 (bijgewerkt)
// Update deze lijsten periodiek conform FATF plenaire sessies

// FATF Zwarte lijst — Call for Action (hoogste risico)
const FATF_ZWART = [
  'myanmar', 'iran', 'noord-korea', 'north korea', 'dprk'
];

// FATF Grijze lijst — Increased Monitoring (verhoogd risico)
const FATF_GRIJS = [
  'algerije', 'algeria', 'angola', 'bulgarije', 'bulgaria',
  'burkina faso', 'kameroen', 'cameroon', 'congo', 'kroatie', 'croatia',
  'haiti', 'kenia', 'kenya', 'libanon', 'lebanon', 'mali',
  'monaco', 'mozambique', 'namibie', 'namibia',
  'nigeria', 'filipijnen', 'philippines',
  'senegal', 'zuid-afrika', 'south africa', 'zuid-soedan', 'south sudan',
  'syrie', 'syria', 'tanzania', 'venezuela', 'vietnam', 'jemen', 'yemen'
];

// EU hoog-risico derde landen (Delegated Regulation)
const EU_HOOG_RISICO = [
  'afghanistan', 'barbados', 'burkina faso', 'kameroen', 'cameroon',
  'democratische republiek congo', 'democratic republic of congo',
  'gibraltar', 'haiti', 'jamaica', 'jordanie', 'jordan',
  'mali', 'mozambique', 'myanmar', 'nigeria', 'panama',
  'filipijnen', 'philippines', 'senegal',
  'zuid-soedan', 'south sudan', 'syrie', 'syria',
  'trinidad en tobago', 'trinidad and tobago',
  'oeganda', 'uganda', 'vanuatu', 'jemen', 'yemen'
];

// Sanctielanden (EU/VN/OFAC — volledige embargo of zware sancties)
const SANCTIELANDEN = [
  'rusland', 'russia', 'belarus', 'wit-rusland',
  'iran', 'noord-korea', 'north korea', 'dprk',
  'syrie', 'syria', 'cuba', 'myanmar', 'venezuela',
  'afghanistan', 'irak', 'iraq', 'libie', 'libya',
  'somalie', 'somalia', 'soedan', 'sudan', 'jemen', 'yemen',
  'zimbabwe', 'centraal-afrikaanse republiek', 'central african republic',
  'eritrea', 'guinee-bissau', 'guinea-bissau'
];

/**
 * Bepaal landenrisico voor een gegeven land
 * @param {string} land - Landnaam (NL of EN)
 * @returns {{ risico: 'hoog'|'verhoogd'|'laag', categorieen: string[], toelichting: string }}
 */
function bepaalLandenrisico(land) {
  if (!land) return { risico: 'laag', categorieen: [], toelichting: 'Geen land opgegeven.' };

  const norm = land.toLowerCase().trim();
  const nlVarianten = ['nederland', 'nl', 'the netherlands', 'netherlands', 'dutch'];
  if (nlVarianten.includes(norm)) {
    return { risico: 'laag', categorieen: [], toelichting: 'Nederland — geen verhoogd landenrisico.' };
  }

  const categorieen = [];
  if (FATF_ZWART.includes(norm)) categorieen.push('FATF zwarte lijst (Call for Action)');
  if (FATF_GRIJS.includes(norm)) categorieen.push('FATF grijze lijst (Increased Monitoring)');
  if (EU_HOOG_RISICO.includes(norm)) categorieen.push('EU hoog-risico derde land');
  if (SANCTIELANDEN.includes(norm)) categorieen.push('Sanctieland (EU/VN/OFAC)');

  if (categorieen.length === 0) {
    return { risico: 'laag', categorieen: [], toelichting: `${land} — geen verhoogd landenrisico geïdentificeerd.` };
  }

  const isFatfZwartOfSanctie = FATF_ZWART.includes(norm) || SANCTIELANDEN.includes(norm);
  const risico = isFatfZwartOfSanctie ? 'hoog' : 'verhoogd';
  const toelichting = `${land} staat op: ${categorieen.join(', ')}. ${risico === 'hoog' ? 'Verscherpt CDD vereist.' : 'Verhoogde waakzaamheid vereist.'}`;

  return { risico, categorieen, toelichting };
}

module.exports = { bepaalLandenrisico, FATF_ZWART, FATF_GRIJS, EU_HOOG_RISICO, SANCTIELANDEN };
