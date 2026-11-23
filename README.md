# FondMarket – demo

Prototip demonstrativ pentru o platformă de achiziții destinată beneficiarilor Start-Up Nation:

- încărcarea proiectului aprobat și extragerea specificațiilor minime din oferta de la depunere;
- catalog de echipamente marcat ca „conform” sau „sub specificațiile aprobate”;
- dosar de achiziție: 3 cereri de ofertă, 3 oferte, comparație, proces-verbal de selecție;
- panou pentru furnizori și vedere de platformă (comisioane).

Furnizorii, produsele, prețurile și tarifele sunt fictive.

Pagina e un singur fișier `index.html`, fără build. Pe GitHub Pages, datele rămân în browserul vizitatorului, iar asistentul AI nu e activ (butonul „Folosește exemplul” arată fluxul complet).

## Prototip B2B (React + Tailwind)

În folderul `b2b/`: platformă dedicată programului Start-Up Nation: oferte pentru înscriere, achiziții pornind de la oferta de la depunere și dashboard pentru furnizori.

Link: https://maziludaniel85-arch.github.io/fondmarket/b2b/

## Platforma reală (server Node.js + MySQL, pentru Hostinger)

Aceeași pagină din `b2b/` funcționează în două moduri:

- **Demo** (GitHub Pages, artefact): date fictive, totul în browser.
- **Live** (pe serverul din `server/`): conturi reale, comenzi salvate în MySQL, cereri de ofertă trimise pe email furnizorilor, citirea ofertelor cu Claude. Pagina detectează singură serverul prin `/api/health`.

### Ce face serverul

| Funcție | Detalii |
|---|---|
| Conturi | beneficiar (înregistrare cu email și parolă) și administrator (creat la prima pornire din `ADMIN_EMAIL` / `ADMIN_PASSWORD`) |
| Proiectul beneficiarului | lista de achiziții, dosarele și stadiul lor se salvează automat |
| Citirea ofertelor | `/api/extract` trimite textul și imaginile ofertei la Claude; cheia API stă doar pe server |
| Date firmă | preluare din ANAF după CUI (serviciul public de verificare TVA) |
| Comenzi | prețurile se calculează pe server; ordin de plată cu proformă pe email; administratorul marchează încasarea |
| Furnizori | administratorul îi înregistrează pe categorii; primesc email de bun venit |
| Cereri de ofertă | pleacă pe email doar pentru dosarele plătite; furnizorul răspunde dintr-un link (`/oferta/<token>`), fără cont, cu preț și PDF |
| Ofertele primite | beneficiarul le vede cu ora trimiterii, deschiderii și răspunsului (jurnalul de transmitere) și alege câștigătoarea |

Plata cu cardul nu e încă legată la un procesator (Netopia, Stripe etc.). Până atunci apare ca „în curând”.

### Publicare pe Hostinger (plan Business, aplicație Node.js)

1. **Bază de date:** hPanel → Baze de date → MySQL. Creează baza și utilizatorul; notează numele, utilizatorul și parola.
2. **Email:** hPanel → Emailuri. Creează o adresă de trimitere (de exemplu `oferte@domeniul-tau.ro`).
3. **Aplicația:** hPanel → Site-uri → Adaugă site → Aplicație web Node.js → conectează repo-ul GitHub `fondmarket`, ramura `main`. Comanda de pornire: `npm start`. Versiune Node: 20 sau mai nouă.
4. **Variabile de mediu:** în setările aplicației adaugă valorile din `.env.example` (baza de date, `JWT_SECRET`, contul de administrator, `ANTHROPIC_API_KEY`, SMTP, `PUBLIC_URL`, `PAY_COMPANY`, `PAY_IBAN`). Nu pune cheile în GitHub.
5. **Domeniu:** leagă un subdomeniu (de exemplu `fondmarket.domeniul-tau.ro`) și pune aceeași adresă în `PUBLIC_URL`.

La prima pornire serverul creează singur tabelele și contul de administrator.

### Rulare locală

```bash
npm install
cp .env.example .env   # completează valorile
set -a; . ./.env; set +a; npm start
```
