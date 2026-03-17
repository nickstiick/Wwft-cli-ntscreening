// REST API v1: POST /api/v1 (screening) + GET /api/v1 (history)
// Gecombineerd uit v1-screen.js + v1-screenings.js

const supabase = require('./_supabase');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ─── API KEY AUTH ──────────────────────────
  const authHeader = req.headers.authorization || '';
  const apiKey = authHeader.replace('Bearer ', '').trim();

  if (!apiKey || !apiKey.startsWith('doss_')) {
    return res.status(401).json({ error: 'Geen geldige API key. Gebruik header: Authorization: Bearer doss_xxx' });
  }

  const { data: keyRecord, error: keyError } = await supabase
    .from('api_keys')
    .select('id, tenant_id, credits_totaal, credits_gebruikt, actief, geldig_tot')
    .eq('api_key', apiKey)
    .single();

  if (keyError || !keyRecord) return res.status(401).json({ error: 'API key niet gevonden.' });
  if (!keyRecord.actief) return res.status(403).json({ error: 'API key is gedeactiveerd.' });
  if (new Date(keyRecord.geldig_tot) < new Date()) return res.status(403).json({ error: 'API key is verlopen.' });

  if (req.method === 'POST') return handleScreen(req, res, keyRecord);
  if (req.method === 'GET') return handleScreenings(req, res, keyRecord);
  return res.status(405).json({ error: 'Method not allowed.' });
};

// ─── POST: nieuwe screening ────────────────────────────────
async function handleScreen(req, res, keyRecord) {
  const creditsOver = keyRecord.credits_totaal - keyRecord.credits_gebruikt;
  if (creditsOver <= 0) {
    return res.status(402).json({ error: 'Geen API credits meer beschikbaar.', credits_over: 0 });
  }

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

  req._apiKeyId = keyRecord.id;
  req._tenantId = keyRecord.tenant_id;

  const screenHandler = require('./screen');
  return screenHandler(req, res);
}

// ─── GET: API key gebruik overzicht ───────────────────────
async function handleScreenings(req, res, keyRecord) {
  // Geen screeningdata opgeslagen (privacy by design)
  // Alleen creditgebruik per API key
  return res.status(200).json({
    credits_totaal: keyRecord.credits_totaal,
    credits_gebruikt: keyRecord.credits_gebruikt,
    credits_resterend: keyRecord.credits_totaal - keyRecord.credits_gebruikt,
    geldig_tot: keyRecord.geldig_tot,
    opmerking: 'Screeningresultaten worden niet opgeslagen. Alle data wordt alleen in-memory verwerkt en direct naar de client gestuurd.'
  });
}
