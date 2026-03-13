const { createMollieClient } = require('@mollie/api-client');

const BUNDELS = {
  starter: {
    naam: 'Starter',
    rapporten: 5,
    prijs: '45.00',
    beschrijving: 'Dossier Starter — 5 rapporten'
  },
  kantoor: {
    naam: 'Kantoor',
    rapporten: 25,
    prijs: '175.00',
    beschrijving: 'Dossier Kantoor — 25 rapporten'
  },
  jaarcontract: {
    naam: 'Jaarcontract',
    rapporten: 100,
    prijs: '499.00',
    beschrijving: 'Dossier Jaarcontract — 100 rapporten'
  }
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

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
      amount: {
        currency: 'EUR',
        value: bundelInfo.prijs
      },
      description: bundelInfo.beschrijving,
      redirectUrl: `${getBaseUrl(req)}/betaald`,
      webhookUrl: `${getBaseUrl(req)}/api/webhook`,
      metadata: {
        bundel,
        email,
        rapporten: bundelInfo.rapporten
      },
      method: ['ideal', 'creditcard']
    });

    return res.status(200).json({ checkoutUrl: payment.getCheckoutUrl() });
  } catch (error) {
    console.error('Mollie checkout error:', error);
    return res.status(500).json({ error: 'Er ging iets mis bij het aanmaken van de betaling. Probeer het opnieuw.' });
  }
};

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}
