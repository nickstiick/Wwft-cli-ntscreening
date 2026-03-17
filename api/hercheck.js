// Hercheck endpoint (privacy by design — alleen anoniem referentienummer)
//
// GET /api/hercheck?secret=ADMIN_SECRET — cron: stuur hercheck reminders
// GET /api/hercheck?code=DOSS-XXX — haal herchecks op voor activatiecode
// GET /api/hercheck?referentie=SCR-XXXX-XXXX — opzoeken op referentienummer

const supabase = require('./_supabase');
const { Resend } = require('resend');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { secret, code, referentie } = req.query;

  // ─── CRON: hercheck reminders versturen ──────────────────
  if (secret) {
    if (secret !== process.env.ADMIN_SECRET) {
      return res.status(401).json({ error: 'Niet geautoriseerd.' });
    }

    try {
      const vandaag = new Date().toISOString().slice(0, 10);
      const { data: dueHerchecks, error } = await supabase
        .from('herchecks')
        .select('id, referentie, risico_niveau, hercheck_datum, hercheck_interval_maanden, hercheck_email, tenant_id, activatiecode')
        .eq('actief', true)
        .lte('hercheck_datum', vandaag)
        .order('hercheck_datum', { ascending: true })
        .limit(50);

      if (error) {
        console.error('Hercheck query error:', error);
        return res.status(500).json({ error: 'Fout bij ophalen herchecks.' });
      }

      if (!dueHerchecks || dueHerchecks.length === 0) {
        return res.status(200).json({ status: 'ok', verstuurd: 0, message: 'Geen herchecks verschuldigd.' });
      }

      const resend = new Resend(process.env.RESEND_API_KEY);
      let verstuurd = 0;

      for (const h of dueHerchecks) {
        // E-mail adres bepalen
        let toEmail = h.hercheck_email;
        if (!toEmail && h.tenant_id) {
          const { data: tenant } = await supabase.from('tenants').select('email').eq('id', h.tenant_id).single();
          toEmail = tenant?.email;
        }
        if (!toEmail && h.activatiecode) {
          const { data: codeRecord } = await supabase.from('activatiecodes').select('email').eq('code', h.activatiecode).single();
          toEmail = codeRecord?.email;
        }
        if (!toEmail) continue;

        const risicoKleur = h.risico_niveau === 'hoog' ? '#c0392b' : h.risico_niveau === 'verhoogd' ? '#e67e22' : '#27ae60';

        try {
          await resend.emails.send({
            from: 'Dossier <noreply@dossier.nl>',
            to: toEmail,
            subject: `Herscreening verschuldigd: ${h.referentie}`,
            html: `
              <div style="font-family: 'Georgia', serif; max-width: 560px; margin: 0 auto; padding: 40px 20px;">
                <h2 style="color: #1a1a2e; margin-bottom: 24px;">Herscreening verschuldigd</h2>
                <p style="color: #444; line-height: 1.6;">Een eerder gescreende cliënt is toe aan een herscreening conform uw Wwft-beleid.</p>
                <div style="background: #f8f7f4; border: 2px solid #e67e22; border-radius: 8px; padding: 20px; margin: 24px 0;">
                  <p style="margin: 0; color: #333;"><strong>Referentienummer:</strong> ${h.referentie}</p>
                  <p style="margin: 4px 0 0; color: #666;">Hercheck-datum: ${h.hercheck_datum}</p>
                  <p style="margin: 4px 0 0; color: #666;">Risico: <strong style="color: ${risicoKleur};">${h.risico_niveau || 'onbekend'}</strong></p>
                  <p style="margin: 4px 0 0; color: #666;">Interval: elke ${h.hercheck_interval_maanden} maanden</p>
                </div>
                <p style="color: #444; line-height: 1.6;">Zoek dit referentienummer op in uw dossier en voer een nieuwe screening uit.</p>
                <p><a href="https://dossier.nl/screener" style="display: inline-block; background: #1a1a2e; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; margin-top: 12px;">Herscreening uitvoeren</a></p>
                <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 32px 0;">
                <p style="color: #999; font-size: 13px;">Dit is een geautomatiseerde herinnering. Het referentienummer is anoniem — er worden geen persoonsgegevens opgeslagen.</p>
              </div>
            `
          });
          verstuurd++;
        } catch (emailErr) {
          console.error('Hercheck email error voor', h.referentie, emailErr);
        }

        // Volgende hercheck-datum instellen
        const volgendeDatum = new Date(h.hercheck_datum);
        volgendeDatum.setMonth(volgendeDatum.getMonth() + (h.hercheck_interval_maanden || 12));
        await supabase.from('herchecks').update({
          hercheck_datum: volgendeDatum.toISOString().slice(0, 10)
        }).eq('id', h.id);
      }

      return res.status(200).json({ status: 'ok', verstuurd, totaal: dueHerchecks.length });
    } catch (error) {
      console.error('Hercheck cron error:', error);
      return res.status(500).json({ error: 'Hercheck verwerking mislukt.' });
    }
  }

  // ─── OPZOEKEN: per referentienummer ───────────────────────
  if (referentie) {
    try {
      const { data: hercheck, error } = await supabase
        .from('herchecks')
        .select('referentie, risico_niveau, hercheck_datum, hercheck_interval_maanden, actief, aangemaakt_op')
        .eq('referentie', referentie.toUpperCase())
        .single();

      if (error || !hercheck) {
        return res.status(404).json({ error: 'Referentienummer niet gevonden.' });
      }

      return res.status(200).json(hercheck);
    } catch (error) {
      return res.status(500).json({ error: 'Fout bij opzoeken.' });
    }
  }

  // ─── OVERZICHT: per activatiecode ─────────────────────────
  if (code) {
    try {
      const { data: herchecks, error } = await supabase
        .from('herchecks')
        .select('referentie, risico_niveau, hercheck_datum, hercheck_interval_maanden, actief, aangemaakt_op')
        .eq('activatiecode', code.toUpperCase())
        .eq('actief', true)
        .order('hercheck_datum', { ascending: true });

      if (error) return res.status(500).json({ error: 'Fout bij ophalen herchecks.' });
      return res.status(200).json({ herchecks: herchecks || [] });
    } catch (error) {
      return res.status(500).json({ error: 'Fout bij ophalen herchecks.' });
    }
  }

  return res.status(400).json({ error: 'Parameter "secret" (cron), "referentie" of "code" is verplicht.' });
};
