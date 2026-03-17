// Payment endpoint: checkout (POST met actie=checkout) en webhook (POST met actie=webhook)
// Gecombineerd uit checkout.js + webhook.js

const { createMollieClient } = require('@mollie/api-client');
const supabase = require('./_supabase');
const { Resend } = require('resend');
const { generateActivatiecode } = require('./admin');

const BUNDELS = {
  starter: { naam: 'Starter', rapporten: 5, prijs: '45.00', beschrijving: 'Dossier Starter — 5 rapporten' },
  kantoor: { naam: 'Kantoor', rapporten: 25, prijs: '175.00', beschrijving: 'Dossier Kantoor — 25 rapporten' },
  jaarcontract: { naam: 'Jaarcontract', rapporten: 100, prijs: '499.00', beschrijving: 'Dossier Jaarcontract — 100 rapporten' }
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { actie } = req.body;

  // Default: als geen actie maar wel bundel → checkout; als id → webhook
  if (actie === 'webhook' || (!actie && req.body.id && !req.body.bundel)) {
    return handleWebhook(req, res);
  }
  return handleCheckout(req, res);
};

// ─── CHECKOUT ──────────────────────────────────────────────
async function handleCheckout(req, res) {
  const { bundel, email } = req.body;

  if (!bundel || !email || !BUNDELS[bundel]) {
    return res.status(400).json({ error: 'Ongeldig verzoek. Kies een bundel en vul uw e-mailadres in.' });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Ongeldig e-mailadres.' });
  }

  try {
    const mollieClient = createMollieClient({ apiKey: process.env.MOLLIE_API_KEY });
    const bundelInfo = BUNDELS[bundel];

    const payment = await mollieClient.payments.create({
      amount: { currency: 'EUR', value: bundelInfo.prijs },
      description: bundelInfo.beschrijving,
      redirectUrl: `${getBaseUrl(req)}/betaald`,
      webhookUrl: process.env.MOLLIE_WEBHOOK_URL || `${getBaseUrl(req)}/api/payment`,
      metadata: { bundel, email, rapporten: bundelInfo.rapporten },
      method: ['ideal', 'creditcard']
    });

    return res.status(200).json({ checkoutUrl: payment.getCheckoutUrl() });
  } catch (error) {
    console.error('Mollie checkout error:', error);
    return res.status(500).json({ error: 'Er ging iets mis bij het aanmaken van de betaling. Probeer het opnieuw.' });
  }
}

// ─── WEBHOOK ───────────────────────────────────────────────
async function handleWebhook(req, res) {
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
    const activatiecode = generateActivatiecode();
    const geldigTot = new Date();
    geldigTot.setFullYear(geldigTot.getFullYear() + 1);

    const { error: insertError } = await supabase
      .from('activatiecodes')
      .insert({
        code: activatiecode, email,
        credits_totaal: parseInt(rapporten, 10), credits_gebruikt: 0,
        bundel, aangemaakt_op: new Date().toISOString(),
        geldig_tot: geldigTot.toISOString(), mollie_payment_id: id, bron: 'mollie'
      });

    if (insertError) {
      console.error('Supabase insert error:', insertError);
      return res.status(500).json({ error: 'Fout bij opslaan activatiecode.' });
    }

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
            <span style="font-family: monospace; font-size: 22px; font-weight: bold; color: #1a1a2e; letter-spacing: 2px;">${activatiecode}</span>
          </div>
          <p style="color: #444; line-height: 1.6;">
            <strong>${bundelNamen[bundel]}</strong>: ${rapporten} rapporten · geldig tot ${datumFormatted}
          </p>
          <p style="color: #444; line-height: 1.6;">
            Hiermee kunt u ${rapporten} screenings uitvoeren op <a href="https://dossier.nl/screener" style="color: #1a1a2e;">dossier.nl/screener</a>. Voer de code eenmalig in — daarna screent u zonder onderbreking. Credits zijn geldig tot ${datumFormatted}.
          </p>
          <p style="color: #444; line-height: 1.6;">Bewaar deze code op een veilige plek.</p>
          <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 32px 0;">
          <p style="color: #999; font-size: 13px; line-height: 1.5;">Met vriendelijke groet,<br>Dossier</p>
        </div>
      `
    });

    return res.status(200).json({ status: 'paid', activatiecode });
  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(500).json({ error: 'Webhook verwerking mislukt.' });
  }
}

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}
