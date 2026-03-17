// Hercheck + KVK Mutatie endpoint (gecombineerd)
//
// GET  /api/hercheck?secret=ADMIN_SECRET — cron: stuur hercheck reminders
// GET  /api/hercheck?code=DOSS-XXX — haal herchecks op voor activatiecode
// GET  /api/hercheck?actie=kvk-status&secret=ADMIN_SECRET — KVK monitoring status
// POST /api/hercheck — KVK mutatie webhook (x-kvk-webhook-secret header)

const supabase = require('./_supabase');
const { Resend } = require('resend');

module.exports = async function handler(req, res) {
  if (req.method === 'POST') return handleKvkMutatie(req, res);
  if (req.method === 'GET') {
    if (req.query.actie === 'kvk-status') return handleKvkStatus(req, res);
    return handleHercheck(req, res);
  }
  return res.status(405).json({ error: 'Method not allowed' });
};

// ─── GET: hercheck cron + gebruiker ophalen ────────────────
async function handleHercheck(req, res) {
  const { secret, code, email } = req.query;

  // CRON: stuur hercheck reminders
  if (secret) {
    if (secret !== process.env.ADMIN_SECRET) {
      return res.status(401).json({ error: 'Niet geautoriseerd.' });
    }

    try {
      const vandaag = new Date().toISOString().slice(0, 10);
      const { data: dueScreenings, error } = await supabase
        .from('screenings')
        .select('id, naam, geboortedatum, type, risico_niveau, hercheck_email, hercheck_datum, hercheck_interval_maanden, tenant_id, activatiecode, medewerker, dossiernummer')
        .eq('hercheck_actief', true)
        .lte('hercheck_datum', vandaag)
        .order('hercheck_datum', { ascending: true })
        .limit(50);

      if (error) {
        console.error('Hercheck query error:', error);
        return res.status(500).json({ error: 'Fout bij ophalen herchecks.' });
      }

      if (!dueScreenings || dueScreenings.length === 0) {
        return res.status(200).json({ status: 'ok', verstuurd: 0, message: 'Geen herchecks verschuldigd.' });
      }

      const resend = new Resend(process.env.RESEND_API_KEY);
      let verstuurd = 0;

      for (const s of dueScreenings) {
        let toEmail = s.hercheck_email;
        if (!toEmail && s.tenant_id) {
          const { data: tenant } = await supabase.from('tenants').select('email').eq('id', s.tenant_id).single();
          toEmail = tenant?.email;
        }
        if (!toEmail && s.activatiecode) {
          const { data: codeRecord } = await supabase.from('activatiecodes').select('email').eq('code', s.activatiecode).single();
          toEmail = codeRecord?.email;
        }
        if (!toEmail) continue;

        try {
          await resend.emails.send({
            from: 'Dossier <noreply@dossier.nl>',
            to: toEmail,
            subject: `Herscreening verschuldigd: ${s.naam}`,
            html: `
              <div style="font-family: 'Georgia', serif; max-width: 560px; margin: 0 auto; padding: 40px 20px;">
                <h2 style="color: #1a1a2e; margin-bottom: 24px;">Herscreening verschuldigd</h2>
                <p style="color: #444; line-height: 1.6;">Een eerder gescreende cliënt is toe aan een herscreening conform uw Wwft-beleid:</p>
                <div style="background: #f8f7f4; border: 2px solid #e67e22; border-radius: 8px; padding: 20px; margin: 24px 0;">
                  <p style="margin: 0; color: #333;"><strong>Cliënt:</strong> ${s.naam}</p>
                  ${s.geboortedatum ? `<p style="margin: 4px 0 0; color: #666;">Geboortedatum: ${s.geboortedatum}</p>` : ''}
                  ${s.dossiernummer ? `<p style="margin: 4px 0 0; color: #666;">Dossiernummer: ${s.dossiernummer}</p>` : ''}
                  <p style="margin: 4px 0 0; color: #666;">Laatste screening: ${s.hercheck_datum}</p>
                  <p style="margin: 4px 0 0; color: #666;">Risico: <strong style="color: ${s.risico_niveau === 'hoog' ? '#c0392b' : s.risico_niveau === 'verhoogd' ? '#e67e22' : '#27ae60'};">${s.risico_niveau || 'onbekend'}</strong></p>
                </div>
                <p style="color: #444; line-height: 1.6;">Voer een nieuwe screening uit op <a href="https://dossier.nl/screener" style="color: #1a1a2e;">dossier.nl/screener</a></p>
                <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 32px 0;">
                <p style="color: #999; font-size: 13px;">Dit is een geautomatiseerde herinnering.</p>
              </div>
            `
          });
          verstuurd++;
        } catch (emailErr) {
          console.error('Hercheck email error voor', s.naam, emailErr);
        }

        const volgendeDatum = new Date(s.hercheck_datum);
        volgendeDatum.setMonth(volgendeDatum.getMonth() + (s.hercheck_interval_maanden || 12));
        await supabase.from('screenings').update({ hercheck_datum: volgendeDatum.toISOString().slice(0, 10) }).eq('id', s.id);
      }

      return res.status(200).json({ status: 'ok', verstuurd, totaal: dueScreenings.length });
    } catch (error) {
      console.error('Hercheck cron error:', error);
      return res.status(500).json({ error: 'Hercheck verwerking mislukt.' });
    }
  }

  // GEBRUIKER: haal herchecks op
  if (code || email) {
    try {
      let tenantId = null;
      if (code) {
        const { data: codeRecord } = await supabase.from('activatiecodes').select('tenant_id').eq('code', code.toUpperCase()).single();
        tenantId = codeRecord?.tenant_id;
      } else if (email) {
        const { data: tenant } = await supabase.from('tenants').select('id').eq('email', email).single();
        tenantId = tenant?.id;
      }

      if (!tenantId) return res.status(404).json({ error: 'Geen tenant gevonden.', herchecks: [] });

      const { data: herchecks } = await supabase
        .from('screenings')
        .select('id, naam, geboortedatum, type, risico_niveau, risico_score, hercheck_datum, hercheck_interval_maanden, medewerker, dossiernummer, aangemaakt_op')
        .eq('tenant_id', tenantId)
        .eq('hercheck_actief', true)
        .order('hercheck_datum', { ascending: true });

      return res.status(200).json({ herchecks: herchecks || [] });
    } catch (error) {
      console.error('Hercheck ophalen error:', error);
      return res.status(500).json({ error: 'Fout bij ophalen herchecks.' });
    }
  }

  return res.status(400).json({ error: 'Parameter "secret" (cron) of "code"/"email" (gebruiker) is verplicht.' });
}

// ─── POST: KVK mutatie webhook ─────────────────────────────
async function handleKvkMutatie(req, res) {
  const kvkSecret = req.headers['x-kvk-webhook-secret'];
  if (!kvkSecret || kvkSecret !== process.env.KVK_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Niet geautoriseerd.' });
  }

  const { kvkNummer, mutatieType, mutatieOmschrijving, mutatiedatum } = req.body;
  if (!kvkNummer) return res.status(400).json({ error: 'kvkNummer is verplicht.' });

  try {
    const { data: monitors, error } = await supabase
      .from('kvk_monitoring')
      .select('id, tenant_id, bedrijfsnaam, laatste_screening_id, tenants(email, kantoor_naam)')
      .eq('kvk_nummer', kvkNummer)
      .eq('actief', true);

    if (error) {
      console.error('KVK mutatie query error:', error);
      return res.status(500).json({ error: 'Fout bij ophalen monitors.' });
    }

    if (!monitors || monitors.length === 0) {
      return res.status(200).json({ status: 'ok', actie: 'geen_monitor', kvkNummer });
    }

    let notificaties = 0;

    for (const monitor of monitors) {
      await supabase.from('kvk_monitoring').update({
        laatste_mutatie: { mutatieType, mutatieOmschrijving, mutatiedatum, ontvangen: new Date().toISOString() },
        laatste_check: new Date().toISOString()
      }).eq('id', monitor.id);

      if (monitor.laatste_screening_id) {
        await supabase.from('screenings').update({
          hercheck_datum: new Date().toISOString().slice(0, 10),
          hercheck_actief: true
        }).eq('id', monitor.laatste_screening_id);
      }

      const toEmail = monitor.tenants?.email;
      if (toEmail && process.env.RESEND_API_KEY) {
        try {
          const resend = new Resend(process.env.RESEND_API_KEY);
          await resend.emails.send({
            from: 'Dossier <noreply@dossier.nl>',
            to: toEmail,
            subject: `KVK wijziging: ${monitor.bedrijfsnaam || kvkNummer}`,
            html: `
              <div style="font-family: 'Georgia', serif; max-width: 560px; margin: 0 auto; padding: 40px 20px;">
                <h2 style="color: #1a1a2e; margin-bottom: 24px;">KVK Wijziging gedetecteerd</h2>
                <p style="color: #444; line-height: 1.6;">Er is een wijziging geregistreerd bij de KvK voor een bedrijf dat u monitort:</p>
                <div style="background: #f8f7f4; border: 2px solid #e67e22; border-radius: 8px; padding: 20px; margin: 24px 0;">
                  <p style="margin: 0; color: #333;"><strong>Bedrijf:</strong> ${monitor.bedrijfsnaam || 'Onbekend'}</p>
                  <p style="margin: 4px 0 0; color: #666;">KVK-nummer: ${kvkNummer}</p>
                  ${mutatieType ? `<p style="margin: 4px 0 0; color: #666;">Type wijziging: <strong>${mutatieType}</strong></p>` : ''}
                  ${mutatieOmschrijving ? `<p style="margin: 4px 0 0; color: #666;">${mutatieOmschrijving}</p>` : ''}
                  ${mutatiedatum ? `<p style="margin: 4px 0 0; color: #666;">Mutatiedatum: ${mutatiedatum}</p>` : ''}
                </div>
                <p style="color: #444; line-height: 1.6;"><strong>Aanbeveling:</strong> Voer een herscreening uit om te beoordelen of deze wijziging gevolgen heeft voor uw Wwft-beoordeling.</p>
                <p style="color: #444; line-height: 1.6;"><a href="https://dossier.nl/screener" style="display: inline-block; background: #1a1a2e; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; margin-top: 12px;">Herscreening uitvoeren</a></p>
                <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 32px 0;">
                <p style="color: #999; font-size: 13px;">Dit is een geautomatiseerde notificatie op basis van KVK Mutatieservice monitoring.</p>
              </div>
            `
          });
          notificaties++;
        } catch (emailErr) {
          console.error('KVK mutatie email error:', emailErr);
        }
      }
    }

    return res.status(200).json({ status: 'ok', kvkNummer, monitors_gevonden: monitors.length, notificaties_verstuurd: notificaties });
  } catch (error) {
    console.error('KVK mutatie error:', error);
    return res.status(500).json({ error: 'Fout bij verwerken mutatie.' });
  }
}

// ─── GET: KVK monitoring status ────────────────────────────
async function handleKvkStatus(req, res) {
  const { secret, tenant_id } = req.query;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Niet geautoriseerd.' });
  }

  try {
    let query = supabase
      .from('kvk_monitoring')
      .select('id, kvk_nummer, bedrijfsnaam, laatste_check, laatste_mutatie, actief, aangemaakt_op, tenants(kantoor_naam)')
      .eq('actief', true)
      .order('aangemaakt_op', { ascending: false });

    if (tenant_id) query = query.eq('tenant_id', tenant_id);

    const { data, error } = await query.limit(100);
    if (error) return res.status(500).json({ error: 'Fout bij ophalen monitoring status.' });
    return res.status(200).json({ monitors: data || [] });
  } catch (error) {
    console.error('KVK monitoring status error:', error);
    return res.status(500).json({ error: 'Fout bij ophalen monitoring status.' });
  }
}
