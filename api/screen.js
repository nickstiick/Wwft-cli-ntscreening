// API endpoint that orchestrates the full screening:
// Serper (Google + News), Sanctions.io, Rechtspraak, KvK, and Claude analysis

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { naam, geboortedatum, type, locatie, tier, kvkZoeken } = req.body;

  if (!naam) {
    return res.status(400).json({ error: 'Naam is verplicht.' });
  }

  const isUitgebreid = tier === 'uitgebreid';
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
    // ─── SERPER: GOOGLE SEARCHES ────────────────────────
    const serperKey = process.env.SERPER_API_KEY;

    const googleQueries = [
      `"${naam}" ${locatie || ''}`.trim(),
      `"${naam}" fraude OR oplichting OR witwassen OR veroordeeld`,
      `"${naam}" rechtbank OR aanklacht OR strafzaak`
    ];

    if (isUitgebreid) {
      googleQueries.push(`"${naam}" PEP OR "politiek prominent persoon" OR "politically exposed"`);
      googleQueries.push(`"${naam}" faillissement OR surseance OR WSNP`);
    }

    const googlePromises = googleQueries.map(async (q) => {
      resultaten.queries.push({ type: 'google', query: q, tijdstip: timestamp() });
      try {
        const resp = await fetch('https://google.serper.dev/search', {
          method: 'POST',
          headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ q, gl: 'nl', hl: 'nl', num: 5 })
        });
        const data = await resp.json();
        return (data.organic || []).map(r => ({
          titel: r.title,
          link: r.link,
          snippet: r.snippet,
          bron: 'Google'
        }));
      } catch { return []; }
    });

    // ─── SERPER: BING NEWS ──────────────────────────────
    const newsQuery = `"${naam}"`;
    resultaten.queries.push({ type: 'nieuws', query: newsQuery, tijdstip: timestamp() });

    const newsPromise = (async () => {
      try {
        const resp = await fetch('https://google.serper.dev/news', {
          method: 'POST',
          headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: newsQuery, gl: 'nl', hl: 'nl', num: 10, tbs: 'qdr:y5' })
        });
        const data = await resp.json();
        return (data.news || []).map(r => ({
          titel: r.title,
          link: r.link,
          snippet: r.snippet,
          datum: r.date,
          bron: r.source || 'Nieuws'
        }));
      } catch { return []; }
    })();

    // ─── YANDEX (uitgebreid tier) ───────────────────────
    let yandexPromise = Promise.resolve([]);
    if (isUitgebreid) {
      const yandexQuery = `"${naam}"`;
      resultaten.queries.push({ type: 'yandex', query: yandexQuery, tijdstip: timestamp() });
      yandexPromise = (async () => {
        try {
          const resp = await fetch('https://google.serper.dev/search', {
            method: 'POST',
            headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ q: yandexQuery, gl: 'ru', hl: 'ru', num: 5 })
          });
          const data = await resp.json();
          return (data.organic || []).map(r => ({
            titel: r.title,
            link: r.link,
            snippet: r.snippet,
            bron: 'Yandex/Google RU'
          }));
        } catch { return []; }
      })();
    }

    // ─── SANCTIONS.IO ───────────────────────────────────
    resultaten.queries.push({ type: 'sancties', query: naam, tijdstip: timestamp() });

    const sanctiesPromise = (async () => {
      try {
        const resp = await fetch(
          `https://api.sanctions.io/search/?name=${encodeURIComponent(naam)}&min_score=75`,
          { headers: { 'Authorization': `Bearer ${process.env.SANCTIONS_API_KEY}`, 'Accept': 'application/json' } }
        );
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
      } catch {
        return { resultaten: [], gecontroleerd: false };
      }
    })();

    // ─── RECHTSPRAAK ────────────────────────────────────
    resultaten.queries.push({ type: 'rechtspraak', query: naam, tijdstip: timestamp() });

    const rechtspraakPromise = (async () => {
      try {
        const baseUrl = getBaseUrl(req);
        const resp = await fetch(`${baseUrl}/api/rechtspraak?naam=${encodeURIComponent(naam)}`);
        return await resp.json();
      } catch {
        return { resultaten: [] };
      }
    })();

    // ─── KVK (optioneel) ────────────────────────────────
    let kvkPromise = Promise.resolve({ resultaten: [] });
    if (kvkZoeken && (type === 'rechtspersoon' || type === 'ubo')) {
      resultaten.queries.push({ type: 'kvk', query: naam, tijdstip: timestamp() });
      kvkPromise = (async () => {
        try {
          const baseUrl = getBaseUrl(req);
          const resp = await fetch(`${baseUrl}/api/kvk?naam=${encodeURIComponent(naam)}`);
          return await resp.json();
        } catch {
          return { resultaten: [] };
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
    if (isUitgebreid) resultaten.yandex = yandexResults;
    resultaten.sancties = sanctiesResult;
    resultaten.rechtspraak = rechtspraakResult;
    resultaten.kvk = kvkResult;

    // ─── CLAUDE ANALYSE ─────────────────────────────────
    const analyse = await analyseMetClaude(naam, geboortedatum, type, locatie, resultaten);

    return res.status(200).json({
      naam,
      geboortedatum,
      type,
      locatie,
      resultaten,
      analyse,
      tijdstip: new Date().toISOString()
    });

  } catch (error) {
    console.error('Screen error:', error);
    return res.status(500).json({ error: 'Er ging iets mis bij de screening. Probeer het opnieuw.' });
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
- Als er geen negatieve resultaten zijn, geef dan risico_niveau "laag"
- Sanctiehits zijn altijd "rood" ernst
- Dit is een hulpmiddel, geen definitief oordeel
- Antwoord ALLEEN met valid JSON, geen andere tekst`
        }]
      })
    });

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
    bevindingen: [],
    risico_uitleg: 'De AI-analyse kon niet worden voltooid. Controleer de individuele zoekresultaten.'
  };
}

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}
