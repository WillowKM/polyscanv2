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

// Coordinates for Open-Meteo forecast high (keyed by station code)
const STATION_COORDS = {
  NZWN: { lat: -41.33, lon: 174.81 },
  RJTT: { lat: 35.55,  lon: 139.78 },
  RKSI: { lat: 37.46,  lon: 126.44 },
  WSSS: { lat: 1.36,   lon: 103.99 },
  WMKK: { lat: 2.74,   lon: 101.71 },
  ZUUU: { lat: 30.58,  lon: 103.95 },
  ZBAA: { lat: 40.08,  lon: 116.58 },
  VILK: { lat: 26.76,  lon: 80.89  },
  OPKC: { lat: 24.90,  lon: 67.17  },
  OEJN: { lat: 21.68,  lon: 39.16  },
  LLBG: { lat: 32.01,  lon: 34.89  },
  EPWA: { lat: 52.17,  lon: 20.97  },
  LFPB: { lat: 48.97,  lon: 2.44   },
  EGLC: { lat: 51.51,  lon: 0.05   },
  LEMD: { lat: 40.47,  lon: -3.57  },
  KATL: { lat: 33.64,  lon: -84.43 },
  KLGA: { lat: 40.78,  lon: -73.87 },
  KSEA: { lat: 47.44,  lon: -122.31},
  KSFO: { lat: 37.62,  lon: -122.38},
  KMIA: { lat: 25.80,  lon: -80.28 },
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

function parseWunderground(html) {
  try {
    let temp = null, cond = '', humidity = null;

    const tempPatterns = [
      /class="wu-value wu-value-to"[^>]*>\s*([-\d.]+)\s*</,
      /"temperature"\s*:\s*\{\s*"imperial"\s*:\s*\{\s*"value"\s*:\s*([-\d.]+)/,
      /"temperature"\s*:\s*\{\s*"metric"\s*:\s*\{\s*"value"\s*:\s*([-\d.]+)/,
      /data-testid="TemperatureValue"[^>]*>([-\d.]+)</,
      /"temp"\s*:\s*([-\d.]+)/,
    ];
    for (const p of tempPatterns) {
      const m = html.match(p);
      if (m) { temp = parseFloat(m[1]); break; }
    }

    const condPatterns = [
      /data-testid="wxPhrase"[^>]*>([^<]+)</,
      /"phrase"\s*:\s*"([^"]+)"/,
      /"conditionPhrase"\s*:\s*"([^"]+)"/,
    ];
    for (const p of condPatterns) {
      const m = html.match(p);
      if (m) { cond = m[1].trim(); break; }
    }

    const humM = html.match(/data-testid="HumiditySection"[^>]*>.*?(\d+)%/s) ||
                 html.match(/"humidity"\s*:\s*(\d+)/);
    if (humM) humidity = parseInt(humM[1]);

    return { temp, cond, humidity };
  } catch(e) {
    return { temp: null, cond: '', humidity: null };
  }
}

// Fetch forecast high from Open-Meteo (free, no key, no CORS issues server-side)
async function fetchForecastHigh(station) {
  const coords = STATION_COORDS[station];
  if (!coords) return null;
  try {
    // temperature_unit=fahrenheit so US cities get °F, others we convert
    const isUS = US_STATIONS.has(station);
    const unit = isUS ? 'fahrenheit' : 'celsius';
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&daily=temperature_2m_max&temperature_unit=${unit}&timezone=auto&forecast_days=1`;
    const res = await fetch(url, { timeout: 8000 });
    if (!res.ok) return null;
    const json = await res.json();
    const high = json?.daily?.temperature_2m_max?.[0];
    return high !== undefined ? parseFloat(high.toFixed(1)) : null;
  } catch(e) {
    return null;
  }
}

app.get('/weather/:station', async (req, res) => {
  const { station } = req.params;
  const cacheKey = station.toUpperCase();

  if (CACHE[cacheKey] && (Date.now() - CACHE[cacheKey].ts) < CACHE_TTL) {
    return res.json({ ...CACHE[cacheKey].data, cached: true });
  }

  const isUS = US_STATIONS.has(cacheKey);

  try {
    // Fetch current temp from Wunderground + forecast high from Open-Meteo in parallel
    const [wuRes, forecastHigh] = await Promise.allSettled([
      fetch(`https://www.wunderground.com/weather/${station}`, { headers: WU_HEADERS, timeout: 12000 }),
      fetchForecastHigh(cacheKey),
    ]);

    let raw = { temp: null, cond: '', humidity: null };
    if (wuRes.status === 'fulfilled' && wuRes.value.ok) {
      const html = await wuRes.value.text();
      raw = parseWunderground(html);
    }

    const high = forecastHigh.status === 'fulfilled' ? forecastHigh.value : null;

    const data = {
      temp: isUS ? raw.temp : toC(raw.temp),
      high: high, // already in correct unit from Open-Meteo
      cond: raw.cond,
      humidity: raw.humidity,
      unit: isUS ? 'F' : 'C',
    };

    CACHE[cacheKey] = { data, ts: Date.now() };
    res.json({ ...data, station: cacheKey, cached: false, source: 'wu+openmeteo' });
  } catch(err) {
    if (CACHE[cacheKey]) return res.json({ ...CACHE[cacheKey].data, cached: true, stale: true });
    res.status(500).json({ error: err.message, station: cacheKey });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), cached: Object.keys(CACHE).length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PolyScan running on port ${PORT}`));
