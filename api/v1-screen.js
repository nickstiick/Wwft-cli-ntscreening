// REST API endpoint: POST /api/v1-screen
// Authenticatie via API key in header: Authorization: Bearer doss_xxx
// Dezelfde screening als /api/screen maar met API key auth + credit tracking

const supabase = require('./_supabase');

module.exports = async function handler(req, res) {
  // CORS headers voor API gebruik
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Gebruik POST.' });
  }

  // ─── API KEY AUTH ──────────────────────────
  const authHeader = req.headers.authorization || '';
  const apiKey = authHeader.replace('Bearer ', '').trim();

  if (!apiKey || !apiKey.startsWith('doss_')) {
    return res.status(401).json({
      error: 'Geen geldige API key. Gebruik header: Authorization: Bearer doss_xxx'
    });
  }

  // Valideer API key
  const { data: keyRecord, error: keyError } = await supabase
    .from('api_keys')
    .select('id, tenant_id, credits_totaal, credits_gebruikt, actief, geldig_tot')
    .eq('api_key', apiKey)
    .single();

  if (keyError || !keyRecord) {
    return res.status(401).json({ error: 'API key niet gevonden.' });
  }

  if (!keyRecord.actief) {
    return res.status(403).json({ error: 'API key is gedeactiveerd.' });
  }

  if (new Date(keyRecord.geldig_tot) < new Date()) {
    return res.status(403).json({ error: 'API key is verlopen.' });
  }

  const creditsOver = keyRecord.credits_totaal - keyRecord.credits_gebruikt;
  if (creditsOver <= 0) {
    return res.status(402).json({ error: 'Geen API credits meer beschikbaar.', credits_over: 0 });
  }

  // Credit afschrijven (atomic: alleen als credits_gebruikt nog niet boven limiet)
  const { data: updated, error: updateError } = await supabase
    .from('api_keys')
    .update({ credits_gebruikt: keyRecord.credits_gebruikt + 1 })
    .eq('id', keyRecord.id)
    .lt('credits_gebruikt', keyRecord.credits_totaal)
    .select('credits_gebruikt')
    .single();

  if (updateError || !updated) {
    return res.status(402).json({ error: 'Geen API credits meer beschikbaar.', credits_over: 0 });
  }

  // ─── SCREENING UITVOEREN ──────────────────
  // Voeg API key info toe aan request voor screen.js
  req._apiKeyId = keyRecord.id;
  req._tenantId = keyRecord.tenant_id;

  // Importeer en roep de screen handler aan
  const screenHandler = require('./screen');
  return screenHandler(req, res);
};
