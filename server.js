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
    /data-testid="wxPhrase"[^>]*>([^<]+)</,
    /"phrase"\s*:\s*"([^"]+)"/,
    /"conditionPhrase"\s*:\s*"([^"]+)"/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return m[1].trim();
  }
  return '';
}

function parseHumidity(html) {
  const m = html.match(/data-testid="HumiditySection"[^>]*>.*?(\d+)%/s) ||
            html.match(/"humidity"\s*:\s*(\d+)/);
  return m ? parseInt(m[1]) : null;
}

// Improved hourly high parser
// Wunderground hourly page embeds JSON data in a <script> tag
// We look specifically for the daily forecast high, not random numbers
function parseHourlyHigh(html, isUS) {
  try {
    // Strategy 1: Find JSON array of hourly temps and take the max
    // WU embeds data like: "temperature":{"imperial":{"value":84}...
    // across multiple hourly entries — collect all and take max
    const imperialTemps = [];
    const metricTemps = [];

    const impPattern = /"temperature"\s*:\s*\{\s*"imperial"\s*:\s*\{\s*"value"\s*:\s*([-\d.]+)/g;
    const metPattern = /"temperature"\s*:\s*\{\s*"metric"\s*:\s*\{\s*"value"\s*:\s*([-\d.]+)/g;

    let m;
    while ((m = impPattern.exec(html)) !== null) {
      const n = parseFloat(m[1]);
      if (!isNaN(n) && n > -60 && n < 150) imperialTemps.push(n);
    }
    while ((m = metPattern.exec(html)) !== null) {
      const n = parseFloat(m[1]);
      if (!isNaN(n) && n > -60 && n < 60) metricTemps.push(n);
    }

    // Strategy 2: Look for explicit daily high in the forecast section
    const dailyHighImp = html.match(/"tempHigh"\s*:\s*\{\s*"imperial"\s*:\s*\{\s*"value"\s*:\s*([-\d.]+)/);
    const dailyHighMet = html.match(/"tempHigh"\s*:\s*\{\s*"metric"\s*:\s*\{\s*"value"\s*:\s*([-\d.]+)/);

    if (dailyHighImp) return parseFloat(dailyHighImp[1]);
    if (dailyHighMet) return parseFloat(dailyHighMet[1]);

    // Strategy 3: Use max of hourly temps
    // For US stations use imperial, otherwise use metric
    if (isUS && imperialTemps.length > 0) {
      // Filter out outliers — temps should be in realistic range for the day
      const sorted = imperialTemps.sort((a,b)=>a-b);
      // Remove bottom 10% outliers (cold overnight readings) and take max of day
      const dayTemps = sorted.slice(Math.floor(sorted.length * 0.1));
      return Math.max(...dayTemps);
    }

    if (!isUS && metricTemps.length > 0) {
      const sorted = metricTemps.sort((a,b)=>a-b);
      const dayTemps = sorted.slice(Math.floor(sorted.length * 0.1));
      return Math.max(...dayTemps);
    }

    // Fallback: use imperial and convert
    if (imperialTemps.length > 0) {
      const sorted = imperialTemps.sort((a,b)=>a-b);
      const max = Math.max(...sorted.slice(Math.floor(sorted.length * 0.1)));
      return isUS ? max : toC(max);
    }

    return null;
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

  let temp = null, cond = '', humidity = null, high = null;

  if (currentRes.status === 'fulfilled' && currentRes.value.ok) {
    const html = await currentRes.value.text();
    temp     = parseCurrentTemp(html);
    cond     = parseCond(html);
    humidity = parseHumidity(html);
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

  return {
    temp:     isUS ? temp : toC(temp),
    high:     isUS ? high : (high !== null ? (high > 60 ? toC(high) : high) : null),
    cond,
    humidity,
    trend,
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
