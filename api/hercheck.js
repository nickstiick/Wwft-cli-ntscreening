// Hercheck endpoint: stuurt e-mail reminders voor screenings die aan hercheck toe zijn
// Kan als cron job worden aangeroepen (bijv. dagelijks via Vercel Cron of externe service)
// GET /api/hercheck?secret=ADMIN_SECRET — stuurt reminders
// GET /api/hercheck?code=DOSS-XXX — haal herchecks op voor een activatiecode

const supabase = require('./_supabase');
const { Resend } = require('resend');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { secret, code, email } = req.query;

  // ─── CRON: stuur hercheck reminders ────────
  if (secret) {
    if (secret !== process.env.ADMIN_SECRET) {
      return res.status(401).json({ error: 'Niet geautoriseerd.' });
    }

    try {
      // Zoek screenings waar hercheck_datum vandaag of in het verleden is
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
        // Bepaal e-mailadres
        let toEmail = s.hercheck_email;

        if (!toEmail && s.tenant_id) {
          const { data: tenant } = await supabase
            .from('tenants')
            .select('email')
            .eq('id', s.tenant_id)
            .single();
          toEmail = tenant?.email;
        }

        if (!toEmail && s.activatiecode) {
          const { data: codeRecord } = await supabase
            .from('activatiecodes')
            .select('email')
            .eq('code', s.activatiecode)
            .single();
          toEmail = codeRecord?.email;
        }

        if (!toEmail) continue;

        // Stuur reminder e-mail
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
                <p style="color: #444; line-height: 1.6;">
                  Voer een nieuwe screening uit op <a href="https://dossier.nl/screener" style="color: #1a1a2e;">dossier.nl/screener</a>
                </p>
                <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 32px 0;">
                <p style="color: #999; font-size: 13px;">Dit is een geautomatiseerde herinnering. U kunt de hercheck uitschakelen in uw dossier.</p>
              </div>
            `
          });
          verstuurd++;
        } catch (emailErr) {
          console.error('Hercheck email error voor', s.naam, emailErr);
        }

        // Schuif hercheck datum op naar volgende interval
        const volgendeDatum = new Date(s.hercheck_datum);
        volgendeDatum.setMonth(volgendeDatum.getMonth() + (s.hercheck_interval_maanden || 12));

        await supabase
          .from('screenings')
          .update({ hercheck_datum: volgendeDatum.toISOString().slice(0, 10) })
          .eq('id', s.id);
      }

      return res.status(200).json({ status: 'ok', verstuurd, totaal: dueScreenings.length });
    } catch (error) {
      console.error('Hercheck cron error:', error);
      return res.status(500).json({ error: 'Hercheck verwerking mislukt.' });
    }
  }

  // ─── GEBRUIKER: haal herchecks op ──────────
  if (code || email) {
    try {
      let tenantId = null;

      if (code) {
        const { data: codeRecord } = await supabase
          .from('activatiecodes')
          .select('tenant_id')
          .eq('code', code.toUpperCase())
          .single();
        tenantId = codeRecord?.tenant_id;
      } else if (email) {
        const { data: tenant } = await supabase
          .from('tenants')
          .select('id')
          .eq('email', email)
          .single();
        tenantId = tenant?.id;
      }

      if (!tenantId) {
        return res.status(404).json({ error: 'Geen tenant gevonden.', herchecks: [] });
      }

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
};
