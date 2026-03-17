// API endpoint that orchestrates the full screening:
// Serper (Google + News) via Mullvad VPN, Sanctions.io, Rechtspraak, KvK, and Claude analysis

const { serperGoogle, serperNews } = require('./_search');
const supabase = require('./_supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { naam, geboortedatum, type, locatie, land, kvkZoeken, activatiecode, medewerker, dossiernummer, hercheck, hercheckEmail, kvkMonitoring,
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
      try {
        const params = new URLSearchParams({ name: naam, min_score: '75' });
        if (geboortedatum) params.set('date_of_birth', geboortedatum);
        if (type === 'rechtspersoon') params.set('entity_type', 'organization');
        else if (type === 'natuurlijk_persoon' || type === 'ubo') params.set('entity_type', 'person');

        const resp = await fetch(
          `https://api.sanctions.io/search/?${params.toString()}`,
          { headers: { 'Authorization': `Bearer ${process.env.SANCTIONS_API_KEY}`, 'Accept': 'application/json' } }
        );
        if (!resp.ok) throw new Error(`Sanctions.io HTTP ${resp.status}`);
        const data = await resp.json();
        return {
          resultaten: (data.results || []).slice(0, 10).map(r => ({
            naam: r.name,
            lijst: r.list_name || r.source,
            score: r.score,
            type: r.entity_type,
            details: r.remarks || r.additional_information || ''
          })),
          gecontroleerd: true
        };
      } catch (e) {
        console.error('Sanctiescreening mislukt:', e.message);
        return { resultaten: [], gecontroleerd: false };
      }
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

    // ─── CLAUDE ANALYSE ─────────────────────────────────
    const analyse = await analyseMetClaude(naam, geboortedatum, type, locatie, resultaten);

    const tijdstip = new Date().toISOString();

    // Extract KVK-nummer uit resultaten (eerste hit)
    const kvkNummer = resultaten.kvk?.resultaten?.[0]?.kvkNummer || null;

    // Sla screening op in database (async, geen blokkade)
    // Wwft art. 33 cliëntgegevens meenemen in resultaten object (voor rapport)
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

    const screeningRecord = {
      naam,
      geboortedatum: geboortedatum || null,
      type: type || 'natuurlijk_persoon',
      locatie: locatie || null,
      land: land || 'Nederland',
      kvk_nummer: kvkNummer,
      risico_niveau: analyse.risico_niveau || null,
      risico_score: analyse.risico_score >= 0 ? analyse.risico_score : null,
      samenvatting: analyse.samenvatting || null,
      resultaten,
      analyse,
      bron: req._apiKeyId ? 'api' : 'web',
      medewerker: medewerker || null,
      dossiernummer: dossiernummer || null,
      aangemaakt_op: tijdstip
    };

    // Koppel aan tenant via activatiecode
    if (activatiecode) {
      screeningRecord.activatiecode = activatiecode;
      const { data: codeRecord } = await supabase
        .from('activatiecodes')
        .select('tenant_id')
        .eq('code', activatiecode.toUpperCase())
        .single();
      if (codeRecord?.tenant_id) {
        screeningRecord.tenant_id = codeRecord.tenant_id;
      }
    }

    // API key koppeling
    if (req._apiKeyId) {
      screeningRecord.api_key_id = req._apiKeyId;
      screeningRecord.tenant_id = req._tenantId;
    }

    // Hercheck instellen
    if (hercheck) {
      const hercheckDatum = new Date();
      hercheckDatum.setMonth(hercheckDatum.getMonth() + (parseInt(hercheck) || 12));
      screeningRecord.hercheck_datum = hercheckDatum.toISOString().slice(0, 10);
      screeningRecord.hercheck_actief = true;
      screeningRecord.hercheck_email = hercheckEmail || null;
      screeningRecord.hercheck_interval_maanden = parseInt(hercheck) || 12;
    }

    // Opslaan (fire-and-forget, fout hier mag de response niet blokkeren)
    let screeningId = null;
    try {
      const { data: saved } = await supabase
        .from('screenings')
        .insert(screeningRecord)
        .select('id')
        .single();
      screeningId = saved?.id;

      // KVK Monitoring activeren als gevraagd + KVK-nummer beschikbaar + tenant bekend
      if (kvkMonitoring && kvkNummer && screeningRecord.tenant_id) {
        await supabase
          .from('kvk_monitoring')
          .upsert({
            tenant_id: screeningRecord.tenant_id,
            kvk_nummer: kvkNummer,
            bedrijfsnaam: resultaten.kvk?.resultaten?.[0]?.naam || naam,
            laatste_screening_id: screeningId,
            laatste_check: tijdstip,
            actief: true
          }, { onConflict: 'tenant_id,kvk_nummer', ignoreDuplicates: false })
          .then(() => {})
          .catch(err => console.error('KVK monitoring opslaan mislukt:', err));
      }
    } catch (saveErr) {
      console.error('Screening opslaan mislukt:', saveErr);
    }

    return res.status(200).json({
      id: screeningId,
      naam,
      geboortedatum,
      type,
      locatie,
      resultaten,
      analyse,
      tijdstip
    });

  } catch (error) {
    console.error('Screen error:', error?.message || error, error?.stack);
    return res.status(500).json({
      error: 'Er ging iets mis bij de screening. Probeer het opnieuw.',
      debug: process.env.NODE_ENV !== 'production' ? (error?.message || String(error)) : undefined
    });
  }
};

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
  "bevindingen": [
    {
      "categorie": "sancties" | "rechtspraak" | "media" | "kvk" | "pep" | "overig",
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
- Sanctiehits zijn altijd "rood" ernst
- PEP-check: beoordeel of de persoon een politiek prominent persoon is (of familielid/naaste geassocieerde van een PEP). Vul is_pep en pep_toelichting ALTIJD in.
- CDD-niveau: "vereenvoudigd" alleen bij bewezen laag risico, "verscherpt" bij PEP, sanctiehits, hoog-risico land of andere rode vlaggen, anders "standaard"
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

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}
