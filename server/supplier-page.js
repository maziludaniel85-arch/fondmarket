// Pagina pe care o deschide furnizorul din emailul cu cererea de ofertă. Fără cont.
const { esc } = require('./mail');
const specTxt = s => (typeof s[1] === 'number' ? `${s[0]} ≥ ${s[1]}${s[2] ? ' ' + s[2] : ''}` : s[1] ? `${s[0]}: ${s[1]}` : String(s[0]));


const css = `*{box-sizing:border-box}body{margin:0;background:#f8fafc;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0f172a;line-height:1.5}
.w{max-width:680px;margin:0 auto;padding:24px 16px}.c{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:24px;margin-top:16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:0 0 12px}.m{color:#64748b;font-size:14px}ul{padding-left:18px}li{margin:8px 0}
label{display:block;font-weight:600;font-size:14px;margin:16px 0 6px}input,textarea{width:100%;font:inherit;padding:10px 12px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;color:#0f172a}
button{margin-top:20px;width:100%;min-height:44px;border:0;border-radius:8px;background:#1e3a8a;color:#fff;font:inherit;font-weight:600;cursor:pointer}button:disabled{opacity:.6}
.err{color:#be123c;font-size:14px;margin-top:8px}.ok{background:#ecfdf5;border-color:#a7f3d0}.brand{font-weight:700;color:#1e3a8a}`;

const page = (title, body) => `<!doctype html><html lang="ro"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${css}</style></head><body><div class="w"><p class="brand">FondMarket</p>${body}</div></body></html>`;

function render(x) {
  const items = x.items.map(it => `<li><b>${esc(it.name)}</b> × ${Number(it.qty) || 1}${(it.specs || []).length ? `<br><span class="m">Minim: ${esc(it.specs.map(specTxt).join('; '))}</span>` : ''}</li>`).join('');
  const done = x.answered_at ? `<div class="c ok"><b>Oferta ta a fost trimisă.</b> <span class="m">Poți trimite o variantă nouă mai jos, dacă e nevoie.</span></div>` : '';
  return page('Cerere de ofertă', `<h1>Cerere de ofertă</h1><p class="m">De la <b>${esc(x.firm || 'beneficiar Start-Up Nation')}</b> către <b>${esc(x.supplier)}</b>. Termen: ${x.deadline ? new Date(x.deadline).toLocaleDateString('ro-RO') : '7 zile'}.</p>${done}
<div class="c"><h2>Echipamente solicitate</h2><ul>${items}</ul><p class="m">Ofertele care nu îndeplinesc specificațiile minime nu vor fi luate în considerare.</p></div>
<form class="c" id="f"><h2>Trimite oferta</h2>
<label for="p">Preț total, fără TVA (lei)</label><input id="p" name="price" inputmode="decimal" required placeholder="ex. 54.300">
<label for="d">Oferta în PDF</label><input id="d" type="file" accept="application/pdf">
<label for="n">Observații (termen de livrare, garanție)</label><textarea id="n" name="note" rows="3"></textarea>
<button id="b" type="submit">Trimite oferta</button><p class="err" id="e" role="alert"></p></form>
<script>
document.getElementById('f').addEventListener('submit',async function(ev){ev.preventDefault();var b=document.getElementById('b'),e=document.getElementById('e');e.textContent='';b.disabled=true;b.textContent='Se trimite…';
try{var body={price:document.getElementById('p').value,note:document.getElementById('n').value};var f=document.getElementById('d').files[0];
if(f){if(f.size>15e6)throw new Error('Fișierul e prea mare (maximum 15 MB).');body.fileName=f.name;body.fileBase64=await new Promise(function(ok,ko){var r=new FileReader();r.onload=function(){ok(String(r.result).split(',')[1])};r.onerror=ko;r.readAsDataURL(f)})}
var r=await fetch('/api/oferta/${x.token}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});var j=await r.json();if(!r.ok)throw new Error(j.error||'Nu am putut trimite oferta.');
document.getElementById('f').outerHTML='<div class="c ok"><b>Mulțumim! Oferta a fost trimisă.</b><p class="m">Beneficiarul a primit-o și o compară cu celelalte oferte.</p></div>'}
catch(x){e.textContent=x.message;b.disabled=false;b.textContent='Trimite oferta'}});
</script>`);
}

const notFound = () => page('Link invalid', '<div class="c"><h1>Linkul nu mai e valid</h1><p class="m">Verifică emailul cu cererea de ofertă sau contactează beneficiarul.</p></div>');

module.exports = { render, notFound };
