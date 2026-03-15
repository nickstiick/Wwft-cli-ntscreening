// REST API endpoint: GET /api/v1-screenings
// Haal screening historie op voor een tenant (API key auth)
// Query params: ?limit=20&offset=0&naam=zoekterm

const supabase = require('./_supabase');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // ─── API KEY AUTH ──────────────────────────
  const authHeader = req.headers.authorization || '';
  const apiKey = authHeader.replace('Bearer ', '').trim();

  if (!apiKey || !apiKey.startsWith('doss_')) {
    return res.status(401).json({ error: 'Geen geldige API key.' });
  }

  const { data: keyRecord } = await supabase
    .from('api_keys')
    .select('tenant_id, actief, geldig_tot')
    .eq('api_key', apiKey)
    .single();

  if (!keyRecord || !keyRecord.actief) {
    return res.status(401).json({ error: 'API key niet gevonden of gedeactiveerd.' });
  }

  if (new Date(keyRecord.geldig_tot) < new Date()) {
    return res.status(403).json({ error: 'API key is verlopen.' });
  }

  // ─── QUERY SCREENINGS ─────────────────────
  const { limit = '20', offset = '0', naam, id } = req.query;

  try {
    // Enkele screening ophalen via ID
    if (id) {
      const { data: screening, error } = await supabase
        .from('screenings')
        .select('*')
        .eq('id', id)
        .eq('tenant_id', keyRecord.tenant_id)
        .single();

      if (error || !screening) {
        return res.status(404).json({ error: 'Screening niet gevonden.' });
      }

      return res.status(200).json(screening);
    }

    // Lijst ophalen
    let query = supabase
      .from('screenings')
      .select('id, naam, geboortedatum, type, locatie, land, risico_niveau, risico_score, samenvatting, hercheck_datum, hercheck_actief, medewerker, dossiernummer, aangemaakt_op', { count: 'exact' })
      .eq('tenant_id', keyRecord.tenant_id)
      .order('aangemaakt_op', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (naam) {
      query = query.ilike('naam', `%${naam}%`);
    }

    const { data: screenings, count, error } = await query;

    if (error) {
      console.error('Screenings query error:', error);
      return res.status(500).json({ error: 'Fout bij ophalen screenings.' });
    }

    return res.status(200).json({
      screenings: screenings || [],
      totaal: count || 0,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('Screenings error:', error);
    return res.status(500).json({ error: 'Fout bij ophalen screenings.' });
  }
};
