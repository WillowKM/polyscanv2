const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const CACHE = {};
const PREV_TEMPS = {};
const CACHE_TTL = 10 * 60 * 1000;

const US_STATIONS = new Set(['KATL','KLGA','KSEA','KSFO','KMIA','KBKF','KHOU','KORD','CYYZ']);

const STATION_META = {
  NZWN: { cc:'nz', city:'wellington'    },
  RJTT: { cc:'jp', city:'tokyo'         },
  RKSI: { cc:'kr', city:'incheon'       },
  WSSS: { cc:'sg', city:'singapore'     },
  WMKK: { cc:'my', city:'kuala-lumpur'  },
  ZUUU: { cc:'cn', city:'chengdu'       },
  ZBAA: { cc:'cn', city:'beijing'       },
  ZSPD: { cc:'cn', city:'shanghai'      },
  VILK: { cc:'in', city:'lucknow'       },
  OPKC: { cc:'pk', city:'karachi'       },
  OEJN: { cc:'sa', city:'jeddah'        },
  LLBG: { cc:'il', city:'tel-aviv'      },
  LTFM: { cc:'tr', city:'istanbul'      },
  EPWA: { cc:'pl', city:'warsaw'        },
  LFPB: { cc:'fr', city:'paris'         },
  EGLC: { cc:'gb', city:'london'        },
  LEMD: { cc:'es', city:'madrid'        },
  FACT: { cc:'za', city:'cape-town'     },
  KATL: { cc:'us', city:'atlanta'       },
  KLGA: { cc:'us', city:'new-york'      },
  KSEA: { cc:'us', city:'seattle'       },
  KSFO: { cc:'us', city:'san-francisco' },
  KMIA: { cc:'us', city:'miami'         },
  KBKF: { cc:'us', city:'denver'        },
  KHOU: { cc:'us', city:'houston'       },
  KORD: { cc:'us', city:'chicago'       },
  CYYZ: { cc:'ca', city:'toronto'       },
};

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
    // WU embeds sunrise/sunset as sunriseTimeLocal and sunsetTimeLocal
    const riseM = html.match(/"sunriseTimeLocal"\s*:\s*"([^"]+)"/) ||
                  html.match(/"sunrise"\s*:\s*"([^"]+)"/);
    const setM  = html.match(/"sunsetTimeLocal"\s*:\s*"([^"]+)"/) ||
                  html.match(/"sunset"\s*:\s*"([^"]+)"/);

    if (!riseM && !setM) return { sunrise: null, sunset: null };

    function fmtTime(str) {
      if (!str) return null;
      // Format: "2026-06-17T06:24:00+0200" or "06:24:00"
      const d = new Date(str);
      if (!isNaN(d.getTime())) {
        return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
      }
      // Fallback: extract HH:MM
      const t = str.match(/(\d{1,2}):(\d{2})/);
      if (t) {
        const h = parseInt(t[1]);
        const m = t[2];
        const ampm = h >= 12 ? 'PM' : 'AM';
        const h12 = h % 12 || 12;
        return `${h12}:${m} ${ampm}`;
      }
      return null;
    }

    return {
      sunrise: riseM ? fmtTime(riseM[1]) : null,
      sunset:  setM  ? fmtTime(setM[1])  : null,
    };
  } catch(e) {
    return { sunrise: null, sunset: null };
  }
}

// Parse hourly high from Wunderground hourly page
// Debug confirmed: WU embeds hourly JSON as "temp":XX inside imperial objects
// We collect all hourly temp readings and take the daily max
function parseHourlyHigh(html, isUS) {
  try {
    const temps = [];

    // Pattern confirmed from debug: "imperial":{"temp":XX,"heatIndex"...
    // Collect all imperial temp values from hourly entries
    const impTempPattern = /"imperial"\s*:\s*\{[^}]*"temp"\s*:\s*([-\d.]+)/g;
    let m;
    while ((m = impTempPattern.exec(html)) !== null) {
      const n = parseFloat(m[1]);
      // Filter nulls and unrealistic values
      if (!isNaN(n) && n > -40 && n < 130) temps.push(n);
    }

    // Also try metric temp pattern
    const metTempPattern = /"metric"\s*:\s*\{[^}]*"temp"\s*:\s*([-\d.]+)/g;
    const metTemps = [];
    while ((m = metTempPattern.exec(html)) !== null) {
      const n = parseFloat(m[1]);
      if (!isNaN(n) && n > -40 && n < 55) metTemps.push(n);
    }

    // Also try compact pattern: "temp":XX anywhere in hourly data
    const compactPattern = /"temp"\s*:\s*(\d{1,3}(?:\.\d)?)/g;
    const compactTemps = [];
    while ((m = compactPattern.exec(html)) !== null) {
      const n = parseFloat(m[1]);
      if (!isNaN(n) && n > 0 && n < 130) compactTemps.push(n);
    }

    // Pick best source
    if (isUS) {
      // US stations: prefer imperial temps
      const src = temps.length > 3 ? temps : compactTemps;
      if (src.length === 0) return null;
      // Take max but ignore overnight lows by filtering bottom 20%
      const sorted = src.slice().sort((a,b)=>a-b);
      return Math.max(...sorted.slice(Math.floor(sorted.length * 0.2)));
    } else {
      // Non-US: prefer metric if available, otherwise convert imperial
      if (metTemps.length > 3) {
        const sorted = metTemps.slice().sort((a,b)=>a-b);
        return Math.max(...sorted.slice(Math.floor(sorted.length * 0.2)));
      }
      if (temps.length > 3) {
        const sorted = temps.slice().sort((a,b)=>a-b);
        const maxF = Math.max(...sorted.slice(Math.floor(sorted.length * 0.2)));
        return toC(maxF);
      }
      if (compactTemps.length > 3) {
        // Could be F or C — if values > 50 assume F
        const sorted = compactTemps.slice().sort((a,b)=>a-b);
        const maxVal = Math.max(...sorted.slice(Math.floor(sorted.length * 0.2)));
        return maxVal > 50 ? toC(maxVal) : maxVal;
      }
      return null;
    }
  } catch(e) {
    return null;
  }
}

function todayString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

async function fetchStation(station) {
  const meta = STATION_META[station];
  const isUS = US_STATIONS.has(station);
  const today = todayString();

  const currentUrl = `https://www.wunderground.com/weather/${station}`;
  const hourlyUrl  = `https://www.wunderground.com/hourly/${meta.cc}/${meta.city}/${station}/date/${today}`;

  const [currentRes, hourlyRes] = await Promise.allSettled([
    fetch(currentUrl, { headers: WU_HEADERS, timeout: 12000 }),
    fetch(hourlyUrl,  { headers: WU_HEADERS, timeout: 12000 }),
  ]);

  let temp = null, cond = '', humidity = null, high = null, sunrise = null, sunset = null;

  if (currentRes.status === 'fulfilled' && currentRes.value.ok) {
    const html = await currentRes.value.text();
    temp     = parseCurrentTemp(html);
    cond     = parseCond(html);
    humidity = parseHumidity(html);
    const sun = parseSunTimes(html);
    sunrise  = sun.sunrise;
    sunset   = sun.sunset;
  }

  if (hourlyRes.status === 'fulfilled' && hourlyRes.value.ok) {
    const html = await hourlyRes.value.text();
    high = parseHourlyHigh(html, isUS);
  }

  const prevTemp = PREV_TEMPS[station] || null;
  let trend = 'up';
  if (prevTemp !== null && temp !== null) {
    trend = temp >= prevTemp ? 'up' : 'down';
  }
  if (temp !== null) PREV_TEMPS[station] = temp;

  // Use stale cache high if fresh fetch returned null
  const cachedHigh = CACHE[station] ? CACHE[station].data.high : null;
  const finalHigh = high !== null ? high : cachedHigh;

  return {
    temp:     isUS ? temp : toC(temp),
    high:     isUS ? finalHigh : (finalHigh !== null ? (finalHigh > 60 ? toC(finalHigh) : finalHigh) : null),
    cond,
    humidity,
    trend,
    sunrise,
    sunset,
    unit: isUS ? 'F' : 'C',
  };
}

app.get('/weather/:station', async (req, res) => {
  const { station } = req.params;
  const cacheKey = station.toUpperCase();

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

app.get('/debug/:station', async (req, res) => {
  const station = req.params.station.toUpperCase();
  const meta = STATION_META[station];
  if (!meta) return res.status(400).json({ error: 'unknown station' });
  const today = todayString();
  const currentUrl = `https://www.wunderground.com/weather/${station}`;
  const hourlyUrl  = `https://www.wunderground.com/hourly/${meta.cc}/${meta.city}/${station}/date/${today}`;
  try {
    const [cr, hr] = await Promise.allSettled([
      fetch(currentUrl, { headers: WU_HEADERS, timeout: 12000 }),
      fetch(hourlyUrl,  { headers: WU_HEADERS, timeout: 12000 }),
    ]);
    const currentHtml = (cr.status==='fulfilled' && cr.value.ok) ? await cr.value.text() : '';
    const hourlyHtml  = (hr.status==='fulfilled' && hr.value.ok) ? await hr.value.text() : '';

    // Pull key snippets so we can see exactly what patterns exist
    const snippets = {};
    const terms = ['phrase','tempHigh','temperature','wxPhrase','conditionPhrase','humidity','imperial','metric'];
    terms.forEach(t => {
      const idx = currentHtml.indexOf(t);
      if (idx !== -1) snippets['current_'+t] = currentHtml.slice(Math.max(0,idx-20), idx+120);
    });
    terms.forEach(t => {
      const idx = hourlyHtml.indexOf(t);
      if (idx !== -1) snippets['hourly_'+t] = hourlyHtml.slice(Math.max(0,idx-20), idx+120);
    });

    res.json({
      currentHtmlLen: currentHtml.length,
      hourlyHtmlLen:  hourlyHtml.length,
      parsed: {
        temp: parseCurrentTemp(currentHtml),
        cond: parseCond(currentHtml),
        humidity: parseHumidity(currentHtml),
        high: parseHourlyHigh(hourlyHtml, US_STATIONS.has(station)),
      },
      snippets
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), cached: Object.keys(CACHE).length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PolyScan 24/7 running on port ${PORT}`));
