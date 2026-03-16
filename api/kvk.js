// KvK Handelsregister HTTP handler — delegates to shared _kvk.js module
const { zoeken, basisprofiel, vestigingsprofiel, naamgeving } = require('./_kvk');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { naam, kvk, vestiging, profiel, actie } = req.query;

  try {
    // Basisprofiel ophalen
    if (actie === 'basisprofiel' && kvk) {
      const data = await basisprofiel(kvk);
      if (!data) return res.status(404).json({ error: 'KvK-nummer niet gevonden.' });
      return res.status(200).json(data);
    }

    // Vestigingsprofiel ophalen
    if (actie === 'vestigingsprofiel' && vestiging) {
      const data = await vestigingsprofiel(vestiging);
      if (!data) return res.status(404).json({ error: 'Vestigingsnummer niet gevonden.' });
      return res.status(200).json(data);
    }

    // Naamgeving ophalen
    if (actie === 'naamgeving' && kvk) {
      const data = await naamgeving(kvk);
      if (!data) return res.status(404).json({ error: 'Naamgeving niet gevonden.' });
      return res.status(200).json(data);
    }

    // Standaard: zoeken
    if (!naam && !kvk) {
      return res.status(400).json({ error: 'Parameter "naam" of "kvk" is verplicht.' });
    }

    const zoekParams = {};
    if (kvk) zoekParams.kvkNummer = kvk;
    else zoekParams.naam = naam;

    const resultaten = await zoeken(zoekParams);

    // Auto-enrich: haal basisprofiel op voor eerste resultaat
    let basisprofielData = null;
    if (profiel === 'true' && resultaten.length > 0 && resultaten[0].kvkNummer) {
      try {
        basisprofielData = await basisprofiel(resultaten[0].kvkNummer);
      } catch (e) {
        console.warn('Basisprofiel ophalen mislukt:', e.message);
      }
    }

    return res.status(200).json({
      aantal: resultaten.length,
      resultaten,
      basisprofiel: basisprofielData
    });
  } catch (error) {
    console.error('KvK proxy error:', error);
    return res.status(500).json({ error: 'Fout bij het ophalen van KvK gegevens.' });
  }
};
