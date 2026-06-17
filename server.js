const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const CACHE = {};
const PREV_TEMPS = {}; // track previous temp for arrow direction
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

function parseHourlyHigh(html) {
  try {
    const allTemps = [];
    const jsonMatch = html.match(/"temperature"\s*:\s*\[([\d\s,.-]+)\]/);
    if (jsonMatch) {
      jsonMatch[1].split(',').forEach(v => {
        const n = parseFloat(v.trim());
        if (!isNaN(n) && n > -50 && n < 150) allTemps.push(n);
      });
    }
    const spanPattern = /<(?:span|td)[^>]*>\s*([-]?\d{1,3})\s*<\/(?:span|td)>/g;
    let m;
    while ((m = spanPattern.exec(html)) !== null) {
      const n = parseInt(m[1]);
      if (!isNaN(n) && n > 0 && n < 130) allTemps.push(n);
    }
    if (allTemps.length === 0) return null;
    return Math.max(...allTemps);
  } catch(e) { return null; }
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
    high = parseHourlyHigh(html);
  }

  // Track temp direction
  const prevTemp = PREV_TEMPS[station] || null;
  let trend = 'up'; // default — assume climbing
  if (prevTemp !== null && temp !== null) {
    trend = temp >= prevTemp ? 'up' : 'down';
  }
  if (temp !== null) PREV_TEMPS[station] = temp;

  return {
    temp:     isUS ? temp     : toC(temp),
    high:     isUS ? high     : toC(high),
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

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), cached: Object.keys(CACHE).length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PolyScan 24/7 running on port ${PORT}`));
