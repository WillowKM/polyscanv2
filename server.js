const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const CACHE = {};
const CACHE_TTL = 10 * 60 * 1000;

const US_STATIONS = new Set(['KATL','KLGA','KSEA','KSFO','KMIA']);

// Country code + city slug for Wunderground hourly URL
const STATION_META = {
  NZWN: { cc:'nz', city:'wellington'    },
  RJTT: { cc:'jp', city:'tokyo'         },
  RKSI: { cc:'kr', city:'incheon'       },
  WSSS: { cc:'sg', city:'singapore'     },
  WMKK: { cc:'my', city:'kuala-lumpur'  },
  ZUUU: { cc:'cn', city:'chengdu'       },
  ZBAA: { cc:'cn', city:'beijing'       },
  VILK: { cc:'in', city:'lucknow'       },
  OPKC: { cc:'pk', city:'karachi'       },
  OEJN: { cc:'sa', city:'jeddah'        },
  LLBG: { cc:'il', city:'tel-aviv'      },
  EPWA: { cc:'pl', city:'warsaw'        },
  LFPB: { cc:'fr', city:'paris'         },
  EGLC: { cc:'gb', city:'london'        },
  LEMD: { cc:'es', city:'madrid'        },
  KATL: { cc:'us', city:'atlanta'       },
  KLGA: { cc:'us', city:'new-york'      },
  KSEA: { cc:'us', city:'seattle'       },
  KSFO: { cc:'us', city:'san-francisco' },
  KMIA: { cc:'us', city:'miami'         },
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

// Extract forecast high from the hourly page
// The hourly page has all temps for the day — we find the max
function parseHourlyHigh(html) {
  try {
    // Wunderground hourly page has temps in a table
    // Pattern: numbers inside the hourly table cells
    const allTemps = [];

    // Try JSON data embedded in page
    const jsonMatch = html.match(/"temperature"\s*:\s*\[([\d\s,.-]+)\]/);
    if (jsonMatch) {
      jsonMatch[1].split(',').forEach(v => {
        const n = parseFloat(v.trim());
        if (!isNaN(n) && n > -50 && n < 150) allTemps.push(n);
      });
    }

    // Try table row pattern — hourly rows contain temp values
    const rowPattern = /class="[^"]*hourly[^"]*"[^>]*>[\s\S]{0,500}?([-\d]+)\s*°/gi;
    let m;
    while ((m = rowPattern.exec(html)) !== null) {
      const n = parseFloat(m[1]);
      if (!isNaN(n) && n > -50 && n < 150) allTemps.push(n);
    }

    // Try span/td patterns for temperature values
    const spanPattern = /<(?:span|td)[^>]*>\s*([-]?\d{1,3})\s*<\/(?:span|td)>/g;
    while ((m = spanPattern.exec(html)) !== null) {
      const n = parseInt(m[1]);
      if (!isNaN(n) && n > 0 && n < 130) allTemps.push(n);
    }

    if (allTemps.length === 0) return null;
    return Math.max(...allTemps);
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

  // Fetch current conditions page + hourly page in parallel
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
    high = parseHourlyHigh(html);
  }

  // Convert to correct units
  return {
    temp: isUS ? temp : toC(temp),
    high: isUS ? high : toC(high),
    cond,
    humidity,
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

// Debug — shows raw hourly HTML snippet to verify parsing
app.get('/debug/:station', async (req, res) => {
  const meta = STATION_META[req.params.station.toUpperCase()];
  if (!meta) return res.status(400).json({ error: 'unknown station' });
  const today = todayString();
  const url = `https://www.wunderground.com/hourly/${meta.cc}/${meta.city}/${req.params.station}/date/${today}`;
  try {
    const r = await fetch(url, { headers: WU_HEADERS, timeout: 12000 });
    const html = await r.text();
    const high = parseHourlyHigh(html);
    // Return a sample of the HTML around temp-looking content
    const sample = html.slice(0, 3000);
    res.json({ high, htmlLength: html.length, sample });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), cached: Object.keys(CACHE).length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PolyScan running on port ${PORT}`));
