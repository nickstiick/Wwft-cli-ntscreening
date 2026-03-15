const supabase = require('./_supabase');
const crypto = require('crypto');

function generateApiKey() {
  return 'doss_' + crypto.randomBytes(24).toString('hex');
}

module.exports = async function handler(req, res) {
  // POST: genereer een nieuwe API key
  if (req.method === 'POST') {
    const { email, naam, credits } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'E-mailadres is verplicht.' });
    }

    try {
      // Zoek tenant
      const { data: tenant } = await supabase
        .from('tenants')
        .select('id')
        .eq('email', email)
        .single();

      if (!tenant) {
        return res.status(404).json({ error: 'Maak eerst een tenant aan via /api/tenant.' });
      }

      const apiKey = generateApiKey();
      const geldigTot = new Date();
      geldigTot.setFullYear(geldigTot.getFullYear() + 1);

      const { data: key, error } = await supabase
        .from('api_keys')
        .insert({
          tenant_id: tenant.id,
          api_key: apiKey,
          naam: naam || 'API Key',
          credits_totaal: credits || 100,
          credits_gebruikt: 0,
          actief: true,
          geldig_tot: geldigTot.toISOString()
        })
        .select()
        .single();

      if (error) {
        console.error('API key insert error:', error);
        return res.status(500).json({ error: 'Fout bij aanmaken API key.' });
      }

      return res.status(200).json({
        api_key: apiKey,
        naam: key.naam,
        credits_totaal: key.credits_totaal,
        geldig_tot: key.geldig_tot,
        opmerking: 'Bewaar deze key veilig. Hij wordt niet opnieuw getoond.'
      });
    } catch (error) {
      console.error('API keys error:', error);
      return res.status(500).json({ error: 'Fout bij aanmaken API key.' });
    }
  }

  // DELETE: deactiveer API key
  if (req.method === 'DELETE') {
    const { api_key } = req.body;

    if (!api_key) {
      return res.status(400).json({ error: 'API key is verplicht.' });
    }

    const { error } = await supabase
      .from('api_keys')
      .update({ actief: false })
      .eq('api_key', api_key);

    if (error) {
      return res.status(500).json({ error: 'Fout bij deactiveren API key.' });
    }

    return res.status(200).json({ status: 'gedeactiveerd' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
