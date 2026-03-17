// API endpoint that orchestrates the full screening:
// Serper (Google + News) via Mullvad VPN, Sanctions.io, Rechtspraak, KvK, and Claude analysis

const { serperGoogle, serperNews } = require('./_search');
const supabase = require('./_supabase');
const { bepaalLandenrisico } = require('./_landenrisico');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Wizard step-modus: individuele stappen voor de frontend wizard
  const { step } = req.body;
  if (step) {
    try {
      switch (step) {
        case 'kvk': return await stepKvk(req, res);
        case 'sanctions': return await stepSanctions(req, res);
        case 'search': return await stepSearch(req, res);
        case 'analyse': return await stepAnalyse(req, res);
        default: return res.status(400).json({ error: 'Onbekende stap: ' + step });
      }
    } catch (error) {
      console.error(`screen-step [${step}] error:`, error?.message || error);
      return res.status(500).json({ error: 'Er ging iets mis. Probeer het opnieuw.' });
    }
  }

  // Volledige screening (originele flow, ook voor API-gebruik)
  const { naam, geboortedatum, type, locatie, land, kvkZoeken, activatiecode, hercheck,
    aard_dienst, nationaliteit, adres_straat, adres_postcode, id_document_type, id_document_nummer, id_document_geldig_tot,
    vertegenwoordiger_naam, vertegenwoordiger_geboortedatum, herkomst_middelen, herkomst_vermogen, ubos } = req.body;

  if (!naam) {
    return res.status(400).json({ error: 'Naam is verplicht.' });
  }

  // Automatisch internationaal detecteren op basis van land-veld
  const nlVarianten = ['nederland', 'nl', 'the netherlands', 'netherlands', 'dutch', ''];
  const isInternationaal = land && !nlVarianten.includes(land.toLowerCase().trim());
  const resultaten = {
    google: [],
    nieuws: [],
    sancties: { resultaten: [], gecontroleerd: true },
    rechtspraak: { resultaten: [] },
    kvk: { resultaten: [] },
    queries: []
  };

  const timestamp = () => new Date().toISOString();

  try {
    // ─── SERPER: GOOGLE SEARCHES (via Mullvad VPN) ──────
    const googleQueries = [
      `"${naam}" ${locatie || ''}`.trim(),
      `"${naam}" fraude OR oplichting OR witwassen OR veroordeeld OR verdacht`,
      `"${naam}" rechtbank OR aanklacht OR strafzaak OR veroordeling`
    ];

    // Altijd mee: PEP en faillissement queries
    googleQueries.push(`"${naam}" PEP OR "politiek prominent persoon" OR "politically exposed"`);
    googleQueries.push(`"${naam}" faillissement OR surseance OR WSNP`);

    const googlePromises = googleQueries.map(async (q) => {
      resultaten.queries.push({ type: 'google', query: q, tijdstip: timestamp() });
      try {
        return await serperGoogle(q);
      } catch (e) { console.warn('Google search mislukt:', e.message); return []; }
    });

    // ─── SERPER: NEWS (via Mullvad VPN) ─────────────────
    // Nieuwsquery: brede zoek + Claude filtert irrelevante berichten eruit
    const newsQuery = `"${naam}"`;
    resultaten.queries.push({ type: 'nieuws', query: newsQuery, tijdstip: timestamp() });

    const newsPromise = (async () => {
      try {
        return await serperNews(newsQuery);
      } catch (e) { console.warn('Nieuws search mislukt:', e.message); return []; }
    })();

    // ─── YANDEX (automatisch bij internationale cliënt) ──
    let yandexPromise = Promise.resolve([]);
    if (isInternationaal) {
      const yandexQuery = `"${naam}"`;
      resultaten.queries.push({ type: 'yandex', query: yandexQuery, tijdstip: timestamp() });
      yandexPromise = (async () => {
        try {
          return await serperGoogle(yandexQuery, { gl: 'ru', hl: 'ru', bron: 'Yandex/Google RU' });
        } catch (e) { console.warn('Yandex search mislukt:', e.message); return []; }
      })();
    }

    // ─── SANCTIONS.IO ───────────────────────────────────
    resultaten.queries.push({ type: 'sancties', query: naam, tijdstip: timestamp() });

    const sanctiesPromise = (async () => {
      const entityType = type === 'rechtspersoon' ? 'organization' : 'person';
      const hoofdResultaat = await screenSanctions(naam, geboortedatum, entityType);

      // UBO's apart screenen (Wwft art. 24)
      const uboResultaten = [];
      if (Array.isArray(ubos)) {
        const uboPromises = ubos.filter(u => u.naam?.trim()).map(async (ubo) => {
          resultaten.queries.push({ type: 'sancties_ubo', query: ubo.naam, tijdstip: timestamp() });
          const hits = await screenSanctions(ubo.naam, ubo.geboortedatum, 'person');
          return { ubo_naam: ubo.naam, ubo_geboortedatum: ubo.geboortedatum || null, hits: hits.resultaten, pep_hits: hits.pep_resultaten };
        });
        uboResultaten.push(...await Promise.all(uboPromises));
      }

      return {
        resultaten: hoofdResultaat.resultaten,
        pep_resultaten: hoofdResultaat.pep_resultaten,
        ubo_sancties: uboResultaten,
        gecontroleerd: hoofdResultaat.gecontroleerd
      };
    })();

    // ─── RECHTSPRAAK ────────────────────────────────────
    resultaten.queries.push({ type: 'rechtspraak', query: naam, tijdstip: timestamp() });

    const rechtspraakPromise = (async () => {
      try {
        const baseUrl = getBaseUrl(req);
        const resp = await fetch(`${baseUrl}/api/rechtspraak?naam=${encodeURIComponent(naam)}`);
        if (!resp.ok) throw new Error(`Rechtspraak HTTP ${resp.status}`);
        return await resp.json();
      } catch (e) {
        console.warn('Rechtspraak ophalen mislukt:', e.message);
        return { resultaten: [] };
      }
    })();

    // ─── KVK (inbegrepen bij rechtspersoon/ubo) ──────────
    let kvkPromise = Promise.resolve({ resultaten: [], basisprofiel: null, vestigingsprofielen: [], gecontroleerd: false });
    if (type === 'rechtspersoon' || type === 'ubo') {
      resultaten.queries.push({ type: 'kvk', query: naam, tijdstip: timestamp() });
      kvkPromise = (async () => {
        try {
          const baseUrl = getBaseUrl(req);
          // Zoeken + basisprofiel in één aanroep
          const resp = await fetch(`${baseUrl}/api/kvk?naam=${encodeURIComponent(naam)}&profiel=true`);
          if (!resp.ok) throw new Error(`KvK HTTP ${resp.status}`);
          const kvkData = await resp.json();
          const zoekResultaten = kvkData.resultaten || [];
          if (!zoekResultaten.length) return { resultaten: [], basisprofiel: null, vestigingsprofielen: [], gecontroleerd: true };

          // Vestigingsprofielen ophalen voor unieke vestigingsnummers
          const vestigingsprofielen = [];
          const vestigingsnummers = [...new Set(zoekResultaten.map(r => r.vestigingsnummer).filter(Boolean))].slice(0, 3);
          for (const vn of vestigingsnummers) {
            try {
              const vpResp = await fetch(`${baseUrl}/api/kvk?actie=vestigingsprofiel&vestiging=${encodeURIComponent(vn)}`);
              if (vpResp.ok) {
                const vp = await vpResp.json();
                vestigingsprofielen.push(vp);
              }
            } catch (e) {
              console.warn('KvK vestigingsprofiel mislukt:', e.message);
            }
          }

          return {
            resultaten: zoekResultaten,
            basisprofiel: kvkData.basisprofiel || null,
            vestigingsprofielen,
            gecontroleerd: true
          };
        } catch (e) {
          console.warn('KvK ophalen mislukt:', e.message);
          return { resultaten: [], basisprofiel: null, vestigingsprofielen: [], gecontroleerd: false };
        }
      })();
    }

    // ─── WACHT OP ALLE RESULTATEN ───────────────────────
    const [googleResults, newsResults, yandexResults, sanctiesResult, rechtspraakResult, kvkResult] =
      await Promise.all([
        Promise.all(googlePromises),
        newsPromise,
        yandexPromise,
        sanctiesPromise,
        rechtspraakPromise,
        kvkPromise
      ]);

    resultaten.google = googleResults.flat();
    resultaten.nieuws = newsResults;
    if (isInternationaal) resultaten.yandex = yandexResults;
    resultaten.sancties = sanctiesResult;
    resultaten.rechtspraak = rechtspraakResult;
    resultaten.kvk = kvkResult;

    // ─── LANDENRISICO (FATF/EU) ──────────────────────────
    resultaten.landenrisico = bepaalLandenrisico(land);
    // Check ook nationaliteit als die afwijkt van land
    if (nationaliteit && nationaliteit.toLowerCase().trim() !== (land || '').toLowerCase().trim()) {
      resultaten.landenrisico_nationaliteit = bepaalLandenrisico(nationaliteit);
    }

    // ─── CLAUDE ANALYSE ─────────────────────────────────
    const analyse = await analyseMetClaude(naam, geboortedatum, type, locatie, resultaten);

    const tijdstip = new Date().toISOString();

    // Cliëntgegevens meenemen in response (voor client-side rapport/PDF)
    // Geen opslag van persoonsgegevens in backend — privacy by design
    resultaten.clientgegevens = {
      aard_dienst: aard_dienst || null,
      nationaliteit: nationaliteit || null,
      adres_straat: adres_straat || null,
      adres_postcode: adres_postcode || null,
      id_document_type: id_document_type || null,
      id_document_nummer: id_document_nummer || null,
      id_document_geldig_tot: id_document_geldig_tot || null,
      vertegenwoordiger_naam: vertegenwoordiger_naam || null,
      vertegenwoordiger_geboortedatum: vertegenwoordiger_geboortedatum || null,
      herkomst_middelen: herkomst_middelen || null,
      herkomst_vermogen: herkomst_vermogen || null,
      ubos: ubos || null
    };

    // Gebruik loggen (alleen teller, geen persoonsgegevens)
    logGebruik(activatiecode, req._apiKeyId, req._tenantId);

    // Referentienummer genereren (altijd, voor in het rapport)
    const referentie = genereerReferentie();

    // Hercheck: anoniem opslaan (alleen referentienummer + datum + email)
    let hercheckAdvies = null;
    if (hercheck) {
      const risicoInterval = { hoog: 3, verhoogd: 6, laag: 12 };
      const gebruikerInterval = parseInt(hercheck) || 12;
      const risicoNiveau = analyse.risico_niveau || 'laag';
      const aanbevolenInterval = risicoInterval[risicoNiveau] || 12;
      hercheckAdvies = Math.min(gebruikerInterval, aanbevolenInterval);

      const hercheckDatum = new Date();
      hercheckDatum.setMonth(hercheckDatum.getMonth() + hercheckAdvies);

      // Tenant opzoeken via activatiecode
      let tenantId = req._tenantId || null;
      if (!tenantId && activatiecode) {
        const { data: codeRecord } = await supabase
          .from('activatiecodes').select('tenant_id').eq('code', activatiecode.toUpperCase()).single();
        tenantId = codeRecord?.tenant_id || null;
      }

      // Anonieme hercheck opslaan (geen naam, geen persoonsgegevens)
      await supabase.from('herchecks').insert({
        referentie,
        tenant_id: tenantId,
        activatiecode: activatiecode || null,
        risico_niveau: analyse.risico_niveau || null,
        hercheck_datum: hercheckDatum.toISOString().slice(0, 10),
        hercheck_interval_maanden: hercheckAdvies,
        hercheck_email: req.body.hercheckEmail || null,
        actief: true
      }).catch(err => console.error('Hercheck opslaan mislukt:', err));
    }

    return res.status(200).json({
      referentie,
      naam,
      geboortedatum,
      type,
      locatie,
      resultaten,
      analyse,
      tijdstip,
      hercheck_advies_maanden: hercheckAdvies
    });

  } catch (error) {
    console.error('Screen error:', error?.message || error, error?.stack);
    return res.status(500).json({
      error: 'Er ging iets mis bij de screening. Probeer het opnieuw.',
      debug: process.env.NODE_ENV !== 'production' ? (error?.message || String(error)) : undefined
    });
  }
};

// ═══ WIZARD STEP HANDLERS ═══════════════════════════════════

async function stepKvk(req, res) {
  const { naam } = req.body;
  if (!naam) return res.status(400).json({ error: 'Naam is verplicht.' });
  const baseUrl = getBaseUrl(req);
  const result = { resultaten: [], basisprofiel: null, vestigingsprofielen: [], gecontroleerd: false };
  try {
    const resp = await fetch(`${baseUrl}/api/kvk?naam=${encodeURIComponent(naam)}&profiel=true`);
    if (!resp.ok) throw new Error(`KvK HTTP ${resp.status}`);
    const kvkData = await resp.json();
    result.resultaten = kvkData.resultaten || [];
    result.basisprofiel = kvkData.basisprofiel || null;
    result.gecontroleerd = true;
    if (result.resultaten.length > 0) {
      const vns = [...new Set(result.resultaten.map(r => r.vestigingsnummer).filter(Boolean))].slice(0, 3);
      for (const vn of vns) {
        try {
          const vpResp = await fetch(`${baseUrl}/api/kvk?actie=vestigingsprofiel&vestiging=${encodeURIComponent(vn)}`);
          if (vpResp.ok) result.vestigingsprofielen.push(await vpResp.json());
        } catch (e) { console.warn('KvK vestigingsprofiel mislukt:', e.message); }
      }
    }
  } catch (e) { console.warn('KvK ophalen mislukt:', e.message); }
  return res.status(200).json(result);
}

async function stepSanctions(req, res) {
  const { naam, geboortedatum, type, ubos } = req.body;
  if (!naam) return res.status(400).json({ error: 'Naam is verplicht.' });
  try {
    // Screen hoofdsubject
    const hoofdResultaat = await screenSanctions(naam, geboortedatum, type === 'rechtspersoon' ? 'organization' : 'person');

    // Screen elke UBO apart tegen sanctielijsten (Wwft art. 24)
    const uboResultaten = [];
    if (Array.isArray(ubos)) {
      const uboPromises = ubos.filter(u => u.naam?.trim()).map(async (ubo) => {
        const hits = await screenSanctions(ubo.naam, ubo.geboortedatum, 'person');
        return { ubo_naam: ubo.naam, ubo_geboortedatum: ubo.geboortedatum || null, hits: hits.resultaten, pep_hits: hits.pep_resultaten };
      });
      const results = await Promise.all(uboPromises);
      uboResultaten.push(...results);
    }

    return res.status(200).json({
      resultaten: hoofdResultaat.resultaten,
      pep_resultaten: hoofdResultaat.pep_resultaten,
      ubo_sancties: uboResultaten,
      gecontroleerd: hoofdResultaat.gecontroleerd
    });
  } catch (e) {
    console.error('Sanctiescreening mislukt:', e.message);
    return res.status(200).json({ resultaten: [], ubo_sancties: [], gecontroleerd: false });
  }
}

// Herbruikbare sanctiescreening voor één naam
async function screenSanctions(naam, geboortedatum, entityType) {
  if (!process.env.SANCTIONS_API_KEY) {
    console.error('SANCTIONS_API_KEY niet geconfigureerd');
    return { resultaten: [], pep_resultaten: [], gecontroleerd: false };
  }
  const headers = {
    'Authorization': `Bearer ${process.env.SANCTIONS_API_KEY}`,
    'Accept': 'application/json; version=2.1'
  };
  const params = new URLSearchParams({ name: naam, data_source: 'ALL' });
  if (geboortedatum) params.set('date_of_birth', geboortedatum);
  if (entityType) params.set('entity_type', entityType);

  const mapResults = (data) => (data.results || []).slice(0, 10).map(r => ({
    naam: r.name, lijst: r.list_name || r.source, score: r.score,
    type: r.entity_type, details: r.remarks || r.additional_information || ''
  }));

  try {
    // Sanctielijsten en PEP-lijsten parallel opvragen
    const [sanctieResp, pepResp] = await Promise.all([
      fetch(`https://api.sanctions.io/search?${params.toString()}`, {
        headers, signal: AbortSignal.timeout(10000)
      }),
      fetch(`https://api.sanctions.io/pep-search?${params.toString()}`, {
        headers, signal: AbortSignal.timeout(10000)
      }).catch(e => {
        console.error('PEP-screening mislukt voor', naam, ':', e.message);
        return null;
      })
    ]);

    if (!sanctieResp.ok) {
      const body = await sanctieResp.text().catch(() => '');
      throw new Error(`Sanctions.io HTTP ${sanctieResp.status}: ${body.slice(0, 200)}`);
    }
    const sanctieData = await sanctieResp.json();

    let pepResultaten = [];
    if (pepResp && pepResp.ok) {
      const pepData = await pepResp.json();
      pepResultaten = mapResults(pepData);
    }

    return {
      resultaten: mapResults(sanctieData),
      pep_resultaten: pepResultaten,
      gecontroleerd: true
    };
  } catch (e) {
    console.error('Sanctiescreening mislukt voor', naam, ':', e.message);
    return { resultaten: [], pep_resultaten: [], gecontroleerd: false };
  }
}

async function stepSearch(req, res) {
  const { naam, locatie, land } = req.body;
  if (!naam) return res.status(400).json({ error: 'Naam is verplicht.' });
  const nlVarianten = ['nederland', 'nl', 'the netherlands', 'netherlands', 'dutch', ''];
  const isInternationaal = land && !nlVarianten.includes(land.toLowerCase().trim());
  const baseUrl = getBaseUrl(req);
  const googleQueries = [
    `"${naam}" ${locatie || ''}`.trim(),
    `"${naam}" fraude OR oplichting OR witwassen OR veroordeeld OR verdacht`,
    `"${naam}" rechtbank OR aanklacht OR strafzaak OR veroordeling`,
    `"${naam}" PEP OR "politiek prominent persoon" OR "politically exposed"`,
    `"${naam}" faillissement OR surseance OR WSNP`
  ];
  const [googleResults, newsResults, yandexResults, rechtspraakResult] = await Promise.all([
    Promise.all(googleQueries.map(async q => {
      try { return await serperGoogle(q); }
      catch (e) { console.warn('Google mislukt:', e.message); return []; }
    })),
    (async () => {
      try { return await serperNews(`"${naam}"`); }
      catch (e) { return []; }
    })(),
    isInternationaal ? (async () => {
      try { return await serperGoogle(`"${naam}"`, { gl: 'ru', hl: 'ru', bron: 'Yandex/Google RU' }); }
      catch (e) { return []; }
    })() : Promise.resolve([]),
    (async () => {
      try {
        const resp = await fetch(`${baseUrl}/api/rechtspraak?naam=${encodeURIComponent(naam)}`);
        if (!resp.ok) throw new Error(`Rechtspraak HTTP ${resp.status}`);
        return await resp.json();
      } catch (e) { return { resultaten: [] }; }
    })()
  ]);
  const result = { google: googleResults.flat(), nieuws: newsResults, rechtspraak: rechtspraakResult };
  if (isInternationaal) result.yandex = yandexResults;
  return res.status(200).json(result);
}

async function stepAnalyse(req, res) {
  const { naam, geboortedatum, type, locatie, land, resultaten,
    activatiecode, hercheck,
    aard_dienst, nationaliteit, adres_straat, adres_postcode,
    id_document_type, id_document_nummer, id_document_geldig_tot,
    vertegenwoordiger_naam, vertegenwoordiger_geboortedatum,
    herkomst_middelen, herkomst_vermogen, ubos } = req.body;
  if (!naam || !resultaten) return res.status(400).json({ error: 'Naam en resultaten zijn verplicht.' });

  // Cliëntgegevens voor client-side rapport (niet opgeslagen)
  resultaten.clientgegevens = {
    aard_dienst: aard_dienst || null, nationaliteit: nationaliteit || null,
    adres_straat: adres_straat || null, adres_postcode: adres_postcode || null,
    id_document_type: id_document_type || null, id_document_nummer: id_document_nummer || null,
    id_document_geldig_tot: id_document_geldig_tot || null,
    vertegenwoordiger_naam: vertegenwoordiger_naam || null,
    vertegenwoordiger_geboortedatum: vertegenwoordiger_geboortedatum || null,
    herkomst_middelen: herkomst_middelen || null, herkomst_vermogen: herkomst_vermogen || null,
    ubos: ubos || null
  };

  // Landenrisico (FATF/EU)
  resultaten.landenrisico = bepaalLandenrisico(land);
  if (nationaliteit && nationaliteit.toLowerCase().trim() !== (land || '').toLowerCase().trim()) {
    resultaten.landenrisico_nationaliteit = bepaalLandenrisico(nationaliteit);
  }

  const analyse = await analyseMetClaude(naam, geboortedatum, type, locatie, resultaten);
  const tijdstip = new Date().toISOString();

  // Gebruik loggen (alleen teller, geen persoonsgegevens)
  logGebruik(activatiecode, null, null);

  // Referentienummer genereren
  const referentie = genereerReferentie();

  // Hercheck: anoniem opslaan
  let hercheckAdvies = null;
  if (hercheck) {
    const risicoInterval = { hoog: 3, verhoogd: 6, laag: 12 };
    const gebruikerInterval = parseInt(hercheck) || 12;
    const risicoNiveau = analyse.risico_niveau || 'laag';
    const aanbevolenInterval = risicoInterval[risicoNiveau] || 12;
    hercheckAdvies = Math.min(gebruikerInterval, aanbevolenInterval);

    const hercheckDatum = new Date();
    hercheckDatum.setMonth(hercheckDatum.getMonth() + hercheckAdvies);

    let tenantId = null;
    if (activatiecode) {
      const { data: codeRecord } = await supabase
        .from('activatiecodes').select('tenant_id').eq('code', activatiecode.toUpperCase()).single();
      tenantId = codeRecord?.tenant_id || null;
    }

    await supabase.from('herchecks').insert({
      referentie,
      tenant_id: tenantId,
      activatiecode: activatiecode || null,
      risico_niveau: analyse.risico_niveau || null,
      hercheck_datum: hercheckDatum.toISOString().slice(0, 10),
      hercheck_interval_maanden: hercheckAdvies,
      hercheck_email: req.body.hercheckEmail || null,
      actief: true
    }).catch(err => console.error('Hercheck opslaan mislukt:', err));
  }

  return res.status(200).json({ referentie, naam, geboortedatum, type, locatie, resultaten, analyse, tijdstip, hercheck_advies_maanden: hercheckAdvies });
}

// ═══ SHARED HELPERS ═════════════════════════════════════════

async function analyseMetClaude(naam, geboortedatum, type, locatie, resultaten) {
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: `Je bent een Wwft-compliance analyst. Analyseer de volgende screeningresultaten voor een cliëntonderzoek.

Subject: ${naam}
${geboortedatum ? `Geboortedatum: ${geboortedatum}` : ''}
Type: ${type || 'natuurlijk persoon'}
${locatie ? `Locatie: ${locatie}` : ''}

=== GOOGLE RESULTATEN ===
${JSON.stringify(resultaten.google.slice(0, 15), null, 2)}

=== NIEUWSBERICHTEN ===
${JSON.stringify(resultaten.nieuws.slice(0, 10), null, 2)}

=== SANCTIELIJSTEN ===
Gecontroleerd: ${resultaten.sancties.gecontroleerd ? 'Ja' : 'Nee (fout bij ophalen)'}
Hits: ${JSON.stringify(resultaten.sancties.resultaten, null, 2)}
${resultaten.sancties.pep_resultaten?.length ? `\n=== PEP-LIJSTEN (sanctions.io) ===\nHits: ${JSON.stringify(resultaten.sancties.pep_resultaten, null, 2)}` : '\n=== PEP-LIJSTEN (sanctions.io) ===\nGeen PEP-hits gevonden.'}
${resultaten.sancties.ubo_sancties?.length ? `\n=== UBO SANCTIESCREENING ===\n${JSON.stringify(resultaten.sancties.ubo_sancties, null, 2)}` : ''}

=== LANDENRISICO (FATF/EU) ===
Land: ${JSON.stringify(resultaten.landenrisico || {}, null, 2)}
${resultaten.landenrisico_nationaliteit ? `Nationaliteit: ${JSON.stringify(resultaten.landenrisico_nationaliteit, null, 2)}` : ''}

=== RECHTSPRAAK ===
${JSON.stringify(resultaten.rechtspraak.resultaten || [], null, 2)}

=== KVK ===
${JSON.stringify(resultaten.kvk.resultaten || [], null, 2)}

Geef je analyse als JSON met exact deze structuur:
{
  "risico_niveau": "laag" | "verhoogd" | "hoog",
  "risico_score": 0-100,
  "samenvatting": "korte samenvatting in 2-3 zinnen",
  "wwft_oordeel": "beknopt oordeel vanuit Wwft-perspectief",
  "is_pep": true | false,
  "pep_toelichting": "toelichting waarom wel/niet PEP (altijd invullen)",
  "cdd_niveau": "vereenvoudigd" | "standaard" | "verscherpt",
  "cdd_toelichting": "korte uitleg waarom dit CDD-niveau van toepassing is",
  "landenrisico_oordeel": "beoordeling van het landenrisico op basis van FATF/EU lijsten (altijd invullen)",
  "ubo_risico_oordeel": "beoordeling van UBO-screening resultaten (altijd invullen, ook als er geen UBOs zijn)",
  "hercheck_advies": "3 maanden" | "6 maanden" | "12 maanden" | "24 maanden",
  "bevindingen": [
    {
      "categorie": "sancties" | "sancties_ubo" | "rechtspraak" | "media" | "kvk" | "pep" | "landenrisico" | "overig",
      "ernst": "groen" | "oranje" | "rood" | "grijs",
      "beschrijving": "korte beschrijving van de bevinding",
      "bron": "bronverwijzing"
    }
  ],
  "risico_uitleg": "uitgebreide toelichting op het risico-oordeel"
}

Belangrijk:
- Wees feitelijk en objectief
- Baseer je oordeel alleen op de aangeleverde resultaten
- NEGEER berichten die duidelijk NIET relevant zijn voor compliance/Wwft, zoals: sportverslagen, voetbalnieuws, entertainment, roddels, recepten, of berichten waarin de naam slechts terloops wordt genoemd zonder verband met financiële criminaliteit, fraude, witwassen, sancties, of andere Wwft-risico's
- Neem ALLEEN bevindingen op die daadwerkelijk relevant zijn voor het cliëntonderzoek
- Als er geen negatieve of relevante resultaten zijn, geef dan risico_niveau "laag"
- Sanctiehits zijn altijd "rood" ernst — ook sanctiehits op UBO's
- UBO-screening: als een UBO op een sanctielijst staat, is dit ALTIJD "rood" en leidt tot risico_niveau "hoog". Vermeld welke UBO het betreft.
- PEP-check: beoordeel of de persoon een politiek prominent persoon is (of familielid/naaste geassocieerde van een PEP). Vul is_pep en pep_toelichting ALTIJD in.
- Landenrisico: als het land op de FATF zwarte lijst of EU sanctielijst staat → "hoog". FATF grijze lijst → minimaal "verhoogd". Voeg een bevinding toe met categorie "landenrisico".
- CDD-niveau: "vereenvoudigd" alleen bij bewezen laag risico, "verscherpt" bij PEP, sanctiehits (inclusief UBO), hoog-risico land (FATF/EU), of andere rode vlaggen, anders "standaard"
- hercheck_advies: baseer op risico — hoog→"3 maanden", verhoogd→"6 maanden", laag→"12 maanden"
- Dit is een hulpmiddel, geen definitief oordeel
- Antwoord ALLEEN met valid JSON, geen andere tekst`
        }]
      })
    });

    if (!resp.ok) throw new Error(`Claude API HTTP ${resp.status}`);
    const data = await resp.json();
    const content = data.content?.[0]?.text || '';

    // Parse JSON uit de response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }

    return defaultAnalyse();
  } catch (error) {
    console.error('Claude analyse error:', error);
    return defaultAnalyse();
  }
}

function defaultAnalyse() {
  return {
    risico_niveau: 'grijs',
    risico_score: -1,
    samenvatting: 'Analyse kon niet worden uitgevoerd. Beoordeel de resultaten handmatig.',
    wwft_oordeel: 'Automatische analyse niet beschikbaar.',
    is_pep: false,
    pep_toelichting: 'PEP-status kon niet automatisch worden bepaald. Beoordeel handmatig.',
    cdd_niveau: 'standaard',
    cdd_toelichting: 'Standaard CDD als fallback. Beoordeel of verscherpt onderzoek nodig is.',
    bevindingen: [],
    risico_uitleg: 'De AI-analyse kon niet worden voltooid. Controleer de individuele zoekresultaten.'
  };
}

// Genereer uniek referentienummer: SCR-XXXX-XXXX (voor in rapport + hercheck)
function genereerReferentie() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // geen I/O/0/1 (leesbaar)
  const blok = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `SCR-${blok()}-${blok()}`;
}

// Gebruik loggen: alleen teller per activatiecode/api_key, geen persoonsgegevens
async function logGebruik(activatiecode, apiKeyId, tenantId) {
  try {
    if (activatiecode) {
      await supabase.rpc('increment_gebruik', { code_param: activatiecode.toUpperCase() }).catch(() => {});
    }
    // Fallback: als er geen RPC is, tellen we via de activatiecodes tabel (credits_gebruikt wordt al bijgehouden door activate.js)
  } catch (e) {
    // Niet-blokkerend — gebruik-logging mag nooit de screening breken
  }
}

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}
