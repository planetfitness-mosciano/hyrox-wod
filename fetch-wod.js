'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// fetch-wod.js — HYROX WOD daily automation
// Runs via GitHub Actions every day at 04:50 Italy time (02:50 UTC)
// 1. Puppeteer logs into portal.hyrox365.com and captures the Bearer token
// 2. Queries the Hyrox GraphQL API for today's scheduled lesson
// 3. Generates index.html for the TV display
// ─────────────────────────────────────────────────────────────────────────────

const puppeteer = require('puppeteer');
const fs        = require('fs');
const path      = require('path');

const GRAPHQL   = 'https://api.prod.hyrox.fiit-tech.net/graphql';
const PORTAL    = 'https://portal.hyrox365.com/login';
const HUB       = 'https://performancehub.hyrox365.com';
const EMAIL     = process.env.HYROX_EMAIL;
const PASSWORD  = process.env.HYROX_PASSWORD;
const OUT       = path.join(__dirname, 'index.html');

// ─── Utility ─────────────────────────────────────────────────────────────────

function fmtSecs(s) {
  if (!s || s <= 0) return null;
  const m = Math.floor(s / 60), r = s % 60;
  if (m === 0) return `${r}s`;
  if (r === 0) return `${m}min`;
  return `${m}min ${r}s`;
}

function intensityLabel(n) {
  if (n <= 3) return 'PRINCIPIANTE';
  if (n <= 5) return 'INTERMEDIO';
  if (n <= 7) return 'AVANZATO';
  return 'ELITE';
}

const DAYS   = ['DOMENICA','LUNEDÌ','MARTEDÌ','MERCOLEDÌ','GIOVEDÌ','VENERDÌ','SABATO'];
const MONTHS = ['GENNAIO','FEBBRAIO','MARZO','APRILE','MAGGIO','GIUGNO',
                'LUGLIO','AGOSTO','SETTEMBRE','OTTOBRE','NOVEMBRE','DICEMBRE'];

function italianDate(isoDate) {
  // isoDate = 'YYYY-MM-DD' (already in Italy timezone)
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${DAYS[dt.getUTCDay()]} ${d} ${MONTHS[m - 1]} ${y}`;
}

function esc(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─── Metric logic ─────────────────────────────────────────────────────────────
// -1 is the sentinel for "open" (AMRAP for reps, "—" for distance/others)

function metricHtml(ex) {
  const r = ex.detailedMetrics.repetitions;
  const d = ex.detailedMetrics.distance;

  if (r.single != null) {
    if (r.single === -1) return '<span class="ex-metric amrap">AMRAP</span>';
    if (r.single > 0)    return `<span class="ex-metric">${r.single} reps</span>`;
  }
  if (r.min != null && r.min > 0) {
    if (r.max != null && r.max > 0 && r.max !== r.min)
      return `<span class="ex-metric">${r.min}–${r.max} reps</span>`;
    return `<span class="ex-metric">${r.min} reps</span>`;
  }
  if (d.single != null) {
    if (d.single === -1) return '<span class="ex-metric">—</span>';
    if (d.single > 0)    return `<span class="ex-metric">${d.single}m</span>`;
  }
  if (d.min != null && d.min > 0) return `<span class="ex-metric">${d.min}m</span>`;
  const dur = fmtSecs(ex.duration);
  if (dur) return `<span class="ex-metric">${dur}</span>`;
  return '<span class="ex-metric">—</span>';
}

// ─── Section schema string ────────────────────────────────────────────────────

function sectionSchema(s) {
  const parts = [];
  if (s.workTime != null && s.workTime > 0) {
    parts.push(`${s.workTime}s lavoro`);
    parts.push(`${s.restTime || 0}s riposo`);
  }
  parts.push(`${s.rounds} round${s.rounds !== 1 ? 's' : ''}`);
  const dur = fmtSecs(s.duration);
  if (dur) parts.push(dur);
  return parts.join(' · ');
}

// ─── HTML generation ─────────────────────────────────────────────────────────

const CSS = `
:root{--bg:#000;--bg2:#0d0d0d;--bg3:#1a1a1a;--white:#fff;--yellow:#FFE500;--yellow2:rgba(255,229,0,.16);--yellow3:rgba(255,229,0,.35);--dim:rgba(255,255,255,.78);--line:rgba(255,255,255,.10);--linehi:rgba(255,255,255,.18)}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{width:1920px;height:1080px;overflow:hidden;background:var(--bg);color:#fff;font-family:'Barlow',sans-serif}
.screen{width:1920px;height:1080px;display:grid;grid-template-columns:520px 1fr;overflow:hidden}
.left{background:var(--bg2);border-right:2px solid var(--linehi);display:flex;flex-direction:column;padding:0 0 44px;flex-shrink:0}
.left-top-bar{width:100%;height:6px;background:var(--yellow)}
.logo-block{background:#000;border-bottom:1px solid var(--linehi);padding:26px 36px 22px;display:flex;flex-direction:column;gap:0}
.hyrox-wrap{width:100%;margin-bottom:14px}.hyrox-img{width:100%;height:auto;display:block}
.hyrox-fallback{font-family:'Barlow Condensed',sans-serif;font-weight:900;font-size:46px;letter-spacing:.20em;color:#fff}
.logo-divider{width:100%;height:1px;background:rgba(255,255,255,.18);margin-bottom:14px}
.pf-wrap{width:100%}.pf-img{width:100%;height:auto;display:block;filter:brightness(0) invert(1)}
.left-body{flex:1;display:flex;flex-direction:column;padding:30px 40px 0;overflow:hidden}
.eyebrow{font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:18px;letter-spacing:.45em;color:var(--yellow);text-transform:uppercase;margin-bottom:12px;display:flex;align-items:center;gap:12px}
.eyebrow::after{content:"";flex:1;height:1px;background:rgba(255,229,0,.30)}
.wod-title{font-family:'Barlow Condensed',sans-serif;font-weight:900;font-size:68px;line-height:.88;letter-spacing:-.01em;text-transform:uppercase;color:#fff;margin-bottom:18px}
.wod-desc{font-size:18px;line-height:1.65;color:var(--dim);margin-bottom:24px;flex:1}
.meta-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:24px}
.meta-item{background:var(--bg3);border:1px solid var(--linehi);border-radius:5px;padding:13px 16px}
.meta-item.hl{border-color:rgba(255,229,0,.45);background:rgba(255,229,0,.05)}
.meta-lbl{font-family:'Barlow Condensed',sans-serif;font-size:15px;letter-spacing:.38em;color:var(--yellow);margin-bottom:6px;text-transform:uppercase}
.meta-val{font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:28px;color:#fff}
.date-row{font-family:'Barlow Condensed',sans-serif;font-size:21px;letter-spacing:.18em;color:rgba(255,255,255,.88);text-transform:uppercase;padding-top:18px;border-top:1px solid var(--linehi);display:flex;align-items:center;gap:10px}
.date-row::before{content:"";display:inline-block;width:18px;height:3px;background:var(--yellow);border-radius:2px}
.right{display:flex;flex-direction:column;overflow:hidden;position:relative}
.right-top-bar{width:100%;height:6px;background:var(--yellow);flex-shrink:0}
.right::before,.right::after{content:"";position:absolute;left:0;right:0;height:52px;pointer-events:none;z-index:10}
.right::before{top:88px;background:linear-gradient(to bottom,#000 0%,transparent 100%)}
.right::after{bottom:0;background:linear-gradient(to top,#000 0%,transparent 100%)}
.right-header{display:flex;align-items:center;justify-content:space-between;padding:26px 54px 22px;border-bottom:1px solid var(--linehi);flex-shrink:0;background:var(--bg);position:relative;z-index:5}
.right-title{font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:22px;letter-spacing:.38em;color:rgba(255,255,255,.50);text-transform:uppercase}
.right-loc{font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:22px;letter-spacing:.20em;color:#000;background:var(--yellow);border-radius:4px;padding:7px 22px;text-transform:uppercase}
.scroll-viewport{flex:1;overflow:hidden;position:relative}
.scroll-content{padding:24px 54px 40px;display:flex;flex-direction:column;gap:14px;will-change:transform}
.section{border:1px solid var(--linehi);border-radius:6px;overflow:hidden;background:rgba(255,255,255,.025);flex-shrink:0}
.section-hd{display:flex;align-items:center;gap:18px;padding:18px 26px;background:rgba(255,255,255,.05);border-bottom:1px solid var(--linehi)}
.section-badge{font-family:'Barlow Condensed',sans-serif;font-weight:900;font-size:17px;letter-spacing:.28em;color:#000;background:var(--yellow);border-radius:3px;padding:6px 16px;text-transform:uppercase;flex-shrink:0}
.section-name{font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:30px;letter-spacing:.10em;color:#fff;text-transform:uppercase}
.section-schema{margin-left:auto;font-family:'Barlow Condensed',sans-serif;font-size:20px;letter-spacing:.06em;color:var(--yellow);flex-shrink:0;font-weight:600}
.group{border-bottom:1px solid rgba(255,255,255,.06)}.group:last-child{border-bottom:none}
.zone-label{font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:17px;letter-spacing:.28em;color:#000;background:var(--yellow);display:inline-block;padding:5px 16px;margin:12px 22px 6px;border-radius:3px;text-transform:uppercase}
.ex-list{padding:2px 0}
.ex-row{display:flex;align-items:center;gap:16px;padding:16px 26px;border-bottom:1px solid rgba(255,255,255,.05)}
.ex-row:last-child{border-bottom:none}
.ex-idx{font-family:'Barlow Condensed',sans-serif;font-size:20px;font-weight:700;color:rgba(255,255,255,.28);min-width:28px;text-align:right;flex-shrink:0}
.ex-dot{width:6px;height:6px;border-radius:50%;background:var(--yellow);opacity:.65;flex-shrink:0}
.ex-name{font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:32px;letter-spacing:.02em;text-transform:uppercase;color:#fff;flex:1}
.ex-note{font-family:'Barlow Condensed',sans-serif;font-size:18px;letter-spacing:.08em;color:rgba(255,255,255,.55);flex-shrink:0;font-style:italic}
.ex-rpe{font-family:'Barlow Condensed',sans-serif;font-size:18px;letter-spacing:.12em;color:rgba(255,229,0,.75);flex-shrink:0}
.ex-metric{font-family:'Barlow Condensed',sans-serif;font-weight:900;font-size:34px;color:var(--yellow);letter-spacing:.05em;min-width:110px;text-align:right;flex-shrink:0}
.ex-metric.amrap{font-size:24px;letter-spacing:.15em}
@keyframes fadeUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
.left-top-bar,.right-top-bar{animation:fadeIn .3s ease both}
.logo-block{animation:fadeUp .6s cubic-bezier(.16,1,.3,1) both .08s}
.left-body>*{animation:fadeUp .65s cubic-bezier(.16,1,.3,1) both}
.left-body>*:nth-child(1){animation-delay:.18s}.left-body>*:nth-child(2){animation-delay:.26s}
.left-body>*:nth-child(3){animation-delay:.34s}.left-body>*:nth-child(4){animation-delay:.42s}
.left-body>*:nth-child(5){animation-delay:.50s}
.right-header{animation:fadeIn .5s ease both .28s}
.section{animation:fadeUp .65s cubic-bezier(.16,1,.3,1) both}
.section:nth-child(1){animation-delay:.44s}.section:nth-child(2){animation-delay:.58s}.section:nth-child(3){animation-delay:.72s}
`.trim();

const SCROLL_SCRIPT = `
function initScroll(){
  const vp=document.querySelector('.scroll-viewport');
  const ct=document.querySelector('.scroll-content');
  if(!vp||!ct)return;
  const vpH=vp.clientHeight,totalH=ct.scrollHeight;
  if(totalH<=vpH)return;
  const maxPos=totalH-vpH,PX=0.5,PAUSE=2800;
  let pos=0,dir=1,pausing=false;
  function doPause(cb){pausing=true;setTimeout(()=>{pausing=false;cb();},PAUSE);}
  function tick(){
    if(pausing)return;
    pos+=PX*dir;
    if(pos>=maxPos){pos=maxPos;ct.style.transform='translateY(-'+pos.toFixed(2)+'px)';doPause(()=>{dir=-1;requestAnimationFrame(tick);});return;}
    if(pos<=0){pos=0;ct.style.transform='translateY(0px)';doPause(()=>{dir=1;requestAnimationFrame(tick);});return;}
    ct.style.transform='translateY(-'+pos.toFixed(2)+'px)';
    requestAnimationFrame(tick);
  }
  setTimeout(()=>requestAnimationFrame(tick),1600);
}
document.addEventListener('DOMContentLoaded',initScroll);
`.trim();

function buildHtml(lesson, isoDate) {
  // Title: "Complete #201" → "Complete <br>#201"
  const titleMatch = lesson.name.match(/^(.+?)\s+(#\d+)$/);
  const titleHtml  = titleMatch
    ? `${esc(titleMatch[1])} <br>${esc(titleMatch[2])}`
    : esc(lesson.name);

  // Count total exercises across all sections
  let totalEx = 0;
  for (const s of lesson.sections)
    for (const g of s.sectionExerciseGroups)
      totalEx += g.sectionExercises.length;

  const totalSections = lesson.sections.length;
  const durStr        = fmtSecs(lesson.duration) || '—';
  const intLabel      = `${intensityLabel(lesson.intensity)} · RPE ${lesson.intensity}`;

  // Description: truncate if very long
  const desc = (lesson.description || '').replace(/\s+/g,' ').trim();

  // Date in Italian
  const dateStr = italianDate(isoDate);

  // Sections HTML
  let sectionsHtml = '';
  lesson.sections.forEach((s, si) => {
    const badge  = String(si + 1).padStart(2, '0');
    const schema = sectionSchema(s);

    let groupsHtml = '';
    s.sectionExerciseGroups.forEach(g => {
      // Zone label: translate "Zone" → "Zona" for Italian display
      const zoneLbl = g.showTitle
        ? `<div class="zone-label">${esc(g.name.replace(/^Zone\b/, 'Zona'))}</div>`
        : '';

      let rows = '';
      g.sectionExercises.forEach((ex, ei) => {
        const rpeHtml  = ex.rpe  ? `<span class="ex-rpe">RPE ${ex.rpe}</span>`        : '';
        const noteHtml = ex.notes ? `<span class="ex-note">${esc(ex.notes)}</span>` : '';
        rows += `<div class="ex-row">
            <span class="ex-idx">${ei + 1}</span>
            <div class="ex-dot"></div>
            <span class="ex-name">${esc(ex.exercise.name)}</span>
            ${noteHtml}${rpeHtml}
            ${metricHtml(ex)}
          </div>`;
      });

      groupsHtml += `<div class="group">${zoneLbl}${rows}</div>`;
    });

    sectionsHtml += `
    <div class="section">
      <div class="section-hd">
        <span class="section-badge">${badge}</span>
        <span class="section-name">${esc(s.name)}</span>
        <span class="section-schema">${esc(schema)}</span>
      </div>
      <div class="ex-list">${groupsHtml}</div>
    </div>`;
  });

  return `<!DOCTYPE html>
<html lang="it"><head>
<meta charset="UTF-8">
<title>HYROX WOD</title>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;600;700;800;900&family=Barlow:wght@300;400;500&display=swap" rel="stylesheet">
<style>
${CSS}
</style></head>
<body>
<div class="screen">
  <div class="left">
    <div class="left-top-bar"></div>
    <div class="logo-block">
      <div class="hyrox-wrap"><div class="hyrox-fallback">HYROX</div></div>
      <div class="logo-divider"></div>
      <div class="pf-wrap"><img class="pf-img" src="https://planet.fit/wp-content/uploads/2023/02/Logo-planet_bianco.png" alt="Planet Fitness"></div>
    </div>
    <div class="left-body">
      <div class="eyebrow">Workout of the Day</div>
      <div class="wod-title">${titleHtml}</div>
      <div class="wod-desc">${esc(desc)}</div>
      <div class="meta-grid">
        <div class="meta-item hl"><div class="meta-lbl">Durata</div><div class="meta-val">${esc(durStr)}</div></div>
        <div class="meta-item hl"><div class="meta-lbl">Intensità</div><div class="meta-val">${esc(intLabel)}</div></div>
        <div class="meta-item"><div class="meta-lbl">Esercizi</div><div class="meta-val">${totalEx}</div></div>
        <div class="meta-item"><div class="meta-lbl">Sezioni</div><div class="meta-val">${totalSections}</div></div>
      </div>
      <div class="date-row">${esc(dateStr)}</div>
    </div>
  </div>
  <div class="right">
    <div class="right-top-bar"></div>
    <div class="right-header">
      <div class="right-title">Programma Allenamento</div>
      <div class="right-loc">Mosciano Sant'Angelo</div>
    </div>
    <div class="scroll-viewport">
      <div class="scroll-content">${sectionsHtml}
      </div>
    </div>
  </div>
</div>
<script>
${SCROLL_SCRIPT}
</script>
<script>
// Ricarica la pagina ogni ora per aggiornare gli URL video
setTimeout(() => location.reload(), 60 * 60 * 1000);
</script>
</body></html>`;
}

// ─── GraphQL helpers ──────────────────────────────────────────────────────────

async function gql(token, query, variables = {}) {
  const r = await fetch(GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ query, variables })
  });
  if (!r.ok) throw new Error(`GraphQL HTTP ${r.status}`);
  const json = await r.json();
  if (json.errors) throw new Error(`GraphQL error: ${json.errors[0].message}`);
  return json.data;
}

async function getTodayLessonId(token) {
  // Italy timezone date (YYYY-MM-DD)
  const isoDate = new Intl.DateTimeFormat('sv', { timeZone: 'Europe/Rome' }).format(new Date());

  const data = await gql(token, `{
    allLessonSchedules(filters: { first: 20 }) {
      id scheduledAt
      lesson { id name }
    }
  }`);

  const todays = data.allLessonSchedules
    .filter(s => s.scheduledAt.startsWith(isoDate));

  if (todays.length === 0) {
    throw new Error(`Nessun WOD trovato per ${isoDate}`);
  }

  // Prefer the first result (API returns newest→oldest; within same day, order as returned)
  const lesson = todays[0];
  console.log(`WOD di oggi (${isoDate}): ${lesson.lesson.name} [${lesson.lesson.id}]`);
  return { lessonId: lesson.lesson.id, isoDate };
}

async function getLessonDetails(token, lessonId) {
  const data = await gql(token, `{
    lessonById(id: "${lessonId}") {
      id name description duration intensity
      sections(orderBy: DISPLAY_ORDER) {
        id name format duration workTime restTime rounds isRotational isMain notes
        sectionExerciseGroups(orderBy: DISPLAY_ORDER) {
          id name description duration showTitle notes repeatTimes format
          sectionExercises {
            id displayOrder duration rpe description notes
            detailedMetrics {
              weight      { min max single }
              repetitions { min max single }
              distance    { min max single }
            }
            exercise { id name description }
          }
        }
      }
    }
  }`);
  return data.lessonById;
}

// ─── Puppeteer: login + token capture ────────────────────────────────────────

async function captureToken() {
  console.log('Avvio Puppeteer...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ]
  });

  const page = await browser.newPage();

  // Anti-bot: nascondi webdriver
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  await page.setViewport({ width: 1366, height: 768 });
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );

  // Intercept a livello di rete: cattura il Bearer token da QUALSIASI richiesta HTTP
  // (più affidabile di window.fetch injection che dipende dalla SPA)
  let capturedToken = null;
  await page.setRequestInterception(true);
  page.on('request', req => {
    const auth = req.headers()['authorization'];
    if (auth && auth.startsWith('Bearer ')) capturedToken = auth.slice(7);
    req.continue();
  });

  // IMPORTANTE: includi redirect_to già nel login iniziale.
  // Se navigassimo prima senza redirect_to e poi tornassimo con redirect_to
  // da utente già autenticato, il portale ignora il parametro e NON completa l'SSO.
  const loginUrl = `${PORTAL}?redirect_to=${encodeURIComponent(HUB + '/portal-authorization')}`;
  console.log('Apertura login (con redirect_to hub)...');
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('input[placeholder="Email"]', { timeout: 15000 });

  await page.click('input[placeholder="Email"]');
  await page.type('input[placeholder="Email"]', EMAIL, { delay: 60 });
  await page.click('input[placeholder="Password"]');
  await page.type('input[placeholder="Password"]', PASSWORD, { delay: 60 });

  console.log('Submit login...');
  // Avvia navigazione e pressione Enter in parallelo per evitare race condition
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }),
    page.keyboard.press('Enter'),
  ]);
  console.log('URL dopo submit:', page.url());

  // Funzione di check: siamo sull'hub e fuori da portal-authorization?
  const onHub = () =>
    window.location.origin === 'https://performancehub.hyrox365.com' &&
    !window.location.pathname.includes('/portal-authorization');

  // Se il portale ha già completato l'SSO e siamo sull'hub, procedi.
  // Altrimenti aspetta (il portale potrebbe fare redirect JS asincrono).
  if (!(await page.evaluate(onHub))) {
    console.log('Aspettando SSO su performancehub... (URL corrente:', page.url(), ')');
    try {
      await page.waitForFunction(onHub, { timeout: 60000, polling: 500 });
    } catch (e) {
      console.log('TIMEOUT SSO — URL finale:', page.url());
      await page.screenshot({ path: 'debug-login.png', fullPage: true });
      await browser.close();
      throw e;
    }
  }
  console.log('Su performancehub:', page.url());

  // Naviga a /workouts per triggerare le chiamate GraphQL autenticate
  console.log('Navigazione a /workouts...');
  await page.goto(HUB + '/workouts', { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Aspetta token (intercettato a livello di rete, max 20s)
  const deadline = Date.now() + 20000;
  while (!capturedToken && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
  }

  if (!capturedToken) {
    await page.screenshot({ path: 'debug-login.png', fullPage: true });
    await browser.close();
    throw new Error('Token non catturato entro 20s: nessuna richiesta GraphQL autenticata su /workouts');
  }

  console.log('Token catturato.');
  await browser.close();
  return capturedToken;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!EMAIL || !PASSWORD) {
    console.error('ERRORE: impostare HYROX_EMAIL e HYROX_PASSWORD come variabili d\'ambiente.');
    process.exit(1);
  }

  // Step 1: Get Bearer token via Puppeteer login
  const token = await captureToken();

  // Step 2: Find today's lesson
  const { lessonId, isoDate } = await getTodayLessonId(token);

  // Step 3: Get full lesson details
  const lesson = await getLessonDetails(token, lessonId);
  console.log(`Lezione: "${lesson.name}" — ${lesson.sections.length} sezioni`);

  // Step 4: Generate HTML
  const html = buildHtml(lesson, isoDate);

  // Step 5: Write to file
  fs.writeFileSync(OUT, html, 'utf8');
  console.log(`✓ index.html generato (${html.length} bytes) → ${OUT}`);
}

main().catch(err => {
  console.error('ERRORE:', err.message);
  process.exit(1);
});
