const supabase = require('./_supabase');

// Alfabet zonder verwarrende tekens (geen O/0/I/1)
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCodeSegment(len) {
  let segment = '';
  for (let i = 0; i < len; i++) {
    segment += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return segment;
}

function generateActivatiecode() {
  return `DOSS-${generateCodeSegment(4)}-${generateCodeSegment(4)}-${generateCodeSegment(4)}`;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Beveilig met ADMIN_SECRET
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '').trim();

  if (!token || token !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Niet geautoriseerd.' });
  }

  const { credits, email, notitie } = req.body;

  if (!credits || typeof credits !== 'number' || credits < 1) {
    return res.status(400).json({ error: 'Geef een geldig aantal credits op (minimaal 1).' });
  }

  try {
    const activatiecode = generateActivatiecode();
    const geldigTot = new Date();
    geldigTot.setFullYear(geldigTot.getFullYear() + 1);

    const { error } = await supabase
      .from('activatiecodes')
      .insert({
        code: activatiecode,
        email: email || null,
        credits_totaal: credits,
        credits_gebruikt: 0,
        bundel: 'admin',
        aangemaakt_op: new Date().toISOString(),
        geldig_tot: geldigTot.toISOString(),
        notitie: notitie || null,
        bron: 'admin'
      });

    if (error) {
      console.error('Supabase insert error:', error);
      return res.status(500).json({ error: 'Fout bij het aanmaken van de code.' });
    }

    return res.status(200).json({
      code: activatiecode,
      credits,
      aangemaakt: new Date().toISOString(),
      geldig_tot: geldigTot.toISOString()
    });
  } catch (error) {
    console.error('Admin code error:', error);
    return res.status(500).json({ error: 'Fout bij het aanmaken van de code.' });
  }
};

// Export for reuse in webhook.js
module.exports.generateActivatiecode = generateActivatiecode;
