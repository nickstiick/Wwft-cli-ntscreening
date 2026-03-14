module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { naam, kvk } = req.query;
  if (!naam && !kvk) {
    return res.status(400).json({ error: 'Parameter "naam" of "kvk" is verplicht.' });
  }

  try {
    let searchUrl;
    if (kvk) {
      searchUrl = `https://api.kvk.nl/api/v1/zoeken?kvkNummer=${encodeURIComponent(kvk)}&pagina=1&resultatenPerPagina=3`;
    } else {
      searchUrl = `https://api.kvk.nl/api/v1/zoeken?naam=${encodeURIComponent(naam)}&pagina=1&resultatenPerPagina=3`;
    }

    const response = await fetch(searchUrl, {
      headers: {
        'apikey': process.env.KVK_API_KEY,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      console.error('KvK API status:', response.status);
      return res.status(502).json({ error: 'KvK API niet bereikbaar.' });
    }

    const data = await response.json();

    const resultaten = (data.resultaten || []).slice(0, 3).map(item => ({
      kvkNummer: item.kvkNummer || '',
      naam: item.naam || '',
      type: item.type || '',
      adres: item.adres
        ? `${item.adres.binnenlandsAdres?.straatnaam || ''} ${item.adres.binnenlandsAdres?.huisnummer || ''}, ${item.adres.binnenlandsAdres?.postcode || ''} ${item.adres.binnenlandsAdres?.plaats || ''}`
        : '',
      actief: item.actief !== false
    }));

    return res.status(200).json({
      aantal: resultaten.length,
      resultaten
    });
  } catch (error) {
    console.error('KvK proxy error:', error);
    return res.status(500).json({ error: 'Fout bij het ophalen van KvK gegevens.' });
  }
};
