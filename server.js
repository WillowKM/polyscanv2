const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CACHE = {};
const POLY_CACHE = {};
const PREV_TEMPS = {};
const CACHE_TTL     = 10 * 60 * 1000;
const POLY_CACHE_TTL = 3 * 60 * 1000; // refresh Polymarket odds every 3 min

const MARKETS_FILE = path.join(__dirname, 'markets.json');
const RECORD_FILE   = path.join(__dirname, 'record.json'); // permanent W/L tally — never auto-cleaned, survives deploys/updates

const US_STATIONS = new Set(['KATL','KLGA','KSEA','KSFO','KMIA','KBKF','KHOU','KORD','CYYZ']);

// lat/lon added for Open-Meteo daily-high lookups — coordinates match
// each station's physical airport location so the high lines up with
// the same place the current-temp reading comes from
const STATION_META = {
  NZWN: { cc:'nz', city:'wellington',     lat:-41.3272, lon:174.8053  },
  RJTT: { cc:'jp', city:'tokyo',          lat:35.5494,  lon:139.7798  },
  RKSI: { cc:'kr', city:'incheon',        lat:37.4602,  lon:126.4407  },
  WSSS: { cc:'sg', city:'singapore',      lat:1.3644,   lon:103.9915  },
  WMKK: { cc:'my', city:'kuala-lumpur',   lat:2.7456,   lon:101.7099  },
  ZUUU: { cc:'cn', city:'chengdu',        lat:30.5785,  lon:103.9471  },
  ZBAA: { cc:'cn', city:'beijing',        lat:40.0801,  lon:116.5846  },
  ZSPD: { cc:'cn', city:'shanghai',       lat:31.1434,  lon:121.8052  },
  VILK: { cc:'in', city:'lucknow',        lat:26.7606,  lon:80.8893   },
  OPKC: { cc:'pk', city:'karachi',        lat:24.9008,  lon:67.1681   },
  OEJN: { cc:'sa', city:'jeddah',         lat:21.6796,  lon:39.1565   },
  LLBG: { cc:'il', city:'tel-aviv',       lat:32.0114,  lon:34.8867   },
  LTFM: { cc:'tr', city:'istanbul',       lat:41.2753,  lon:28.7519   },
  EPWA: { cc:'pl', city:'warsaw',         lat:52.1657,  lon:20.9671   },
  LFPB: { cc:'fr', city:'paris',          lat:48.9694,  lon:2.4414    },
  EGLC: { cc:'gb', city:'london',         lat:51.5053,  lon:0.0553    },
  LEMD: { cc:'es', city:'madrid',         lat:40.4983,  lon:-3.5676   },
  FACT: { cc:'za', city:'cape-town',      lat:-33.9648, lon:18.6017   },
  KATL: { cc:'us', city:'atlanta',        lat:33.6407,  lon:-84.4277  },
  KLGA: { cc:'us', city:'new-york',       lat:40.7769,  lon:-73.8740  },
  KSEA: { cc:'us', city:'seattle',        lat:47.4502,  lon:-122.3088 },
  KSFO: { cc:'us', city:'san-francisco',  lat:37.6213,  lon:-122.3790 },
  KMIA: { cc:'us', city:'miami',          lat:25.7959,  lon:-80.2870  },
  KBKF: { cc:'us', city:'denver',         lat:39.7149,  lon:-104.7563 },
  KHOU: { cc:'us', city:'houston',        lat:29.6454,  lon:-95.2789  },
  KORD: { cc:'us', city:'chicago',        lat:41.9742,  lon:-87.9073  },
  CYYZ: { cc:'ca', city:'toronto',        lat:43.6777,  lon:-79.6248  },
};

// ── City name → URL slug mapping ───────────────────────────────────────────
// Matches exactly how Polymarket constructs their event slugs
const CITY_SLUGS = {
  'Wellington':    'wellington',
  'Tokyo':         'tokyo',
  'Seoul':         'seoul',
  'Shanghai':      'shanghai',
  'Singapore':     'singapore',
  'Kuala Lumpur':  'kuala-lumpur',
  'Chengdu':       'chengdu',
  'Beijing':       'beijing',
  'Lucknow':       'lucknow',
  'Karachi':       'karachi',
  'Jeddah':        'jeddah',
  'Tel Aviv':      'tel-aviv',
  'Istanbul':      'istanbul',
  'Warsaw':        'warsaw',
  'Paris':         'paris',
  'London':        'london',
  'Madrid':        'madrid',
  'Cape Town':     'cape-town',
  'Atlanta':       'atlanta',
  'New York':      'new-york',
  'Miami':         'miami',
  'Toronto':       'toronto',
  'Chicago':       'chicago',
  'Houston':       'houston',
  'Denver':        'denver',
  'Seattle':       'seattle',
  'San Francisco': 'san-francisco',
};

// ── Date helpers ────────────────────────────────────────────────────────────
function todayString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// Format: "june-19-2026"
function polyDateSlug() {
  const d = new Date();
  const months = ['january','february','march','april','may','june',
                  'july','august','september','october','november','december'];
  return `${months[d.getMonth()]}-${d.getDate()}-${d.getFullYear()}`;
}

// Build the Polymarket event slug for a city on today's date
// e.g. "highest-temperature-in-chicago-on-june-19-2026"
function buildEventSlug(cityName) {
  const citySlug = CITY_SLUGS[cityName];
  if (!citySlug) return null;
  return `highest-temperature-in-${citySlug}-on-${polyDateSlug()}`;
}

// Build the specific market slug when a bet temperature is known
// e.g. "highest-temperature-in-london-on-june-18-2026-28c"
function buildMarketSlug(cityName, tempC) {
  const eventSlug = buildEventSlug(cityName);
  if (!eventSlug) return null;
  return `${eventSlug}-${tempC}c`;
}

// ── markets.json helpers ────────────────────────────────────────────────────
function loadMarkets() {
  try {
    const raw = fs.readFileSync(MARKETS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch(e) {
    return { bets: [] };
  }
}

function saveMarkets(data) {
  fs.writeFileSync(MARKETS_FILE, JSON.stringify(data, null, 2));
}

// Remove bets from previous days automatically
function cleanOldBets() {
  const today = todayString();
  const data = loadMarkets();
  const before = data.bets.length;
  data.bets = data.bets.filter(b => b.date === today);
  if (data.bets.length !== before) saveMarkets(data);
  return data;
}

// ── record.json — permanent win/loss tally ─────────────────────────────────
// This file is NEVER auto-cleaned and is untouched by daily bet rollover or
// code updates. A bet is settled (and removed from the active list) the
// moment its live probability touches 0% or 100% — whichever comes first —
// since you're betting NO on the bracket:
//   probability → 0%   = market certain it WON'T happen = WIN
//   probability → 100% = market certain it WILL happen   = LOSS
function loadRecord() {
  try {
    const raw = fs.readFileSync(RECORD_FILE, 'utf8');
    return JSON.parse(raw);
  } catch(e) {
    return { settled: [], wins: 0, losses: 0 };
  }
}

function saveRecord(data) {
  fs.writeFileSync(RECORD_FILE, JSON.stringify(data, null, 2));
}

// Checks a live probability against a bet and settles it permanently if
// it has resolved. Returns the settlement entry if one occurred, else null.
function maybeSettleBet(bet, prob) {
  if (prob === null || prob === undefined) return null;
  if (prob > 0 && prob < 100) return null; // still live, nothing to do

  const outcome = prob <= 0 ? 'WIN' : 'LOSS';
  const record = loadRecord();

  // Guard against double-settling using bracketSlug (works for both US and non-US)
  const key = `${bet.city}|${bet.date}|${bet.bracketSlug || bet.tempC}`;
  const alreadySettled = record.settled.some(s => s.key === key);
  if (alreadySettled) return null;

  const entry = {
    key,
    city:        bet.city,
    bracketSlug: bet.bracketSlug || `${bet.tempC}c`,
    tempC:       bet.tempC,
    date:        bet.date,
    outcome,
    finalProb:   prob,
    marketUrl:   bet.marketUrl,
    settledAt:   new Date().toISOString(),
  };

  record.settled.unshift(entry); // newest first
  record.wins   = (record.wins   || 0) + (outcome === 'WIN'  ? 1 : 0);
  record.losses = (record.losses || 0) + (outcome === 'LOSS' ? 1 : 0);
  saveRecord(record);

  // Remove the now-settled bet from the active markets list
  const markets = loadMarkets();
  markets.bets = markets.bets.filter(
    b => !(b.city === bet.city && b.date === bet.date &&
           (b.bracketSlug || `${b.tempC}c`) === (bet.bracketSlug || `${bet.tempC}c`))
  );
  saveMarkets(markets);

  return entry;
}

// ── Polymarket Gamma API ────────────────────────────────────────────────────
// Fetches all outcome probabilities for a city's today event
async function fetchPolymarketEvent(cityName) {
  const cacheKey = cityName;
  if (POLY_CACHE[cacheKey] && (Date.now() - POLY_CACHE[cacheKey].ts) < POLY_CACHE_TTL) {
    return POLY_CACHE[cacheKey].data;
  }

  const eventSlug = buildEventSlug(cityName);
  if (!eventSlug) return null;

  try {
    const url = `https://gamma-api.polymarket.com/events?slug=${eventSlug}`;
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      timeout: 8000
    });
    if (!res.ok) return null;
    const json = await res.json();

    if (!json || !json.length) return null;
    const event = json[0];

    // Parse markets — each market is one temperature bracket
    const markets = event.markets || [];
    const outcomes = markets.map(m => {
      // outcomePrices is a JSON string like '["0.45","0.55"]'
      let yesProb = null;
      try {
        const prices = typeof m.outcomePrices === 'string'
          ? JSON.parse(m.outcomePrices)
          : m.outcomePrices;
        yesProb = prices && prices[0] ? Math.round(parseFloat(prices[0]) * 100) : null;
      } catch(e) {}

      return {
        bracket: m.groupItemTitle || m.question || '',
        slug:    m.slug || '',
        prob:    yesProb,
        volume:  m.volume ? parseFloat(m.volume).toFixed(0) : '0',
      };
    }).filter(o => o.prob !== null);

    const data = {
      eventSlug,
      title:    event.title || '',
      outcomes,
      volume:   event.volume ? parseFloat(event.volume).toFixed(0) : '0',
    };

    POLY_CACHE[cacheKey] = { data, ts: Date.now() };
    return data;
  } catch(e) {
    return null;
  }
}

// Find the probability for a specific temperature bracket.
// bet.bracketSlug is either "28c" (non-US) or "88-89f" (US).
// We match against the Polymarket market slug which ends the same way.
function findBracketProb(polyData, bet) {
  if (!polyData || !polyData.outcomes) return null;
  const targetSlug = (bet.bracketSlug || '').toLowerCase();
  const tempStr    = bet.tempC !== null && bet.tempC !== undefined ? String(bet.tempC) : null;

  for (const o of polyData.outcomes) {
    const slug    = (o.slug    || '').toLowerCase();
    const bracket = (o.bracket || '').toLowerCase();
    // Match by slug suffix — most reliable
    if (slug.endsWith(`-${targetSlug}`)) return o.prob;
    // Fallback: slug contains the whole bracket (e.g. "88-89f" in slug)
    if (targetSlug && slug.includes(targetSlug)) return o.prob;
    // Fallback for non-US: bracket text contains the °C number
    if (tempStr && bracket.includes(tempStr)) return o.prob;
  }
  return null;
}

// ── Weather scraping (unchanged from original) ──────────────────────────────
function toC(f) {
  if (f === null || isNaN(f)) return null;
  return parseFloat(((f - 32) * 5 / 9).toFixed(1));
}

const WU_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Accept-Encoding': 'identity',
  'Connection': 'keep-alive',
};

function parseCurrentTemp(html) {
  const patterns = [
    /class="wu-value wu-value-to"[^>]*>\s*([-\d.]+)\s*</,
    /"temperature"\s*:\s*\{\s*"imperial"\s*:\s*\{\s*"value"\s*:\s*([-\d.]+)/,
    /"temperature"\s*:\s*\{\s*"metric"\s*:\s*\{\s*"value"\s*:\s*([-\d.]+)/,
    /data-testid="TemperatureValue"[^>]*>([-\d.]+)</,
    /"temp"\s*:\s*([-\d.]+)/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return parseFloat(m[1]);
  }
  return null;
}

function parseCond(html) {
  const patterns = [
    /"wxPhraseLong"\s*:\s*"([^"]+)"/,
    /"wxPhraseMedium"\s*:\s*"([^"]+)"/,
    /"wxPhraseShort"\s*:\s*"([^"]+)"/,
    /data-testid="wxPhrase"[^>]*>([^<]+)</,
    /"phrase"\s*:\s*"([^"]+)"/,
    /"conditionPhrase"\s*:\s*"([^"]+)"/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m && m[1].trim() && m[1].trim() !== 'null') return m[1].trim();
  }
  return '';
}

function parseHumidity(html) {
  const m = html.match(/data-testid="HumiditySection"[^>]*>.*?(\d+)%/s) ||
            html.match(/"humidity"\s*:\s*(\d+)/);
  return m ? parseInt(m[1]) : null;
}

function parseSunTimes(html) {
  try {
    const risePatterns = [
      /"sunriseTimeLocal"\s*:\s*"([^"]+)"/,
      /"sunrise"\s*:\s*"([^"]+)"/,
      /data-testid="SunriseValue"[^>]*>([^<]+)</,
    ];
    const setPatterns = [
      /"sunsetTimeLocal"\s*:\s*"([^"]+)"/,
      /"sunset"\s*:\s*"([^"]+)"/,
      /data-testid="SunsetValue"[^>]*>([^<]+)</,
    ];
    let riseRaw = null, setRaw = null;
    for (const p of risePatterns) { const m = html.match(p); if (m) { riseRaw = m[1]; break; } }
    for (const p of setPatterns)  { const m = html.match(p); if (m) { setRaw  = m[1]; break; } }
    if (!riseRaw && !setRaw) return { sunrise: null, sunset: null };
    function fmtTime(str) {
      if (!str) return null;
      if (/^\d{1,2}:\d{2}\s*[AP]M$/i.test(str.trim())) return str.trim();
      const d = new Date(str);
      if (!isNaN(d.getTime())) return d.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit', hour12:true });
      const t = str.match(/(\d{1,2}):(\d{2})/);
      if (t) { const h=parseInt(t[1]); const m=t[2]; return `${h%12||12}:${m} ${h>=12?'PM':'AM'}`; }
      return null;
    }
    return { sunrise: fmtTime(riseRaw), sunset: fmtTime(setRaw) };
  } catch(e) { return { sunrise: null, sunset: null }; }
}

function parseForecastHighLow(html, isUS) {
  try {
    const maxImpM = html.match(/"temperatureMax"\s*:\s*\{"imperial"\s*:\s*\{"value"\s*:\s*([-\d.]+)/);
    const maxMetM = html.match(/"temperatureMax"\s*:\s*\{[^}]*"metric"\s*:\s*\{"value"\s*:\s*([-\d.]+)/);
    if (maxImpM || maxMetM) {
      if (isUS && maxImpM)  return parseFloat(maxImpM[1]);
      if (!isUS && maxMetM) return parseFloat(maxMetM[1]);
      if (!isUS && maxImpM) return toC(parseFloat(maxImpM[1]));
    }
    const highM = html.match(/"tempHigh"\s*:\s*([-\d.]+)/);
    if (highM) { const v = parseFloat(highM[1]); return isUS ? v : (v > 50 ? toC(v) : v); }
    const highFM = html.match(/"high"\s*:\s*\{"fahrenheit"\s*:\s*"?([-\d.]+)"?[^}]*"celsius"\s*:\s*"?([-\d.]+)"?/);
    if (highFM) return isUS ? parseFloat(highFM[1]) : parseFloat(highFM[2]);
    return null;
  } catch(e) { return null; }
}

function parseHourlyHigh(html, isUS) {
  try {
    const temps = [];
    const impTempPattern = /"imperial"\s*:\s*\{[^}]*"temp"\s*:\s*([-\d.]+)/g;
    let m;
    while ((m = impTempPattern.exec(html)) !== null) {
      const n = parseFloat(m[1]);
      if (!isNaN(n) && n > -40 && n < 130) temps.push(n);
    }
    const metTempPattern = /"metric"\s*:\s*\{[^}]*"temp"\s*:\s*([-\d.]+)/g;
    const metTemps = [];
    while ((m = metTempPattern.exec(html)) !== null) {
      const n = parseFloat(m[1]);
      if (!isNaN(n) && n > -40 && n < 55) metTemps.push(n);
    }
    const compactPattern = /"temp"\s*:\s*(\d{1,3}(?:\.\d)?)/g;
    const compactTemps = [];
    while ((m = compactPattern.exec(html)) !== null) {
      const n = parseFloat(m[1]);
      if (!isNaN(n) && n > 0 && n < 130) compactTemps.push(n);
    }
    if (isUS) {
      const src = temps.length > 3 ? temps : compactTemps;
      if (src.length === 0) return null;
      const sorted = src.slice().sort((a,b)=>a-b);
      return Math.max(...sorted.slice(Math.floor(sorted.length * 0.2)));
    } else {
      if (metTemps.length > 3) {
        const sorted = metTemps.slice().sort((a,b)=>a-b);
        return Math.max(...sorted.slice(Math.floor(sorted.length * 0.2)));
      }
      if (temps.length > 3) {
        const sorted = temps.slice().sort((a,b)=>a-b);
        return toC(Math.max(...sorted.slice(Math.floor(sorted.length * 0.2))));
      }
      if (compactTemps.length > 3) {
        const sorted = compactTemps.slice().sort((a,b)=>a-b);
        const maxVal = Math.max(...sorted.slice(Math.floor(sorted.length * 0.2)));
        return maxVal > 50 ? toC(maxVal) : maxVal;
      }
      return null;
    }
  } catch(e) { return null; }
}

// ── Open-Meteo daily high (free, no API key, no JS-rendering issue) ────────
// Wunderground's forecast page now renders client-side via JavaScript, so
// the old scraping approach below returns blank highs most of the time.
// Open-Meteo serves clean server-rendered JSON for free, so we use it as
// the primary source for today's forecast high. Returns °C always.
const OPEN_METEO_CACHE = {};
const OPEN_METEO_TTL = 10 * 60 * 1000;

async function fetchOpenMeteoHigh(station) {
  const meta = STATION_META[station];
  if (!meta || meta.lat === undefined || meta.lon === undefined) return null;

  if (OPEN_METEO_CACHE[station] && (Date.now() - OPEN_METEO_CACHE[station].ts) < OPEN_METEO_TTL) {
    return OPEN_METEO_CACHE[station].high;
  }

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${meta.lat}&longitude=${meta.lon}&daily=temperature_2m_max&timezone=auto&forecast_days=1`;
    const res = await fetch(url, { timeout: 8000 });
    if (!res.ok) return null;
    const json = await res.json();
    const highC = json && json.daily && json.daily.temperature_2m_max
      ? json.daily.temperature_2m_max[0]
      : null;
    if (highC === null || highC === undefined || isNaN(highC)) return null;

    OPEN_METEO_CACHE[station] = { high: highC, ts: Date.now() };
    return highC;
  } catch(e) {
    return null;
  }
}

async function fetchStation(station) {
  const meta = STATION_META[station];
  const isUS = US_STATIONS.has(station);
  const today = todayString();

  const currentUrl  = `https://www.wunderground.com/weather/${station}`;
  const hourlyUrl   = `https://www.wunderground.com/hourly/${meta.cc}/${meta.city}/${station}/date/${today}`;
  const forecastUrl = `https://www.wunderground.com/forecast/${meta.cc}/${meta.city}/${station}`;

  const [currentRes, hourlyRes, forecastRes] = await Promise.allSettled([
    fetch(currentUrl,  { headers: WU_HEADERS, timeout: 12000 }),
    fetch(hourlyUrl,   { headers: WU_HEADERS, timeout: 12000 }),
    fetch(forecastUrl, { headers: WU_HEADERS, timeout: 12000 }),
  ]);

  let temp = null, cond = '', humidity = null, high = null, sunrise = null, sunset = null;

  if (currentRes.status === 'fulfilled' && currentRes.value.ok) {
    const html = await currentRes.value.text();
    temp     = parseCurrentTemp(html);
    cond     = parseCond(html);
    humidity = parseHumidity(html);
    const sun = parseSunTimes(html);
    sunrise = sun.sunrise; sunset = sun.sunset;
  }

  // PRIMARY: Open-Meteo for today's high — free, reliable, server-rendered JSON.
  // This replaced the old Wunderground forecast-page scrape, which broke once
  // Wunderground moved to client-side JS rendering (the high is no longer in
  // the raw HTML we fetch). Open-Meteo always returns °C; we convert to °F
  // below for US stations to match the rest of that station's display unit.
  const meHighC = await fetchOpenMeteoHigh(station);
  if (meHighC !== null) {
    high = isUS ? (meHighC * 9/5 + 32) : meHighC;
  }

  // Sunrise/sunset still comes from Wunderground scraping — unaffected by
  // the JS-rendering issue since that data is server-rendered on their pages.
  if (forecastRes.status === 'fulfilled' && forecastRes.value.ok) {
    const html = await forecastRes.value.text();
    if (!sunrise || !sunset) {
      const sun = parseSunTimes(html);
      if (!sunrise) sunrise = sun.sunrise;
      if (!sunset)  sunset  = sun.sunset;
    }
    // FALLBACK: only if Open-Meteo failed, try the old scrape method
    if (high === null) {
      const fHigh = parseForecastHighLow(html, isUS);
      if (fHigh !== null) high = fHigh;
    }
  }

  if (high === null && hourlyRes.status === 'fulfilled' && hourlyRes.value.ok) {
    const html = await hourlyRes.value.text();
    const hHigh = parseHourlyHigh(html, isUS);
    if (hHigh !== null) high = hHigh;
    if (!sunrise || !sunset) {
      const sun = parseSunTimes(html);
      if (!sunrise) sunrise = sun.sunrise;
      if (!sunset)  sunset  = sun.sunset;
    }
  }

  const prevTemp = PREV_TEMPS[station] || null;
  let trend = 'up';
  if (prevTemp !== null && temp !== null) trend = temp >= prevTemp ? 'up' : 'down';
  if (temp !== null) PREV_TEMPS[station] = temp;

  const highSource = meHighC !== null ? 'open-meteo' : (high !== null ? 'wunderground-fallback' : 'cache');

  const cachedHigh = CACHE[station] ? CACHE[station].data.high : null;
  const finalHigh  = high !== null ? high : cachedHigh;

  let validatedHigh = finalHigh;
  if (temp !== null && finalHigh !== null) {
    const tempC = isUS ? toC(temp) : temp;
    const highC = isUS ? toC(finalHigh) : finalHigh;
    if (highC < tempC - 15) validatedHigh = null;
  }

  return {
    temp:    isUS ? temp : toC(temp),
    high:    validatedHigh,
    highSource,
    cond, humidity, trend, sunrise, sunset,
    unit:    isUS ? 'F' : 'C',
  };
}

// ── API ROUTES ──────────────────────────────────────────────────────────────

// Weather for a station
app.get('/weather/:station', async (req, res) => {
  const cacheKey = req.params.station.toUpperCase();
  if (CACHE[cacheKey] && (Date.now() - CACHE[cacheKey].ts) < CACHE_TTL) {
    return res.json({ ...CACHE[cacheKey].data, cached: true });
  }
  try {
    const data = await fetchStation(cacheKey);
    CACHE[cacheKey] = { data, ts: Date.now() };
    res.json({ ...data, station: cacheKey, cached: false });
  } catch(err) {
    if (CACHE[cacheKey]) return res.json({ ...CACHE[cacheKey].data, cached: true, stale: true });
    res.status(500).json({ error: err.message, station: cacheKey });
  }
});

// Get today's bets from markets.json
app.get('/markets', (req, res) => {
  const data = cleanOldBets();
  res.json(data);
});

// Add a bet for today
// Body: { city, tempC, bracketSlug, isUS }
// Non-US: bracketSlug = "28c",  tempC = 28
// US:     bracketSlug = "88-89f", tempC = null
app.post('/markets/bet', (req, res) => {
  const { city, tempC, bracketSlug, isUS } = req.body;
  if (!city || !bracketSlug) return res.status(400).json({ error: 'city and bracketSlug required' });

  const eventSlug  = buildEventSlug(city);
  if (!eventSlug) return res.status(400).json({ error: 'unknown city' });

  // Build the market slug using whatever bracket format was sent
  // Non-US: "highest-temperature-in-london-on-june-22-2026-28c"
  // US:     "highest-temperature-in-atlanta-on-june-22-2026-88-89f"
  const marketSlug = `${eventSlug}-${bracketSlug}`;

  const data = cleanOldBets();
  data.bets = data.bets.filter(b => b.city !== city);
  data.bets.push({
    city,
    tempC:       tempC !== null && tempC !== undefined ? parseInt(tempC) : null,
    bracketSlug, // e.g. "28c" or "88-89f"
    isUS:        !!isUS,
    date:        todayString(),
    eventSlug,
    marketSlug,
    eventUrl:  `https://polymarket.com/event/${eventSlug}`,
    marketUrl: `https://polymarket.com/event/${eventSlug}/${marketSlug}`,
    addedAt:   new Date().toISOString(),
  });
  saveMarkets(data);
  delete POLY_CACHE[city];
  res.json({ ok: true, bet: data.bets.find(b => b.city === city) });
});

// Remove a bet
app.delete('/markets/bet/:city', (req, res) => {
  const city = req.params.city;
  const data = loadMarkets();
  data.bets = data.bets.filter(b => b.city !== city);
  saveMarkets(data);
  res.json({ ok: true });
});

// Live Polymarket odds for a city (uses Gamma API)
app.get('/poly/:city', async (req, res) => {
  const city = decodeURIComponent(req.params.city);
  try {
    const data = await fetchPolymarketEvent(city);
    if (!data) return res.status(404).json({ error: 'no market found' });

    // If we have a stored bet for this city, also return the specific bracket prob
    const markets = loadMarkets();
    const bet = markets.bets.find(b => b.city === city);
    let betProb = null;
    let settled = null;
    if (bet) {
      betProb = findBracketProb(data, bet);
      settled = maybeSettleBet(bet, betProb);
    }

    res.json({ ...data, betProb, bet: bet || null, settled });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Batch poly odds for multiple cities (used by ticker)
app.post('/poly/batch', async (req, res) => {
  const { cities } = req.body; // array of city names
  if (!cities || !Array.isArray(cities)) return res.status(400).json({ error: 'cities array required' });

  const markets = loadMarkets();
  const results = await Promise.allSettled(
    cities.map(async city => {
      const polyData = await fetchPolymarketEvent(city);
      const bet      = markets.bets.find(b => b.city === city);
      let betProb    = null;
      let settled    = null;
      if (polyData && bet) {
        betProb = findBracketProb(polyData, bet);
        settled = maybeSettleBet(bet, betProb);
      }
      return { city, polyData, bet: bet || null, betProb, settled };
    })
  );

  const out = {};
  results.forEach(r => {
    if (r.status === 'fulfilled') out[r.value.city] = r.value;
  });
  res.json(out);
});

// Permanent win/loss record — never auto-cleaned, survives daily rollover and deploys
app.get('/record', (req, res) => {
  res.json(loadRecord());
});

app.get('/health', (req, res) => {
  res.json({ status:'ok', uptime: process.uptime(), cached: Object.keys(CACHE).length, polyCached: Object.keys(POLY_CACHE).length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PolyScan 24/7 by Willow running on port ${PORT}`));
