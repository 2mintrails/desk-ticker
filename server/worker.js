/** v1 
 * Desk Ticker server (Cloudflare Worker).
 *
 * Does the fetching the Google Sheet's script used to do, on a timer, and keeps the results in a small database:
 *   prices  every 2 min while the Indian or US market is open (every 20 min otherwise) — Yahoo Finance,
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
  if ((m = g.match(/^NSE:(.+)$/))) return m[1].replace(/&/g, '_') + '.NS';
  if ((m = g.match(/^BOM:(.+)$/))) return m[1] + '.BO';
  if ((m = g.match(/^CURRENCY:([A-Z]{6})$/))) return m[1] + '=X';
  if ((m = g.match(/^(NASDAQ|NYSE|NYSEARCA|NYSEAMERICAN|BATS):(.+)$/))) return m[2].replace(/\./g, '-');
  return null;
}
// Yahoo's "spark" endpoint gives up to 20 symbols per call; two answer shapes exist, both handled
function readSpark(j) {
  const out = {};
  const add = (sym, ts, cl, prev, meta) => {
    ts = ts || []; cl = cl || [];
    let i = cl.length - 1; while (i >= 0 && cl[i] == null) i--;
    const price = meta?.regularMarketPrice ?? (i >= 0 ? cl[i] : null);
    if (price == null) return;
    out[sym] = { price, prev: prev ?? null, at: meta?.regularMarketTime ?? (i >= 0 ? ts[i] : null),
      hi52: meta?.fiftyTwoWeekHigh ?? null, lo52: meta?.fiftyTwoWeekLow ?? null,
      line: ts.map((t, k) => cl[k] == null ? '' : t + ':' + (+cl[k]).toFixed(2)).filter(Boolean).join(';') };
  };
  if (j?.spark?.result) j.spark.result.forEach(r => { const x = r.response?.[0]; if (x) add(r.symbol, x.timestamp, x.indicators?.quote?.[0]?.close, x.meta?.chartPreviousClose ?? x.meta?.previousClose, x.meta); });
  else if (j && typeof j === 'object') Object.entries(j).forEach(([s, x]) => { if (x && Array.isArray(x.close)) add(s, x.timestamp, x.close, x.chartPreviousClose ?? x.previousClose, null); });
  return out;
}
async function yahooQuotes(syms) {
  const out = {}, errs = [];
  for (let i = 0; i < syms.length; i += 20) {
    const part = syms.slice(i, i + 20);
    try { Object.assign(out, readSpark(await get('https://query1.finance.yahoo.com/v8/finance/spark?symbols=' + part.map(encodeURIComponent).join(',') + '&range=1d&interval=5m', { json: true }))); }
    catch (e) { errs.push(String(e.message || e)); }
  }
  // the three indices the app relies on most: if the batch missed them, ask one by one
  for (const s of ['^NSEI', '^BSESN', '^GSPC']) {
    if (out[s] || !syms.includes(s)) continue;
    try {
      const r = (await get('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(s) + '?interval=5m&range=1d', { json: true })).chart.result[0];
      const one = readSpark({ spark: { result: [{ symbol: s, response: [r] }] } })[s]; if (one) out[s] = one;
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
  const all = await sheetCSV(GID.main);
  if (all.length < 2) throw new Error('Sheet1 came back empty');
  const syms = [...new Set(all.slice(1).map(r => yahooSym(r[0])).filter(Boolean))];
  const { out: Y, errs } = await yahooQuotes(syms);
  let used = 0, kept = 0;
  all.slice(1).forEach(r => {
    const y = Y[yahooSym(r[0])]; if (!y || y.prev == null) return;
    const g = num(r[1]);
    if (g != null && Math.abs(y.price - g) / g > 0.08) { kept++; return; }      // too far from Google's value: keep Google's
    while (r.length < 6) r.push('');
    const ch = y.price - y.prev;
    r[1] = y.price.toFixed(2); r[2] = ch.toFixed(2); r[3] = (ch / y.prev * 100).toFixed(2);
    if (!num(r[4]) && y.hi52) r[4] = String(y.hi52);
    if (!num(r[5]) && y.lo52) r[5] = String(y.lo52);
    used++;
  });
  const idx = [['Index', 'Price', 'Prev close', 'Quote time', 'Day line']];
  [['INDEXNSE:NIFTY_50', '^NSEI'], ['INDEXBOM:SENSEX', '^BSESN'], ['INDEXSP:.INX', '^GSPC']].forEach(([g, s]) => {
    const y = Y[s]; if (y && y.prev != null) idx.push([g, String(y.price), String(y.prev), String(y.at || ''), y.line]);
  });
  await dbPut(env, 'sheet1', all);
  if (idx.length > 1) await dbPut(env, 'idx', idx);
  return `${used} from Yahoo, ${kept} kept from Google (too far apart), ${syms.length} asked` + (errs.length ? ' · ' + errs.join(' | ') : '');
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
const FEEDS = {
  India: [['https://news.google.com/rss/headlines/section/topic/NATION?hl=en-IN&gl=IN&ceid=IN:en', ''], [GN('site:ptinews.com'), ''],
    ['https://indianexpress.com/section/india/feed/', 'Indian Express'], ['https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml', 'Hindustan Times'],
    [GN('site:theprint.in'), ''], [GN('site:indiatoday.in'), ''], [GN('site:ndtv.com'), '']],
  Markets: [['https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms', 'ET Markets'], ['https://www.livemint.com/rss/markets', 'Mint'],
    ['https://www.business-standard.com/rss/markets-106.rss', 'Business Standard'], [GN('site:moneycontrol.com markets'), ''],
    [GN('Sensex OR Nifty OR NSE OR BSE OR "Dalal Street" OR "stock market"'), '']],
  USMarkets: [['https://www.cnbc.com/id/20910258/device/rss/rss.html', 'CNBC'], ['https://feeds.content.dowjones.io/public/rss/mw_topstories', 'MarketWatch'],
    [GNUS('site:reuters.com markets'), ''], [GNUS('"Wall Street" OR "S&P 500" OR Nasdaq OR "Dow Jones" stocks'), '']],
  World: [[GN('site:reuters.com'), ''], [GN('site:apnews.com'), ''], [GN('site:bloomberg.com'), ''], ['https://www.theguardian.com/world/rss', 'The Guardian'],
    ['https://www.cnbc.com/id/100727362/device/rss/rss.html', 'CNBC'], [GN('site:dw.com/en'), ''],
    ['https://news.google.com/rss/headlines/section/topic/WORLD?hl=en-IN&gl=IN&ceid=IN:en', '']],
};
const BLOCK = ['The Hindu', 'BBC', 'Al Jazeera', 'NDTV Sports'];
const KEEP = 10, MAX_PER_SOURCE = 2, MAX_AGE_H = 12;
const MARKET_WORDS = /\b(sensex|nifty|nse|bse|stock|stocks|shares?|stock markets?|share market|equity|equities|ipo|rupee|rbi|sebi|fii|fiis|dii|q[1-4]|quarterly|profit|revenue|earnings|dividend|bonus|buyback|bond|bonds|yield|gold|silver|crude|inflation|gdp|mutual funds?|sip|smallcap|midcap|largecap|brokerage|target price|f&o|futures|nasdaq|dow|s&p|wall street|dalal street|investors?|valuation|market cap|promoters?)\b/i;
const US_WORDS = /\b(wall street|s&p|nasdaq|dow|nyse|stocks?|shares?|equities|earnings|fed|federal reserve|powell|treasury|treasuries|yields?|bond|bonds|ipo|rally|selloff|sell-off|futures|dollar|inflation|cpi|jobs report|payrolls|recession|tariffs?|nvidia|apple|microsoft|amazon|alphabet|google|meta|tesla|broadcom|berkshire|jpmorgan|investors?|market cap|valuation|guidance|outlook|chipmakers?|tech stocks)\b/i;
const decode = s => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;|&apos;|&#x27;|&#8217;/g, "'")
  .replace(/&quot;|&#8220;|&#8221;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#8211;|&#8212;/g, '-').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
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
  items.filter(x => !x.t || x.t > cutoff).sort((a, b) => b.t - a.t).forEach(x => {
    const key = x.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 50), ws = words(x.title);
    if (seen.has(key) || out.length >= KEEP || (per[x.source] || 0) >= MAX_PER_SOURCE || kept.some(k => sameStory(k, ws))) return;
    seen.add(key); kept.push(ws); per[x.source] = (per[x.source] || 0) + 1;
    out.push({ text: x.source ? x.title + ' - ' + x.source : x.title, link: /^https?:\/\//.test(x.link) ? x.link : '' });
  });
  return out;
}
async function jobNews(env, section) {
  const items = (await Promise.all(FEEDS[section].map(([u, s]) => readFeed(u, s)))).flat();
  const filt = section === 'Markets' ? items.filter(x => MARKET_WORDS.test(x.title)) : section === 'USMarkets' ? items.filter(x => US_WORDS.test(x.title)) : items;
  const top = pickTop(filt);
  if (!top.length) throw new Error('no headlines from any ' + section + ' feed (kept the last list)');
  await dbPut(env, 'news_' + section, top);
  return top.length + ' headlines · newest: ' + top[0].text.slice(0, 80);
}

/* ---------------- the timer ---------------- */
async function runJob(env, job) {
  try { const note = job.startsWith('news:') ? await jobNews(env, job.slice(5)) : job === 'env' ? await jobEnv(env) : await jobPrices(env); await logRun(env, job, true, note); return note; }
  catch (e) { await logRun(env, job, false, e.message || e); return 'failed: ' + (e.message || e); }
}
async function tick(env, t = Date.now()) {
  const p = istParts(t), m = p.mi, jobs = [];
  if (marketWindow(t) || m % 20 === 0) jobs.push('prices');
  if (m % 10 === 0) jobs.push('env');
  const sec = { 2: 'India', 4: 'World', 6: 'Markets', 8: 'USMarkets' }[m % 10];
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

const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' };
export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(tick(env, event.scheduledTime)); },
  async fetch(req, env) {
    const u = new URL(req.url);
    try {
      if (u.pathname === '/v1/all') return new Response(JSON.stringify(await allTabs(env)), { headers: CORS });
      if (u.pathname === '/v1/status') {
        const d = await dbGet(env, ['log', 'sheet1', 'idx', 'env', 'news_India', 'news_World', 'news_Markets', 'news_USMarkets']);
        const ages = Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'log').map(([k, x]) => [k, Math.round((Date.now() - x.at) / 60e3) + ' min ago']));
        return new Response(JSON.stringify({ now: istStamp(), ages, runs: d.log?.v || {} }, null, 1), { headers: CORS });
      }
      if (u.pathname === '/v1/run') {                 // run one job now (used once after each deploy); at most once a minute per job
        const job = u.searchParams.get('job') || 'prices';
        if (!/^(prices|env|news:(India|World|Markets|USMarkets))$/.test(job)) return new Response('unknown job', { status: 400 });
        const last = (await dbGet(env, ['log'])).log?.v?.[job];
        if (last && last.at === istStamp().slice(0, 16) + last.at.slice(16)) return new Response(JSON.stringify({ job, note: 'ran this minute already', last }), { headers: CORS });
        return new Response(JSON.stringify({ job, note: await runJob(env, job) }), { headers: CORS });
      }
      return new Response('Desk Ticker server. Try /v1/status', { headers: { 'Content-Type': 'text/plain' } });
    } catch (e) { return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 500, headers: CORS }); }
  },
};
