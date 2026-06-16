const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const CACHE = {};
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// US stations — display in °F, everything else convert to °C
const US_STATIONS = new Set(['KATL','KLGA','KSEA','KSFO','KMIA']);

function toC(f) {
  if (f === null || isNaN(f)) return null;
  return parseFloat(((f - 32) * 5 / 9).toFixed(1));
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
};

function parseWunderground(html) {
  try {
    let temp = null, high = null, low = null, cond = '', humidity = null, wind = null;

    // Current temperature - try multiple patterns
    const tempPatterns = [
      /class="wu-value wu-value-to"[^>]*>\s*([-\d.]+)\s*</,
      /"temperature"\s*:\s*\{\s*"metric"\s*:\s*\{\s*"value"\s*:\s*([-\d.]+)/,
      /data-testid="TemperatureValue"[^>]*>([-\d.]+)</,
      /"temp"\s*:\s*([-\d.]+)/,
    ];
    for (const p of tempPatterns) {
      const m = html.match(p);
      if (m) { temp = parseFloat(m[1]); break; }
    }

    // Today's high
    const highPatterns = [
      /Today[^}]{0,200}High[^}]{0,100}([\d.]+)/is,
      /"tempHigh"\s*:\s*\{\s*"metric"\s*:\s*\{\s*"value"\s*:\s*([-\d.]+)/,
      /data-testid="highTempValue"[^>]*>([-\d.]+)</,
      /"maxTemp"\s*:\s*([-\d.]+)/,
      /class="high-temp"[^>]*>\s*([-\d.]+)/,
    ];
    for (const p of highPatterns) {
      const m = html.match(p);
      if (m) { high = parseFloat(m[1]); break; }
    }

    // Condition
    const condPatterns = [
      /data-testid="wxPhrase"[^>]*>([^<]+)</,
      /"phrase"\s*:\s*"([^"]+)"/,
      /class="condition-icon[^"]*"[^>]*alt="([^"]+)"/,
      /"conditionPhrase"\s*:\s*"([^"]+)"/,
    ];
    for (const p of condPatterns) {
      const m = html.match(p);
      if (m) { cond = m[1].trim(); break; }
    }

    // Humidity
    const humM = html.match(/data-testid="HumiditySection"[^>]*>.*?(\d+)%/s) ||
                 html.match(/"humidity"\s*:\s*(\d+)/);
    if (humM) humidity = parseInt(humM[1]);

    // Wind
    const windM = html.match(/data-testid="Wind"[^>]*>.*?([\d.]+)\s*(km\/h|mph|kph)/is) ||
                  html.match(/"windSpeed"\s*:\s*\{\s*"metric"\s*:\s*\{\s*"value"\s*:\s*([\d.]+)/);
    if (windM) wind = parseFloat(windM[1]);

    return { temp, high, low, cond, humidity, wind };
  } catch(e) {
    return { temp: null, high: null, low: null, cond: '', humidity: null, wind: null };
  }
}

app.get('/weather/:station', async (req, res) => {
  const { station } = req.params;
  const cacheKey = station.toUpperCase();

  // Return cached data if fresh
  if (CACHE[cacheKey] && (Date.now() - CACHE[cacheKey].ts) < CACHE_TTL) {
    return res.json({ ...CACHE[cacheKey].data, cached: true });
  }

  const url = `https://www.wunderground.com/weather/${station}`;

  try {
    const response = await fetch(url, {
      headers: HEADERS,
      timeout: 10000,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    const raw = parseWunderground(html);

    // Convert °F → °C for non-US stations (Wunderground returns °F by default)
    const isUS = US_STATIONS.has(cacheKey);
    const data = {
      ...raw,
      temp: isUS ? raw.temp : toC(raw.temp),
      high: isUS ? raw.high : toC(raw.high),
      unit: isUS ? 'F' : 'C',
    };

    // Cache the result
    CACHE[cacheKey] = { data, ts: Date.now() };

    res.json({ ...data, station: cacheKey, cached: false, source: 'wunderground' });
  } catch(err) {
    // Return cached stale data if available
    if (CACHE[cacheKey]) {
      return res.json({ ...CACHE[cacheKey].data, cached: true, stale: true });
    }
    res.status(500).json({ error: err.message, station: cacheKey });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), cached: Object.keys(CACHE).length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PolyScan server running on port ${PORT}`));
