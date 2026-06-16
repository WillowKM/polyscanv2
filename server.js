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

function toC(f) {
  if (f === null || isNaN(f)) return null;
  return parseFloat(((f - 32) * 5 / 9).toFixed(1));
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Accept-Encoding': 'identity',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
};

function parseWunderground(html) {
  try {
    let temp = null, high = null, cond = '', humidity = null, wind = null;

    // ── CURRENT TEMP ──
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

    // ── TODAY'S HIGH — try every known pattern ──
    const highPatterns = [
      // Wunderground embeds data as JSON inside a <script> tag
      /"tempHigh"\s*:\s*\{\s*"imperial"\s*:\s*\{\s*"value"\s*:\s*([-\d.]+)/,
      /"tempHigh"\s*:\s*\{\s*"metric"\s*:\s*\{\s*"value"\s*:\s*([-\d.]+)/,
      /"high"\s*:\s*\{\s*"imperial"\s*:\s*\{\s*"value"\s*:\s*([-\d.]+)/,
      /"high"\s*:\s*\{\s*"metric"\s*:\s*\{\s*"value"\s*:\s*([-\d.]+)/,
      // data-testid patterns
      /data-testid="highTempValue"[^>]*>([-\d.]+)</,
      /data-testid="HighTemp"[^>]*>([-\d.]+)</,
      // Inline text patterns
      /High\s*<[^>]+>\s*([\d]+)/i,
      /class="high[^"]*"[^>]*>\s*([\d]+)/i,
      // Fallback — any maxTemp
      /"maxTemp"\s*:\s*([-\d.]+)/,
      /"max"\s*:\s*([-\d.]+)/,
    ];
    for (const p of highPatterns) {
      const m = html.match(p);
      if (m) { high = parseFloat(m[1]); break; }
    }

    // ── CONDITION ──
    const condPatterns = [
      /data-testid="wxPhrase"[^>]*>([^<]+)</,
      /"phrase"\s*:\s*"([^"]+)"/,
      /"conditionPhrase"\s*:\s*"([^"]+)"/,
      /class="condition-icon[^"]*"[^>]*alt="([^"]+)"/,
    ];
    for (const p of condPatterns) {
      const m = html.match(p);
      if (m) { cond = m[1].trim(); break; }
    }

    // ── HUMIDITY ──
    const humM = html.match(/data-testid="HumiditySection"[^>]*>.*?(\d+)%/s) ||
                 html.match(/"humidity"\s*:\s*(\d+)/);
    if (humM) humidity = parseInt(humM[1]);

    // ── WIND ──
    const windM = html.match(/"windSpeed"\s*:\s*\{\s*"imperial"\s*:\s*\{\s*"value"\s*:\s*([\d.]+)/) ||
                  html.match(/"windSpeed"\s*:\s*\{\s*"metric"\s*:\s*\{\s*"value"\s*:\s*([\d.]+)/);
    if (windM) wind = parseFloat(windM[1]);

    return { temp, high, cond, humidity, wind };
  } catch(e) {
    return { temp: null, high: null, cond: '', humidity: null, wind: null };
  }
}

// ── DEBUG endpoint — shows raw snippets from Wunderground HTML ──
app.get('/debug/:station', async (req, res) => {
  const url = `https://www.wunderground.com/weather/${req.params.station}`;
  try {
    const response = await fetch(url, { headers: HEADERS, timeout: 12000 });
    const html = await response.text();
    const parsed = parseWunderground(html);

    // Pull 200-char snippets around key terms so we can see what's there
    const snippets = {};
    ['tempHigh','high','maxTemp','High','TemperatureValue','highTempValue'].forEach(term => {
      const idx = html.indexOf(term);
      if (idx !== -1) snippets[term] = html.slice(Math.max(0,idx-30), idx+120);
    });

    res.json({ parsed, htmlLength: html.length, snippets });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── WEATHER endpoint ──
app.get('/weather/:station', async (req, res) => {
  const { station } = req.params;
  const cacheKey = station.toUpperCase();

  if (CACHE[cacheKey] && (Date.now() - CACHE[cacheKey].ts) < CACHE_TTL) {
    return res.json({ ...CACHE[cacheKey].data, cached: true });
  }

  const url = `https://www.wunderground.com/weather/${station}`;
  try {
    const response = await fetch(url, { headers: HEADERS, timeout: 12000 });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const html = await response.text();
    const raw = parseWunderground(html);

    const isUS = US_STATIONS.has(cacheKey);
    const data = {
      ...raw,
      temp: isUS ? raw.temp : toC(raw.temp),
      high: isUS ? raw.high : toC(raw.high),
      unit: isUS ? 'F' : 'C',
    };

    CACHE[cacheKey] = { data, ts: Date.now() };
    res.json({ ...data, station: cacheKey, cached: false, source: 'wunderground' });
  } catch(err) {
    if (CACHE[cacheKey]) return res.json({ ...CACHE[cacheKey].data, cached: true, stale: true });
    res.status(500).json({ error: err.message, station: cacheKey });
  }
});

// ── HEALTH ──
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), cached: Object.keys(CACHE).length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PolyScan running on port ${PORT}`));
