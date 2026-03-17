// Gebruik-overzicht endpoint (geen persoonsgegevens opgeslagen)
//
// GET /api/hercheck?code=DOSS-XXX — haal gebruiksoverzicht op voor activatiecode
// GET /api/hercheck?secret=ADMIN_SECRET — admin: alle activatiecodes overzicht

const supabase = require('./_supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { secret, code } = req.query;

  // ADMIN: overzicht alle activatiecodes
  if (secret) {
    if (secret !== process.env.ADMIN_SECRET) {
      return res.status(401).json({ error: 'Niet geautoriseerd.' });
    }

    try {
      const { data, error } = await supabase
        .from('activatiecodes')
        .select('code, credits_totaal, credits_gebruikt, geldig_tot, aangemaakt_op, tenant_id, tenants(kantoor_naam, email)')
        .order('aangemaakt_op', { ascending: false })
        .limit(100);

      if (error) return res.status(500).json({ error: 'Fout bij ophalen.' });

      const overzicht = (data || []).map(c => ({
        code: c.code,
        credits_totaal: c.credits_totaal,
        credits_gebruikt: c.credits_gebruikt,
        credits_resterend: c.credits_totaal - c.credits_gebruikt,
        geldig_tot: c.geldig_tot,
        kantoor: c.tenants?.kantoor_naam || null,
        email: c.tenants?.email || null
      }));

      return res.status(200).json({ overzicht });
    } catch (error) {
      console.error('Admin overzicht error:', error);
      return res.status(500).json({ error: 'Fout bij ophalen overzicht.' });
    }
  }

  // GEBRUIKER: overzicht per activatiecode
  if (code) {
    try {
      const { data: codeRecord, error } = await supabase
        .from('activatiecodes')
        .select('code, credits_totaal, credits_gebruikt, geldig_tot, aangemaakt_op')
        .eq('code', code.toUpperCase())
        .single();

      if (error || !codeRecord) {
        return res.status(404).json({ error: 'Code niet gevonden.' });
      }

      return res.status(200).json({
        code: codeRecord.code,
        credits_totaal: codeRecord.credits_totaal,
        credits_gebruikt: codeRecord.credits_gebruikt,
        credits_resterend: codeRecord.credits_totaal - codeRecord.credits_gebruikt,
        geldig_tot: codeRecord.geldig_tot,
        // Hercheck-info: niet meer server-side — hercheck-advies staat in het rapport/PDF
        opmerking: 'Herchecks worden niet meer server-side bijgehouden. Het hercheck-advies staat in uw screeningrapport (PDF).'
      });
    } catch (error) {
      console.error('Gebruiksoverzicht error:', error);
      return res.status(500).json({ error: 'Fout bij ophalen overzicht.' });
    }
  }

  return res.status(400).json({ error: 'Parameter "code" of "secret" is verplicht.' });
};
