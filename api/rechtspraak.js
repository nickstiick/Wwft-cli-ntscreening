module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { naam } = req.query;
  if (!naam) {
    return res.status(400).json({ error: 'Parameter "naam" is verplicht.' });
  }

  try {
    const searchUrl = `https://uitspraken.rechtspraak.nl/api/zoek?zoekterm=${encodeURIComponent(naam)}&max=5&sort=Relevance`;

    const response = await fetch(searchUrl, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Dossier-WWFT-Screening/1.0'
      }
    });

    if (!response.ok) {
      console.error('Rechtspraak API status:', response.status);
      return res.status(502).json({ error: 'Rechtspraak.nl API niet bereikbaar.' });
    }

    // Rechtspraak.nl kan HTML teruggeven i.p.v. JSON — detecteer dit
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('json')) {
      console.error('Rechtspraak API gaf geen JSON terug, content-type:', contentType);
      return res.status(200).json({ aantal: 0, resultaten: [], opmerking: 'Rechtspraak.nl API tijdelijk niet beschikbaar als JSON-service.' });
    }

    const data = await response.json();

    const resultaten = (data.resultaten || data.Results || []).slice(0, 5).map(item => ({
      ecli: item.DeeplinkUrl || item.ecli || item.TitelEmphasis || '',
      titel: item.Titel || item.titel || '',
      instantie: item.Instantie || item.instantie || '',
      datum: item.Datum || item.datum || item.UitspraakDatum || '',
      samenvatting: (item.Samenvatting || item.samenvatting || '').slice(0, 300),
      link: item.DeeplinkUrl
        ? `https://uitspraken.rechtspraak.nl${item.DeeplinkUrl}`
        : item.link || ''
    }));

    return res.status(200).json({
      aantal: resultaten.length,
      resultaten
    });
  } catch (error) {
    console.error('Rechtspraak proxy error:', error);
    return res.status(500).json({ error: 'Fout bij het ophalen van rechtspraak gegevens.' });
  }
};
