// Shared KvK Handelsregister logic — v2 Zoeken + v1 Basisprofiel + v1 Vestigingsprofiel
// Imported by both api/kvk.js (HTTP handler) and api/screen.js (orchestrator)
// Supports test and production mode via KVK_TEST_MODE env var

const KVK_TEST_KEY = 'l7xx1f2691f2520d487b902f4e0b57a0b197';

function getBaseUrl() {
  const isTest = process.env.KVK_TEST_MODE === 'true';
  return isTest ? 'https://api.kvk.nl/test' : 'https://api.kvk.nl';
}

function getApiKey() {
  const isTest = process.env.KVK_TEST_MODE === 'true';
  return isTest ? KVK_TEST_KEY : process.env.KVK_API_KEY;
}

async function kvkFetch(url) {
  const resp = await fetch(url, {
    headers: {
      'apikey': getApiKey(),
      'Accept': 'application/json'
    }
  });
  if (!resp.ok) {
    const status = resp.status;
    if (status === 404) return null;
    throw new Error(`KvK API ${status}`);
  }
  return resp.json();
}

// ─── Zoeken (v2) ────────────────────────────────────────
async function zoeken(params) {
  const base = getBaseUrl();
  const qs = new URLSearchParams({ resultatenPerPagina: '5', pagina: '1' });
  if (params.naam) qs.set('naam', params.naam);
  if (params.kvkNummer) qs.set('kvkNummer', params.kvkNummer);
  if (params.vestigingsnummer) qs.set('vestigingsnummer', params.vestigingsnummer);
  if (params.type) qs.set('type', params.type);
  if (params.plaats) qs.set('plaats', params.plaats);

  const data = await kvkFetch(`${base}/api/v2/zoeken?${qs.toString()}`);
  if (!data) return [];

  return (data.resultaten || []).map(item => ({
    kvkNummer: item.kvkNummer || '',
    vestigingsnummer: item.vestigingsnummer || '',
    naam: item.naam || '',
    type: item.type || '',
    actief: item.actief !== false,
    adres: formatAdres(item.adres),
    _links: item._links || {}
  }));
}

// ─── Basisprofiel (v1) ──────────────────────────────────
async function basisprofiel(kvkNummer) {
  const base = getBaseUrl();
  const data = await kvkFetch(`${base}/api/v1/basisprofielen/${encodeURIComponent(kvkNummer)}`);
  if (!data) return null;

  const result = {
    kvkNummer: data.kvkNummer || kvkNummer,
    indNonMailing: data.indNonMailing || 'Nee',
    naam: data.naam || '',
    formeleRegistratiedatum: data.formeleRegistratiedatum || '',
    totaalWerkzamePersonen: data.totaalWerkzamePersonen ?? null,
    statutaireNaam: data.statutaireNaam || '',
    handelsnamen: (data.handelsnamen || []).map(h => h.naam || h),
    sbiActiviteiten: (data.sbiActiviteiten || []).map(s => ({
      sbiCode: s.sbiCode || '',
      sbiOmschrijving: s.sbiOmschrijving || ''
    })),
    _embedded: {}
  };

  // Eigenaar info
  if (data._embedded?.eigenaar) {
    const e = data._embedded.eigenaar;
    result._embedded.eigenaar = {
      naam: e.naam || '',
      geboortedatum: e.geboortedatum || null,
      overpijedDatum: e.overpijedDatum || null
    };
  }

  // Hoofdvestiging
  if (data._embedded?.hoofdvestiging) {
    const h = data._embedded.hoofdvestiging;
    result._embedded.hoofdvestiging = {
      vestigingsnummer: h.vestigingsnummer || '',
      eersteHandelsnaam: h.eersteHandelsnaam || '',
      adres: formatAdresDetail(h.adressen),
      totaalWerkzamePersonen: h.totaalWerkzamePersonen ?? null
    };
  }

  return result;
}

// ─── Vestigingsprofiel (v1) ─────────────────────────────
async function vestigingsprofiel(vestigingsnummer) {
  const base = getBaseUrl();
  const data = await kvkFetch(`${base}/api/v1/vestigingsprofielen/${encodeURIComponent(vestigingsnummer)}`);
  if (!data) return null;

  return {
    vestigingsnummer: data.vestigingsnummer || vestigingsnummer,
    kvkNummer: data.kvkNummer || '',
    eersteHandelsnaam: data.eersteHandelsnaam || '',
    indHoofdvestiging: data.indHoofdvestiging || 'Nee',
    indCommercieleVestiging: data.indCommercieleVestiging || 'Nee',
    totaalWerkzamePersonen: data.totaalWerkzamePersonen ?? null,
    statutaireNaam: data.statutaireNaam || '',
    adressen: (data.adressen || []).map(a => formatSingleAdres(a)),
    websites: data.websites || [],
    sbiActiviteiten: (data.sbiActiviteiten || []).map(s => ({
      sbiCode: s.sbiCode || '',
      sbiOmschrijving: s.sbiOmschrijving || ''
    })),
    formeleRegistratiedatum: data.formeleRegistratiedatum || '',
    materieleRegistratie: data.materieleRegistratie || {}
  };
}

// ─── Naamgeving (v1) ────────────────────────────────────
async function naamgeving(kvkNummer) {
  const base = getBaseUrl();
  const data = await kvkFetch(`${base}/api/v1/naamgevingen/kvknummer/${encodeURIComponent(kvkNummer)}`);
  if (!data) return null;
  return {
    kvkNummer: data.kvkNummer || kvkNummer,
    naam: data.naam || '',
    statutaireNaam: data.statutaireNaam || '',
    handelsnamen: data.handelsnamen || []
  };
}

// ─── Helpers ────────────────────────────────────────────
function formatAdres(adres) {
  if (!adres) return '';
  const b = adres.binnenlandsAdres || adres;
  return [
    b.straatnaam, b.huisnummer, b.huisletter, b.huisnummerToevoeging,
    b.postbusnummer ? `Postbus ${b.postbusnummer}` : '',
    ',', b.postcode, b.plaats
  ].filter(Boolean).join(' ').replace(' ,', ',');
}

function formatAdresDetail(adressen) {
  if (!adressen?.length) return '';
  const addr = adressen.find(a => a.type === 'bezoekadres') || adressen[0];
  return formatSingleAdres(addr);
}

function formatSingleAdres(a) {
  if (!a) return '';
  return [
    a.straatnaam, a.huisnummer, a.huisletter, a.huisnummerToevoeging,
    ',', a.postcode, a.plaats, a.land && a.land !== 'Nederland' ? `(${a.land})` : ''
  ].filter(Boolean).join(' ').replace(' ,', ',');
}

module.exports = { zoeken, basisprofiel, vestigingsprofiel, naamgeving };
