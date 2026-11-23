// Trimiterea emailurilor prin SMTP (căsuța de email de pe Hostinger).
// Fără SMTP configurat, emailurile sunt doar scrise în jurnalul aplicației.
const nodemailer = require('nodemailer');

let transport = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER) {
  const port = Number(process.env.SMTP_PORT || 465);
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
  });
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function layout(title, body) {
  return `<!doctype html><html lang="ro"><body style="margin:0;background:#f8fafc;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
<div style="max-width:600px;margin:0 auto;padding:24px">
<p style="font-weight:bold;color:#1e3a8a;font-size:18px;margin:0 0 16px">FondMarket</p>
<div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:24px">
<h1 style="font-size:18px;margin:0 0 12px">${esc(title)}</h1>${body}</div>
<p style="font-size:12px;color:#64748b;margin-top:16px">Email trimis automat de platforma FondMarket.</p></div></body></html>`;
}

async function send({ to, subject, html, text, replyTo }) {
  const msg = { from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, html, text, replyTo };
  if (!transport) {
    console.log('[mail:neconfigurat]', JSON.stringify({ to, subject }));
    return { skipped: true };
  }
  return transport.sendMail(msg);
}

module.exports = { send, layout, esc };
