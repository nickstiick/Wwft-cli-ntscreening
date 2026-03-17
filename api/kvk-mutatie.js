// KVK Mutatieservice webhook endpoint
// Ontvangt mutatie-notificaties van de KVK Mutatieservice en triggert herchecks
//
// POST /api/kvk-mutatie — ontvang mutatie van KVK
// GET  /api/kvk-mutatie?secret=ADMIN_SECRET — handmatige check (poll alle gemonitorde KVK-nummers)
//
// Toekomstig: wanneer KVK Mutatieservice contract is afgesloten,
// configureer deze URL als webhook endpoint bij KVK.

const supabase = require('./_supabase');

module.exports = async function handler(req, res) {
  // ─── POST: ontvang mutatie-notificatie van KVK ──────
  if (req.method === 'POST') {
    // Verifieer dat het request van KVK komt
    const kvkSecret = req.headers['x-kvk-webhook-secret'];
    if (!kvkSecret || kvkSecret !== process.env.KVK_WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'Niet geautoriseerd.' });
    }

    const { kvkNummer, mutatieType, mutatieOmschrijving, mutatiedatum } = req.body;

    if (!kvkNummer) {
      return res.status(400).json({ error: 'kvkNummer is verplicht.' });
    }

    try {
      // Zoek alle actieve monitors voor dit KVK-nummer
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
        // Geen monitor actief voor dit KVK-nummer — gewoon bevestigen
        return res.status(200).json({ status: 'ok', actie: 'geen_monitor', kvkNummer });
      }

      // Sla mutatie op en stuur notificatie per tenant
      let notificaties = 0;

      for (const monitor of monitors) {
        // Update laatste mutatie info
        await supabase
          .from('kvk_monitoring')
          .update({
            laatste_mutatie: { mutatieType, mutatieOmschrijving, mutatiedatum, ontvangen: new Date().toISOString() },
            laatste_check: new Date().toISOString()
          })
          .eq('id', monitor.id);

        // Markeer gekoppelde screening voor hercheck (zet hercheck_datum op vandaag)
        if (monitor.laatste_screening_id) {
          await supabase
            .from('screenings')
            .update({
              hercheck_datum: new Date().toISOString().slice(0, 10),
              hercheck_actief: true
            })
            .eq('id', monitor.laatste_screening_id);
        }

        // E-mail notificatie (als Resend beschikbaar is)
        const toEmail = monitor.tenants?.email;
        if (toEmail && process.env.RESEND_API_KEY) {
          try {
            const { Resend } = require('resend');
            const resend = new Resend(process.env.RESEND_API_KEY);

            await resend.emails.send({
              from: 'Dossier <noreply@dossier.nl>',
              to: toEmail,
              subject: `KVK wijziging: ${monitor.bedrijfsnaam || kvkNummer}`,
              html: `
                <div style="font-family: 'Georgia', serif; max-width: 560px; margin: 0 auto; padding: 40px 20px;">
                  <h2 style="color: #1a1a2e; margin-bottom: 24px;">KVK Wijziging gedetecteerd</h2>
                  <p style="color: #444; line-height: 1.6;">Er is een wijziging geregistreerd bij de Kamer van Koophandel voor een bedrijf dat u monitort:</p>
                  <div style="background: #f8f7f4; border: 2px solid #e67e22; border-radius: 8px; padding: 20px; margin: 24px 0;">
                    <p style="margin: 0; color: #333;"><strong>Bedrijf:</strong> ${monitor.bedrijfsnaam || 'Onbekend'}</p>
                    <p style="margin: 4px 0 0; color: #666;">KVK-nummer: ${kvkNummer}</p>
                    ${mutatieType ? `<p style="margin: 4px 0 0; color: #666;">Type wijziging: <strong>${mutatieType}</strong></p>` : ''}
                    ${mutatieOmschrijving ? `<p style="margin: 4px 0 0; color: #666;">${mutatieOmschrijving}</p>` : ''}
                    ${mutatiedatum ? `<p style="margin: 4px 0 0; color: #666;">Mutatiedatum: ${mutatiedatum}</p>` : ''}
                  </div>
                  <p style="color: #444; line-height: 1.6;">
                    <strong>Aanbeveling:</strong> Voer een herscreening uit om te beoordelen of deze wijziging gevolgen heeft voor uw Wwft-beoordeling.
                  </p>
                  <p style="color: #444; line-height: 1.6;">
                    <a href="https://dossier.nl/screener" style="display: inline-block; background: #1a1a2e; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; margin-top: 12px;">Herscreening uitvoeren</a>
                  </p>
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

      return res.status(200).json({
        status: 'ok',
        kvkNummer,
        monitors_gevonden: monitors.length,
        notificaties_verstuurd: notificaties
      });
    } catch (error) {
      console.error('KVK mutatie error:', error);
      return res.status(500).json({ error: 'Fout bij verwerken mutatie.' });
    }
  }

  // ─── GET: handmatige check / status ──────────────
  if (req.method === 'GET') {
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

      if (tenant_id) {
        query = query.eq('tenant_id', tenant_id);
      }

      const { data, error } = await query.limit(100);

      if (error) {
        return res.status(500).json({ error: 'Fout bij ophalen monitoring status.' });
      }

      return res.status(200).json({ monitors: data || [] });
    } catch (error) {
      console.error('KVK monitoring status error:', error);
      return res.status(500).json({ error: 'Fout bij ophalen monitoring status.' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
