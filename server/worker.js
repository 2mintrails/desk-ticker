/**
 * Desk Ticker server (Cloudflare Worker).
 *
 * Does the fetching the Google Sheet's script used to do, on a timer, and keeps the results in a small database:
 *   prices  every minute while the Indian or US market is open (every 20 min otherwise) — Yahoo Finance,
 *           for every symbol in Sheet1 column A; Google Finance values from the sheet are kept as a fallback
 *   env     every 10 min — HAL / Kempegowda airport reports, airports across India, air quality (IQAir, then WAQI)
 *   news    every 10 min, one section per run — India, World, Markets, US Markets
 * The sheet stays the place for what you control: the watchlist (Sheet1 column A) and the Settings tab.
 *
 * The app reads everything in one go from  /v1/all  — laid out exactly like the sheet's tabs, so the app's
 * existing checks keep working. If this server is down, the app goes back to reading the sheet directly.
 *
 * Secrets (set from GitHub): IQAIR_KEY, WAQI_KEY. Database: D1 "desk-ticker", table kv(k, v, at).
 */

const SHEET_PUB = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQvtAtoM3GTJ--tbsHV5cWMPhFrtaofoAyvqSbRt2H2-n2_pUiQ5YYnaVsXRgRTe1ieAnODMXPw1joB/pub';
const GID = { main: '1087668592', news: '202194850', aqi: '1500091563' };
const UA = 'Mozilla/5.0 (DeskTicker personal display)';
const HOME = { lat: 12.9352, lon: 77.6245 };            // Koramangala (a "Home lat/lon" setting overrides it)

/* ---------------- small helpers ---------------- */
const istParts = (t = Date.now()) => { const d = new Date(t + 5.5 * 3600e3); return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), wd: d.getUTCDay() }; };
const p2 = n => String(n).padStart(2, '0');
const istStamp = (t = Date.now(), sec = true) => { const p = istParts(t); return `${p.y}-${p2(p.mo)}-${p2(p.d)} ${p2(p.h)}:${p2(p.mi)}` + (sec ? ':' + p2(p.s) : ''); };
async function get(url, opt = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...(opt.headers || {}) }, cf: { cacheTtl: 0 } });
  if (!res.ok) throw new Error(url.split('?')[0].slice(0, 80) + ' → HTTP ' + res.status);
  return opt.json ? res.json() : res.text();
}
function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const sheetCSV = gid => get(`${SHEET_PUB}?gid=${gid}&single=true&output=csv&_=${Date.now()}`).then(parseCSV);
const num = v => { const x = parseFloat(String(v ?? '').replace(/[,₹\s]/g, '')); return isFinite(x) ? x : null; };

async function dbGet(env, keys) {
  const { results } = await env.DB.prepare(`SELECT k, v, at FROM kv WHERE k IN (${keys.map(() => '?').join(',')})`).bind(...keys).all();
  const o = {}; results.forEach(r => { try { o[r.k] = { v: JSON.parse(r.v), at: r.at }; } catch (e) {} }); return o;
}
const dbPut = (env, k, v) => env.DB.prepare('INSERT INTO kv (k, v, at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at')
  .bind(k, JSON.stringify(v), Date.now()).run();
async function logRun(env, job, ok, note) {
  const cur = (await dbGet(env, ['log'])).log?.v || {};
  cur[job] = { at: istStamp(), ok, note: String(note || '').slice(0, 300) };
  await dbPut(env, 'log', cur);
}

/* ---------------- prices: Yahoo Finance for every watchlist symbol ---------------- */
const YMAP = {
  'INDEXNSE:NIFTY_50': '^NSEI', 'INDEXBOM:SENSEX': '^BSESN', 'INDEXSP:.INX': '^GSPC', 'INDEXNASDAQ:.IXIC': '^IXIC', 'INDEXDJX:.DJI': '^DJI',
  'INDEXNSE:NIFTY_BANK': '^NSEBANK', 'INDEXNSE:INDIA_VIX': '^INDIAVIX', 'INDEXNSE:NIFTY_IT': '^CNXIT', 'INDEXNSE:NIFTY_AUTO': '^CNXAUTO',
  'INDEXNSE:NIFTY_PHARMA': '^CNXPHARMA', 'INDEXNSE:NIFTY_FMCG': '^CNXFMCG', 'INDEXNSE:NIFTY_METAL': '^CNXMETAL', 'INDEXNSE:NIFTY_REALTY': '^CNXREALTY',
  'INDEXNSE:NIFTY_ENERGY': '^CNXENERGY', 'INDEXNSE:NIFTY_PSU_BANK': '^CNXPSUBANK', 'INDEXNSE:NIFTY_MEDIA': '^CNXMEDIA', 'INDEXNSE:NIFTY_INFRA': '^CNXINFRA',
  'INDEXNSE:NIFTY_FIN_SERVICE': 'NIFTY_FIN_SERVICE.NS', 'INDEXNSE:NIFTY_MIDCAP_100': 'NIFTY_MIDCAP_100.NS', 'INDEXNSE:NIFTY_SMLCAP_100': '^CNXSC',
  'INDEXNSE:NIFTY_NEXT_50': '^NSMIDCP',
};
function yahooSym(g) {
  g = String(g || '').trim(); if (!g) return null;
  if (YMAP[g]) return YMAP[g];
  let m;
  if ((m = g.match(/^NSE:(.+)$/))) return m[1] + '.NS';
  if ((m = g.match(/^BOM:(.+)$/))) return m[1] + '.BO';
  if ((m = g.match(/^CURRENCY:([A-Z]{6})$/))) return m[1] + '=X';
  if ((m = g.match(/^(NASDAQ|NYSE|NYSEARCA|NYSEAMERICAN|BATS):(.+)$/))) return m[2].replace(/\./g, '-');
  return null;
}
// price history for one symbol, for the app's tap-to-open detail card (1 day, 3 months or 1 year); kept a while per symbol
const HIST = { '1d': ['5m', 2 * 60e3], '3mo': ['1d', 3 * 3600e3], '1y': ['1wk', 6 * 3600e3] };
async function hist(env, sym, range) {
  const ys = yahooSym(sym); if (!ys || !HIST[range]) return { error: 'unknown symbol or range' };
  const key = 'hist_' + range + '_' + ys.replace(/[^A-Za-z0-9^.=&-]/g, ''), c = (await dbGet(env, [key]))[key];
  if (c && Date.now() - c.at < HIST[range][1]) return c.v;
  try {
    const r = (await get('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ys) + '?range=' + range + '&interval=' + HIST[range][0], { json: true })).chart.result[0];
    const m = r.meta || {}, cl = (r.indicators.quote[0] || {}).close || [];
    const pts = (r.timestamp || []).map((t, i) => [t * 1000, cl[i]]).filter(x => x[1] != null && isFinite(x[1])).map(x => [x[0], Math.round(x[1] * 100) / 100]);
    if (pts.length < 2) throw new Error('no history');
    const v = { sym, range, pts, prev: m.chartPreviousClose ?? m.previousClose ?? null, dayHi: m.regularMarketDayHigh ?? null, dayLo: m.regularMarketDayLow ?? null,
      hi52: m.fiftyTwoWeekHigh ?? null, lo52: m.fiftyTwoWeekLow ?? null, tz: m.exchangeTimezoneName || '' };
    await dbPut(env, key, v);
    return v;
  } catch (e) { return c ? c.v : { error: String(e.message || e) }; }
}
// Prices and previous closes come from Yahoo's DAILY closes (last 5 sessions): the latest close is today's price
// (it moves during the session), the one before it is the previous close. (Yahoo's intraday "previous close"
// fields were seen a day off, 12–14 Nov.) The three main indices also get the day's 5-minute line.
function readDaily(j) {
  const out = {};
  Object.entries(j || {}).forEach(([sym, x]) => {
    if (!x || !Array.isArray(x.close)) return;
    const c = x.close.map((v, i) => [x.timestamp[i], v]).filter(([, v]) => v != null);
    if (c.length < 2) return;
    out[sym] = { price: c[c.length - 1][1], prev: c[c.length - 2][1], at: null };
  });
  return out;
}
async function yahooQuotes(syms) {
  const out = {}, errs = [];
  for (let i = 0; i < syms.length; i += 20) {
    const part = syms.slice(i, i + 20);
    try { Object.assign(out, readDaily(await get('https://query1.finance.yahoo.com/v8/finance/spark?symbols=' + part.map(encodeURIComponent).join(',') + '&range=5d&interval=1d', { json: true }))); }
    catch (e) { errs.push(String(e.message || e)); }
  }
  for (const s of ['^NSEI', '^BSESN', '^GSPC']) {
    if (!syms.includes(s)) continue;
    try {
      const r = (await get('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(s) + '?interval=5m&range=1d', { json: true })).chart.result[0];
      const m = r.meta || {}, ts = r.timestamp || [], cl = ((r.indicators || {}).quote || [{}])[0].close || [];
      const line = ts.map((t, k) => cl[k] == null ? '' : t + ':' + (+cl[k]).toFixed(2)).filter(Boolean).join(';');
      const o = out[s] || {};
      out[s] = { price: m.regularMarketPrice ?? o.price, prev: o.prev ?? m.chartPreviousClose, at: m.regularMarketTime || null, line };
    } catch (e) { errs.push(String(e.message || e)); }
  }
  return { out, errs };
}
function marketWindow(t = Date.now()) {          // a busy time for prices: Indian session or US session (India time)
  const p = istParts(t), m = p.h * 60 + p.mi, wd = p.wd;
  const india = wd >= 1 && wd <= 5 && m >= 9 * 60 && m <= 16 * 60;
  const us = (wd >= 1 && wd <= 5 && m >= 18 * 60 + 45) || (wd >= 2 && wd <= 6 && m <= 3 * 60);
  return india || us;
}
async function jobPrices(env) {
  let all = [];
  try { all = await sheetCSV(GID.main); } catch (e) {}
  if (all.length < 1) all = [['Symbol', 'Price', 'Change', 'ChangePct']];
  const cfg = await getCfg(env), have = new Set(all.slice(1).map(r => String(r[0] || '').trim()));
  [...cfg.watch.in, ...cfg.watch.large, ...cfg.watch.us].forEach(x => { if (!have.has(x.sym)) { all.push([x.sym, '', '', '']); have.add(x.sym); } });
  const syms = [...new Set(all.slice(1).map(r => yahooSym(r[0])).filter(Boolean))];
  const { out: Y, errs } = await yahooQuotes(syms);
  let used = 0, kept = 0, dbg = '';
  all.slice(1).forEach(r => {
    const y = Y[yahooSym(r[0])]; if (!y) return;
    const g = num(r[1]), gc = num(r[2]);
    const prev = y.prev ?? (g != null && gc != null && g - gc > 0 ? g - gc : null);
    if (prev == null) return;
    if (String(r[0]).trim() === 'INDEXNSE:NIFTY_50') dbg = ` · Nifty: Google ${g} (${gc}), Yahoo ${y.price} prev ${y.prev}`;
    y.prev = prev;
    if (g != null && Math.abs(y.price - g) / g > 0.08) { kept++; return; }      // too far from Google's value: keep Google's
    while (r.length < 6) r.push('');
    const ch = y.price - prev;
    r[1] = y.price.toFixed(2); r[2] = ch.toFixed(2); r[3] = (ch / prev * 100).toFixed(2);
    while (r.length < 25) r.push(''); r[23] = 'yahoo'; r[24] = String(y.at || '');
    if (!num(r[4]) && y.hi52) r[4] = String(y.hi52);
    if (!num(r[5]) && y.lo52) r[5] = String(y.lo52);
    used++;
  });
  const idx = [['Index', 'Price', 'Prev close', 'Quote time', 'Day line']];
  [['INDEXNSE:NIFTY_50', '^NSEI'], ['INDEXBOM:SENSEX', '^BSESN'], ['INDEXSP:.INX', '^GSPC']].forEach(([g, s]) => {
    const y = Y[s]; if (y && y.prev != null && all.some(r => String(r[0]).trim() === g)) idx.push([g, String(y.price), String(y.prev), String(y.at || ''), y.line]);
  });
  await dbPut(env, 'sheet1', all);
  // keep each day's gold (24K per gram) and silver (per kg) rate, so longer trends are possible later
  try {
    const rate = v => num(String(v || '').split('(')[0]);
    const hist = (await dbGet(env, ['metal_hist'])).metal_hist?.v || {};
    let changed = false;
    all.slice(1, 10).forEach(r => { const d = Date.parse(r[8]), g = rate(r[9]), sv = rate(r[15]);
      if (d && g && sv) { const k = new Date(d + 6 * 3600e3).toISOString().slice(0, 10); if (!hist[k] || hist[k].gold !== g || hist[k].silver !== sv) { hist[k] = { gold: g, silver: sv }; changed = true; } } });
    if (changed) { const keys = Object.keys(hist).sort(); keys.slice(0, Math.max(0, keys.length - 800)).forEach(k => delete hist[k]); await dbPut(env, 'metal_hist', hist); }
  } catch (e) {}
  if (idx.length > 1) await dbPut(env, 'idx', idx);
  return `${used} from Yahoo, ${kept} kept from Google (too far apart), ${syms.length} asked` + dbg + (errs.length ? ' · ' + errs.join(' | ') : '');
}

/* ---------------- env: airport weather, air quality, settings ---------------- */
function interp(x, from, to) { for (let i = 1; i < from.length; i++) if (x <= from[i]) return to[i - 1] + (x - from[i - 1]) * (to[i] - to[i - 1]) / (from[i] - from[i - 1]); return to[to.length - 1]; }
const US_IDX = [0, 50, 100, 150, 200, 300, 400, 500], US_PM25 = [0, 12, 35.4, 55.4, 150.4, 250.4, 350.4, 500.4], US_PM10 = [0, 54, 154, 254, 354, 424, 504, 604];
const IN_IDX = [0, 50, 100, 200, 300, 400, 500], IN_PM25 = [0, 30, 60, 90, 120, 250, 380], IN_PM10 = [0, 50, 100, 250, 350, 430, 510];
const kmBetween = (a, b, c, d) => { const R = Math.PI / 180, x = Math.sin((c - a) * R / 2) ** 2 + Math.cos(a * R) * Math.cos(c * R) * Math.sin((d - b) * R / 2) ** 2; return 12742 * Math.asin(Math.sqrt(x)); };
async function aqiIQAir(env, home) {
  if (!env.IQAIR_KEY) return null;
  const r = await get(`https://api.airvisual.com/v2/nearest_city?lat=${home.lat}&lon=${home.lon}&key=${env.IQAIR_KEY}`, { json: true });
  if (r.status !== 'success') return null;
  const p = r.data.current.pollution, t = Date.parse(p.ts);
  if (!t || Date.now() - t > 3 * 3600e3) return null;
  const pm10 = p.mainus === 'p1';
  const aqi = Math.round(interp(interp(p.aqius, US_IDX, pm10 ? US_PM10 : US_PM25), pm10 ? IN_PM10 : IN_PM25, IN_IDX));
  const q = istParts(t);
  return [String(aqi), r.data.city + ' (IQAir)', `${p2(q.d)}-${p2(q.mo)}-${q.y} ${p2(q.h)}:${p2(q.mi)}:00`, pm10 ? 'PM10' : 'PM2.5'];
}
async function aqiWAQI(env, home) {
  if (!env.WAQI_KEY) return null;
  const T = env.WAQI_KEY, box = [home.lat - .12, home.lon - .12, home.lat + .12, home.lon + .12].join(',');
  const list = await get(`https://api.waqi.info/v2/map/bounds?latlng=${box}&networks=all&token=${T}`, { json: true });
  const near = (list.status === 'ok' ? list.data : []).filter(x => kmBetween(home.lat, home.lon, x.lat, x.lon) <= 25)
    .sort((a, b) => kmBetween(home.lat, home.lon, a.lat, a.lon) - kmBetween(home.lat, home.lon, b.lat, b.lon));
  for (const st of near.slice(0, 5)) {
    const r = await get(`https://api.waqi.info/feed/@${st.uid}/?token=${T}`, { json: true }).catch(() => null);
    const d = r?.data, iq = d?.iaqi || {};
    if (r?.status !== 'ok' || !(iq.pm25 || iq.pm10)) continue;
    const t = Date.parse(d.time?.iso || ''); if (!t || Date.now() - t > 3 * 3600e3) continue;
    const sub = {};
    if (iq.pm25) sub['PM2.5'] = interp(interp(iq.pm25.v, US_IDX, US_PM25), IN_PM25, IN_IDX);
    if (iq.pm10) sub['PM10'] = interp(interp(iq.pm10.v, US_IDX, US_PM10), IN_PM10, IN_IDX);
    const top = Object.entries(sub).sort((a, b) => b[1] - a[1])[0];
    const name = String(d.city?.name || '').split(',')[0].replace(/\s*-\s*(KSPCB|CPCB|IITM)\s*$/i, '').trim();
    const m = String(d.time?.s || '').match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}:\d{2}:\d{2})/);
    return [String(Math.round(top[1])), name, m ? `${m[3]}-${m[2]}-${m[1]} ${m[4]}` : String(d.time?.s || ''), top[0]];
  }
  return null;
}
async function jobEnv(env) {
  const notes = [], prev = (await dbGet(env, ['env'])).env?.v || {}, o = { ...prev };
  const set = (await getCfg(env)).settings || {};                 // home location from the shared settings
  const home = { lat: num(set['Home lat']) ?? HOME.lat, lon: num(set['Home lon']) ?? HOME.lon };
  try {
    const t = await get('https://aviationweather.gov/api/data/metar?ids=VOBG,VOBL&hours=4&format=raw');
    const lines = t.split('\n').map(l => l.trim()).filter(l => /^(METAR |SPECI )?(VOBG|VOBL) \d{6}Z/.test(l)).map(l => /^(METAR|SPECI) /.test(l) ? l : 'METAR ' + l);
    if (lines.length) o.metar = lines.slice(0, 20);
  } catch (e) { notes.push('metar: ' + e.message); }
  try {
    const now = Date.now() / 1000, j = await get('https://aviationweather.gov/api/data/metar?bbox=5,67,37,98&format=json', { json: true });
    const list = j.filter(m => m && m.rawOb && m.lat != null && m.lon != null && now - (m.obsTime || 0) < 6 * 3600)
      .map(m => [m.icaoId, String(m.lat), String(m.lon), String(m.name || '').split(',')[0], (/^(METAR|SPECI) /.test(m.rawOb) ? '' : 'METAR ') + m.rawOb]);
    if (list.length) o.airports = list.slice(0, 399);
  } catch (e) { notes.push('airports: ' + e.message); }
  try { const a = (await aqiIQAir(env, home).catch(e => { notes.push('iqair: ' + e.message); return null; })) || await aqiWAQI(env, home); if (a) o.aqi = a; else notes.push('aqi: no fresh reading'); }
  catch (e) { notes.push('aqi: ' + e.message); }
  await dbPut(env, 'env', o);
  return `metar ${o.metar?.length || 0}, airports ${o.airports?.length || 0}, aqi ${o.aqi ? o.aqi[0] + ' ' + o.aqi[1] : '—'}` + (notes.length ? ' · ' + notes.join(' | ') : '');
}

/* ---------------- news ---------------- */
const GN = q => 'https://news.google.com/rss/search?q=' + encodeURIComponent(q + ' when:1d') + '&hl=en-IN&gl=IN&ceid=IN:en';
const GNUS = q => 'https://news.google.com/rss/search?q=' + encodeURIComponent(q + ' when:1d') + '&hl=en-US&gl=US&ceid=US:en';
// Google News doesn't answer Cloudflare's servers, so the server reads papers' own feeds.
const FEEDS = {
  India: [['https://indianexpress.com/section/india/feed/', 'Indian Express'], ['https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml', 'Hindustan Times'],
    ['https://feeds.feedburner.com/ndtvnews-india-news', 'NDTV'], ['https://timesofindia.indiatimes.com/rssfeeds/-2128936835.cms', 'Times of India'],
    ['https://www.indiatoday.in/rss/1206514', 'India Today'], ['https://theprint.in/category/india/feed/', 'ThePrint'],
    ['https://www.news18.com/commonfeeds/v1/eng/rss/india.xml', 'News18'], ['https://www.livemint.com/rss/news', 'Mint']],
  Markets: [['https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms', 'ET Markets'], ['https://www.livemint.com/rss/markets', 'Mint'],
    ['https://www.business-standard.com/rss/markets-106.rss', 'Business Standard'], ['https://www.moneycontrol.com/rss/marketreports.xml', 'Moneycontrol'],
    ['https://www.financialexpress.com/market/feed/', 'Financial Express'], ['https://www.hindustantimes.com/feeds/rss/business/rssfeed.xml', 'Hindustan Times']],
  MarketsMore: [['https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms', 'ET Markets'], ['https://www.cnbctv18.com/commonfeeds/v1/cne/rss/market.xml', 'CNBC-TV18'],
    ['https://www.moneycontrol.com/rss/MCtopnews.xml', 'Moneycontrol'], ['https://www.moneycontrol.com/rss/buzzingstocks.xml', 'Moneycontrol'],
    ['https://www.business-standard.com/rss/markets-news-10601.rss', 'Business Standard'], ['https://www.livemint.com/rss/companies', 'Mint'],
    ['https://www.thehindubusinessline.com/markets/feeder/default.rss', 'BusinessLine'], ['https://www.ndtvprofit.com/stfeed/markets', 'NDTV Profit']],
  USMarkets: [['https://www.cnbc.com/id/20910258/device/rss/rss.html', 'CNBC'], ['https://feeds.content.dowjones.io/public/rss/mw_topstories', 'MarketWatch'],
    ['https://feeds.content.dowjones.io/public/rss/mw_marketpulse', 'MarketWatch'], ['https://finance.yahoo.com/news/rssindex', 'Yahoo Finance'],
    ['https://www.nasdaq.com/feed/rssoutbound?category=Markets', 'Nasdaq'], ['https://www.investing.com/rss/news_25.rss', 'Investing.com'],
    ['https://www.cnbc.com/id/15839069/device/rss/rss.html', 'CNBC'], ['https://www.cnbc.com/id/10001147/device/rss/rss.html', 'CNBC'], ['https://seekingalpha.com/market_currents.xml', 'Seeking Alpha']],
  World: [['https://www.theguardian.com/world/rss', 'The Guardian'], ['https://www.cnbc.com/id/100727362/device/rss/rss.html', 'CNBC'],
    ['https://rss.dw.com/rdf/rss-en-world', 'DW'], ['https://feeds.npr.org/1004/rss.xml', 'NPR'], ['https://feeds.skynews.com/feeds/rss/world.xml', 'Sky News'],
    ['https://www.france24.com/en/rss', 'France 24'], ['https://www.hindustantimes.com/feeds/rss/world-news/rssfeed.xml', 'Hindustan Times'],
    ['https://timesofindia.indiatimes.com/rssfeeds/296589292.cms', 'Times of India']],
};
const BLOCK = ['The Hindu', 'BBC', 'Al Jazeera', 'NDTV Sports'];
const KEEP = 10, MAX_PER_SOURCE = 2, MAX_AGE_H = 12;
const MARKET_WORDS = /\b(sensex|nifty|nse|bse|stock|stocks|shares?|stock markets?|share market|equity|equities|ipo|rupee|rbi|sebi|fii|fiis|dii|q[1-4]|quarterly|profit|revenue|earnings|dividend|bonus|buyback|bond|bonds|yield|gold|silver|crude|inflation|gdp|mutual funds?|sip|smallcap|midcap|largecap|brokerage|target price|f&o|futures|nasdaq|dow|s&p|wall street|dalal street|investors?|valuation|market cap|promoters?)\b/i;
// US market news must be about the US: a clearly American term always passes; a headline about another country's market is dropped
const US_STRONG = /\b(wall street|s&p ?500|s&p|nasdaq|dow jones|the dow|dow|nyse|federal reserve|the fed|fed|fomc|powell|treasury|treasuries)\b/i;        // the US market itself
const US_JUNK = /earnings call transcript|james bond|\bquiz\b|\bhoroscope\b/i;
const US_ABBR = /\b(U\.S\.|US|USA|American?)\b/;
const FOREIGN = /\b(asia|asian|asia-pacific|europe|european|japan|japanese|nikkei|topix|china|chinese|hong kong|hang seng|shanghai|shenzhen|india|indian|sensex|nifty|ftse|dax|cac ?40|stoxx|kospi|korea|korean|asx|australia|australian|tsx|canada|canadian|toronto|britain|british|uk|london|germany|german|france|french|italy|italian|spain|spanish|ibex|brazil|bovespa|mexico|argentina|chile|colombia|peru|taiwan|taiex|singapore|saudi|tadawul|dubai|abu dhabi|uae|qatar|kuwait|bahrain|oman|egypt|israel|tel aviv|turkey|bist|russia|moex|south africa|nigeria|morocco|indonesia|jakarta|idx|philippines|psei|thailand|vietnam|malaysia|pakistan|karachi|sri lanka|colombo|bangladesh|poland|wig\w*|sweden|omx\w*|norway|oslo|denmark|finland|netherlands|aex|belgium|bel ?20|portugal|psi|greece|athens|swiss|switzerland|smi|austria|new zealand|nzx\w*|emerging markets?|euro ?zone|ecb|boj|pboc|rbi|boe|yen|yuan|rupee|sterling|at close of trade)\b/i;
const US_WORDS = /\b(wall street|s&p|nasdaq|dow|nyse|stocks?|shares?|equities|earnings|fed|federal reserve|powell|treasury|treasuries|yields?|bonds|bond (?:yields?|market|prices)|ipo|rally|selloff|sell-off|futures|dollar|inflation|cpi|jobs report|payrolls|recession|tariffs?|nvidia|apple|microsoft|amazon|alphabet|google|meta|tesla|broadcom|berkshire|jpmorgan|investors?|market cap|valuation|guidance|outlook|chipmakers?|tech stocks)\b/i;
const decode = s => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;|&apos;|&#x27;|&#8217;/g, "'")
  .replace(/&quot;|&#8220;|&#8221;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#8211;|&#8212;/g, '-').replace(/&nbsp;/g, ' ')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/\s+/g, ' ').trim();
const tag = (x, t) => { const m = x.match(new RegExp('<' + t + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + t + '>', 'i')); return m ? m[1] : ''; };
function isEnglish(t) {
  const letters = t.replace(/[^\p{L}]/gu, ''); if (!letters.length) return false;
  if (t.replace(/[^A-Za-z]/g, '').length / letters.length < 0.9) return false;
  if (/[äöüßéèêàçñ]/i.test(t) && !/\b(the|and|of|to|in|for|on|with|is|are)\b/i.test(t)) return false;
  const w = t.toLowerCase().split(/[^a-z']+/).filter(Boolean);
  const en = w.filter(x => /^(the|a|an|and|of|to|in|for|on|with|is|are|was|as|at|by|from|after|over|says|new|will|has|have|its|his|her|their|into|amid|why|how|what|who|india|indian|us|uk|pm|govt)$/.test(x)).length;
  const foreign = w.filter(x => /^(der|die|das|und|nicht|mit|für|ist|le|la|les|des|et|est|pour|el|los|las|y|con|para|del|una|het|een|van)$/.test(x)).length;
  return foreign <= en;
}
function isNews(t, anyLang) {
  if ((!anyLang && !isEnglish(t)) || t.split(/\s+/).length < 6) return false;
  if (/^(video|watch|photos?|gallery|in pics|quiz|podcast|listen|opinion)\b/i.test(t)) return false;
  if (/\b(live (results|updates|blog|coverage|score)|election results|results 20\d\d|20\d\d .*results$|as it happened|highlights)\b/i.test(t)) return false;
  if (/\blive\s*:|\blive$|^live\b|\bLIVE\b/.test(t)) return false;
  if (/^(latest|top|breaking) (news|headlines)\b/i.test(t)) return false;
  if (/^(newstrack|explained|explainer|analysis|editorial|column|interview|watch|recap|in numbers)\s*[:|]/i.test(t)) return false;
  if (/\b(vacanc(y|ies)|recruitment|admit card|apply online|apply now|answer key|syllabus|sarkari|job alert)\b/i.test(t)) return false;
  if (/\b(special|quiz|horoscope|rashifal|lucky (number|colour)|wishes|greetings|images|messages)\s*:/i.test(t)) return false;
  return true;
}
async function readFeed(url, src, anyLang) {
  try {
    const xml = await get(url);
    return (xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || []).map(it => {
      let title = decode(tag(it, 'title')), source = src;
      if (!source) { const k = title.lastIndexOf(' - '); if (k > 20) { source = title.slice(k + 3); title = title.slice(0, k); } }
      if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3));
      title = title.replace(/\s*\|\s*Latest News.*$/i, '');
      return { title, source, link: decode(tag(it, 'link')), t: Date.parse(decode(tag(it, 'pubDate'))) || 0 };
    }).filter(x => x.title && isNews(x.title, anyLang) && !BLOCK.some(b => (x.source || '').toLowerCase().startsWith(b.toLowerCase())));
  } catch (e) { return []; }
}
const STOP = new Set(('a an the of to in on for at by with and or is are was were be as from after over into its his her their this that says said amid new news ' +
  'का के की में से को पर है हैं ने और भी एक लिए तो हुआ हुई गया गई किया कर करने रहा रही रहे था थी थे यह वह इस उस जा जो कि नहीं बाद साथ दौरान तक अब न्यूज़ news: अलीगढ़').split(' '));
const words = t => new Set(t.toLowerCase().replace(/[^a-z0-9\u0900-\u097F ]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)));
const sameStory = (a, b) => { let n = 0; a.forEach(w => { if (b.has(w)) n++; }); return n >= 3 && n / Math.min(a.size, b.size) >= 0.5; };
function pickTop(items, o = {}) {
  const KEEP_N = o.keep || KEEP, PER = o.per || MAX_PER_SOURCE;
  const cutoff = Date.now() - (o.ageH || MAX_AGE_H) * 3600e3, seen = new Set(), per = {}, out = [], kept = [];
  items.filter(x => !x.t || x.t === 1 || x.t > cutoff).sort((a, b) => b.t - a.t).forEach(x => {
    const key = x.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 50), ws = words(x.title);
    if (seen.has(key) || out.length >= KEEP_N || (per[x.source] || 0) >= PER || (o.skip && o.skip(x)) || kept.some(k => sameStory(k, ws))) return;
    seen.add(key); kept.push(ws); per[x.source] = (per[x.source] || 0) + 1;
    out.push({ text: x.source ? x.title + ' - ' + x.source : x.title, link: /^https?:\/\//.test(x.link) ? x.link : '', ...(x.sym ? { sym: x.sym, tick: x.tick } : {}) });
  });
  return out;
}
async function jobNews(env, section) {
  const lists = await Promise.all(FEEDS[section].map(([u, s]) => readFeed(u, s))), items = lists.flat();
  const perFeed = lists.map((l, i) => FEEDS[section][i][1] + ' ' + l.length).join(', ');
  let filt = section === 'Markets' ? items.filter(x => MARKET_WORDS.test(x.title)) : items;
  if (section === 'USMarkets') {
    const mine = (((await getCfg(env)).watch || {}).us || []).filter(x => !/^INDEX/.test(x.sym)).map(x => stockMatcher(x));   // a headline naming one of your US stocks always counts
    filt = items.filter(x => { const t = x.title; if (US_JUNK.test(t)) return false;
      if (/\bGAAP EPS\b|\bbeats? by \$|\bmisses by \$/i.test(t) && !mine.some(f => f(t))) return false;   // one-line results of companies you don't follow
      if (US_STRONG.test(t) || US_ABBR.test(t)) return true;          // about the US market: keep, even if another country is mentioned
      if (FOREIGN.test(t)) return false;                                // another country's market: drop, even if a US company is named
      return mine.some(f => f(t)) || US_WORDS.test(t); });
  }
  const top = pickTop(filt);
  if (!top.length) throw new Error('no headlines from any ' + section + ' feed (kept the last list)');
  await dbPut(env, 'news_' + section, top);
  return top.length + ' headlines (' + perFeed + ') · newest: ' + top[0].text.slice(0, 70);
}

/* ---------------- local news: the city nearest the home location ---------------- */
const IE_CITY = c => ['https://indianexpress.com/section/cities/' + c + '/feed/', 'Indian Express'];
const HT_CITY = c => ['https://www.hindustantimes.com/feeds/rss/cities/' + c + '-news/rssfeed.xml', 'Hindustan Times'];
const CITIES = [
  ['Bengaluru', 12.97, 77.59, [IE_CITY('bangalore'), HT_CITY('bengaluru'), ['https://www.news18.com/commonfeeds/v1/eng/rss/bengaluru-news.xml', 'News18']]],
  ['Mumbai', 19.08, 72.88, [IE_CITY('mumbai'), HT_CITY('mumbai')]],
  ['Delhi', 28.61, 77.21, [IE_CITY('delhi'), HT_CITY('delhi')]],
  ['Gurugram', 28.46, 77.03, [HT_CITY('gurugram'), IE_CITY('delhi')]],
  ['Noida', 28.54, 77.39, [HT_CITY('noida'), IE_CITY('delhi')]],
  ['Pune', 18.52, 73.86, [IE_CITY('pune'), HT_CITY('pune')]],
  ['Chennai', 13.08, 80.27, [IE_CITY('chennai'), HT_CITY('chennai')]],
  ['Hyderabad', 17.39, 78.49, [IE_CITY('hyderabad'), HT_CITY('hyderabad')]],
  ['Kolkata', 22.57, 88.36, [IE_CITY('kolkata'), HT_CITY('kolkata')]],
  ['Ahmedabad', 23.02, 72.57, [IE_CITY('ahmedabad'), HT_CITY('ahmedabad')]],
  ['Lucknow', 26.85, 80.95, [IE_CITY('lucknow'), HT_CITY('lucknow')]],
  ['Chandigarh', 30.73, 76.78, [IE_CITY('chandigarh'), HT_CITY('chandigarh')]],
  ['Jaipur', 26.91, 75.79, [IE_CITY('jaipur'), HT_CITY('jaipur')]],
  ['Patna', 25.59, 85.14, [HT_CITY('patna')]], ['Bhopal', 23.26, 77.41, [HT_CITY('bhopal')]], ['Indore', 22.72, 75.86, [HT_CITY('indore')]],
  ['Ranchi', 23.34, 85.31, [HT_CITY('ranchi')]], ['Dehradun', 30.32, 78.03, [HT_CITY('dehradun')]],
];
const kmFlat = (a, b, c, d) => { const R = Math.PI / 180, x = (d - b) * R * Math.cos((a + c) / 2 * R), y = (c - a) * R; return Math.sqrt(x * x + y * y) * 6371; };
const reEsc = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// which local news fits a spot: a city with its own feeds within 60 km, else headlines that name the given city
const CITY_WIDE = [['https://indianexpress.com/section/cities/feed/', 'Indian Express'], ['https://www.hindustantimes.com/feeds/rss/cities/rssfeed.xml', 'Hindustan Times'],
  ['https://www.hindustantimes.com/feeds/rss/cities/others/rssfeed.xml', 'Hindustan Times'], ['https://timesofindia.indiatimes.com/rssfeeds/-2128936835.cms', 'Times of India']];
function localPlan(lat, lon, cityName) {
  const byDist = CITIES.map(c => [kmFlat(lat, lon, c[1], c[2]), c]).sort((a, b) => a[0] - b[0]);
  if (byDist[0][0] <= 60) return { city: byDist[0][1][0], feeds: byDist[0][1][3], match: null };
  const name = String(cityName || '').trim();
  if (!/^[A-Za-z][A-Za-z .'-]{2,39}$/.test(name)) return null;
  const feeds = [...byDist.slice(0, 3).flatMap(x => x[1][3]), ...CITY_WIDE, ...FEEDS.India].filter((f, i, a) => a.findIndex(g => g[0] === f[0]) === i);
  // plus the Hindi papers' own city feeds (small cities' local news is mostly in Hindi): Amar Ujala by city, Live Hindustan by state and city
  const slug = name.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
  return { city: name, feeds, slug, match: new RegExp('(?<![A-Za-z])' + reEsc(name) + '(?![A-Za-z])', 'i') };
}
async function localNews(plan, env) {
  const lists = await Promise.all(plan.feeds.map(([u, s]) => readFeed(u, s)));
  const items = plan.match ? lists.flat().filter(x => plan.match.test(x.title)) : lists.flat();
  const read = lists.reduce((n, l) => n + l.length, 0);
  if (!plan.slug) return { top: pickTop(items, { keep: 8, per: 7, ageH: 24 }), note: plan.feeds.length + ' feeds, ' + read + ' read' };
  // a city without its own feed: the Hindi papers' city news comes first, then other stories that name it, from the last day only
  const found = (await Promise.all((await cityFeeds(env, plan.slug)).map(([u, s]) => readFeed(u, s, true)))).flat();
  let top = pickTop(found, { keep: 8, per: 4, ageH: 24 });
  if (top.length < 8) { const have = new Set(top.map(x => x.text.toLowerCase().slice(0, 40)));
    top = top.concat(pickTop(items, { keep: 8 - top.length, per: 3, ageH: 24 }).filter(x => !have.has(x.text.toLowerCase().slice(0, 40)))); }
  if (env) top = await toEnglish(env, top);
  return { top, note: plan.feeds.length + ' feeds + Hindi city papers, ' + read + ' read, ' + found.length + ' from city papers, ' + items.length + ' name ' + plan.city };
}
// which Live Hindustan state section has this city: tried once, then remembered for a week
const LH_STATES = ['uttar-pradesh', 'bihar', 'uttarakhand', 'jharkhand', 'madhya-pradesh', 'rajasthan', 'haryana', 'delhi', 'himachal-pradesh', 'punjab', 'chhattisgarh'];
async function cityFeeds(env, slug) {
  const out = [['https://www.amarujala.com/rss/' + slug + '.xml', 'Amar Ujala']];
  if (!env) return out;
  const key = 'lhstate2_' + slug.replace(/-/g, ''), c = (await dbGet(env, [key]))[key];
  let st = c && Date.now() - c.at < 7 * 864e5 ? c.v.state : undefined;
  if (st === undefined) {
    const tries = await Promise.all(LH_STATES.map(async x => (await readFeed('https://api.livehindustan.com/feeds/rss/' + x + '/' + slug + '/rssfeed.xml', 'Live Hindustan', true)).length ? x : ''));
    st = tries.find(Boolean) || ''; await dbPut(env, key, { state: st });
  }
  if (st) out.push(['https://api.livehindustan.com/feeds/rss/' + st + '/' + slug + '/rssfeed.xml', 'Live Hindustan']);
  return out;
}
// Hindi (Devanagari) headlines are translated to short plain English by the AI; if that fails, they stay in Hindi
async function toEnglish(env, top) {
  const idx = top.map((x, i) => /[\u0900-\u097F]/.test(x.text) ? i : -1).filter(i => i >= 0);
  if (!idx.length || !env.AI) return top;
  try {
    const list = idx.map((i, k) => (k + 1) + '. ' + top[i].text).join('\n');
    const r = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', { messages: [
      { role: 'system', content: 'You translate Hindi news headlines into short, natural English headlines. Keep names and places. Do not add anything.' },
      { role: 'user', content: 'Translate each headline to English (max 16 words each). Reply with a JSON array of strings, same order, nothing else.\n\n' + list }], max_tokens: 700, temperature: 0.1 });
    const txt = typeof r.response === 'string' ? r.response : JSON.stringify(r.response || '');
    const arr = JSON.parse((txt.match(/\[[\s\S]*\]/) || ['[]'])[0]);
    if (Array.isArray(arr) && arr.length === idx.length) idx.forEach((i, k) => { const t = String(arr[k] || '').trim(); if (t.length > 8 && !/[\u0900-\u097F]/.test(t)) top[i] = { ...top[i], text: t, hi: top[i].text }; });
  } catch (e) {}
  return top;
}
async function jobLocal(env) {
  const set = (await getCfg(env)).settings || {};
  const plan = localPlan(num(set['Home lat']) ?? HOME.lat, num(set['Home lon']) ?? HOME.lon, set['Home city'] || String(set['Home name'] || '').split(',')[0]);
  if (!plan) { await dbPut(env, 'news_Local', { city: '', items: [] }); return 'home is not near a city with a local feed, and no home city is saved'; }
  const { top, note } = await localNews(plan, env);
  if (!top.length && !plan.match) throw new Error('no ' + plan.city + ' headlines (' + note + ')');
  await dbPut(env, 'news_Local', { city: plan.city, items: top });       // nothing naming a smaller city: the slide hides itself
  return plan.city + ': ' + top.length + ' headlines (' + note + ')' + (top[0] ? ' · newest: ' + top[0].text.slice(0, 70) : '');
}
// local news for where a device is right now (when it is away from home); kept for 15 minutes per city
async function localHere(env, lat, lon, cityName) {
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return { city: '', items: [] };
  const plan = localPlan(lat, lon, cityName); if (!plan) return { city: '', items: [] };
  const key = 'local6_' + plan.city.toLowerCase().replace(/[^a-z]/g, ''), c = (await dbGet(env, [key]))[key];
  if (c && Date.now() - c.at < 15 * 60e3) return { ...c.v, at: c.at };
  const { top } = await localNews(plan, env);
  if (!top.length && c && c.v.items.length && Date.now() - c.at < 6 * 3600e3) return { ...c.v, at: c.at };   // feeds failed: keep the last list for a while
  const v = { city: plan.city, items: top.map(i => ({ t: i.text, u: i.link })) };
  await dbPut(env, key, v);
  return { ...v, at: Date.now() };
}

/* ---------------- watchlist news: business headlines that name a stock in the Indian watchlist ---------------- */
const WATCH_FEEDS = [...FEEDS.Markets,
  ['https://economictimes.indiatimes.com/markets/stocks/news/rssfeeds/2146842.cms', 'Economic Times'], ['https://economictimes.indiatimes.com/news/company/rssfeeds/2143429.cms', 'Economic Times'],
  ['https://economictimes.indiatimes.com/industry/rssfeeds/13352306.cms', 'Economic Times'],
  ['https://www.livemint.com/rss/companies', 'Mint'], ['https://www.business-standard.com/rss/companies-101.rss', 'Business Standard'],
  ['https://www.moneycontrol.com/rss/business.xml', 'Moneycontrol'], ['https://www.moneycontrol.com/rss/buzzingstocks.xml', 'Moneycontrol'],
  ['https://www.financialexpress.com/industry/feed/', 'Financial Express'], ['https://www.financialexpress.com/business/feed/', 'Financial Express'],
  ['https://indianexpress.com/section/business/feed/', 'Indian Express'], ['https://www.cnbctv18.com/commonfeeds/v1/cne/rss/market.xml', 'CNBC-TV18'],
  ['https://www.cnbctv18.com/commonfeeds/v1/cne/rss/business.xml', 'CNBC-TV18'], ['https://www.news18.com/commonfeeds/v1/eng/rss/business.xml', 'News18']];
// other names the papers use (the stock's own name and ticker are always tried too)
const ALIAS = { 'NSE:M&M': ['M&M', 'Mahindra'], 'NSE:LT': ['L&T', 'Larsen'], 'NSE:HINDUNILVR': ['HUL'], 'NSE:INDIGO': ['InterGlobe'], 'NSE:DRREDDY': ['Dr Reddy', 'Dr. Reddy'],
  'NSE:SONACOMS': ['Sona Comstar', 'Sona BLW'], 'NSE:RECLTD': ['REC Ltd', 'REC Limited'], 'NSE:BHARTIARTL': ['Airtel'], 'NSE:VBL': ['Varun Beverages'], 'NSE:POLYMED': ['Polymed'],
  'NSE:RELIANCE': ['RIL', 'Reliance Industries', 'Reliance Jio', 'Reliance Retail'], 'NSE:SUNPHARMA': ['Sun Pharmaceutical'], 'NSE:HDFCBANK': ['HDFC Bank'], 'NSE:ABREL': ['Birla Estates'],
  'NSE:TMCV': ['Tata Motors'], 'NSE:TATACONSUM': ['Tata Consumer'], 'NSE:INOXINDIA': ['INOX India', 'Inox India'] };
function stockMatcher(x) {
  const names = new Set([x.name, ...(ALIAS[x.sym] || [])]);
  const short = x.name.replace(/\s+(Ltd\.?|Limited|Company|Corporation|Corp\.?|Industries|Inc\.?)$/i, '').trim();
  if (short.length >= 4) names.add(short);
  const parts = [...names].filter(n => n && n.length >= 3).map(n => /^[A-Z&]{2,5}$/.test(n) ? null : reEsc(n)).filter(Boolean);
  const caps = [...names, x.tick].filter(n => n && /^[A-Z&]{3,12}$/.test(n) || /^[A-Z]&[A-Z]$/.test(n || '')).map(reEsc);   // tickers and initials: exact capitals only
  const B = '(?<![A-Za-z0-9&])', E = '(?![A-Za-z0-9&])';
  const a = parts.length ? new RegExp(B + '(' + parts.join('|') + ')' + E, 'i') : null, b = caps.length ? new RegExp(B + '(' + caps.join('|') + ')' + E) : null;
  const not = x.sym === 'NSE:RELIANCE' ? /Reliance (Power|Infra|Infrastructure|Capital|Home|Communications|Naval|General)/i : x.sym === 'NSE:M&M' ? /Mahindra (Finance|Lifespace|Holidays|Logistics)|Tech Mahindra|Kotak Mahindra/i : null;
  return t => (!not || !not.test(t)) && ((a && a.test(t)) || (b && b.test(t)));
}
/* ---------------- gold & silver: why the price moved, and any analyst view, from news headlines ---------------- */
const BULLION_FEEDS = [['https://economictimes.indiatimes.com/markets/commodities/rssfeeds/1808152121.cms', 'Economic Times'],
  ['https://www.livemint.com/rss/markets', 'Mint'], ['https://www.business-standard.com/rss/markets-106.rss', 'Business Standard'],
  ['https://www.financialexpress.com/market/commodities/feed/', 'Financial Express'], ['https://www.investing.com/rss/news_11.rss', 'Investing.com'],
  ['https://www.moneycontrol.com/rss/business.xml', 'Moneycontrol'], ['https://www.cnbctv18.com/commonfeeds/v1/cne/rss/market.xml', 'CNBC-TV18'],
  ['https://www.goodreturns.in/rss/personal-finance-fb.xml', 'GoodReturns'], ['https://www.hindustantimes.com/feeds/rss/business/rssfeed.xml', 'Hindustan Times'],
  ['https://indianexpress.com/section/business/feed/', 'Indian Express'], ['https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms', 'Economic Times']];
const METAL_RE = { gold: /\bgold\b/i, silver: /\bsilver\b/i };
const METAL_NOT = { gold: /goldman|golden|gold medal|gold coast|gold loan|gold card|goldilocks|black gold|green gold|white gold|gold standard of/i,
  silver: /silver lining|silver medal|silver jubilee|silver screen|silverline|silver lake|quicksilver|silverware|silver fox/i };
const PRICE_WORDS = /\b(price|prices|rate|rates|bullion|mcx|comex|ounce|oz|per 10 ?g(ram)?|per kg|rall(y|ies)|surges?|jumps?|soars?|climbs?|gains?|rises?|slips?|falls?|drops?|dips?|plunges?|tumbles?|slides?|eases?|steady|flat|record|all-time high|lifetime high|lows?|highs?|outlook|forecast|target|support|resistance|demand|hedge|safe[- ]haven)\b/i;
const OUTLOOK = /\b((gold|silver|bullion|price|prices)( price)? (outlook|forecast)|(outlook|forecast) (for|on) (gold|silver|bullion)|target|targets|expected to|may (touch|hit|test|rise|fall|reach|cross|trade|consolidate)|could (touch|hit|test|rise|fall|reach|cross)|likely to|seen (at|rising|falling|trading)|predict|support (at|near|level)|resistance|buy on dips|by (diwali|dhanteras|akshaya tritiya|march|december|year[- ]end|20\d\d)|what's next|where (is|are) .* headed|should you buy)\b/i;
/* ---------------- market mood: the trend and the why, in words, for India (Nifty) and the US (S&P 500) ---------------- */
function nyParts(t) { const o = {}; new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, weekday: 'short', hour: 'numeric', minute: 'numeric' })
  .formatToParts(new Date(t)).forEach(x => o[x.type] = x.value); return { wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday), m: (+o.hour % 24) * 60 + +o.minute }; }
function sessionOpen(mkt, t) {
  if (mkt === 'in') { const p = istParts(t), m = p.h * 60 + p.mi; return p.wd >= 1 && p.wd <= 5 && m >= 555 && m < 930; }
  const p = nyParts(t); return p.wd >= 1 && p.wd <= 5 && p.m >= 570 && p.m < 960;
}
// the summary stays "live" until 45 min after the close, so the final version is written once the closing-wrap articles are out
function summaryLive(mkt, t) {
  if (mkt === 'in') { const p = istParts(t), m = p.h * 60 + p.mi; return p.wd >= 1 && p.wd <= 5 && m >= 555 && m < 975; }
  const p = nyParts(t); return p.wd >= 1 && p.wd <= 5 && p.m >= 570 && p.m < 1005;
}
// headlines count only from the morning of the current session day (7 am India, so pre-market previews count / 7 am New York), so last week's stories can't explain today
function sessionCutoff(mkt, t) {
  if (mkt === 'in') { const p = istParts(t); return t - ((p.h * 60 + p.mi) * 60 + p.s) * 1e3 + 7 * 3600e3; }
  const p = nyParts(t); return t - p.m * 60e3 + 7 * 3600e3;
}
const MOOD_UP = /\b(inflows?|buying|easing (oil|crude|inflation|yields?)|rate[- ]cut hopes?|rall(y|ies)|gains?|optimism|upgrade|strong earnings|record high|recover(y|s|ing)?|rebound)/i;
const MOOD_DN = /\b(outflows?|selling|sell-?off|profit[- ]taking|rising (oil|crude|yields?)|fears?|worries|concerns?|weak|slump|tariffs?|hawkish|losses|slide|plunge|tumble|decline|caution|jitters|risk-off|pressure|drag)/i;
async function moodSummary(env, mkt, heads, move, dir) {
  if (!env.AI) throw new Error('no AI binding');
  const name = mkt === 'in' ? 'the Indian stock market (Nifty 50 / Sensex)' : 'the US stock market (S&P 500, Nasdaq, Dow)';
  const prompt = 'Latest market headlines about ' + name + ':\n' + heads.map(h => '- ' + h).join('\n') + '\n\n' + (move ? 'Fact: ' + move + '\n\n' : '') +
    'Write two short lines in plain English for someone glancing at a desk display:\n' +
    '"trend": max 12 words. Start with the WHOLE market\'s direction (e.g. "' + (mkt === 'in' ? 'Indian shares slip' : 'Wall Street falls') + '..."), then, if the headlines say so, which sectors lead or lag or how long the run has gone on. Never describe only one sector or one company. It must agree with the Fact above. Example: "Third straight day of gains; banks lead, IT lags".\n' +
    '"why": max 14 words on the main reasons the market moved today, as the market-wrap headlines explain them (ignore single-company stories unless headlines say they are moving or holding back the whole market). Be specific: name the event or factor the headlines point to (a big IPO, the Fed, earnings, oil, foreign investors); never vague phrases like "investors await news" or "market is down". Example: "Foreign investors are buying again on rate-cut hopes; easing crude helps". The reasons MUST explain the direction in the Fact: if the market is down, give reasons for a fall; if up, reasons for a rise. If no headline explains that direction, "why" is an empty string.\n' +
    'Rules: NO digits or numbers of any kind (no index levels, points, percentages, prices, amounts); words like "third" or "week" are fine. No predictions or advice. If the headlines give no reason, "why" is an empty string.\n' +
    'Reply with JSON only: {"trend":"","why":""}';
  let r;
  for (const model of ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-3.1-8b-instruct']) {
    try { r = await env.AI.run(model, { messages: [{ role: 'system', content: 'You summarise market news faithfully. You never invent facts, numbers or forecasts.' }, { role: 'user', content: prompt }], max_tokens: 200, temperature: 0.1 }); break; }
    catch (e) { r = null; }
  }
  if (!r) throw new Error('AI unavailable');
  const txt = typeof r.response === 'string' ? r.response : JSON.stringify(r.response || '');
  const j = JSON.parse((txt.match(/\{[\s\S]*\}/) || ['{}'])[0]);
  const clean = x => { const t = String(x || '').replace(/\s+/g, ' ').replace(/^["'\s]+|["'.\s]+$/g, '').trim(); return t.length > 6 && t.length < 110 && !/\d/.test(t) ? t[0].toUpperCase() + t.slice(1) : ''; };
  const out = { trend: clean(j.trend), why: clean(j.why) };
  if (!out.trend) throw new Error('no usable trend line: ' + txt.slice(0, 80));
  // safety check: a "why" that only gives reasons for the opposite move is dropped rather than shown
  if (out.why && dir < 0 && MOOD_UP.test(out.why) && !MOOD_DN.test(out.why)) out.why = '';
  if (out.why && dir > 0 && MOOD_DN.test(out.why) && !MOOD_UP.test(out.why)) out.why = '';
  return out;
}
async function jobMood(env) {
  const d = await dbGet(env, ['news_Markets', 'news_USMarkets', 'mood', 'sheet1']), now = Date.now(), old = d.mood?.v || {}, out = { ...old }, notes = [];
  const pct = sym => { const r = (d.sheet1?.v || []).find(x => String(x[0] || '').trim() === sym); const p = r && parseFloat(r[1]), c = r && parseFloat(r[2]);
    return p && isFinite(c) && p !== c ? c / (p - c) * 100 : null; };
  for (const [mkt, key, sym, lab] of [['in', 'news_Markets', 'INDEXNSE:NIFTY_50', 'Nifty 50'], ['us', 'news_USMarkets', 'INDEXSP:.INX', 'S&P 500']]) {
    const cur = old[mkt], open = summaryLive(mkt, now), trading = sessionOpen(mkt, now);
    // while the market is open: refresh every 30 min; once it closes: one final version, then hold until the next session
    const MOOD_V = 6, due = !cur || cur.v !== MOOD_V || (open ? now - cur.at > 30 * 60e3 || cur.final : !cur.final);
    if (!due) { notes.push(mkt + ' kept (' + (cur.final ? 'final' : 'live') + ')'); continue; }
    // market-wrap headlines straight from the market feeds: ones that talk about the index or the market as a whole, newest first
    const feeds = mkt === 'in' ? [...FEEDS.Markets, ...FEEDS.MarketsMore] : FEEDS.USMarkets;
    const lists = await Promise.all(feeds.map(([u, s]) => readFeed(u, s)));
    const diag = feeds.map(([u, s], i) => s.replace(/\s+/g, '') + ':' + lists[i].length + '/' + lists[i].filter(x => x.t && x.t >= sessionCutoff(mkt, now)).length).join(' ');
    const raw = lists.flat().filter(x => x.t && x.t >= Math.min(sessionCutoff(mkt, now), now - 2 * 3600e3) && now - x.t < 20 * 3600e3).sort((a, b) => b.t - a.t);
    const WRAP = mkt === 'in' ? /\b(sensex|nifty|gift nifty|dalal street|d-street|indian (stock |equity |share )?markets?|stock markets?|share markets?|markets? (today|live|close|closing|wrap|crash|fall|rally|update)|closing bell|opening bell|pre-?open|benchmarks?|fii|fpi|foreign (investors?|funds?)|bank nifty|midcaps?|smallcaps?|india vix)\b/i
                              : /\b(wall street|s&p( 500)?|nasdaq|dow( jones)?|us stocks|stock market|stocks (rise|fall|rally|slip|close|end|open|gain|drop)|market (today|close|wrap)|closing bell|treasur(y|ies) yields?|fed\b)/i;
    const seenT = new Set(), heads = raw.filter(x => WRAP.test(x.title) && (mkt === 'in' || (!US_JUNK.test(x.title) && !FOREIGN.test(x.title) && !/\b(thai|thailand|downer|asx|nzx|philippine|indonesia|malaysia|singapore|vietnam|poland|polish|brazil|mexic)/i.test(x.title) && !/\bvs\.? |better buy|dividend stocks|stocks? to (buy|watch)|should you buy|social security\b/i.test(x.title))) && !seenT.has(x.title.toLowerCase().slice(0, 50)) && seenT.add(x.title.toLowerCase().slice(0, 50)))
      .slice(0, 16).map(x => x.title);
    const pc = pct(sym), dir = pc == null || Math.abs(pc) < 0.15 ? 0 : Math.sign(pc);
    const move = pc == null ? '' : lab + ' is ' + (dir === 0 ? 'roughly flat' : dir > 0 ? 'up' : 'down') + ' today' + (trading ? ' so far' : ' at the close') + '.';
    if (heads.length < 2) {
      // too little fresh news to explain the day (often early on a Monday): say only the direction, no reason, rather than borrow old stories
      if (pc == null) { notes.push(mkt + ' too few fresh headlines'); continue; }
      const who = mkt === 'in' ? 'Indian shares' : 'Wall Street';
      out[mkt] = { trend: who + (dir === 0 ? ' are steady' : dir > 0 ? ' are higher' : ' are lower') + (trading ? ' so far today' : ' today'), why: '', at: now, final: !open, v: MOOD_V };
      notes.push(mkt + ' direction only (' + heads.length + ' fresh headlines) [' + diag + ']'); continue;
    }
    try { const s = await moodSummary(env, mkt, heads, move, dir); out[mkt] = { ...s, at: now, final: !open, v: MOOD_V }; notes.push(mkt + (open ? ' live' : ' final') + ' (' + heads.length + ' headlines): ' + s.trend + ' | ' + (s.why || '-') + ' [' + diag + '] || ' + heads.slice(0, 6).map(h => h.slice(0, 60)).join(' ~ ')); }
    catch (e) { notes.push(mkt + ' AI failed: ' + String(e.message || e).slice(0, 80)); }
  }
  await dbPut(env, 'mood', out);
  return notes.join(' · ');
}
async function bullionSummary(env, recent, views, dirs = {}) {
  if (!env.AI) throw new Error('no AI binding');
  const fmt = l => l.length ? l.map(x => '- ' + x.title + ' (' + (x.source || '') + ')').join('\n') : '(none)';
  const word = d => d > 0 ? 'UP' : d < 0 ? 'DOWN' : 'about unchanged';
  const facts = ['gold', 'silver'].filter(m => dirs[m] != null).map(m => 'Fact: today\'s ' + m + ' rate in India is ' + word(dirs[m]) + ' versus yesterday.').join('\n');
  const prompt = (facts ? facts + '\n\n' : '') + 'Headlines from Indian business news in the last day or so.\n\nGOLD:\n' + fmt(recent.gold) + '\n\nGOLD analyst/outlook headlines (last 5 days):\n' + fmt(views.gold) +
    '\n\nSILVER:\n' + fmt(recent.silver) + '\n\nSILVER analyst/outlook headlines (last 5 days):\n' + fmt(views.silver) +
    '\n\nFor gold and for silver separately, write:\n"why": one plain sentence, max 9 words. It MUST start with "Falling on", "Rising on", "Steady as" or "Mixed as", matching the Fact for that metal (UP = "Rising on", DOWN = "Falling on"), then reasons the headlines give for THAT direction. If no headline explains that direction, use an empty string. Example: "Falling on a strong dollar and Fed rate-hike bets". No numbers unless in the headlines. Empty string if the headlines give no reason.\n' +
    '"experts": max 9 words stating what analysts/experts in these headlines expect next: a direction, range, target or support/resistance level that a headline actually states (e.g. "Weak near term; support near 1.28 lakh"). A headline that only asks a question ("more fall ahead or bounce back?") or says "what experts say" without the view is NOT a view: ignore it. Empty string if no headline states a view. Never add your own prediction.\n"n": how many headlines the experts line is based on.\n' +
    'Reply with JSON only: {"gold":{"why":"","experts":"","n":0},"silver":{"why":"","experts":"","n":0}}';
  let r;
  for (const model of ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-3.1-8b-instruct']) {
    try { r = await env.AI.run(model, { messages: [{ role: 'system', content: 'You summarise news headlines faithfully. You never invent facts or forecasts.' }, { role: 'user', content: prompt }], max_tokens: 300, temperature: 0.1 }); break; }
    catch (e) { r = null; }
  }
  if (!r) throw new Error('AI unavailable');
  const txt = typeof r.response === 'string' ? r.response : JSON.stringify(r.response || '');
  const j = JSON.parse((txt.match(/\{[\s\S]*\}/) || ['{}'])[0]);
  const clean = (x, ok) => { const t = String(x || '').replace(/\s+/g, ' ').replace(/^["'\s]+|["'.\s]+$/g, '').trim(); return ok && t.length > 6 && t.length < 90 ? t[0].toUpperCase() + t.slice(1) : ''; };
  const out = { at: Date.now() };
  for (const m of ['gold', 'silver']) { const o = j[m] || {};
    out[m] = { why: clean(o.why, recent[m].length > 0), experts: clean(o.experts, views[m].length + recent[m].length > 0), n: Math.min(+o.n || 0, views[m].length + recent[m].length) }; }
  // safety check: a why line pointing the opposite way to today's rate is dropped
  for (const m of ['gold', 'silver']) { const d = dirs[m], w = out[m].why;
    if (w && ((d < 0 && /^rising\b/i.test(w)) || (d > 0 && /^falling\b/i.test(w)) || /no (clear )?reason|not (given|stated|mentioned|specified)|unclear|unknown/i.test(w))) out[m].why = ''; }
  if (!out.gold.why && !out.silver.why) throw new Error('empty summary');
  return out;
}
async function jobBullion(env) {
  const lists = await Promise.all(BULLION_FEEDS.map(([u, s]) => readFeed(u, s)));
  const all = lists.flat().filter(x => x.t).sort((a, b) => b.t - a.t), now = Date.now(), seen = new Set(), out = {};
  for (const m of ['gold', 'silver']) {
    const hits = all.filter(x => METAL_RE[m].test(x.title) && !METAL_NOT[m].test(x.title) && PRICE_WORDS.test(x.title) && !/^(gold|silver) (rate|price)s? today:?\s*(check|in )/i.test(x.title))
      .filter(x => { const k = x.title.toLowerCase().slice(0, 60); if (seen.has(m + k)) return false; seen.add(m + k); return true; });
    const pick = x => x && { t: x.title, src: x.source || '', at: x.t, u: /^https?:\/\//.test(x.link) ? x.link : '' };
    // a headline naming only the other metal belongs there; one naming both counts for both
    const mine = hits.filter(x => m === 'gold' || !/\bgold\b/i.test(x.title) || /\bsilver\b.*\b(falls?|rises?|jumps?|slips?|gains?|drops?|surges?|tumbles?|climbs?)/i.test(x.title));
    out[m] = { why: pick(mine.find(x => now - x.t < 30 * 3600e3 && !OUTLOOK.test(x.title))), view: pick(mine.find(x => now - x.t < 5 * 86400e3 && OUTLOOK.test(x.title))) };
  }
  // Option B: an AI summary of what the reports say — why it moved, and what experts expect (never our own forecast)
  const recent = { gold: [], silver: [] };
  for (const m of ['gold', 'silver']) recent[m] = all.filter(x => now - x.t < 36 * 3600e3 && METAL_RE[m].test(x.title) && !METAL_NOT[m].test(x.title) && PRICE_WORDS.test(x.title))
    .filter((x, i, l) => l.findIndex(y => y.title.toLowerCase().slice(0, 50) === x.title.toLowerCase().slice(0, 50)) === i).slice(0, 14);
  const views = { gold: all.filter(x => now - x.t < 5 * 86400e3 && /\bgold\b/i.test(x.title) && OUTLOOK.test(x.title)).slice(0, 6),
                  silver: all.filter(x => now - x.t < 5 * 86400e3 && /\bsilver\b/i.test(x.title) && OUTLOOK.test(x.title)).slice(0, 6) };
  const gr = await dbGet(env, ['gr_gold', 'gr_silver']), dirs = {};
  for (const [m, k] of [['gold', 'gr_gold'], ['silver', 'gr_silver']]) { const v = gr[k]?.v || {}, ks = Object.keys(v).filter(x => /^\d{4}-/.test(x)).sort();
    if (ks.length >= 2) { const a = v[ks[ks.length - 1]], b = v[ks[ks.length - 2]]; dirs[m] = Math.abs(a - b) / b < 0.001 ? 0 : Math.sign(a - b); } }
  const sig = 'p5' + JSON.stringify(dirs) + JSON.stringify([recent, views].map(o => [o.gold.map(x => x.title), o.silver.map(x => x.title)]));
  const old = (await dbGet(env, ['news_Bullion'])).news_Bullion;
  let sum = old && old.v && old.v.sum, aiNote = 'kept';
  if (!sum || !String(old.v.sig || '').startsWith(sig.slice(0, 2)) || (old.v.sig !== sig && now - (sum.at || 0) > 25 * 60e3) || now - (sum.at || 0) > 6 * 3600e3) {
    try { sum = await bullionSummary(env, recent, views, dirs); aiNote = 'new'; } catch (e) { aiNote = 'AI failed: ' + String(e.message || e).slice(0, 80); if (sum && now - sum.at > 12 * 3600e3) sum = null; }
  }
  out.sum = sum || null; out.sig = aiNote === 'new' ? sig : (old && old.v && old.v.sig) || '';   // only a fresh summary moves the signature on
  await dbPut(env, 'news_Bullion', out);
  const n = lists.reduce((a, l) => a + l.length, 0);
  return 'summary ' + aiNote + ': ' + (sum ? ['gold', 'silver'].map(m => m + ' why=' + (sum[m]?.why || '-') + ' | experts=' + (sum[m]?.experts || '-') + ' (' + (sum[m]?.n || 0) + ')').join(' · ') : 'none') + ' [' + recent.gold.length + 'g/' + recent.silver.length + 's headlines, ' + n + ' read]';
}
// US watchlist news: the same, from US business feeds, for the stocks in the US watchlist
const WATCH_FEEDS_US = [...FEEDS.USMarkets,
  ['https://www.cnbc.com/id/10000664/device/rss/rss.html', 'CNBC'], ['https://www.cnbc.com/id/19854910/device/rss/rss.html', 'CNBC'],
  ['https://feeds.content.dowjones.io/public/rss/mw_bulletins', 'MarketWatch'], ['https://www.nasdaq.com/feed/rssoutbound?category=Stocks', 'Nasdaq'],
  ['https://www.nasdaq.com/feed/rssoutbound?category=Technology', 'Nasdaq'], ['https://seekingalpha.com/feed.xml', 'Seeking Alpha'],
  ['https://www.livemint.com/rss/technology', 'Mint'], ['https://economictimes.indiatimes.com/tech/rssfeeds/13357270.cms', 'Economic Times']];
Object.assign(ALIAS, { 'NASDAQ:GOOGL': ['Alphabet', 'Google', 'Waymo', 'YouTube'], 'NASDAQ:GOOG': ['Alphabet', 'Google'], 'NYSE:TSM': ['TSMC', 'Taiwan Semiconductor'], 'NASDAQ:META': ['Meta Platforms', 'Facebook', 'Instagram'],
  'NASDAQ:NVDA': ['Nvidia'], 'NASDAQ:MSFT': ['Microsoft'], 'NASDAQ:AAPL': ['Apple', 'iPhone'], 'NASDAQ:AMZN': ['Amazon', 'AWS'], 'NYSE:CRM': ['Salesforce'], 'NASDAQ:TSLA': ['Tesla'] });
async function jobWatch(env, us) {
  const list = ((((await getCfg(env)).watch || {})[us ? 'us' : 'in']) || []).filter(x => !/^INDEX/.test(x.sym));
  const FEEDS_W = us ? WATCH_FEEDS_US : WATCH_FEEDS;
  const ms = list.map(x => [x, stockMatcher(x)]);
  const lists = await Promise.all(FEEDS_W.map(([u, s]) => readFeed(u, s)));
  const perFeed = FEEDS_W.map((f, i) => [f[1], lists[i].length]).reduce((o, [n, c]) => (o[n] = (o[n] || 0) + c, o), {});
  const count = {}, hits = [];
  lists.flat().sort((a, b) => b.t - a.t).forEach(it => {
    if (us && (/earnings call transcript|\bGAAP EPS\b/i.test(it.title))) return;
    const m = ms.find(([, f]) => f(it.title)); if (!m) return;
    hits.push({ ...it, sym: m[0].sym, tick: m[0].tick });
  });
  const top = pickTop(hits, { keep: 8, per: 3, ageH: 48, skip: x => { if ((count[x.sym] || 0) >= 2) return true; count[x.sym] = (count[x.sym] || 0) + 1; return false; } });
  await dbPut(env, us ? 'news_WatchUS' : 'news_Watch', top);      // an empty list is fine: the slide hides itself
  return top.length + ' headlines for ' + new Set(top.map(x => x.tick)).size + ' stocks, from ' + hits.length + ' matches (' + Object.entries(perFeed).map(([n, c]) => n + ' ' + c).join(', ') + ')' +
    (top[0] ? ' · newest: [' + top[0].tick + '] ' + top[0].text.slice(0, 60) : '');
}

/* ---------------- gold & silver: IBJA (India Bullion and Jewellers Association) ----------------
   The official national rates (before GST and making charges), published on working days around noon and 5 pm.
   Their home page carries about four months of daily rates in two hidden fields: gold 999 per 10 g, silver 999 per kg. */
const unesc = t => String(t).replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
async function jobMetals(env) {
  const notes = [];
  // gold: Bangalore jewellers' 24K rate per gram from GoodReturns (its page lists the last 10 days; the server keeps every day it sees)
  try {
    const page = await get('https://www.goodreturns.in/gold-rates/bangalore.html');
    const MON = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
    const cell = h => h.replace(/<[^>]+>/g, ' ').replace(/&#x20b9;|&#8377;|&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    const rupees = t => { const m = t.match(/₹?\s*([\d,]{4,})/); return m ? num(m[1]) : null; };
    const seen = {};
    (page.match(/<tr[\s\S]*?<\/tr>/g) || []).forEach(tr => {
      const td = (tr.match(/<td[\s\S]*?<\/td>/g) || []).map(cell); if (td.length < 2) return;
      const d = td[0].match(/^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/); if (!d || !MON[d[1]]) return;
      const k24 = rupees(td[1]), k22 = td[2] ? rupees(td[2]) : null;
      if (!k24 || k24 < 3000 || k24 > 60000 || (k22 && k22 > k24)) return;          // 24K per gram, never below the 22K beside it
      const k = `${d[3]}-${p2(MON[d[1]])}-${p2(+d[2])}`; if (!seen[k]) seen[k] = k24;   // first table wins (the 10-day one)
    });
    const n = Object.keys(seen).length; if (n < 3) throw new Error('GoodReturns gold table not found');
    const hist = (await dbGet(env, ['gr_gold'])).gr_gold?.v || {};
    Object.assign(hist, seen);
    // first time only: add older days the server saved from the sheet (also GoodReturns), if they agree on the days both have
    if (!hist._seeded) {
      const old = (await dbGet(env, ['metal_hist'])).metal_hist?.v || {}, both = Object.keys(seen).filter(k => old[k] && old[k].gold);
      const agree = both.length >= 2 && both.every(k => Math.abs(old[k].gold - seen[k]) / seen[k] < 0.005);
      if (agree) Object.keys(old).forEach(k => { if (!hist[k] && old[k].gold) hist[k] = old[k].gold; });
      hist._seeded = agree ? 'sheet' : 'none';
    }
    const keys = Object.keys(hist).filter(k => /^\d{4}-/.test(k)).sort(); keys.slice(0, Math.max(0, keys.length - 400)).forEach(k => delete hist[k]);
    await dbPut(env, 'gr_gold', hist);
    const last = keys[keys.length - 1];
    notes.push(`gold (GoodReturns) ₹${hist[last]}/g (${last}), ${n} on page, ${keys.length} days kept, older days from sheet: ${hist._seeded}`);
  } catch (e) { notes.push('gold (GoodReturns): ' + (e.message || e)); }
  // IBJA: kept only as the backup for gold and silver
  try {
  const html = await get('https://www.ibjarates.com/');
  const field = id => { const m = html.match(new RegExp('id="' + id + '"\\s+value="([^"]*)"')) || html.match(new RegExp('value="([^"]*)"\\s+id="' + id + '"')); return m ? JSON.parse(unesc(m[1])) : null; };
  const G = field('HdnGold'), S = field('HdnSilver');
  if (!G || !S) throw new Error('IBJA page layout changed (no rate history found)');
  const iso = l => { const m = String(l).match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
  const series = (labels, vals, div) => labels.map((l, i) => ({ date: iso(l), p: vals[i] != null ? +vals[i] / div : null })).filter(x => x.date && x.p > 0);
  const gold = series(G.labels || [], G.purity999 || [], 10);          // → per gram
  const silver = series(S.labels || [], S.silverRate || [], 1);        // per kg
  if (gold.length < 5 || silver.length < 5) throw new Error('IBJA history too short');
  // the latest published rate (today's noon/5 pm) can be newer than the history: add it as today's point
  const now = num((html.match(/id="GoldRatesCompare999"[^>]*>\s*([\d,.]+)/) || [])[1]);
  const p = istParts(), today = `${p.y}-${p2(p.mo)}-${p2(p.d)}`, weekday = p.wd >= 1 && p.wd <= 5;
  if (now && weekday && p.h >= 12 && gold[gold.length - 1].date !== today && Math.abs(now - gold[gold.length - 1].p) > 0.5) gold.push({ date: today, p: now, live: true });
  const o = { gold, silver, at: Date.now() };
  await dbPut(env, 'ibja', o);
  const g = gold[gold.length - 1];
  notes.push(`backup IBJA ₹${g.p}/g (${g.date})`);
  } catch (e) { notes.push('backup IBJA: ' + (e.message || e)); }
  // silver: Bangalore jewellers' rate from GoodReturns (its page lists the last 10 days; the server keeps every day it sees)
  let sNote = '';
  try {
    const page = await get('https://www.goodreturns.in/silver-rates/bangalore.html');
    const MON = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
    const re = /<td>\s*([A-Z][a-z]{2}) (\d{1,2}), (\d{4})\s*<\/td>\s*<td>[^<]*<\/td>\s*<td>[^<]*<\/td>\s*<td>\s*(?:&#x20b9;|₹)\s*([\d,]+)/g;
    const hist = (await dbGet(env, ['gr_silver'])).gr_silver?.v || {};
    let m, n = 0;
    while ((m = re.exec(page))) { if (!MON[m[1]]) continue; hist[`${m[3]}-${p2(MON[m[1]])}-${p2(+m[2])}`] = num(m[4]); n++; }
    if (!n) throw new Error('GoodReturns silver table not found');
    const keys = Object.keys(hist).sort(); keys.slice(0, Math.max(0, keys.length - 400)).forEach(k => delete hist[k]);
    await dbPut(env, 'gr_silver', hist);
    const last = keys[keys.length - 1];
    sNote = `silver (GoodReturns) ₹${hist[last]}/kg (${last}), ${keys.length} days kept`;
  } catch (e) { sNote = 'silver (GoodReturns): ' + (e.message || e); }
  notes.push(sNote);
  if (/^(gold|silver) \(GoodReturns\):/.test(notes[0]) && /^silver \(GoodReturns\):/.test(sNote) && /^backup IBJA:/.test(notes[1] || '')) throw new Error(notes.join(' · '));
  return notes.join(' · ');
}

/* ---------------- the timer ---------------- */
async function runJob(env, job) {
  try { const note = job === 'news:Local' ? await jobLocal(env) : job === 'news:Watch' ? await jobWatch(env) : job === 'news:WatchUS' ? await jobWatch(env, true) : job === 'news:Bullion' ? await jobBullion(env) : job === 'news:Mood' ? await jobMood(env) : job.startsWith('news:') ? await jobNews(env, job.slice(5)) : job === 'env' ? await jobEnv(env) : job === 'metals' ? await jobMetals(env) : await jobPrices(env); await logRun(env, job, true, note); return note; }
  catch (e) { await logRun(env, job, false, e.message || e); return 'failed: ' + (e.message || e); }
}
async function tick(env, t = Date.now()) {
  const p = istParts(t), m = p.mi, jobs = [];
  if (marketWindow(t) || m % 20 === 0) jobs.push('prices');
  if (m % 10 === 0) jobs.push('env');
  if (m % 10 === 5 && (p.h >= 6 && p.h <= 19 || m === 5)) jobs.push('metals');   // every 10 min from 6 am to 7 pm, else hourly
  const sec = { 1: 'Local', 2: 'India', 3: 'Watch', 4: 'World', 6: 'Markets', 7: 'WatchUS', 8: 'USMarkets', 9: 'Bullion', 0: 'Mood' }[m % 10];   // one news section every 2 minutes
  if (sec) jobs.push('news:' + sec);
  for (const j of jobs) await runJob(env, j);
}

/* ---------------- what the app reads ---------------- */
async function allTabs(env) {
  const d = await dbGet(env, ['sheet1', 'idx', 'env', 'news_India', 'news_World', 'news_Markets', 'news_USMarkets']);
  const E = d.env?.v || {};
  // Sheet1, with the airport reports in column R and a heartbeat in W2 (how the app tells a fresh copy from an old one)
  let main = null;
  if (d.sheet1) {
    main = d.sheet1.v.map(r => r.slice());
    const need = Math.max(main.length, (E.metar || []).length, 2);
    while (main.length < need) main.push([]);
    main.forEach(r => { while (r.length < 23) r.push(''); r[17] = ''; });
    (E.metar || []).forEach((l, i) => { main[i][17] = l; });
    main[0][22] = 'Heartbeat'; main[1][22] = istStamp(d.sheet1.at);
  }
  // News tab: A India, B World, C2 time, D Markets, E/F/G links, H US Markets, I its links
  const N = s => d['news_' + s]?.v || [];
  const newsAt = Math.max(0, ...['India', 'World', 'Markets', 'USMarkets'].map(s => d['news_' + s]?.at || 0));
  const news = [['India', 'World', 'Updated', 'Markets', 'India link', 'World link', 'Markets link', 'US Markets', 'US Markets link']];
  const T = (a, i) => a[i]?.text || '', L = (a, i) => a[i]?.link || '';
  for (let i = 0; i < KEEP; i++) news.push([T(N('India'), i), T(N('World'), i), i === 0 && newsAt ? istStamp(newsAt, false) : '', T(N('Markets'), i), L(N('India'), i), L(N('World'), i), L(N('Markets'), i), T(N('USMarkets'), i), L(N('USMarkets'), i)]);
  // AQI tab: A–D air quality, F–J airports, L–M settings, O–S indices
  const ap = E.airports || [], st = E.settings || [], ix = d.idx?.v || [];
  const n = Math.max(2, ap.length + 1, st.length + 1, ix.length);
  const aqi = [];
  for (let i = 0; i < n; i++) {
    const r = new Array(19).fill('');
    if (i === 0) { r.splice(0, 4, 'AQI', 'AQI station', 'AQI updated', 'AQI main'); r.splice(5, 5, 'Airport', 'Lat', 'Lon', 'Name', 'Report'); r.splice(11, 2, 'Setting', 'Value'); }
    if (i === 1 && E.aqi) r.splice(0, 4, ...E.aqi);
    if (i >= 1 && ap[i - 1]) r.splice(5, 5, ...ap[i - 1]);
    if (i >= 1 && st[i - 1]) r.splice(11, 2, ...st[i - 1]);
    if (ix[i]) r.splice(14, 5, ...ix[i]);
    aqi.push(r);
  }
  const ages = Object.fromEntries(Object.entries(d).map(([k, x]) => [k, Math.round((Date.now() - x.at) / 1000)]));
  return { at: Date.now(), ages, tabs: { [GID.main]: main, [GID.news]: news, [GID.aqi]: aqi } };
}

/* ---------------- settings & watchlist (shared by all your screens) ----------------
   Stored here instead of the sheet. Changing them needs the PIN chosen the first time (kept only as a hash). */
const DEFAULT_WATCH = {"in": [{"sym": "NSE:M&M", "name": "Mahindra & Mahindra", "tick": "M&M", "dom": "mahindra.com"}, {"sym": "NSE:SONACOMS", "name": "Sona BLW Precision", "tick": "SONACOMS", "dom": "sonacomstar.com"}, {"sym": "NSE:BAJFINANCE", "name": "Bajaj Finance", "tick": "BAJFINANCE", "dom": "bajajfinserv.in"}, {"sym": "NSE:BHARTIARTL", "name": "Bharti Airtel", "tick": "BHARTIARTL", "dom": "airtel.in"}, {"sym": "NSE:HDFCBANK", "name": "HDFC Bank", "tick": "HDFCBANK", "dom": "hdfcbank.com"}, {"sym": "NSE:TCS", "name": "TCS", "tick": "TCS", "dom": "tcs.com"}, {"sym": "NSE:INOXINDIA", "name": "INOX India", "tick": "INOXINDIA", "dom": "inoxindia.com"}, {"sym": "NSE:TITAN", "name": "Titan Company", "tick": "TITAN", "dom": "titancompany.in"}, {"sym": "NSE:POLYMED", "name": "Poly Medicure", "tick": "POLYMED", "dom": "polymedicure.com"}, {"sym": "NSE:ITC", "name": "ITC", "tick": "ITC", "dom": "itcportal.com"}, {"sym": "NSE:ABREL", "name": "Aditya Birla Real Estate", "tick": "ABREL", "dom": "adityabirlarealestate.com"}, {"sym": "NSE:TATACONSUM", "name": "Tata Consumer", "tick": "TATACONSUM", "dom": "tataconsumer.com"}], "large": [{"sym": "NSE:RELIANCE", "name": "Reliance", "tick": "RELIANCE", "dom": "ril.com"}, {"sym": "NSE:LT", "name": "Larsen & Toubro", "tick": "LT", "dom": "larsentoubro.com"}, {"sym": "NSE:ICICIBANK", "name": "ICICI Bank", "tick": "ICICIBANK", "dom": "icicibank.com"}, {"sym": "NSE:INFY", "name": "Infosys", "tick": "INFY", "dom": "infosys.com"}, {"sym": "NSE:HINDUNILVR", "name": "Hindustan Unilever", "tick": "HINDUNILVR", "dom": "hul.co.in"}, {"sym": "NSE:SUNPHARMA", "name": "Sun Pharma", "tick": "SUNPHARMA", "dom": "sunpharma.com"}, {"sym": "NSE:TMCV", "name": "Tata Motors", "tick": "TMCV", "dom": "tatamotors.com"}, {"sym": "NSE:TATASTEEL", "name": "Tata Steel", "tick": "TATASTEEL", "dom": "tatasteel.com"}, {"sym": "NSE:TATAPOWER", "name": "Tata Power", "tick": "TATAPOWER", "dom": "tatapower.com"}, {"sym": "NSE:INDIGO", "name": "IndiGo", "tick": "INDIGO", "dom": "goindigo.in"}, {"sym": "NSE:BEL", "name": "Bharat Electronics", "tick": "BEL", "dom": "bel-india.in"}, {"sym": "NSE:RECLTD", "name": "REC", "tick": "RECLTD", "dom": "recindia.nic.in"}, {"sym": "NSE:CIPLA", "name": "Cipla", "tick": "CIPLA", "dom": "cipla.com"}, {"sym": "NSE:DRREDDY", "name": "Dr. Reddy's", "tick": "DRREDDY", "dom": "drreddys.com"}, {"sym": "NSE:VBL", "name": "Varun Beverages", "tick": "VBL", "dom": "varunbeverages.com"}, {"sym": "NSE:AMBUJACEM", "name": "Ambuja Cements", "tick": "AMBUJACEM", "dom": "ambujacement.com"}], "us": [{"sym": "NYSE:TSM", "name": "TSMC", "tick": "TSM", "dom": "tsmc.com"}, {"sym": "NASDAQ:NVDA", "name": "Nvidia", "tick": "NVDA", "dom": "nvidia.com"}, {"sym": "NYSE:CRM", "name": "Salesforce", "tick": "CRM", "dom": "salesforce.com"}, {"sym": "NASDAQ:MSFT", "name": "Microsoft", "tick": "MSFT", "dom": "microsoft.com"}, {"sym": "NASDAQ:AAPL", "name": "Apple", "tick": "AAPL", "dom": "apple.com"}, {"sym": "NASDAQ:GOOGL", "name": "Alphabet (Google)", "tick": "GOOGL", "dom": "google.com"}, {"sym": "NASDAQ:AMZN", "name": "Amazon", "tick": "AMZN", "dom": "amazon.com"}]};
const SALT = 'desk-ticker:v1:';
async function sha(t) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(SALT + t)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(''); }
async function getCfg(env) {
  const d = await dbGet(env, ['cfg', 'env']);
  if (d.cfg) {
    const c = d.cfg.v;
    if (c.watch && c.watch.large && c.watch.large.length) { c.watch = cleanWatch(c.watch); c.at = Date.now(); await dbPut(env, 'cfg', c); }   // fold the old large-caps list into the one Indian watchlist
    return c;
  }
  const fromSheet = Object.fromEntries(((d.env?.v || {}).settings || []).map(([k, v]) => [k, v]));   // first time: copy the sheet's Settings tab
  const cfg = { settings: fromSheet, watch: cleanWatch(DEFAULT_WATCH), pin: null, fails: 0, lockUntil: 0, at: Date.now() };
  await dbPut(env, 'cfg', cfg);
  return cfg;
}
const SETTING_KEYS = /^(Seconds per slide|Show .+ slide|Currency [123]|Night clock (starts|ends)|Home (lat|lon|name|city))$/;
function cleanWatch(w) {
  const one = x => x && typeof x.sym === 'string' && /^[A-Z]+:[A-Z0-9&._\-]{1,20}$/.test(x.sym) ? {
    sym: x.sym, name: String(x.name || x.sym.split(':')[1]).slice(0, 40), tick: String(x.tick || x.sym.split(':')[1]).slice(0, 20),
    ...(x.dom && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(x.dom) ? { dom: x.dom } : {}) } : null;
  const list = l => (Array.isArray(l) ? l : []).map(one).filter(Boolean).filter((x, i, a) => a.findIndex(y => y.sym === x.sym) === i).slice(0, 60);
  return { in: list([...(Array.isArray(w.in) ? w.in : []), ...(Array.isArray(w.large) ? w.large : [])]), large: [], us: list(w.us) };   // one Indian list
}
async function saveSettings(env, body) {
  const cfg = await getCfg(env);
  if (cfg.lockUntil > Date.now()) return [429, { error: 'Too many wrong PINs. Try again after ' + istStamp(cfg.lockUntil).slice(11, 16) + '.' }];
  if (!cfg.pin) {                                    // first save: choose the PIN
    if (!/^\d{4,8}$/.test(String(body.newPin || ''))) return [403, { error: 'choose-pin' }];
    cfg.pin = await sha(String(body.newPin));
  } else if ((await sha(String(body.pin || ''))) !== cfg.pin) {
    cfg.fails = (cfg.fails || 0) + 1;
    if (cfg.fails >= 5) { cfg.lockUntil = Date.now() + 15 * 60e3; cfg.fails = 0; }
    await dbPut(env, 'cfg', cfg);
    return [403, { error: 'wrong-pin' }];
  }
  cfg.fails = 0;
  if (body.set && typeof body.set === 'object') Object.entries(body.set).forEach(([k, v]) => {
    if (!SETTING_KEYS.test(k)) return;
    if (v === null) delete cfg.settings[k]; else cfg.settings[k] = String(v).slice(0, 60);
  });
  if (body.watch) cfg.watch = cleanWatch(body.watch);
  cfg.at = Date.now();
  await dbPut(env, 'cfg', cfg);
  return [200, { ok: true, settings: cfg.settings, watch: cfg.watch, at: cfg.at }];
}
// find a stock by its ticker: NSE (then BSE) for India, US exchanges for the US
async function lookup(q, mkt) {
  q = String(q || '').trim().toUpperCase().replace(/^(NSE|BSE|NASDAQ|NYSE):/, '');
  if (!/^[A-Z0-9&._\-]{1,20}$/.test(q)) return null;
  const tries = mkt === 'us' ? [[q.replace(/\./g, '-'), null]] : [[q + '.NS', 'NSE'], [q + '.BO', 'BOM']];
  for (const [ys, ex] of tries) {
    try {
      const m = (await get('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ys) + '?range=1d&interval=1d', { json: true })).chart.result[0].meta;
      if (!m || m.regularMarketPrice == null) continue;
      const e = ex || ({ NMS: 'NASDAQ', NGM: 'NASDAQ', NCM: 'NASDAQ', NYQ: 'NYSE', PCX: 'NYSEARCA', ASE: 'NYSEAMERICAN', BTS: 'BATS' }[m.exchangeName] || 'NYSE');
      return { sym: e + ':' + q, name: String(m.longName || m.shortName || q).replace(/\s+(Limited|Ltd\.?|Inc\.?|Corporation|Corp\.?)$/i, ''), tick: q, price: m.regularMarketPrice, currency: m.currency };
    } catch (e) {}
  }
  return null;
}

/* ---------------- v2: one clean feed for the app ---------------- */
const IST_DMY = s => { const m = String(s || '').match(/(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})/); return m ? Date.parse(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00+05:30`) : null; };
const rateOf = v => { const m = String(v || '').match(/([\d,]+(?:\.\d+)?)\s*(?:\(\s*([+\-−]?[\d,]+(?:\.\d+)?)\s*\))?/); if (!m) return null;
  const p = parseFloat(m[1].replace(/,/g, '')), c = m[2] != null ? parseFloat(m[2].replace(/,/g, '').replace('−', '-')) : null; return p > 0 ? { p, c } : null; };
const isoDay = s => { const t = Date.parse(s); return t ? new Date(t + 6 * 3600e3).toISOString().slice(0, 10) : null; };
/* ---------------- /v2/watch: a short plain-text summary for an Apple Watch Shortcut ---------------- */
async function watchText(env) {
  const f = await feed(env), now = Date.now(), out = [];
  const t = istParts(now), us = t.h >= 19 || t.h < 3;
  const num = n => Math.round(n).toLocaleString('en-IN'), inr = n => '₹' + num(n);
  const arr = p => p > 0.005 ? '▲' : p < -0.005 ? '▼' : '•';
  const sym = us ? 'INDEXSP:.INX' : 'INDEXNSE:NIFTY_50', q = (f.quotes || {})[sym] || {};
  if (q.p != null) out.push((us ? 'S&P 500 ' : 'Nifty 50 ') + num(q.p) + (q.pct != null ? ' ' + arr(q.pct) + ' ' + Math.abs(q.pct).toFixed(2) + '%' : ''));
  const M = ((f.news || {}).Mood || {})[us ? 'us' : 'in'];
  if (M && M.trend && now - (M.at || 0) < 4 * 864e5) { out.push('Trend: ' + M.trend); if (M.why) out.push('Why: ' + M.why); }
  const m = f.metals || {}, g = (m.gold || [])[0], g1 = (m.gold || [])[1], sv = (m.silver || [])[0], s1 = (m.silver || [])[1];
  const pc = (x, y) => !x ? null : x.c != null && x.p !== x.c ? x.c / (x.p - x.c) * 100 : y && y.p ? (x.p - y.p) / y.p * 100 : null;
  if (out.length) out.push('');
  if (g) { const p = pc(g, g1); out.push('Gold 10g ' + inr(g.p * 10) + (p != null ? ' ' + arr(p) + ' ' + Math.abs(p).toFixed(1) + '%' : '')); }
  if (sv) { const p = pc(sv, s1); out.push('Silver 1kg ' + inr(sv.p) + (p != null ? ' ' + arr(p) + ' ' + Math.abs(p).toFixed(1) + '%' : '')); }
  const S = ((f.news || {}).Bullion || {}).sum;
  if (S && now - (S.at || 0) < 12 * 3600e3 && S.gold && S.gold.why) out.push('Why: ' + S.gold.why);
  try {
    const st = f.settings || {}, lat = parseFloat(st['Home lat']) || 12.9352, lon = parseFloat(st['Home lon']) || 77.6245;
    const r = await fetch('https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon + '&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=1');
    const w = await r.json(), c = w.current || {}, d = w.daily || {};
    const WX = { 0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'cloudy', 45: 'fog', 48: 'fog', 51: 'drizzle', 53: 'drizzle', 55: 'drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain', 80: 'showers', 81: 'showers', 82: 'heavy showers', 95: 'thunderstorm', 96: 'thunderstorm', 99: 'thunderstorm' };
    out.push('');
    out.push(Math.round(c.temperature_2m) + '° ' + (WX[c.weather_code] || '') + ' · ' + Math.round(d.temperature_2m_max[0]) + '°/' + Math.round(d.temperature_2m_min[0]) + '°' +
      ((d.precipitation_probability_max || [0])[0] >= 40 ? ' · rain likely' : ''));
  } catch (e) {}
  const a = f.aqi && f.aqi.aqi != null ? Math.round(f.aqi.aqi) : null;
  if (a != null) out.push('Air: ' + (a <= 50 ? 'Good' : a <= 100 ? 'Moderate' : a <= 150 ? 'Poor' : 'Unhealthy') + ' (AQI ' + a + ')');
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() || 'No data yet';
}
async function feed(env) {
  const cfg = await getCfg(env);
  const keys = ['sheet1', 'idx', 'env', 'log', 'metal_hist', 'ibja', 'gr_silver', 'gr_gold', 'news_India', 'news_World', 'news_Markets', 'news_USMarkets', 'news_Local', 'news_Watch', 'news_WatchUS', 'news_Bullion', 'mood'];
  const d = await dbGet(env, keys), E = d.env?.v || {}, rows = (d.sheet1?.v || []).slice(1);
  const quotes = {};
  rows.forEach(r => {
    const sym = String(r[0] || '').trim(), p = num(r[1]), c = num(r[2]);
    if (!sym || p == null) return;
    quotes[sym] = { p, c, pct: c != null && p !== c ? c / (p - c) * 100 : num(r[3]), prev: c != null ? p - c : null,
      hi52: num(r[4]), lo52: num(r[5]), src: r[23] === 'yahoo' ? 'yahoo' : 'google', at: num(r[24]) ? num(r[24]) * 1000 : null };
  });
  // gold (24K, per gram) and silver (per kg) from the GoodReturns tables: newest first
  const metals = { gold: [], silver: [] };
  rows.forEach(r => {
    const g = rateOf(r[9]), gd = isoDay(r[8]), s = rateOf(r[15]), sd = isoDay(r[12]);
    if (g && gd) metals.gold.push({ date: gd, p: g.p, c: g.c });
    if (s && sd) metals.silver.push({ date: sd, p: s.p, c: s.c });
  });
  metals.source = 'GoodReturns Bangalore';
  const I = d.ibja?.v;
  if (I && I.gold?.length && I.silver?.length) {           // IBJA (official, before GST), with ~4 months of history: newest first
    const withChg = list => list.map((x, i) => ({ date: x.date, p: x.p, c: i ? +(x.p - list[i - 1].p).toFixed(2) : null })).reverse();
    metals.gold = withChg(I.gold); metals.silver = withChg(I.silver); metals.source = 'IBJA'; metals.at = d.ibja.at;
    metals.goldSource = 'IBJA'; metals.silverSource = 'IBJA';
  }
  const GG = d.gr_gold?.v;                                 // gold: GoodReturns Bangalore 24K per gram, as many days as kept
  if (GG) {
    const list = Object.keys(GG).filter(k => /^\d{4}-/.test(k)).sort().map(k => ({ date: k, p: GG[k] }));
    if (list.length >= 2) { metals.gold = list.map((x, i) => ({ date: x.date, p: x.p, c: i ? x.p - list[i - 1].p : null })).reverse(); metals.goldSource = 'GoodReturns Bangalore'; }
  }
  const GS = d.gr_silver?.v;                               // silver: GoodReturns Bangalore (jewellers' rate), as many days as kept
  if (GS && Object.keys(GS).length >= 2) {
    const list = Object.keys(GS).sort().map(k => ({ date: k, p: GS[k] }));
    metals.silver = list.map((x, i) => ({ date: x.date, p: x.p, c: i ? x.p - list[i - 1].p : null })).reverse();
    metals.silverSource = 'GoodReturns Bangalore';
  }
  if (metals.goldSource === 'GoodReturns Bangalore' && metals.silverSource === 'GoodReturns Bangalore') { metals.source = 'GoodReturns Bangalore'; metals.at = Math.max(d.gr_gold?.at || 0, d.gr_silver?.at || 0) || metals.at; }
  const charts = {};
  (d.idx?.v || []).slice(1).forEach(r => {
    charts[r[0]] = { p: num(r[1]), prev: num(r[2]), at: num(r[3]) ? num(r[3]) * 1000 : null,
      line: String(r[4] || '').split(';').map(x => x.split(':').map(Number)).filter(x => x.length === 2 && isFinite(x[0]) && isFinite(x[1])).map(([t, v]) => [t * 1000, v]) };
  });
  const news = {};
  { const L = d.news_Local, W = d.news_Watch;
    news.Local = { at: L?.at || null, city: L?.v?.city || '', items: (L?.v?.items || []).map(i => ({ t: i.text, u: i.link })) };
    news.Watch = { at: W?.at || null, items: (W?.v || []).map(i => ({ t: i.text, u: i.link, sym: i.sym, tick: i.tick })) };
    news.Mood = { at: d.mood?.at || null, ...(d.mood?.v || {}) };
    news.Bullion = { at: d.news_Bullion?.at || null, sum: d.news_Bullion?.v?.sum || null };
    const WU = d.news_WatchUS; news.WatchUS = { at: WU?.at || null, items: (WU?.v || []).map(i => ({ t: i.text, u: i.link, sym: i.sym, tick: i.tick })) }; }
  ['India', 'World', 'Markets', 'USMarkets'].forEach(s => { const x = d['news_' + s]; news[s] = { at: x?.at || null, items: (x?.v || []).map(i => ({ t: i.text, u: i.link })) }; });
  const a = E.aqi;
  const ages = Object.fromEntries(Object.entries(d).filter(([k]) => !['log', 'metal_hist', 'ibja', 'gr_silver', 'gr_gold'].includes(k)).map(([k, x]) => [k, Math.round((Date.now() - x.at) / 1000)]));
  return {
    v: 2, at: Date.now(),
    quotes, charts, metals, news,
    aqi: a ? { aqi: num(a[0]), name: a[1], at: IST_DMY(a[2]), main: a[3] } : null,
    metar: E.metar || [],
    airports: (E.airports || []).map(x => ({ code: x[0], lat: num(x[1]), lon: num(x[2]), name: x[3], raw: x[4] })),
    settings: cfg.settings, watchlist: cfg.watch, settingsAt: cfg.at, pinSet: !!cfg.pin,
    health: { ages, runs: d.log?.v || {}, pricesAt: d.sheet1?.at || null },
  };
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' };
export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(tick(env, event.scheduledTime)); },
  async fetch(req, env) {
    const u = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      if (u.pathname === '/v2/settings' && req.method === 'POST') {
        let body = {}; try { body = await req.json(); } catch (e) {}
        const [code, out] = await saveSettings(env, body);
        return new Response(JSON.stringify(out), { status: code, headers: CORS });
      }
      if (u.pathname === '/v2/hist') return new Response(JSON.stringify(await hist(env, String(u.searchParams.get('sym') || '').slice(0, 40), u.searchParams.get('r'))), { headers: CORS });
      if (u.pathname === '/v2/lookup') return new Response(JSON.stringify(await lookup(u.searchParams.get('q'), u.searchParams.get('mkt'))), { headers: CORS });
      if (u.pathname === '/v2/local') return new Response(JSON.stringify(await localHere(env, +u.searchParams.get('lat'), +u.searchParams.get('lon'), u.searchParams.get('city'))), { headers: CORS });
      if (u.pathname === '/v2/watch') return new Response(await watchText(env), { headers: { ...CORS, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
      if (u.pathname === '/v2/feed') return new Response(JSON.stringify(await feed(env)), { headers: CORS });
      if (u.pathname === '/v1/all') return new Response(JSON.stringify(await allTabs(env)), { headers: CORS });
      if (u.pathname === '/v1/status') {
        const d = await dbGet(env, ['log', 'sheet1', 'idx', 'env', 'news_India', 'news_World', 'news_Markets', 'news_USMarkets']);
        const ages = Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'log').map(([k, x]) => [k, Math.round((Date.now() - x.at) / 60e3) + ' min ago']));
        return new Response(JSON.stringify({ now: istStamp(), ages, runs: d.log?.v || {} }, null, 1), { headers: CORS });
      }
      if (u.pathname === '/v1/run') {                 // run one job now (used once after each deploy); at most once a minute per job
        const job = u.searchParams.get('job') || 'prices';
        if (!/^(prices|env|metals|news:(India|World|Markets|USMarkets|Local|Watch|WatchUS|Bullion|Mood))$/.test(job)) return new Response('unknown job', { status: 400 });
        const last = (await dbGet(env, ['log'])).log?.v?.[job];
        if (last && last.at === istStamp().slice(0, 16) + last.at.slice(16)) return new Response(JSON.stringify({ job, note: 'ran this minute already', last }), { headers: CORS });
        return new Response(JSON.stringify({ job, note: await runJob(env, job) }), { headers: CORS });
      }
      return new Response('Desk Ticker server. Try /v1/status', { headers: { 'Content-Type': 'text/plain' } });
    } catch (e) { return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 500, headers: CORS }); }
  },
};
