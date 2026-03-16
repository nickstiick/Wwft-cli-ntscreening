const supabase = require('./_supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { code, gebruik } = req.body;

  if (!code) {
    return res.status(400).json({ error: 'Geen activatiecode opgegeven.' });
  }

  // Valideer formaat (geen O/0/I/1)
  const codeRegex = /^DOSS-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
  if (!codeRegex.test(code.toUpperCase())) {
    return res.status(400).json({ error: 'Ongeldig codeformaat. Verwacht: DOSS-XXXX-XXXX-XXXX' });
  }

  try {
    const { data: record, error } = await supabase
      .from('activatiecodes')
      .select('*')
      .eq('code', code.toUpperCase())
      .single();

    if (error || !record) {
      return res.status(404).json({ error: 'Activatiecode niet gevonden of verlopen.' });
    }

    // Controleer geldigheid
    if (new Date(record.geldig_tot) < new Date()) {
      return res.status(410).json({ error: 'Uw activatiecode is verlopen. Koop een nieuwe bundel op dossier.nl.' });
    }

    const creditsOver = record.credits_totaal - record.credits_gebruikt;

    // Als gebruik=true, schrijf credits af (aantal: 1 standaard, 2 bij KvK)
    if (gebruik) {
      const aantal = Math.max(1, Math.min(parseInt(req.body.aantal) || 1, 5));

      if (creditsOver < aantal) {
        return res.status(402).json({
          error: aantal > 1
            ? `Niet genoeg credits. U heeft ${creditsOver} credit(s), maar deze screening kost ${aantal} credits (inclusief KvK opzoeken).`
            : 'Geen credits meer beschikbaar.',
          credits_over: creditsOver,
          koopUrl: '/'
        });
      }

      const { error: updateError } = await supabase
        .from('activatiecodes')
        .update({ credits_gebruikt: record.credits_gebruikt + aantal })
        .eq('code', code.toUpperCase());

      if (updateError) {
        console.error('Credit update error:', updateError);
        return res.status(500).json({ error: 'Fout bij het afschrijven van credit.' });
      }

      return res.status(200).json({
        geldig: true,
        credits_over: creditsOver - aantal,
        credits_totaal: record.credits_totaal,
        bundel: record.bundel,
        geldig_tot: record.geldig_tot,
        credits_afgeschreven: aantal
      });
    }

    // Alleen valideren, geen credit afschrijven
    return res.status(200).json({
      geldig: true,
      credits_over: creditsOver,
      credits_totaal: record.credits_totaal,
      bundel: record.bundel,
      geldig_tot: record.geldig_tot
    });
  } catch (error) {
    console.error('Activate error:', error);
    return res.status(500).json({ error: 'Er ging iets mis bij het valideren van uw code.' });
  }
};
