// UI check: opens the app with live data on iPhone sizes, in every theme, steps through every slide and flags text that is
// cut off (sticks out of its card or the screen). Screenshots of every slide are saved to shots/ for a look-over.
// Run: node tools/ui-check.mjs [url]   (CI: .github/workflows/ui-check.yml)
import { chromium, webkit } from 'playwright';
import fs from 'fs';
const URL = process.argv[2] || 'http://localhost:8080/index.html';
const LOOKS = process.env.LOOKS ? process.env.LOOKS.split(',') : ['ambient', 'swiss', 'retro', 'calm', 'anime', 'xsnow', 'xmarket'];
const SIZES_ALL = [['iphone-396x859', 396, 859], ['iphone-375x667', 375, 667], ['iphone-430x932', 430, 932], ['landscape-859x396', 859, 396]];
const SIZES = process.env.SIZES ? SIZES_ALL.filter(x => process.env.SIZES.split(',').some(k => x[0].includes(k))) : SIZES_ALL;
const ENGINES = (process.env.ENGINES || 'webkit,chromium').split(',');
fs.mkdirSync('shots', { recursive: true });
const problems = [], known = [];
// problems already known and parked (reported, but they don't fail the check). Remove a line once it's fixed.
const KNOWN = [
  { look: 'anime', sz: '375x667', slide: /Aligarh|Bengaluru, Karnataka|weather/i, why: 'Anime weather card is too tall on small iPhones (older issue, parked 26 Nov 2026)' },
];
for (const eng of ENGINES) {
  const b = await (eng === 'webkit' ? webkit : chromium).launch();
  for (const look of LOOKS) for (const [sz, w, h] of SIZES) {
   for (let attempt = 1; attempt <= 2; attempt++) { try {
    var ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: eng !== 'webkit' ? true : undefined, hasTouch: true, timezoneId: 'Asia/Kolkata' });
    await ctx.addInitScript(l => { try { localStorage.setItem('deskTickerLook', l); } catch (e) {} }, look);
    const pg = await ctx.newPage(); const errs = [];
    pg.on('pageerror', e => { if (!/access control|Load failed|Failed to fetch|NetworkError/i.test(e.message)) errs.push(e.message); });   // other sites refusing the test machine is not an app fault
    await pg.goto(URL + (URL.includes('?') ? '&' : '?') + '_=' + Date.now()); await pg.waitForTimeout(7000);
    const n = await pg.evaluate(() => { clearInterval(timer); return slides.length; });
    for (let k = 0; k < n; k++) {
      const title = await pg.evaluate(k => { show(k); clearInterval(timer); return slides[k].dataset.title || ('slide ' + k); }, k);
      await pg.waitForTimeout(1200);
      const bad = await pg.evaluate(() => {
        const out = [], sl = document.querySelector('.slide.active'), vw = innerWidth, vh = innerHeight;
        if (!sl) return out;
        const clipAnc = el => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const cs = getComputedStyle(p); if (cs.overflow !== 'visible' || cs.overflowY !== 'visible' || cs.overflowX !== 'visible') return p; } return null; };
        for (const el of sl.querySelectorAll('*')) {
          if (!el.childNodes.length || ![...el.childNodes].some(c => c.nodeType === 3 && c.textContent.trim())) continue;   // elements that hold text
          const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
          const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
          if (el.closest('[hidden], .mevl, .ticker, .marquee, .tape')) continue;
          const t = el.textContent.trim().slice(0, 40), a = clipAnc(el);
          if (a) { const q = a.getBoundingClientRect(); if (r.top < q.top - 2 || r.bottom > q.bottom + 2 || r.left < q.left - 2 || r.right > q.right + 2) out.push('cut off by its box: "' + t + '"'); }
          if (r.bottom > vh + 1 || r.right > vw + 1 || r.top < -1) out.push('off screen: "' + t + '"');
          if (cs.whiteSpace === 'nowrap' && cs.textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth + 2 && cs.overflow !== 'visible') out.push('text too long: "' + t + '"');
        }
        return [...new Set(out)].slice(0, 8);
      });
      const f = `shots/${eng}-${look}-${sz}-${String(k).padStart(2, '0')}.png`;
      await pg.screenshot({ path: f });
      if (bad.length) { const kn = KNOWN.find(x => x.look === look && sz.includes(x.sz) && x.slide.test(title));
        (kn ? known : problems).push({ eng, look, sz, slide: title, bad, shot: f, why: kn && kn.why }); }
    }
    if (errs.length) problems.push({ eng, look, sz, slide: '(page)', bad: errs.slice(0, 5).map(e => 'script error: ' + e) });
    await ctx.close(); break;
   } catch (e) {
     console.log(`CRASH ${eng} ${look} ${sz} attempt ${attempt}: ${String(e.message).split('\n')[0]}`);
     if (attempt === 2) problems.push({ eng, look, sz, slide: '(page)', bad: ['page crashed twice: ' + String(e.message).split('\n')[0]] });
   } }
  }
  await b.close();
}
fs.writeFileSync('shots/report.json', JSON.stringify({ problems, known }, null, 1));
for (const p of known) console.log(`KNOWN ${p.eng} ${p.look} ${p.sz} [${p.slide}] ${p.why}`);
console.log(problems.length ? 'PROBLEMS ' + problems.length : 'ALL CLEAR');
for (const p of problems) console.log(`PROB ${p.eng} ${p.look} ${p.sz} [${p.slide}] ${p.bad.join(' | ')}`);
process.exit(problems.length ? 1 : 0);
