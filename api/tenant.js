const supabase = require('./_supabase');
const crypto = require('crypto');

function generateApiKey() {
  return 'doss_' + crypto.randomBytes(24).toString('hex');
}

module.exports = async function handler(req, res) {
  // GET: haal tenant op via email of activatiecode
  if (req.method === 'GET') {
    const { email, code } = req.query;

    if (!email && !code) {
      return res.status(400).json({ error: 'Parameter "email" of "code" is verplicht.' });
    }

    try {
      let tenantEmail = email;

      // Als code meegegeven, zoek email via activatiecode
      if (code && !email) {
        const { data: codeRecord } = await supabase
          .from('activatiecodes')
          .select('email, tenant_id')
          .eq('code', code.toUpperCase())
          .single();

        if (!codeRecord?.email) {
          return res.status(404).json({ error: 'Geen tenant gevonden voor deze code.' });
        }
        tenantEmail = codeRecord.email;
      }

      const { data: tenant } = await supabase
        .from('tenants')
        .select('*')
        .eq('email', tenantEmail)
        .single();

      if (!tenant) {
        return res.status(404).json({ error: 'Tenant niet gevonden.' });
      }

      // Haal API keys op
      const { data: apiKeys } = await supabase
        .from('api_keys')
        .select('id, naam, api_key, credits_totaal, credits_gebruikt, actief, aangemaakt_op, geldig_tot')
        .eq('tenant_id', tenant.id)
        .order('aangemaakt_op', { ascending: false });

      return res.status(200).json({ ...tenant, api_keys: apiKeys || [] });
    } catch (error) {
      console.error('Tenant GET error:', error);
      return res.status(500).json({ error: 'Fout bij ophalen tenant.' });
    }
  }

  // POST: maak of update tenant, of beheer API keys via ?action=
  if (req.method === 'POST') {
    const action = req.query.action;

    // POST ?action=create-key: genereer nieuwe API key
    if (action === 'create-key') {
      const { email, naam, credits } = req.body;

      if (!email) {
        return res.status(400).json({ error: 'E-mailadres is verplicht.' });
      }

      try {
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

    // POST (default): maak of update tenant
    const { email, kantoor_naam, logo_url, kleur, adres, telefoon, website, disclaimer, code } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'E-mailadres is verplicht.' });
    }

    try {
      // Upsert tenant
      const { data: tenant, error } = await supabase
        .from('tenants')
        .upsert({
          email,
          kantoor_naam: kantoor_naam || null,
          logo_url: logo_url || null,
          kleur: kleur || '#1a1a2e',
          adres: adres || null,
          telefoon: telefoon || null,
          website: website || null,
          disclaimer: disclaimer || null
        }, { onConflict: 'email' })
        .select()
        .single();

      if (error) {
        console.error('Tenant upsert error:', error);
        return res.status(500).json({ error: 'Fout bij opslaan tenant.' });
      }

      // Koppel activatiecode aan tenant als meegegeven
      if (code) {
        await supabase
          .from('activatiecodes')
          .update({ tenant_id: tenant.id })
          .eq('code', code.toUpperCase());
      }

      // Koppel alle codes met hetzelfde email
      await supabase
        .from('activatiecodes')
        .update({ tenant_id: tenant.id })
        .eq('email', email)
        .is('tenant_id', null);

      return res.status(200).json(tenant);
    } catch (error) {
      console.error('Tenant POST error:', error);
      return res.status(500).json({ error: 'Fout bij opslaan tenant.' });
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
