// Citirea ofertelor cu Claude. Cheia API stă doar pe server (variabila ANTHROPIC_API_KEY).
const CATS = ['HoReCa', 'IT', 'Mobilier', 'Beauty', 'Energie verde', 'Promovare', 'Utilaje', 'Altele'];

const PROMPT = `Extragi lista de achiziții dintr-o ofertă de preț sau dintr-o decizie de finanțare depusă în programul Start-Up Nation (România). Ignoră salariile, chiria, utilitățile și alte cheltuieli care nu sunt echipamente sau servicii cumpărate de la un furnizor.
Pentru fiecare poziție: name (denumirea scurtă, fără specificații), cat (unul din: ${CATS.join(', ')}), qty (număr), val (valoarea totală a poziției fără TVA, în moneda ofertei, număr), cur ("RON" sau "EUR"), specs (specificațiile tehnice minime ca listă de [eticheta, valoare numerică sau null, unitate]; ex. ["Presiune",15,"bar"], ["Carcasă inox",null,""]; maximum 8). Nu inventa nimic ce nu apare în document.
Răspunde doar cu JSON, fără alt text: {"items":[{"name":"","cat":"","qty":1,"val":0,"cur":"RON","specs":[["",0,""]]}]}`;

async function extract({ text, pdfBase64, images }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    const e = new Error('Citirea cu AI nu e configurată pe server (lipsește ANTHROPIC_API_KEY).');
    e.status = 503;
    throw e;
  }
  const content = [];
  if (pdfBase64) content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } });
  for (const img of (images || []).slice(0, 4)) {
    const m = /^data:(image\/(png|jpeg|webp|gif));base64,(.+)$/.exec(img || '');
    if (m) content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[3] } });
  }
  content.push({ type: 'text', text: PROMPT + (text ? `\nText extras din document:\n"""${String(text).slice(0, 20000)}"""` : '') });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', max_tokens: 8000, messages: [{ role: 'user', content }] }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error('[ai] eroare', res.status, body.slice(0, 500));
    const e = new Error('Serviciul AI nu a putut citi documentul. Încearcă din nou sau completează manual.');
    e.status = 502;
    throw e;
  }
  const data = await res.json();
  const out = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const m = out.match(/\{[\s\S]*\}/);
  let parsed = { items: [] };
  try { parsed = JSON.parse(m ? m[0] : out); } catch (_) { /* răspuns invalid → listă goală */ }
  const items = (Array.isArray(parsed.items) ? parsed.items : []).slice(0, 60).map(x => ({
    name: String(x.name || '').trim().slice(0, 160),
    cat: CATS.includes(x.cat) ? x.cat : 'Altele',
    qty: Math.max(1, Math.round(Number(x.qty) || 1)),
    val: Math.max(0, Number(x.val) || 0),
    cur: /eur/i.test(x.cur || '') ? 'EUR' : 'RON',
    specs: (Array.isArray(x.specs) ? x.specs : []).filter(a => Array.isArray(a) && a[0]).slice(0, 8)
      .map(([k, v, u]) => [String(k).slice(0, 80), v == null || v === '' || isNaN(Number(v)) ? null : Number(v), String(u || '').slice(0, 20)]),
  })).filter(x => x.name);
  return { items, usage: data.usage || null };
}

module.exports = { extract, CATS };
