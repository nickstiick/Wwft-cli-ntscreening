const { createMollieClient } = require('@mollie/api-client');
const { kv } = require('@vercel/kv');
const { Resend } = require('resend');
const { generateActivatiecode } = require('./admin');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { id } = req.body;
  if (!id) {
    return res.status(400).json({ error: 'Geen payment ID ontvangen.' });
  }

  try {
    const mollieClient = createMollieClient({ apiKey: process.env.MOLLIE_API_KEY });
    const payment = await mollieClient.payments.get(id);

    if (payment.status !== 'paid') {
      return res.status(200).json({ status: payment.status });
    }

    const { bundel, email, rapporten } = payment.metadata;

    // Genereer activatiecode (geen O/0/I/1 tekens)
    const activatiecode = generateActivatiecode();

    const geldigTot = new Date();
    geldigTot.setFullYear(geldigTot.getFullYear() + 1);

    const record = {
      email,
      credits_totaal: parseInt(rapporten, 10),
      credits_gebruikt: 0,
      bundel,
      aangemaakt_op: new Date().toISOString(),
      geldig_tot: geldigTot.toISOString(),
      mollie_payment_id: id
    };

    // Sla op in Vercel KV (365 dagen TTL)
    await kv.set(activatiecode, JSON.stringify(record), { ex: 365 * 24 * 60 * 60 });

    // Stuur e-mail met activatiecode
    const resend = new Resend(process.env.RESEND_API_KEY);
    const bundelNamen = { starter: 'Starter', kantoor: 'Kantoor', jaarcontract: 'Jaarcontract' };
    const datumFormatted = geldigTot.toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });

    await resend.emails.send({
      from: 'Dossier <noreply@dossier.nl>',
      to: email,
      subject: `Uw Dossier activatiecode — ${bundelNamen[bundel]}`,
      html: `
        <div style="font-family: 'Georgia', serif; max-width: 560px; margin: 0 auto; padding: 40px 20px;">
          <h2 style="color: #1a1a2e; margin-bottom: 24px;">Uw activatiecode</h2>
          <p style="color: #444; line-height: 1.6;">Geachte heer/mevrouw,</p>
          <p style="color: #444; line-height: 1.6;">Bedankt voor uw aankoop. Hieronder vindt u uw activatiecode:</p>
          <div style="background: #f8f7f4; border: 2px solid #1a1a2e; border-radius: 8px; padding: 20px; text-align: center; margin: 24px 0;">
            <span style="font-family: monospace; font-size: 22px; font-weight: bold; color: #1a1a2e; letter-spacing: 2px;">
              ${activatiecode}
            </span>
          </div>
          <p style="color: #444; line-height: 1.6;">
            <strong>${bundelNamen[bundel]}</strong>: ${rapporten} rapporten · geldig tot ${datumFormatted}
          </p>
          <p style="color: #444; line-height: 1.6;">
            Hiermee kunt u ${rapporten} screenings uitvoeren op <a href="https://dossier.nl/screener" style="color: #1a1a2e;">dossier.nl/screener</a>. Voer de code eenmalig in — daarna screent u zonder onderbreking. Credits zijn geldig tot ${datumFormatted}.
          </p>
          <p style="color: #444; line-height: 1.6;">
            Bewaar deze code op een veilige plek.
          </p>
          <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 32px 0;">
          <p style="color: #999; font-size: 13px; line-height: 1.5;">
            Met vriendelijke groet,<br>Dossier
          </p>
        </div>
      `
    });

    return res.status(200).json({ status: 'paid', activatiecode });
  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(500).json({ error: 'Webhook verwerking mislukt.' });
  }
};
