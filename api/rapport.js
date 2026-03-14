// api/rapport.js — Server-side PDF generation via Puppeteer + @sparticuz/chromium
// Renders the screening report as HTML, converts to A4 PDF, returns as download

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { rapportData, whitelabel, analyse, sancties, zoekresultaten, queries, isProef } = req.body;

  if (!rapportData?.naam) {
    return res.status(400).json({ error: 'Rapportdata met naam is verplicht.' });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless
    });

    const page = await browser.newPage();
    const html = buildRapportHtml(rapportData, whitelabel, analyse, sancties, zoekresultaten, queries, isProef);

    await page.setContent(html, { waitUntil: 'networkidle0' });

    const pdf = await page.pdf({
      format: 'A4',
      margin: { top: '20mm', bottom: '20mm', left: '20mm', right: '20mm' },
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `
        <div style="width:100%; font-size:9px; color:#999; text-align:center; font-family:serif; padding:0 20mm;">
          <span>Dossier — Wwft cliëntscreening</span>
          <span style="float:right;">Pagina <span class="pageNumber"></span> van <span class="totalPages"></span></span>
        </div>
      `
    });

    const datum = new Date().toISOString().slice(0, 10);
    const naamClean = rapportData.naam.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9\-]/g, '').toLowerCase();
    const filename = `Wwft-${naamClean}-${datum}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdf.length);

    return res.status(200).end(pdf);
  } catch (error) {
    console.error('PDF generation error:', error);
    return res.status(500).json({ error: 'PDF generatie mislukt. Probeer het opnieuw.' });
  } finally {
    if (browser) await browser.close();
  }
};

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildRapportHtml(data, wl, analyse, sancties, zoekresultaten, queries, isProef) {
  const a = analyse || {};
  const wh = wl || {};
  const kleur = wh.kleur || '#1a1a2e';
  const niveauLabel = { laag: 'Laag risico', verhoogd: 'Verhoogd risico', hoog: 'Hoog risico', grijs: 'Onbekend' };
  const niveauKleur = { laag: '#27ae60', verhoogd: '#e67e22', hoog: '#c0392b', grijs: '#95a5a6' };
  const ernstKleur = { groen: '#27ae60', oranje: '#e67e22', rood: '#c0392b', grijs: '#95a5a6' };
  const niveau = a.risico_niveau || 'grijs';
  const rKleur = niveauKleur[niveau] || '#95a5a6';
  const tijdstip = data.tijdstip ? new Date(data.tijdstip).toLocaleString('nl-NL') : new Date().toLocaleString('nl-NL');

  let html = `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;0,700;1,400&display=swap');

  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Cormorant Garamond', Georgia, serif;
    color: #333;
    line-height: 1.6;
    font-size: 11pt;
    background: #fff;
  }

  .header { text-align: center; margin-bottom: 28px; padding-bottom: 16px; border-bottom: 3px solid ${kleur}; }
  .header img { max-height: 50px; margin-bottom: 8px; }
  .header .kantoor { font-size: 16pt; font-weight: 700; color: ${kleur}; }
  .meta { text-align: center; font-size: 9pt; color: #666; margin-bottom: 24px; line-height: 1.8; }
  .meta strong { color: #333; }

  .risk-stamp {
    text-align: center;
    padding: 20px;
    border: 3px solid ${rKleur};
    border-radius: 8px;
    margin-bottom: 24px;
    background: ${niveau === 'laag' ? '#f0faf4' : niveau === 'verhoogd' ? '#fef9ec' : niveau === 'hoog' ? '#fdf0ef' : '#f5f5f5'};
    color: ${rKleur};
  }
  .risk-stamp .label { font-size: 9pt; text-transform: uppercase; letter-spacing: 3px; font-weight: 700; font-family: sans-serif; }
  .risk-stamp .score { font-size: 36pt; font-weight: 700; margin: 2px 0; }
  .risk-stamp .niveau { font-size: 14pt; font-weight: 700; text-transform: uppercase; }

  .section { margin-bottom: 20px; page-break-inside: avoid; }
  .section-title { font-size: 13pt; font-weight: 700; color: ${kleur}; margin-bottom: 8px; padding-bottom: 4px; border-bottom: 1px solid #e0ddd5; }
  .section-count { font-size: 8pt; background: #f8f7f4; padding: 1px 6px; border-radius: 8px; color: #666; font-family: sans-serif; margin-left: 6px; }

  .bevinding { padding: 8px 12px; border-left: 4px solid; margin-bottom: 8px; border-radius: 0 6px 6px 0; background: #f8f7f4; font-size: 10pt; }
  .bevinding.groen { border-color: #27ae60; }
  .bevinding.oranje { border-color: #e67e22; }
  .bevinding.rood { border-color: #c0392b; }
  .bevinding.grijs { border-color: #95a5a6; }
  .bevinding-bron { font-size: 8pt; color: #666; margin-top: 2px; font-family: sans-serif; }
  .fp-note { font-size: 8pt; color: #95a5a6; font-style: italic; margin-top: 4px; }

  .bron { padding: 6px 0; border-bottom: 1px solid #eee; font-size: 10pt; }
  .bron:last-child { border-bottom: none; }
  .bron a { color: ${kleur}; text-decoration: none; font-weight: 600; }
  .bron .snippet { color: #666; font-size: 9pt; margin-top: 1px; }

  .samenvatting { font-size: 11pt; line-height: 1.7; }
  .wwft-box { background: #f8f7f4; padding: 10px 14px; border-radius: 6px; margin-top: 10px; font-size: 10pt; }
  .wwft-box strong { color: ${kleur}; }

  table { width: 100%; border-collapse: collapse; font-size: 9pt; margin-bottom: 12px; }
  th { background: ${kleur}; color: #fff; text-align: left; padding: 6px 10px; font-size: 8pt; text-transform: uppercase; letter-spacing: 1px; }
  td { padding: 6px 10px; border-bottom: 1px solid #e0ddd5; }

  .query-log { font-family: 'Courier New', monospace; font-size: 8pt; color: #888; background: #f8f7f4; padding: 8px 10px; border-radius: 6px; line-height: 1.5; }

  .disclaimer { background: #f8f7f4; border: 1px solid #e0ddd5; border-radius: 6px; padding: 12px 14px; font-size: 9pt; color: #666; margin-top: 24px; line-height: 1.5; }

  .watermark {
    position: fixed; top: 50%; left: 50%;
    transform: translate(-50%, -50%) rotate(-30deg);
    font-size: 48pt; color: rgba(192, 57, 43, 0.06);
    font-weight: 700; pointer-events: none; z-index: -1; white-space: nowrap;
  }
</style>
</head>
<body>`;

  // Watermark for proef
  if (isProef) {
    html += `<div class="watermark">PROEFSCREENING</div>`;
  }

  // Header with logo and kantoor name
  if (wh.kantoorNaam || wh.logoBase64) {
    html += `<div class="header">`;
    if (wh.logoBase64) html += `<img src="${wh.logoBase64}" alt="Logo"><br>`;
    if (wh.kantoorNaam) html += `<div class="kantoor">${esc(wh.kantoorNaam)}</div>`;
    html += `</div>`;
  }

  // Meta info
  html += `<div class="meta">`;
  html += `<strong>Wwft Cliëntscreening</strong> — ${tijdstip}`;
  if (wh.medewerker) html += `<br>Medewerker: ${esc(wh.medewerker)}`;
  if (wh.dossiernummer) html += `<br>Dossiernummer: ${esc(wh.dossiernummer)}`;
  html += `<br>Subject: <strong>${esc(data.naam)}</strong>`;
  if (data.geboortedatum) html += ` (${esc(data.geboortedatum)})`;
  if (data.locatie) html += ` — ${esc(data.locatie)}`;
  if (data.land && data.land.toLowerCase() !== 'nederland') html += `, ${esc(data.land)}`;
  html += `</div>`;

  // Risk stamp
  html += `<div class="risk-stamp">`;
  html += `<div class="label">Risicobeoordeling</div>`;
  if (a.risico_score >= 0) html += `<div class="score">${a.risico_score}</div>`;
  html += `<div class="niveau">${niveauLabel[niveau] || 'Onbekend'}</div>`;
  html += `</div>`;

  // Samenvatting
  if (a.samenvatting) {
    html += `<div class="section">`;
    html += `<div class="section-title">Samenvatting</div>`;
    html += `<div class="samenvatting">${esc(a.samenvatting)}</div>`;
    if (a.wwft_oordeel) {
      html += `<div class="wwft-box"><strong>Wwft-oordeel:</strong> ${esc(a.wwft_oordeel)}</div>`;
    }
    html += `</div>`;
  }

  // Bevindingen
  if (a.bevindingen && a.bevindingen.length > 0) {
    html += `<div class="section">`;
    html += `<div class="section-title">Risico-indicatoren ter beoordeling<span class="section-count">${a.bevindingen.length}</span></div>`;
    a.bevindingen.forEach(b => {
      html += `<div class="bevinding ${b.ernst || 'grijs'}">`;
      html += `${esc(b.beschrijving)}`;
      html += `<div class="bevinding-bron">${esc(b.categorie || '')} ${b.bron ? '— ' + esc(b.bron) : ''}</div>`;
      html += `</div>`;
    });
    html += `</div>`;
  }

  // Risico-uitleg
  if (a.risico_uitleg) {
    html += `<div class="section">`;
    html += `<div class="section-title">Toelichting risicobeoordeling</div>`;
    html += `<div class="samenvatting">${esc(a.risico_uitleg)}</div>`;
    html += `</div>`;
  }

  // Sancties
  const sanctieList = sancties?.resultaten || [];
  html += `<div class="section">`;
  html += `<div class="section-title">Sanctielijsten<span class="section-count">${sanctieList.length} hits</span></div>`;
  if (sanctieList.length > 0) {
    html += `<table><thead><tr><th>Naam</th><th>Lijst</th><th>Score</th><th>Status</th></tr></thead><tbody>`;
    sanctieList.forEach(s => {
      const isFp = s.falsePositive;
      html += `<tr style="${isFp ? 'color:#95a5a6;' : ''}">`;
      html += `<td>${esc(s.naam)}</td>`;
      html += `<td>${esc(s.lijst || '')}</td>`;
      html += `<td>${s.score}%</td>`;
      html += `<td>${isFp ? 'False positive' : 'Treffer'}</td>`;
      html += `</tr>`;
      if (isFp && s.fpReden) {
        html += `<tr><td colspan="4" class="fp-note">Treffer beoordeeld als false positive door ${esc(s.fpMedewerker || 'niet opgegeven')} op ${esc(s.fpDatum || '')}. Reden: ${esc(s.fpReden)}</td></tr>`;
      }
    });
    html += `</tbody></table>`;
  } else {
    html += `<div class="bevinding groen">Geen matches gevonden op EU, OFAC of VN sanctielijsten.</div>`;
  }
  if (sancties && !sancties.gecontroleerd) {
    html += `<div class="bevinding grijs">Sanctielijsten konden niet worden gecontroleerd.</div>`;
  }
  html += `</div>`;

  // Rechtspraak
  const rechtspraakList = zoekresultaten?.rechtspraak?.resultaten || [];
  html += `<div class="section">`;
  html += `<div class="section-title">Rechtspraak.nl<span class="section-count">${rechtspraakList.length}</span></div>`;
  if (rechtspraakList.length > 0) {
    rechtspraakList.forEach(r => {
      html += `<div class="bron">`;
      html += `<a href="${esc(r.link || '#')}">${esc(r.titel || r.ecli || 'Uitspraak')}</a>`;
      html += `<div class="snippet">${esc(r.instantie || '')} ${r.datum ? '— ' + r.datum : ''}</div>`;
      if (r.samenvatting) html += `<div class="snippet">${esc(r.samenvatting)}</div>`;
      html += `</div>`;
    });
  } else {
    html += `<div class="bevinding groen">Geen uitspraken gevonden.</div>`;
  }
  html += `</div>`;

  // KvK
  const kvkList = zoekresultaten?.kvk?.resultaten || [];
  if (kvkList.length > 0) {
    html += `<div class="section">`;
    html += `<div class="section-title">KvK<span class="section-count">${kvkList.length}</span></div>`;
    kvkList.forEach(k => {
      html += `<div class="bron"><strong>${esc(k.naam)}</strong> — KvK: ${esc(k.kvkNummer)}`;
      if (k.adres) html += `<div class="snippet">${esc(k.adres)}</div>`;
      html += `</div>`;
    });
    html += `</div>`;
  }

  // Webresultaten
  const googleList = zoekresultaten?.google || [];
  if (googleList.length > 0) {
    html += `<div class="section">`;
    html += `<div class="section-title">Webresultaten<span class="section-count">${googleList.length}</span></div>`;
    googleList.slice(0, 15).forEach(g => {
      html += `<div class="bron"><a href="${esc(g.link)}">${esc(g.titel)}</a>`;
      if (g.snippet) html += `<div class="snippet">${esc(g.snippet)}</div>`;
      html += `</div>`;
    });
    html += `</div>`;
  }

  // Nieuws
  const nieuwsList = zoekresultaten?.nieuws || [];
  if (nieuwsList.length > 0) {
    html += `<div class="section">`;
    html += `<div class="section-title">Nieuwsberichten<span class="section-count">${nieuwsList.length}</span></div>`;
    nieuwsList.forEach(n => {
      html += `<div class="bron"><a href="${esc(n.link)}">${esc(n.titel)}</a>`;
      if (n.bron || n.datum) html += `<div class="snippet">${esc(n.bron || '')} ${n.datum ? '— ' + n.datum : ''}</div>`;
      if (n.snippet) html += `<div class="snippet">${esc(n.snippet)}</div>`;
      html += `</div>`;
    });
    html += `</div>`;
  }

  // Queries log
  if (queries && queries.length > 0) {
    html += `<div class="section">`;
    html += `<div class="section-title">Uitgevoerde zoekopdrachten</div>`;
    html += `<div class="query-log">`;
    queries.forEach(q => {
      html += `[${(q.tijdstip || '').slice(11, 19)}] ${esc(q.type)}: ${esc(q.query)}<br>`;
    });
    html += `</div></div>`;
  }

  // Disclaimer
  html += `<div class="disclaimer">`;
  html += `<strong>Disclaimer:</strong> Dit rapport is een hulpmiddel bij de uitvoering van het cliëntonderzoek als bedoeld in de Wwft. Het vervangt niet de wettelijke verplichting van de verantwoordelijke instelling. De verantwoordelijke instelling blijft te allen tijde zelf verantwoordelijk voor de naleving van de Wwft en de beoordeling van de risico's.`;
  if (isProef) {
    html += `<br><br><strong style="color:#c0392b;">PROEFSCREENING — Dit rapport is niet geldig als officieel Wwft-dossier.</strong>`;
  }
  html += `</div>`;

  html += `</body></html>`;
  return html;
}
