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
  // settings: the sheet's script copies the Settings tab into the AQI tab, columns L–M
  try {
    const a = await sheetCSV(GID.aqi);
    const s = a.map(r => [String(r[11] || '').trim(), String(r[12] || '').trim()]).filter(r => r[0] && r[0] !== 'Setting');
    if (s.length) o.settings = s;
  } catch (e) { notes.push('settings: ' + e.message); }
  const set = Object.fromEntries((o.settings || []).map(r => [String(r[0]).trim(), String(r[1]).trim()]));
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
  return `metar ${o.metar?.length || 0}, airports ${o.airports?.length || 0}, aqi ${o.aqi ? o.aqi[0] + ' ' + o.aqi[1] : '—'}, settings ${o.settings?.length || 0}` + (notes.length ? ' · ' + notes.join(' | ') : '');
}

/* ---------------- news ---------------- */
const GN = q => 'https://news.google.com/rss/search?q=' + encodeURIComponent(q + ' when:1d') + '&hl=en-IN&gl=IN&ceid=IN:en';
const GNUS = q => 'https://news.google.com/rss/search?q=' + encodeURIComponent(q + ' when:1d') + '&hl=en-US&gl=US&ceid=US:en';
// Google News doesn't answer Cloudflare's servers, so the server reads papers' own feeds; whatever Google News
// headlines the sheet's script still collects (News tab) are used to fill a section when these come up short.
const FEEDS = {
  India: [['https://indianexpress.com/section/india/feed/', 'Indian Express'], ['https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml', 'Hindustan Times'],
    ['https://feeds.feedburner.com/ndtvnews-india-news', 'NDTV'], ['https://timesofindia.indiatimes.com/rssfeeds/-2128936835.cms', 'Times of India'],
    ['https://www.indiatoday.in/rss/1206514', 'India Today'], ['https://theprint.in/category/india/feed/', 'ThePrint'],
    ['https://www.news18.com/commonfeeds/v1/eng/rss/india.xml', 'News18'], ['https://www.livemint.com/rss/news', 'Mint']],
  Markets: [['https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms', 'ET Markets'], ['https://www.livemint.com/rss/markets', 'Mint'],
    ['https://www.business-standard.com/rss/markets-106.rss', 'Business Standard'], ['https://www.moneycontrol.com/rss/marketreports.xml', 'Moneycontrol'],
    ['https://www.financialexpress.com/market/feed/', 'Financial Express'], ['https://www.hindustantimes.com/feeds/rss/business/rssfeed.xml', 'Hindustan Times']],
  USMarkets: [['https://www.cnbc.com/id/20910258/device/rss/rss.html', 'CNBC'], ['https://feeds.content.dowjones.io/public/rss/mw_topstories', 'MarketWatch'],
    ['https://feeds.content.dowjones.io/public/rss/mw_marketpulse', 'MarketWatch'], ['https://finance.yahoo.com/news/rssindex', 'Yahoo Finance'],
    ['https://www.nasdaq.com/feed/rssoutbound?category=Markets', 'Nasdaq'], ['https://www.investing.com/rss/news_25.rss', 'Investing.com']],
  World: [['https://www.theguardian.com/world/rss', 'The Guardian'], ['https://www.cnbc.com/id/100727362/device/rss/rss.html', 'CNBC'],
    ['https://rss.dw.com/rdf/rss-en-world', 'DW'], ['https://feeds.npr.org/1004/rss.xml', 'NPR'], ['https://feeds.skynews.com/feeds/rss/world.xml', 'Sky News'],
    ['https://www.france24.com/en/rss', 'France 24'], ['https://www.hindustantimes.com/feeds/rss/world-news/rssfeed.xml', 'Hindustan Times'],
    ['https://timesofindia.indiatimes.com/rssfeeds/296589292.cms', 'Times of India']],
};
const BLOCK = ['The Hindu', 'BBC', 'Al Jazeera', 'NDTV Sports'];
const KEEP = 10, MAX_PER_SOURCE = 2, MAX_AGE_H = 12;
const MARKET_WORDS = /\b(sensex|nifty|nse|bse|stock|stocks|shares?|stock markets?|share market|equity|equities|ipo|rupee|rbi|sebi|fii|fiis|dii|q[1-4]|quarterly|profit|revenue|earnings|dividend|bonus|buyback|bond|bonds|yield|gold|silver|crude|inflation|gdp|mutual funds?|sip|smallcap|midcap|largecap|brokerage|target price|f&o|futures|nasdaq|dow|s&p|wall street|dalal street|investors?|valuation|market cap|promoters?)\b/i;
const US_WORDS = /\b(wall street|s&p|nasdaq|dow|nyse|stocks?|shares?|equities|earnings|fed|federal reserve|powell|treasury|treasuries|yields?|bond|bonds|ipo|rally|selloff|sell-off|futures|dollar|inflation|cpi|jobs report|payrolls|recession|tariffs?|nvidia|apple|microsoft|amazon|alphabet|google|meta|tesla|broadcom|berkshire|jpmorgan|investors?|market cap|valuation|guidance|outlook|chipmakers?|tech stocks)\b/i;
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
function isNews(t) {
  if (!isEnglish(t) || t.split(/\s+/).length < 6) return false;
  if (/^(video|watch|photos?|gallery|in pics|quiz|podcast|listen|opinion)\b/i.test(t)) return false;
  if (/\b(live (results|updates|blog|coverage|score)|election results|results 20\d\d|20\d\d .*results$|as it happened|highlights)\b/i.test(t)) return false;
  if (/\blive\s*:|\blive$|^live\b|\bLIVE\b/.test(t)) return false;
  if (/^(latest|top|breaking) (news|headlines)\b/i.test(t)) return false;
  if (/^(newstrack|explained|explainer|analysis|editorial|column|interview|watch|recap|in numbers)\s*[:|]/i.test(t)) return false;
  if (/\b(vacanc(y|ies)|recruitment|admit card|apply online|apply now|answer key|syllabus|sarkari|job alert)\b/i.test(t)) return false;
  if (/\b(special|quiz|horoscope|rashifal|lucky (number|colour)|wishes|greetings|images|messages)\s*:/i.test(t)) return false;
  return true;
}
async function readFeed(url, src) {
  try {
    const xml = await get(url);
    return (xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || []).map(it => {
      let title = decode(tag(it, 'title')), source = src;
      if (!source) { const k = title.lastIndexOf(' - '); if (k > 20) { source = title.slice(k + 3); title = title.slice(0, k); } }
      if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3));
      title = title.replace(/\s*\|\s*Latest News.*$/i, '');
      return { title, source, link: decode(tag(it, 'link')), t: Date.parse(decode(tag(it, 'pubDate'))) || 0 };
    }).filter(x => x.title && isNews(x.title) && !BLOCK.some(b => (x.source || '').toLowerCase().startsWith(b.toLowerCase())));
  } catch (e) { return []; }
}
const STOP = new Set('a an the of to in on for at by with and or is are was were be as from after over into its his her their this that says said amid new news'.split(' '));
const words = t => new Set(t.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)));
const sameStory = (a, b) => { let n = 0; a.forEach(w => { if (b.has(w)) n++; }); return n >= 3 && n / Math.min(a.size, b.size) >= 0.5; };
function pickTop(items) {
  const cutoff = Date.now() - MAX_AGE_H * 3600e3, seen = new Set(), per = {}, out = [], kept = [];
  items.filter(x => !x.t || x.t === 1 || x.t > cutoff).sort((a, b) => b.t - a.t).forEach(x => {
    const key = x.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 50), ws = words(x.title);
    if (seen.has(key) || out.length >= KEEP || (per[x.source] || 0) >= MAX_PER_SOURCE || kept.some(k => sameStory(k, ws))) return;
    seen.add(key); kept.push(ws); per[x.source] = (per[x.source] || 0) + 1;
    out.push({ text: x.source ? x.title + ' - ' + x.source : x.title, link: /^https?:\/\//.test(x.link) ? x.link : '' });
  });
  return out;
}
async function jobNews(env, section) {
  const lists = await Promise.all(FEEDS[section].map(([u, s]) => readFeed(u, s))), items = lists.flat();
  const perFeed = lists.map((l, i) => FEEDS[section][i][1] + ' ' + l.length).join(', ');
  // the sheet's own list (Google News, collected by the sheet's script) — used after the fresh items, to fill up
  try {
    const col = { India: [0, 4], World: [1, 5], Markets: [3, 6], USMarkets: [7, 8] }[section];
    (await sheetCSV(GID.news)).slice(1).forEach(r => {
      const text = String(r[col[0]] || '').trim(); if (!text) return;
      const k = text.lastIndexOf(' - '), title = k > 20 ? text.slice(0, k) : text, source = k > 20 ? text.slice(k + 3) : '';
      items.push({ title, source, link: String(r[col[1]] || ''), t: 1 });          // t = 1: older than any dated item, never too old
    });
  } catch (e) {}
  const filt = section === 'Markets' ? items.filter(x => MARKET_WORDS.test(x.title)) : section === 'USMarkets' ? items.filter(x => US_WORDS.test(x.title)) : items;
  const top = pickTop(filt);
  if (!top.length) throw new Error('no headlines from any ' + section + ' feed (kept the last list)');
  await dbPut(env, 'news_' + section, top);
  return top.length + ' headlines (' + perFeed + ') · newest: ' + top[0].text.slice(0, 70);
}

/* ---------------- gold & silver: IBJA (India Bullion and Jewellers Association) ----------------
   The official national rates (before GST and making charges), published on working days around noon and 5 pm.
   Their home page carries about four months of daily rates in two hidden fields: gold 999 per 10 g, silver 999 per kg. */
const unesc = t => String(t).replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
async function jobMetals(env) {
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
  return `gold 999 ₹${g.p}/g (${g.date}), ${gold.length} days of history · ${sNote}`;
}

/* ---------------- the timer ---------------- */
async function runJob(env, job) {
  try { const note = job.startsWith('news:') ? await jobNews(env, job.slice(5)) : job === 'env' ? await jobEnv(env) : job === 'metals' ? await jobMetals(env) : await jobPrices(env); await logRun(env, job, true, note); return note; }
  catch (e) { await logRun(env, job, false, e.message || e); return 'failed: ' + (e.message || e); }
}
async function tick(env, t = Date.now()) {
  const p = istParts(t), m = p.mi, jobs = [];
  if (marketWindow(t) || m % 20 === 0) jobs.push('prices');
  if (m % 10 === 0) jobs.push('env');
  if (m % 10 === 5 && (p.h >= 6 && p.h <= 19 || m === 5)) jobs.push('metals');   // every 10 min from 6 am to 7 pm, else hourly
  const sec = { 2: 'India', 4: 'World', 6: 'Markets', 8: 'USMarkets' }[m % 10];   // one news section every 2 minutes
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
  if (d.cfg) return d.cfg.v;
  const fromSheet = Object.fromEntries(((d.env?.v || {}).settings || []).map(([k, v]) => [k, v]));   // first time: copy the sheet's Settings tab
  const cfg = { settings: fromSheet, watch: DEFAULT_WATCH, pin: null, fails: 0, lockUntil: 0, at: Date.now() };
  await dbPut(env, 'cfg', cfg);
  return cfg;
}
const SETTING_KEYS = /^(Seconds per slide|Show .+ slide|Currency [123]|Night clock (starts|ends)|Home (lat|lon|name))$/;
function cleanWatch(w) {
  const one = x => x && typeof x.sym === 'string' && /^[A-Z]+:[A-Z0-9&._\-]{1,20}$/.test(x.sym) ? {
    sym: x.sym, name: String(x.name || x.sym.split(':')[1]).slice(0, 40), tick: String(x.tick || x.sym.split(':')[1]).slice(0, 20),
    ...(x.dom && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(x.dom) ? { dom: x.dom } : {}) } : null;
  const list = l => (Array.isArray(l) ? l : []).map(one).filter(Boolean).filter((x, i, a) => a.findIndex(y => y.sym === x.sym) === i).slice(0, 40);
  return { in: list(w.in), large: list(w.large), us: list(w.us) };
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
async function feed(env) {
  const cfg = await getCfg(env);
  const keys = ['sheet1', 'idx', 'env', 'log', 'metal_hist', 'ibja', 'gr_silver', 'news_India', 'news_World', 'news_Markets', 'news_USMarkets'];
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
  const GS = d.gr_silver?.v;                               // silver: GoodReturns Bangalore (jewellers' rate), as many days as kept
  if (GS && Object.keys(GS).length >= 2) {
    const list = Object.keys(GS).sort().map(k => ({ date: k, p: GS[k] }));
    metals.silver = list.map((x, i) => ({ date: x.date, p: x.p, c: i ? x.p - list[i - 1].p : null })).reverse();
    metals.silverSource = 'GoodReturns Bangalore';
  }
  const charts = {};
  (d.idx?.v || []).slice(1).forEach(r => {
    charts[r[0]] = { p: num(r[1]), prev: num(r[2]), at: num(r[3]) ? num(r[3]) * 1000 : null,
      line: String(r[4] || '').split(';').map(x => x.split(':').map(Number)).filter(x => x.length === 2 && isFinite(x[0]) && isFinite(x[1])).map(([t, v]) => [t * 1000, v]) };
  });
  const news = {};
  ['India', 'World', 'Markets', 'USMarkets'].forEach(s => { const x = d['news_' + s]; news[s] = { at: x?.at || null, items: (x?.v || []).map(i => ({ t: i.text, u: i.link })) }; });
  const a = E.aqi;
  const ages = Object.fromEntries(Object.entries(d).filter(([k]) => !['log', 'metal_hist', 'ibja', 'gr_silver'].includes(k)).map(([k, x]) => [k, Math.round((Date.now() - x.at) / 1000)]));
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
      if (u.pathname === '/v2/lookup') return new Response(JSON.stringify(await lookup(u.searchParams.get('q'), u.searchParams.get('mkt'))), { headers: CORS });
      if (u.pathname === '/v2/feed') return new Response(JSON.stringify(await feed(env)), { headers: CORS });
      if (u.pathname === '/v1/all') return new Response(JSON.stringify(await allTabs(env)), { headers: CORS });
      if (u.pathname === '/v1/status') {
        const d = await dbGet(env, ['log', 'sheet1', 'idx', 'env', 'news_India', 'news_World', 'news_Markets', 'news_USMarkets']);
        const ages = Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'log').map(([k, x]) => [k, Math.round((Date.now() - x.at) / 60e3) + ' min ago']));
        return new Response(JSON.stringify({ now: istStamp(), ages, runs: d.log?.v || {} }, null, 1), { headers: CORS });
      }
      if (u.pathname === '/v1/run') {                 // run one job now (used once after each deploy); at most once a minute per job
        const job = u.searchParams.get('job') || 'prices';
        if (!/^(prices|env|metals|news:(India|World|Markets|USMarkets))$/.test(job)) return new Response('unknown job', { status: 400 });
        const last = (await dbGet(env, ['log'])).log?.v?.[job];
        if (last && last.at === istStamp().slice(0, 16) + last.at.slice(16)) return new Response(JSON.stringify({ job, note: 'ran this minute already', last }), { headers: CORS });
        return new Response(JSON.stringify({ job, note: await runJob(env, job) }), { headers: CORS });
      }
      return new Response('Desk Ticker server. Try /v1/status', { headers: { 'Content-Type': 'text/plain' } });
    } catch (e) { return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 500, headers: CORS }); }
  },
};
