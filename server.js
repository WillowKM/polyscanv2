const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
// Calculator is now the homepage. The old TV-rotation scanner still exists
// at /index.html if ever needed, but isn't the default landing page anymore.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'calculator.html'));
});
app.use(express.static(path.join(__dirname, 'public')));

const CACHE = {};
const POLY_CACHE = {};
const PREV_TEMPS = {};
const DAILY_HIGHS = {}; // tracks highest observed temp per station per day — resets on server restart
const CACHE_TTL     = 30 * 60 * 1000; // 30 min — was 10. Reduces Open-Meteo call volume; forecasts don't swing enough in 30 min to matter for the stability signal.
const POLY_CACHE_TTL = 3 * 60 * 1000; // refresh Polymarket odds every 3 min

// ── PERSISTENT STORAGE ───────────────────────────────────────────────────────
// Render's filesystem is EPHEMERAL by default — any file written to a plain
// relative path (like the old `./markets.json`) gets wiped on every restart,
// redeploy, or free-tier spin-down. That was the cause of the record/markets
// data loss.
//
// Fix: set DATA_DIR to a Render persistent disk mount path (e.g. /var/data)
// as an environment variable once you've attached a disk to this service.
// Until you attach a disk, this still defaults to the project folder so
// local dev keeps working unchanged — it just won't survive a Render restart
// until DATA_DIR points at real persistent storage.
const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch(e) { console.error('Could not create DATA_DIR:', e.message); }
}

const MARKETS_FILE     = path.join(DATA_DIR, 'markets.json');
const RECORD_FILE      = path.join(DATA_DIR, 'record.json');      // permanent trade W/L tally — never auto-cleaned, survives deploys/updates
const PREDICTIONS_FILE = path.join(DATA_DIR, 'predictions.json'); // PolyScan's own estimate accuracy — separate from trade record
const CALC_FILE         = path.join(DATA_DIR, 'calc.json');       // Calculator: settings + daily trade log for the target tracker

console.log(`[storage] Using DATA_DIR = ${DATA_DIR}${process.env.DATA_DIR ? ' (persistent disk)' : ' (⚠️ EPHEMERAL — set DATA_DIR env var to a mounted disk path to persist across restarts)'}`);

const US_STATIONS = new Set(['KATL','KLGA','KSEA','KSFO','KMIA','KBKF','KHOU','KORD','CYYZ','KDFW','KDAL','KAUS','KLAX']);

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
  VHHH: { cc:'hk', city:'hong-kong',      lat:22.3117,  lon:114.1717  }, // King's Park Met Station — the ACTUAL resolution reference since 1 July 1992 (confirmed via HKO's own station history + Polymarket's resolution text). NOT the airport (was wrongly using airport coords 22.308/113.9185 before) — key kept as 'VHHH' for continuity elsewhere in the codebase, but coordinates now correctly point at King's Park, Kowloon.
  KDFW: { cc:'us', city:'dallas',         lat:32.8998,  lon:-97.0403  },
  KDAL: { cc:'us', city:'dallas',         lat:32.8471,  lon:-96.8518  },
  RCTP: { cc:'tw', city:'taipei',         lat:25.0797,  lon:121.2342  },
  EDDM: { cc:'de', city:'munich',         lat:48.3538,  lon:11.7861   },
  EFHK: { cc:'fi', city:'helsinki',       lat:60.3172,  lon:24.9633   },
  SABE: { cc:'ar', city:'buenos-aires',   lat:-34.5592, lon:-58.4156  },
  ZGSZ: { cc:'cn', city:'shenzhen',       lat:22.6393,  lon:113.8107  },
  ZUCK: { cc:'cn', city:'chongqing',      lat:29.7192,  lon:106.6417  },
  LIML: { cc:'it', city:'milan',          lat:45.4451,  lon:9.2767    },
  LTAC: { cc:'tr', city:'ankara',         lat:40.1281,  lon:32.9951   },
  UUEE: { cc:'ru', city:'moscow',         lat:55.9726,  lon:37.4146   },
  RKPK: { cc:'kr', city:'busan',          lat:35.1795,  lon:128.9382  },
  KAUS: { cc:'us', city:'austin',         lat:30.1975,  lon:-97.6664  },
  KLAX: { cc:'us', city:'los-angeles',    lat:33.9425,  lon:-118.4081 },
  SBGR: { cc:'br', city:'sao-paulo',      lat:-23.4356, lon:-46.4731  },
  ZHHH: { cc:'cn', city:'wuhan',          lat:30.7838,  lon:114.2081  },
  WIII: { cc:'id', city:'jakarta',        lat:-6.1256,  lon:106.6559  },
  MMMX: { cc:'mx', city:'mexico-city',    lat:19.4363,  lon:-99.0721  },
  DNMM: { cc:'ng', city:'lagos',          lat:6.5774,   lon:3.3212    },
  EHAM: { cc:'nl', city:'amsterdam',      lat:52.3105,  lon:4.7683    },
  MPTO: { cc:'pa', city:'panama-city',    lat:9.0714,   lon:-79.3835  },
  ZGGG: { cc:'cn', city:'guangzhou',      lat:23.3924,  lon:113.2988  },
  RPLL: { cc:'ph', city:'manila',         lat:14.5086,  lon:121.0198  },
};

// ── Source reliability tiers (from the 50-city audit) ──────────────────────
// 'excellent' = official national agency, live obs + forecast, no third-party
//               model needed. 'good'/'weak'/'poor' = no reliable official
//               direct access; falls back to MET Norway/Open-Meteo models —
//               these get flagged in the UI so lower-confidence cities are
//               never presented as equal to verified ones.
const SOURCE_QUALITY = {
  // Excellent — official agency, fully wired (keyless, verified working)
  KATL:'excellent', KLGA:'excellent', KSEA:'excellent', KSFO:'excellent', KMIA:'excellent',
  KBKF:'excellent', KHOU:'excellent', KORD:'excellent', KDFW:'excellent', KAUS:'excellent', KLAX:'excellent',
  VHHH:'excellent', WSSS:'excellent',
  // Excellent — official agency exists, but needs an API key/registration
  // we haven't set up yet, so these still run on the model fallback for now
  RCTP:'excellent', EHAM:'excellent', EDDM:'excellent', EFHK:'excellent', EPWA:'excellent',
  // Good
  RKPK:'good', RKSI:'good', EGLC:'good', LEMD:'good', CYYZ:'good', SBGR:'good', WIII:'good',
  // Weak
  LLBG:'weak', LFPB:'weak', LIML:'weak', SABE:'weak', MMMX:'weak', NZWN:'weak', RJTT:'weak',
  // Poor — everything else (China stations, IN/PK/SA/TR/ZA/NG/RU/MY/PH/PA)
  ZSPD:'poor', ZBAA:'poor', ZUUU:'poor', ZGSZ:'poor', ZUCK:'poor', ZHHH:'poor', ZGGG:'poor',
  VILK:'poor', OPKC:'poor', OEJN:'poor', LTFM:'poor', LTAC:'poor', FACT:'poor', DNMM:'poor',
  UUEE:'poor', WMKK:'poor', RPLL:'poor', MPTO:'poor',
};
// Stations with a genuinely wired official-source fetch (not just "rated
// excellent on paper") — used to decide whether to call fetchOfficialForecast
const OFFICIAL_SOURCE_WIRED = new Set(['KATL','KLGA','KSEA','KSFO','KMIA','KBKF','KHOU','KORD','KDFW','KDAL','KAUS','KLAX','VHHH','WSSS','EDDM']);

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
  'Hong Kong':     'hong-kong',
  'Dallas':        'dallas',
  'Taipei':        'taipei',
  'Munich':        'munich',
  'Helsinki':      'helsinki',
  'Buenos Aires':  'buenos-aires',
  'Shenzhen':      'shenzhen',
  'Chongqing':     'chongqing',
  'Milan':         'milan',
  'Ankara':        'ankara',
  'Moscow':        'moscow',
  'Busan':         'busan',
  'Austin':        'austin',
  'Los Angeles':   'los-angeles',
  'Sao Paulo':     'sao-paulo',
  'Wuhan':         'wuhan',
  'Jakarta':       'jakarta',
  'Mexico City':   'mexico-city',
  'Lagos':         'lagos',
  'Amsterdam':     'amsterdam',
  'Panama City':   'panama-city',
  'Guangzhou':     'guangzhou',
  'Manila':        'manila',
};

// ── Date helpers ────────────────────────────────────────────────────────────
function todayString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// Format: "june-19-2026"
function polyDateSlug(daysAhead = 0) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  const months = ['january','february','march','april','may','june',
                  'july','august','september','october','november','december'];
  return `${months[d.getMonth()]}-${d.getDate()}-${d.getFullYear()}`;
}

// Build the Polymarket event slug for a city, optionally N days ahead of today
// e.g. "highest-temperature-in-chicago-on-june-19-2026"
function buildEventSlug(cityName, daysAhead = 0) {
  const citySlug = CITY_SLUGS[cityName];
  if (!citySlug) return null;
  return `highest-temperature-in-${citySlug}-on-${polyDateSlug(daysAhead)}`;
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

// ── calc.json — Calculator: settings + daily trade log ─────────────────────
// Separate from markets.json (which is the TV scanner's single-bet-per-city
// tracker). The calculator supports multiple legs per city per day (needed
// for Strategy 3's barbell — several Yes + several No legs on one city), so
// each entry is its own trade row with its own id, not one row per city.
//
// "Trading day" = SAST calendar date (matches "first trade after 00:01").
// A trade belongs to today if its SAST date-string matches todaySAST().
function todaySAST() {
  const now = new Date();
  // SAST = UTC+2, no DST
  const sast = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  return `${sast.getUTCFullYear()}-${String(sast.getUTCMonth()+1).padStart(2,'0')}-${String(sast.getUTCDate()).padStart(2,'0')}`;
}

// ── GitHub-backed persistence ────────────────────────────────────────────────
// Render's free tier wipes the local filesystem on every restart/redeploy.
// If GITHUB_TOKEN is set (a Personal Access Token with 'repo' scope), calc.json
// is read from and written to this repo via GitHub's Contents API instead —
// giving real persistence for free, using storage you already have. Falls
// back to local disk automatically if no token is configured, so nothing
// breaks before that env var is added.
const GITHUB_TOKEN     = process.env.GITHUB_TOKEN || null;
const GITHUB_REPO      = process.env.GITHUB_REPO || 'WillowKM/polyscanv2';
const GITHUB_DATA_PATH = process.env.GITHUB_DATA_PATH || 'data/calc.json';

let CALC_CACHE = null; // in-memory hot cache for this process's lifetime
let CALC_SHA   = null; // GitHub blob sha, required to update an existing file

async function githubGetFile() {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_DATA_PATH}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'PolyScan24-7',
    },
  });
  if (res.status === 404) return null; // file doesn't exist yet — first run
  if (!res.ok) throw new Error(`GitHub GET failed: HTTP ${res.status}`);
  const json = await res.json();
  CALC_SHA = json.sha;
  const content = Buffer.from(json.content, 'base64').toString('utf8');
  return JSON.parse(content);
}

async function githubPutFile(data) {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_DATA_PATH}`;
  const body = {
    message: `Update calc data — ${new Date().toISOString()}`,
    content: Buffer.from(JSON.stringify(data, null, 2)).toString('base64'),
    ...(CALC_SHA ? { sha: CALC_SHA } : {}),
  };
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'PolyScan24-7',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`GitHub PUT failed: HTTP ${res.status} ${errText}`);
  }
  const json = await res.json();
  CALC_SHA = json.content?.sha || CALC_SHA;
}

async function loadCalc() {
  if (CALC_CACHE) return CALC_CACHE; // already loaded this process's lifetime

  if (GITHUB_TOKEN) {
    try {
      const data = await githubGetFile();
      if (data) {
        if (!Array.isArray(data.trades)) data.trades = [];
        if (!data.settings) data.settings = {};
        CALC_CACHE = data;
        return CALC_CACHE;
      }
      // No file yet on GitHub — fall through to defaults, will be created on first save
    } catch(e) {
      console.error('[GitHub storage] load failed, falling back to local disk:', e.message);
    }
  }

  // Local disk fallback (or first-ever run before any GitHub file exists)
  try {
    const raw = fs.readFileSync(CALC_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!data.settings) data.settings = {};
    if (!Array.isArray(data.trades)) data.trades = [];
    CALC_CACHE = data;
  } catch(e) {
    CALC_CACHE = { settings: { portfolio: 0, exposureCap: 0, targetPct: 6 }, trades: [] };
  }
  return CALC_CACHE;
}

async function saveCalc(data) {
  CALC_CACHE = data;
  // Always write local disk too — fast, and a safety net for this process's lifetime
  try { fs.writeFileSync(CALC_FILE, JSON.stringify(data, null, 2)); } catch(e) {
    console.error('[Local storage] write failed:', e.message);
  }
  if (GITHUB_TOKEN) {
    try {
      await githubPutFile(data);
    } catch(e) {
      console.error('[GitHub storage] save failed (data is still safe locally for now):', e.message);
    }
  }
}

// Profit math for a single leg. entryPriceCents is the price PAID per
// share (1-99). stake is the $ wagered on this leg.
//   shares bought   = stake / (entryPriceCents/100)
//   WIN payout      = shares * $1
//   CASHOUT payout  = shares * (cashoutPriceCents/100)
//   LOSS payout     = 0
function computeProfit(trade) {
  const shares = trade.stake / (trade.entryPriceCents / 100);
  if (trade.status === 'WIN')     return parseFloat((shares * 1 - trade.stake).toFixed(4));
  if (trade.status === 'LOSS')    return parseFloat((-trade.stake).toFixed(4));
  if (trade.status === 'CASHOUT') return parseFloat((shares * (trade.cashoutPriceCents/100) - trade.stake).toFixed(4));
  return 0; // still open
}

function todaysTrades(calc) {
  const today = todaySAST();
  return calc.trades.filter(t => t.sastDate === today);
}

function calcSummary(calc) {
  const today = todaysTrades(calc);
  const settled = today.filter(t => t.status !== 'open');
  const open     = today.filter(t => t.status === 'open');

  const profitToday   = settled.reduce((sum, t) => sum + computeProfit(t), 0);
  const exposureUsed  = open.reduce((sum, t) => sum + t.stake, 0);
  const portfolio     = calc.settings.portfolio    || 0;
  const exposureCap   = calc.settings.exposureCap  || 0;
  const targetPct     = calc.settings.targetPct    || 6;
  const targetDollars = parseFloat((portfolio * (targetPct/100)).toFixed(2));
  const sessionTarget = parseFloat((targetDollars / 3).toFixed(2));
  const sessionExposureCap = parseFloat((exposureCap / 3).toFixed(2));

  // Per-session breakdown. Session is chosen manually per trade (not by
  // clock time) — unassigned trades don't count toward any session's total.
  const sessions = {};
  ['asian', 'eu', 'us'].forEach(s => {
    const sTrades  = today.filter(t => t.session === s);
    const sSettled = sTrades.filter(t => t.status !== 'open');
    const sOpen    = sTrades.filter(t => t.status === 'open');
    const sProfit  = sSettled.reduce((sum, t) => sum + computeProfit(t), 0);
    const sExposureUsed = sOpen.reduce((sum, t) => sum + t.stake, 0);
    sessions[s] = {
      target:       sessionTarget,
      targetPctOfPortfolio: portfolio > 0 ? parseFloat(((sessionTarget/portfolio)*100).toFixed(2)) : 0,
      profit:       parseFloat(sProfit.toFixed(2)),
      remaining:    parseFloat(Math.max(0, sessionTarget - sProfit).toFixed(2)),
      pctOfTarget:  sessionTarget > 0 ? parseFloat(((sProfit/sessionTarget)*100).toFixed(1)) : 0,
      targetMet:    sProfit >= sessionTarget && sessionTarget > 0,
      tradesCount:  sTrades.length,
      tradesOpen:   sOpen.length,
      tradesSettled: sSettled.length,
      exposureCap:  sessionExposureCap,
      exposureUsed: parseFloat(sExposureUsed.toFixed(2)),
      exposureFree: parseFloat(Math.max(0, sessionExposureCap - sExposureUsed).toFixed(2)),
    };
  });

  return {
    sastDate:       today.length ? today[0].sastDate : todaySAST(),
    targetDollars,
    sessionTarget,
    profitToday:    parseFloat(profitToday.toFixed(2)),
    pctOfTarget:    targetDollars > 0 ? parseFloat(((profitToday/targetDollars)*100).toFixed(1)) : 0,
    targetMet:      profitToday >= targetDollars && targetDollars > 0,
    exposureUsed:   parseFloat(exposureUsed.toFixed(2)),
    exposureFree:   parseFloat((exposureCap - exposureUsed).toFixed(2)),
    exposureCap,
    portfolio,
    tradesOpenCount:    open.length,
    tradesSettledCount: settled.length,
    sessions,
  };
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

// WU's own forecasted high for today, straight off their forecast page — the
// literal number Polymarket's resolution source would show, not a third-party
// model's guess at it. Like the other parsers, prefer the embedded "imperial"
// JSON value (WU's underlying API is always Fahrenheit there regardless of
// display locale) so toC() below can be applied unconditionally, consistent
// with how observedHigh is handled.
function parseWUForecastHigh(html) {
  const patterns = [
    /"calendarDayTemperatureMax"\s*:\s*\[\s*([-\d.]+)/,
    /"temperatureMax"\s*:\s*\[\s*([-\d.]+)/,
    /"temperatureMax"\s*:\s*([-\d.]+)/,
    /data-testid="TemperatureValue"[^>]*>\s*([-\d.]+)\s*</, // first temp block on forecast page is usually today's high
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return parseFloat(m[1]);
  }
  return null;
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

// ── HOURLY DATA (for the stability engine) ──────────────────────────────────
// WU's hourly page is rendered client-side by React ("Please enable
// JavaScript to continue" appears in the raw HTML) — there is no server-
// rendered hourly table to scrape, so a regex-based approach can't work here.
// Instead we use Open-Meteo's free, no-key hourly forecast API, keyed off
// the lat/lon already stored per station in STATION_META. All values come
// back in metric regardless of station — we convert to °F only at display
// time for US cities, same as the rest of the app.
function weatherCodeToCond(code) {
  if (code === 0) return 'Fair';
  if (code === 1 || code === 2 || code === 3) return 'Cloudy';
  if (code === 45 || code === 48) return 'Fog';
  if (code >= 51 && code <= 67) return 'Rain';
  if (code >= 71 && code <= 77) return 'Snow';
  if (code === 80 || code === 81 || code === 82) return 'Rain';
  if (code === 85 || code === 86) return 'Snow';
  if (code === 95 || code === 96 || code === 99) return 'T-Storm';
  return '';
}

// MET Norway doesn't always populate dew_point_temperature depending on
// product/location — derive it as a fallback from temperature + relative
// humidity using the Magnus-Tetens approximation.
function computeDewPoint(tempC, rh) {
  if (tempC === null || tempC === undefined || rh === null || rh === undefined || rh <= 0) return null;
  const a = 17.27, b = 237.7;
  const alpha = Math.log(rh / 100) + (a * tempC) / (b + tempC);
  return parseFloat(((b * alpha) / (a - alpha)).toFixed(1));
}

// ── Open-Meteo circuit breaker ──────────────────────────────────────────────
// Open-Meteo's free tier is rate-limited PER IP, not per app. On shared
// hosting (Render/Vercel free tiers) that IP is shared across many unrelated
// apps, so the daily quota can be exhausted by traffic that has nothing to
// do with PolyScan. Once we see "Daily API request limit exceeded", further
// calls just waste the shared quota and slow down every page load for
// nothing — so we stop trying until the next UTC day and fail instantly.
let openMeteoBlockedUntil = 0;
function msUntilNextUTCMidnight() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
  return next.getTime() - now.getTime();
}

async function fetchHourly(station) {
  const meta = STATION_META[station];
  if (!meta) return { rows: [], error: 'No station metadata' };

  // MET Norway first — no daily quota, no shared-IP exhaustion risk.
  const metNoResult = await fetchHourlyMetNo(station, meta);
  if (metNoResult.rows.length) return metNoResult;

  console.error(`[MET Norway] ${station} failed (${metNoResult.error}) — falling back to Open-Meteo`);

  if (Date.now() < openMeteoBlockedUntil) {
    const mins = Math.ceil((openMeteoBlockedUntil - Date.now()) / 60000);
    return { rows: [], error: `MET Norway failed (${metNoResult.error}); Open-Meteo also unavailable (daily limit, retry in ~${mins}min)` };
  }

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${meta.lat}&longitude=${meta.lon}` +
      `&hourly=temperature_2m,relative_humidity_2m,dew_point_2m,cloud_cover,precipitation_probability,wind_direction_10m,weather_code,surface_pressure` +
      `&timezone=auto&forecast_days=1`;
    const res = await fetch(url);
    if (!res.ok) {
      let reason = `HTTP ${res.status}`;
      try { const errJson = await res.json(); if (errJson.reason) reason = errJson.reason; } catch(e2) {}
      console.error(`[Open-Meteo] ${station} failed: ${reason}`);
      if (/daily.*limit/i.test(reason)) {
        openMeteoBlockedUntil = Date.now() + msUntilNextUTCMidnight();
        console.error(`[Open-Meteo] Daily limit hit — pausing all calls until ${new Date(openMeteoBlockedUntil).toISOString()}`);
      }
      return { rows: [], error: `MET Norway failed (${metNoResult.error}); Open-Meteo also failed (${reason})` };
    }
    const json = await res.json();
    const h = json.hourly;
    if (!h || !h.time) {
      return { rows: [], error: `MET Norway failed (${metNoResult.error}); Open-Meteo returned no data` };
    }

    const rows = h.time.map((t, i) => ({
      time:     t,
      tempC:    h.temperature_2m?.[i]        ?? null,
      dewC:     h.dew_point_2m?.[i]           ?? null,
      humidity: h.relative_humidity_2m?.[i]   ?? null,
      cloud:    h.cloud_cover?.[i]            ?? null,
      precip:   h.precipitation_probability?.[i] ?? null,
      cond:     weatherCodeToCond(h.weather_code?.[i]),
      windDeg:  h.wind_direction_10m?.[i]     ?? null,
      pressure: h.surface_pressure?.[i]       ?? null,
    }));
    return { rows, error: null, source: 'open-meteo' };
  } catch(e) {
    console.error(`[Open-Meteo] ${station} threw: ${e.message}`);
    return { rows: [], error: `MET Norway failed (${metNoResult.error}); Open-Meteo also failed (${e.message})` };
  }
}

// MET Norway (api.met.no) — free, no API key, no daily cap, used in production
// by weather apps worldwide. Requires a descriptive User-Agent (their policy,
// not a technical restriction). Gridded like Open-Meteo, not station-specific,
// but serves as a resilient fallback so stability/Pattern Day never fully
// cut off just because Open-Meteo's shared-IP quota is exhausted.
// ── OFFICIAL SOURCE FETCH ────────────────────────────────────────────────
// For the 'excellent' tier — the actual national agency's own forecast,
// not a gridded model. Only called for stations in OFFICIAL_SOURCE_WIRED.
const OFFICIAL_CACHE = {};
const OFFICIAL_CACHE_TTL = 30 * 60 * 1000;

async function fetchOfficialForecast(station) {
  if (OFFICIAL_CACHE[station] && (Date.now() - OFFICIAL_CACHE[station].ts) < OFFICIAL_CACHE_TTL) {
    return OFFICIAL_CACHE[station].data;
  }
  let result = { highF: null, highC: null, source: null, error: null };
  try {
    if (US_STATIONS.has(station)) {
      result = await fetchNWSForecast(station);
    } else if (station === 'VHHH') {
      result = await fetchHKOForecast();
    } else if (station === 'WSSS') {
      result = await fetchSGForecast();
    } else if (station === 'EDDM') {
      result = await fetchDWDForecast(station);
    }
  } catch(e) {
    result = { highF: null, highC: null, source: null, error: e.message };
  }
  OFFICIAL_CACHE[station] = { data: result, ts: Date.now() };
  return result;
}

async function fetchNWSForecast(station) {
  const meta = STATION_META[station];
  const headers = { 'User-Agent': 'PolyScan24-7/1.0 github.com/WillowKM/polyscanv2', 'Accept': 'application/geo+json' };
  const pointsRes = await fetch(`https://api.weather.gov/points/${meta.lat.toFixed(4)},${meta.lon.toFixed(4)}`, { headers });
  if (!pointsRes.ok) return { highF: null, highC: null, source: 'NWS', error: `points HTTP ${pointsRes.status}` };
  const pointsJson = await pointsRes.json();
  const forecastUrl = pointsJson?.properties?.forecast;
  if (!forecastUrl) return { highF: null, highC: null, source: 'NWS', error: 'no forecast URL in points response' };

  const fcRes = await fetch(forecastUrl, { headers });
  if (!fcRes.ok) return { highF: null, highC: null, source: 'NWS', error: `forecast HTTP ${fcRes.status}` };
  const fcJson = await fcRes.json();
  const periods = fcJson?.properties?.periods || [];
  // Find today's daytime period (isDaytime true, first one = today or tonight)
  const todayPeriod = periods.find(p => p.isDaytime) || periods[0];
  if (!todayPeriod) return { highF: null, highC: null, source: 'NWS', error: 'no periods in forecast' };
  const highF = todayPeriod.temperature;
  return { highF, highC: toC(highF), source: 'NWS', error: null, narrative: todayPeriod.shortForecast };
}

async function fetchHKOForecast() {
  const res = await fetch('https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=fnd&lang=en');
  if (!res.ok) return { highF: null, highC: null, source: 'HKO', error: `HTTP ${res.status}` };
  const json = await res.json();
  const today = json?.weatherForecast?.[0];
  if (!today) return { highF: null, highC: null, source: 'HKO', error: 'no forecast data' };
  const highC = parseFloat(today.forecastMaxtemp?.value);
  return { highF: isNaN(highC) ? null : parseFloat((highC*9/5+32).toFixed(1)), highC: isNaN(highC) ? null : highC, source: 'HKO', error: null, narrative: (today.forecastWeather || '') + ' [Note: HKO\'s public forecast is territory-wide, not King\'s Park-specific — the actual resolution station]' };
}

async function fetchSGForecast() {
  const res = await fetch('https://api.data.gov.sg/v1/environment/4-day-weather-forecast');
  if (!res.ok) return { highF: null, highC: null, source: 'NEA', error: `HTTP ${res.status}` };
  const json = await res.json();
  const forecasts = json?.items?.[0]?.forecasts;
  if (!forecasts || !forecasts.length) return { highF: null, highC: null, source: 'NEA', error: 'no forecast data' };

  // The API returns 4 entries (today + next 3 days) — match by actual date
  // (SGT) instead of assuming index 0 is today, which caused a real bug
  // (grabbed a later day's forecast, e.g. 33° when today was ~30°).
  const nowSGT = new Date(Date.now() + 8 * 60 * 60 * 1000); // UTC+8, no DST
  const todayStr = nowSGT.toISOString().slice(0, 10);
  const today = forecasts.find(f => f.date === todayStr) || forecasts[0];
  if (!today) return { highF: null, highC: null, source: 'NEA', error: `no entry matching ${todayStr}` };
  if (today.date !== todayStr) {
    return { highF: null, highC: null, source: 'NEA', error: `date mismatch — wanted ${todayStr}, only found ${today.date}` };
  }

  const highC = parseFloat(today.temperature?.high);
  return { highF: isNaN(highC) ? null : parseFloat((highC*9/5+32).toFixed(1)), highC: isNaN(highC) ? null : highC, source: 'NEA', error: null, narrative: today.forecast };
}

// DWD (Munich) via Bright Sky — a well-established free wrapper around DWD's
// raw MOSMIX forecast data (2M+ requests/day in production, no key needed).
// Genuinely keyless (confirmed: DWD's open-data server requires no auth).
async function fetchDWDForecast(station) {
  const meta = STATION_META[station];
  const todayStr = new Date().toISOString().slice(0, 10); // Europe/Berlin is close enough to UTC-day for this purpose
  const url = `https://api.brightsky.dev/weather?lat=${meta.lat}&lon=${meta.lon}&date=${todayStr}`;
  const res = await fetch(url);
  if (!res.ok) return { highF: null, highC: null, source: 'DWD', error: `HTTP ${res.status}` };
  const json = await res.json();
  const hours = json?.weather;
  if (!hours || !hours.length) return { highF: null, highC: null, source: 'DWD', error: 'no weather data for today' };
  const temps = hours.map(h => h.temperature).filter(t => t !== null && t !== undefined);
  if (!temps.length) return { highF: null, highC: null, source: 'DWD', error: 'no temperature values today' };
  const highC = Math.max(...temps);
  return { highF: parseFloat((highC*9/5+32).toFixed(1)), highC: parseFloat(highC.toFixed(1)), source: 'DWD', error: null, narrative: null };
}

async function fetchHourlyMetNo(station, meta, openMeteoError) {
  try {
    const url = `https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${meta.lat}&lon=${meta.lon}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'PolyScan24-7/1.0 github.com/WillowKM/polyscanv2' } });
    if (!res.ok) {
      const reason = `MET Norway HTTP ${res.status}`;
      console.error(`[MET Norway] ${station} failed: ${reason}`);
      return { rows: [], error: openMeteoError ? `${openMeteoError}; fallback also failed (${reason})` : reason };
    }
    const json = await res.json();
    const series = json?.properties?.timeseries;
    if (!series || !series.length) {
      return { rows: [], error: 'MET Norway returned no timeseries data' };
    }
    // Only keep today's entries (compact endpoint returns several days)
    const todayStr = new Date().toISOString().slice(0, 10);
    const rows = series
      .filter(entry => entry.time.startsWith(todayStr))
      .map(entry => {
        const details = entry.data?.instant?.details || {};
        const next1h = entry.data?.next_1_hours?.summary?.symbol_code || '';
        const tempC = details.air_temperature ?? null;
        const humidity = details.relative_humidity ?? null;
        // /complete usually includes dew_point_temperature directly; fall back
        // to computing it from temp+humidity if this location doesn't have it.
        const dewC = details.dew_point_temperature ?? computeDewPoint(tempC, humidity);
        return {
          time:     entry.time,
          tempC:    tempC,
          dewC:     dewC,
          humidity: humidity,
          cloud:    details.cloud_area_fraction ?? null,
          precip:   entry.data?.next_1_hours?.details?.precipitation_amount ?? null,
          cond:     metNoSymbolToCond(next1h),
          windDeg:  details.wind_from_direction ?? null,
          pressure: details.air_pressure_at_sea_level ?? null,
        };
      });
    return { rows, error: null, source: 'met-norway' };
  } catch(e) {
    console.error(`[MET Norway] ${station} threw: ${e.message}`);
    return { rows: [], error: openMeteoError ? `${openMeteoError}; fallback also failed (${e.message})` : e.message };
  }
}

function metNoSymbolToCond(symbolCode) {
  if (!symbolCode) return null;
  if (/thunder/.test(symbolCode)) return 'T-Storm';
  if (/rain|sleet|showers/.test(symbolCode)) return 'Rain';
  if (/snow/.test(symbolCode)) return 'Snow';
  if (/fog/.test(symbolCode)) return 'Fog';
  if (/cloudy/.test(symbolCode)) return 'Cloudy';
  if (/fair|clearsky|partlycloudy/.test(symbolCode)) return 'Fair';
  return null;
}

// ── STABILITY ENGINE ─────────────────────────────────────────────────────────
// Five-signal check, built from the Beijing (volatile/overshoot) vs Incheon
// (stable) case comparison. Input rows are always metric (°C) from
// Open-Meteo. Returns a green/red badge plus a flag breakdown so we can see
// WHY a city is flagged, and a suggested estimate adjustment in °C to apply
// on top of the source forecast high.
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a,b)=>a-b);
  const mid = Math.floor(s.length/2);
  return s.length % 2 ? s[mid] : parseFloat(((s[mid-1]+s[mid])/2).toFixed(1));
}

function computeStability(hourlyRows, fetchError, source) {
  const flags = {
    dewPointDrift:   false,
    cloudVolatility: false,
    stormRecency:    false,
    tempCurveShape:  false,
    windShift:       false,
    pressureSwing:   false,
  };
  const notes = [];

  const valid = hourlyRows.filter(r => r.dewC !== null || r.tempC !== null);
  if (!valid.length) {
    return {
      score: 'unknown', flags,
      notes: [fetchError ? `Open-Meteo fetch failed: ${fetchError}` : 'No hourly data available'],
      redCount: 0, estimateAdjustmentC: 0, forecastHighC: null, raw: null, patternDay: null,
    };
  }

  // 1. Dew point drift — max minus min across today's hours
  const dews = valid.map(r => r.dewC).filter(v => v !== null);
  let dewDrift = null;
  if (dews.length >= 2) {
    dewDrift = parseFloat((Math.max(...dews) - Math.min(...dews)).toFixed(1));
    if (dewDrift >= 2) {
      flags.dewPointDrift = true;
      notes.push(`Dew point swings ${dewDrift.toFixed(1)}°C across the day — air mass likely changing`);
    }
  }

  // 2. Cloud cover volatility — range crosses both a clear band and an overcast band
  const clouds = valid.map(r => r.cloud).filter(v => v !== null);
  let cloudRange = null;
  if (clouds.length >= 2) {
    const hasLow  = clouds.some(c => c <= 20);
    const hasHigh = clouds.some(c => c >= 70);
    cloudRange = Math.max(...clouds) - Math.min(...clouds);
    if (hasLow && hasHigh && cloudRange >= 50) {
      flags.cloudVolatility = true;
      notes.push('Cloud cover swings between clear and overcast');
    }
  }

  // 3. Storm recency — thunderstorm/heavy rain earlier in the day, clearing by now
  const stormHours = valid.filter(r => r.cond === 'T-Storm' || r.cond === 'Rain');
  const clearNow   = valid.filter(r => r.cond === 'Fair');
  if (stormHours.length && clearNow.length && valid.indexOf(stormHours[stormHours.length - 1]) < valid.length - 1) {
    flags.stormRecency = true;
    notes.push('Storm/rain earlier today, clearing to fair — overshoot risk');
  }

  // 4. Temp curve shape — still climbing steeply in the last few daytime hours, no plateau
  const daytime = valid.filter(r => {
    const hr = parseInt((r.time || '').split('T')[1]?.slice(0,2) || '-1', 10);
    return hr >= 10 && hr <= 16;
  });
  const temps = daytime.map(r => r.tempC).filter(v => v !== null);
  let tempSlope = null;
  if (temps.length >= 3) {
    tempSlope = parseFloat(((temps[temps.length - 1] - temps[0]) / (temps.length - 1)).toFixed(2));
    if (tempSlope >= 1) {
      flags.tempCurveShape = true;
      notes.push('Temp still climbing steadily through peak hours — may run above forecast');
    }
  }

  // 5. Wind shift — abrupt direction change across the day (>90°)
  const degs = valid.map(r => r.windDeg).filter(v => v !== null);
  let windShiftDeg = null;
  if (degs.length >= 2) {
    const a = degs[0], b = degs[degs.length - 1];
    let diff = Math.abs(a - b);
    diff = Math.min(diff, 360 - diff);
    windShiftDeg = parseFloat(diff.toFixed(0));
    if (diff >= 90) {
      flags.windShift = true;
      notes.push('Wind direction shifts sharply — air mass change likely');
    }
  }

  // 6. Pressure swing — flat/steady pressure all day is one of the clearest
  // "boring, predictable day" signals. Range >= 5 hPa across the day = unstable.
  const pressures = valid.map(r => r.pressure).filter(v => v !== null);
  let pressureRange = null, pressureTrend = 'flat';
  if (pressures.length >= 2) {
    pressureRange = parseFloat((Math.max(...pressures) - Math.min(...pressures)).toFixed(1));
    const delta = pressures[pressures.length-1] - pressures[0];
    pressureTrend = delta > 1 ? 'rising' : delta < -1 ? 'falling' : 'flat';
    if (pressureRange >= 5) {
      flags.pressureSwing = true;
      notes.push(`Pressure swings ${pressureRange.toFixed(1)}hPa across the day — less stable pattern`);
    }
  }

  const redCount = Object.values(flags).filter(Boolean).length;
  const score = redCount >= 2 ? 'red' : 'green';

  // Heuristic estimate bump — starting point only, to be tuned against
  // logged trade outcomes over time (Beijing-style overshoot went +2°C).
  let estimateAdjustmentC = 0;
  if (flags.stormRecency && flags.tempCurveShape) estimateAdjustmentC = 2;
  else if (redCount >= 2) estimateAdjustmentC = 1;

  // ── FORECAST HIGH ───────────────────────────────────────────────────────
  // The actual forecasted maximum temperature for the whole day, from the
  // hourly model — this is what should be compared against a Yes bracket's
  // temperature range, NOT the "observed high so far" (which only reflects
  // hours that have already happened).
  const allTemps = valid.map(r => r.tempC).filter(v => v !== null);
  const forecastHighC = allTemps.length ? parseFloat(Math.max(...allTemps).toFixed(1)) : null;

  // ── PATTERN DAY ─────────────────────────────────────────────────────────
  // Separate from the red/green risk score above. This answers a different
  // question: "is today's weather STORY simple and uniform (all cloudy, all
  // sunny) or a mixed bag (sun/rain/storm in one afternoon)?" A city can be
  // green on stability but still be a "mixed" weather story, and vice versa.
  const condCounts = {};
  valid.forEach(r => { if (r.cond) condCounts[r.cond] = (condCounts[r.cond] || 0) + 1; });
  const condEntries = Object.entries(condCounts).sort((a,b) => b[1]-a[1]);
  let patternDay = null;
  if (condEntries.length) {
    const [dominantCond, dominantCount] = condEntries[0];
    const pctDominant = parseFloat(((dominantCount / valid.length) * 100).toFixed(0));
    const CONDICONS = { Fair:'☀️', Cloudy:'☁️', Rain:'🌧️', 'T-Storm':'⛈️', Snow:'❄️', Fog:'🌫️' };
    patternDay = {
      dominantCond,
      pctDominant,
      isPatternDay: pctDominant >= 75,
      label: `${CONDICONS[dominantCond] || ''} ${dominantCond} ${pctDominant}% of the day`,
    };
  }

  return {
    score, flags, notes, redCount, estimateAdjustmentC, forecastHighC, source: source || 'open-meteo',
    patternDay,
    raw: {
      dew:      { min: dews.length ? Math.min(...dews) : null,          max: dews.length ? Math.max(...dews) : null,          median: median(dews),      driftC: dewDrift },
      cloud:    { min: clouds.length ? Math.min(...clouds) : null,      max: clouds.length ? Math.max(...clouds) : null,      median: median(clouds),    rangePct: cloudRange },
      humidity: { min: valid.length ? Math.min(...valid.map(r=>r.humidity).filter(v=>v!==null)) : null, max: valid.length ? Math.max(...valid.map(r=>r.humidity).filter(v=>v!==null)) : null, median: median(valid.map(r=>r.humidity).filter(v=>v!==null)) },
      wind:     { shiftDeg: windShiftDeg },
      tempSlope: tempSlope,
      pressure: { rangeHpa: pressureRange, trend: pressureTrend },
    },
  };
}

async function fetchStation(station) {
  const meta = STATION_META[station];
  const isUS = US_STATIONS.has(station);

  // Only two pages needed now:
  // 1. current-conditions → temp, cond, humidity, sunrise/sunset
  // 2. forecast → sunrise/sunset fallback
  // Hourly page was only ever used for high-temp scraping which we no longer do.
  const currentUrl  = `https://www.wunderground.com/weather/${station}`;
  const forecastUrl = `https://www.wunderground.com/forecast/${meta.cc}/${meta.city}/${station}`;

  const [currentRes, forecastRes] = await Promise.allSettled([
    fetch(currentUrl,  { headers: WU_HEADERS, timeout: 12000 }),
    fetch(forecastUrl, { headers: WU_HEADERS, timeout: 12000 }),
  ]);

  let temp = null, cond = '', humidity = null, sunrise = null, sunset = null, wuForecastHighRaw = null;

  if (currentRes.status === 'fulfilled' && currentRes.value.ok) {
    const html = await currentRes.value.text();
    temp     = parseCurrentTemp(html);
    cond     = parseCond(html);
    humidity = parseHumidity(html);
    const sun = parseSunTimes(html);
    sunrise = sun.sunrise; sunset = sun.sunset;
  }

  // Sunrise/sunset fallback + WU's own forecasted high from the forecast page
  if (forecastRes.status === 'fulfilled' && forecastRes.value.ok) {
    const html = await forecastRes.value.text();
    if (!sunrise || !sunset) {
      const sun = parseSunTimes(html);
      if (!sunrise) sunrise = sun.sunrise;
      if (!sunset)  sunset  = sun.sunset;
    }
    wuForecastHighRaw = parseWUForecastHigh(html);
  }

  // ── Trend ─────────────────────────────────────────────────────────────────
  const prevTemp = PREV_TEMPS[station] || null;
  let trend = 'up';
  if (prevTemp !== null && temp !== null) trend = temp >= prevTemp ? 'up' : 'down';
  if (temp !== null) PREV_TEMPS[station] = temp;

  // ── Observed daily high ───────────────────────────────────────────────────
  // Instead of forecasting or scraping, we simply track the highest current
  // temp we have seen today from our own polling. Resets when the server
  // restarts (Render restarts daily) or when the date changes.
  // temp here is raw from Wunderground — still in °F for US stations at
  // this point, converted to °C below in the return statement.
  const today = todayString();
  if (!DAILY_HIGHS[station] || DAILY_HIGHS[station].date !== today) {
    // New day or first reading — initialise with current temp
    if (temp !== null) DAILY_HIGHS[station] = { date: today, high: temp };
  } else if (temp !== null && temp > DAILY_HIGHS[station].high) {
    DAILY_HIGHS[station].high = temp;
  }
  const observedHigh = DAILY_HIGHS[station] ? DAILY_HIGHS[station].high : null;

  // ── Stability engine (Open-Meteo hourly, always metric) ─────────────────
  // Raw scraped WU values are always °F under the hood (toC() converts for
  // non-US display below) — so the stability engine, which needs °C to
  // compare against Open-Meteo, must always run the conversion here too.
  const { rows: hourlyRows, error: hourlyError, source: hourlySource } = await fetchHourly(station);
  const stability  = computeStability(hourlyRows, hourlyError, hourlySource);
  const sourceHighC = toC(observedHigh); // observed so far today — NOT a forecast
  const forecastHighC = stability.forecastHighC; // actual forecasted max for the whole day (already °C)
  const estimateHighC = forecastHighC !== null
    ? parseFloat((forecastHighC + stability.estimateAdjustmentC).toFixed(1))
    : null;
  // Mirror into the station's display unit for convenience
  const forecastHighDisplay = forecastHighC !== null
    ? (isUS ? parseFloat((forecastHighC * 9/5 + 32).toFixed(1)) : forecastHighC)
    : null;
  const estimateHighDisplay = estimateHighC !== null
    ? (isUS ? parseFloat((estimateHighC * 9/5 + 32).toFixed(1)) : estimateHighC)
    : null;
  // WU's own forecasted high is scraped already in the station's native
  // display unit (imperial JSON for US stations, same convention as
  // observedHigh above) — no conversion needed for display, but we also
  // compute its °C equivalent so it's directly comparable to forecastHighC.
  // WU's forecast page returns Fahrenheit for EVERY city, not just US ones
  // (their site defaults to imperial units regardless of location) — so this
  // always needs converting to °C for the disagreement comparison, and is
  // only shown in raw Fahrenheit for US stations in the display value.
  const wuForecastHighC = wuForecastHighRaw !== null ? toC(wuForecastHighRaw) : null;
  const wuForecastHighDisplay = wuForecastHighRaw !== null
    ? (isUS ? wuForecastHighRaw : wuForecastHighC)
    : null;
  // Two genuinely independent sources (WU's own forecaster vs the MET
  // Norway/Open-Meteo model) disagreeing by 1.5°C+ is itself a useful signal
  // — worth flagging rather than silently picking one.
  const sourceDisagreementC = (wuForecastHighC !== null && forecastHighC !== null)
    ? parseFloat(Math.abs(wuForecastHighC - forecastHighC).toFixed(1))
    : null;

  // ── OFFICIAL SOURCE (excellent tier only) ────────────────────────────────
  // The actual national agency's own forecast — not a gridded model. Where
  // this disagrees meaningfully with WU specifically, that's the signal
  // worth watching: most retail traders on Polymarket anchor to WU, so a
  // verified official source disagreeing with WU can mean the market is
  // mispriced against WU's number rather than the more accurate one.
  const sourceQuality = SOURCE_QUALITY[station] || 'poor';
  let official = { highF: null, highC: null, source: null, error: null };
  if (OFFICIAL_SOURCE_WIRED.has(station)) {
    official = await fetchOfficialForecast(station);
  }
  const officialHighDisplay = official.highC !== null
    ? (isUS ? official.highF : official.highC)
    : null;
  const officialVsWU_C = (official.highC !== null && wuForecastHighC !== null)
    ? parseFloat((official.highC - wuForecastHighC).toFixed(1)) // positive = official running warmer than WU
    : null;

  return {
    temp:      isUS ? temp         : toC(temp),
    high:      isUS ? observedHigh : toC(observedHigh),
    highSource: 'observed',
    cond, humidity, trend, sunrise, sunset,
    unit: isUS ? 'F' : 'C',
    stability: {
      score:      stability.score,       // 'green' | 'red' | 'unknown'
      redCount:   stability.redCount,
      flags:      stability.flags,
      notes:      stability.notes,
      raw:        stability.raw,         // dew/cloud/humidity/wind/pressure min-median-max, for every city not just red ones
      patternDay: stability.patternDay,  // dominant condition + % of day + isPatternDay flag
      sourceHighC:    sourceHighC,
      forecastHighC:  forecastHighC,
      estimateHighC:  estimateHighC,
      sourceHigh:     isUS ? observedHigh       : sourceHighC,     // observed so far, in station's display unit
      forecastHigh:   forecastHighDisplay,                          // forecasted max for the whole day (MET Norway/Open-Meteo model) — compare this against Yes bracket ranges
      estimateHigh:   estimateHighDisplay,                          // forecast high, adjusted by stability signals
      wuForecastHigh: wuForecastHighDisplay,                        // WU's OWN forecasted high, scraped directly — shown in the station's correct display unit
      sourceDisagreementC: sourceDisagreementC,                     // |WU forecast - model forecast|, in °C — flag when this is large
      sourceQuality:  sourceQuality,                                // 'excellent' | 'good' | 'weak' | 'poor' — from the 50-city audit
      officialHigh:      officialHighDisplay,                       // the actual national agency's own forecast (excellent tier only)
      officialSourceName: official.source,                          // 'NWS' | 'HKO' | 'NEA' | null
      officialNarrative:  official.narrative || null,
      officialError:      official.error,
      officialVsWU_C:     officialVsWU_C,                           // positive = official source running warmer than WU
    },
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

// ── CALCULATOR ROUTES ────────────────────────────────────────────────────────

// Auto-resolve open trades once their bracket's live price hits an extreme.
// Polymarket brackets settle to ~99-100c (won) or ~0-1c (lost) as the day's
// actual high becomes certain — the API rounds to whole cents, so we treat
// >=99c as resolved-yes and <=1c as resolved-no. Matching is by exact
// bracket label, which is reliable for trades logged via the scanner chips
// (label comes straight from Polymarket's own data) but may miss free-typed
// manual entries if the label doesn't match exactly — those still settle
// fine manually via the Won/Lost buttons.
function autoSettleOpenTrades(calc) {
  let changed = false;
  const today = todaysTrades(calc);
  for (const trade of today) {
    if (trade.status !== 'open') continue;
    const cached = POLY_CACHE[trade.city];
    const outcomes = cached?.data?.outcomes;
    if (!outcomes) continue;
    const match = outcomes.find(o => o.bracket === trade.bracketLabel);
    if (!match || match.prob === null) continue;

    let resolvedOutcome = null;
    if (match.prob >= 99.1)      resolvedOutcome = trade.side === 'YES' ? 'WIN' : 'LOSS';
    else if (match.prob <= 0.9)  resolvedOutcome = trade.side === 'YES' ? 'LOSS' : 'WIN';
    if (!resolvedOutcome) continue;

    trade.status = resolvedOutcome;
    trade.settledAt = new Date().toISOString();
    trade.profit = computeProfit(trade);
    trade.autoResolved = true;
    changed = true;
  }
  return changed;
}

// Get settings + today's summary + today's trades
app.get('/calc/state', async (req, res) => {
  try {
    const calc = await loadCalc();
    if (autoSettleOpenTrades(calc)) await saveCalc(calc);
    res.json({
      settings: calc.settings,
      summary:  calcSummary(calc),
      trades:   todaysTrades(calc),
    });
  } catch(e) {
    console.error('[calc/state] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Update settings (portfolio, exposureCap, targetPct)
app.post('/calc/settings', async (req, res) => {
  try {
    const { portfolio, exposureCap, targetPct } = req.body;
    const calc = await loadCalc();
    if (portfolio    !== undefined) calc.settings.portfolio   = parseFloat(portfolio);
    if (exposureCap  !== undefined) calc.settings.exposureCap = parseFloat(exposureCap);
    if (targetPct    !== undefined) calc.settings.targetPct   = parseFloat(targetPct);
    await saveCalc(calc);
    res.json({ ok: true, settings: calc.settings, summary: calcSummary(calc) });
  } catch(e) {
    console.error('[calc/settings] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Log a new trade leg
// Body: { city, strategy ('1'|'2'|'3'), side ('YES'|'NO'), bracketLabel, stake, entryPriceCents, session ('asian'|'eu'|'us') }
app.post('/calc/trades', async (req, res) => {
  try {
    const { city, strategy, side, bracketLabel, stake, entryPriceCents, session } = req.body;
    if (!city || !strategy || !side || !stake || !entryPriceCents) {
      return res.status(400).json({ error: 'city, strategy, side, stake, entryPriceCents required' });
    }
    if (session && !['asian','eu','us'].includes(session)) {
      return res.status(400).json({ error: 'session must be asian, eu, or us' });
    }
    const calc = await loadCalc();
    const trade = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
      city, strategy, side, bracketLabel: bracketLabel || '',
      stake: parseFloat(stake),
      entryPriceCents: parseFloat(entryPriceCents),
      session: session || null, // 'asian' | 'eu' | 'us' | null (unassigned)
      status: 'open', // open | WIN | LOSS | CASHOUT
      cashoutPriceCents: null,
      sastDate: todaySAST(),
      openedAt: new Date().toISOString(),
      settledAt: null,
    };
    calc.trades.unshift(trade);
    await saveCalc(calc);
    res.json({ ok: true, trade, summary: calcSummary(calc) });
  } catch(e) {
    console.error('[calc/trades POST] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Settle a trade: WIN, LOSS, or CASHOUT (needs cashoutPriceCents)
app.post('/calc/trades/:id/settle', async (req, res) => {
  try {
    const { outcome, cashoutPriceCents } = req.body;
    if (!['WIN','LOSS','CASHOUT'].includes(outcome)) return res.status(400).json({ error: 'outcome must be WIN, LOSS, or CASHOUT' });
    if (outcome === 'CASHOUT' && !cashoutPriceCents) return res.status(400).json({ error: 'cashoutPriceCents required for CASHOUT' });

    const calc = await loadCalc();
    const trade = calc.trades.find(t => t.id === req.params.id);
    if (!trade) return res.status(404).json({ error: 'trade not found' });

    trade.status = outcome;
    if (outcome === 'CASHOUT') trade.cashoutPriceCents = parseFloat(cashoutPriceCents);
    trade.settledAt = new Date().toISOString();
    trade.profit = computeProfit(trade);
    await saveCalc(calc);
    res.json({ ok: true, trade, summary: calcSummary(calc) });
  } catch(e) {
    console.error('[calc/trades settle] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Reassign a trade's session after the fact (in case it was logged unassigned or wrong)
app.post('/calc/trades/:id/session', async (req, res) => {
  try {
    const { session } = req.body;
    if (!['asian','eu','us'].includes(session)) return res.status(400).json({ error: 'session must be asian, eu, or us' });
    const calc = await loadCalc();
    const trade = calc.trades.find(t => t.id === req.params.id);
    if (!trade) return res.status(404).json({ error: 'trade not found' });
    trade.session = session;
    await saveCalc(calc);
    res.json({ ok: true, trade, summary: calcSummary(calc) });
  } catch(e) {
    console.error('[calc/trades session] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Delete a trade (mistakes / duplicate entry)
app.delete('/calc/trades/:id', async (req, res) => {
  try {
    const calc = await loadCalc();
    calc.trades = calc.trades.filter(t => t.id !== req.params.id);
    await saveCalc(calc);
    res.json({ ok: true, summary: calcSummary(calc) });
  } catch(e) {
    console.error('[calc/trades DELETE] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Batch weather + stability for the opportunity scanner (reuses the same
// cache as /weather/:station — this just loops it for many stations at once
// instead of the front-end firing 26 separate requests).
app.post('/weather/batch', async (req, res) => {
  const { stations } = req.body;
  if (!stations || !Array.isArray(stations)) return res.status(400).json({ error: 'stations array required' });

  const results = await Promise.allSettled(stations.map(async raw => {
    const station = raw.toUpperCase();
    if (CACHE[station] && (Date.now() - CACHE[station].ts) < CACHE_TTL) {
      return { station, data: CACHE[station].data, cached: true };
    }
    const data = await fetchStation(station);
    CACHE[station] = { data, ts: Date.now() };
    return { station, data, cached: false };
  }));

  const out = {};
  results.forEach((r, i) => {
    const station = stations[i].toUpperCase();
    if (r.status === 'fulfilled') out[station] = r.value.data;
    else out[station] = { error: r.reason?.message || 'failed' };
  });
  res.json(out);
});


// ── STATIONEDGE V1 ──────────────────────────────────────────────────────────
// Separate page and API. This does not use Weather Underground and does not
// alter the calculator. Phase 1 reads exact station observations from the
// NOAA Aviation Weather Center, with HKO official open data for Hong Kong.
const STATIONEDGE_STATIONS = {
  HKO:  { city:'Hong Kong',     station:'Hong Kong Observatory', tz:'Asia/Hong_Kong', source:'hko' },
  NZWN: { city:'Wellington',    station:'Wellington Intl',       tz:'Pacific/Auckland', source:'metar' },
  RJTT: { city:'Tokyo',         station:'Haneda Airport',        tz:'Asia/Tokyo', source:'metar' },
  RKSI: { city:'Seoul',         station:'Incheon Intl',          tz:'Asia/Seoul', source:'metar' },
  RKPK: { city:'Busan',         station:'Gimhae Intl',           tz:'Asia/Seoul', source:'metar' },
  EGLC: { city:'London',        station:'London City Airport',   tz:'Europe/London', source:'metar' },
  EDDM: { city:'Munich',        station:'Munich Airport',        tz:'Europe/Berlin', source:'metar' },
  EHAM: { city:'Amsterdam',     station:'Schiphol Airport',      tz:'Europe/Amsterdam', source:'metar' },
  EFHK: { city:'Helsinki',      station:'Helsinki-Vantaa',       tz:'Europe/Helsinki', source:'metar' },
  KLGA: { city:'New York',      station:'LaGuardia Airport',     tz:'America/New_York', source:'metar' },
  KLAX: { city:'Los Angeles',   station:'Los Angeles Intl',      tz:'America/Los_Angeles', source:'metar' },
  KSFO: { city:'San Francisco', station:'San Francisco Intl',    tz:'America/Los_Angeles', source:'metar' },
  KSEA: { city:'Seattle',       station:'Seattle-Tacoma Intl',   tz:'America/Los_Angeles', source:'metar' },
  LLBG: { city:'Tel Aviv',      station:'Ben Gurion Airport',    tz:'Asia/Jerusalem', source:'metar' },
  LTFM: { city:'Istanbul',      station:'Istanbul Airport',      tz:'Europe/Istanbul', source:'metar' },
  KATL: { city:'Atlanta',       station:'Hartsfield-Jackson Intl', tz:'America/New_York', source:'metar' },
  KAUS: { city:'Austin',        station:'Austin-Bergstrom Intl', tz:'America/Chicago', source:'metar' },
  KORD: { city:'Chicago',       station:"O'Hare Intl",           tz:'America/Chicago', source:'metar' },
  KDAL: { city:'Dallas',        station:'Dallas Love Field',     tz:'America/Chicago', source:'metar' },
  KBKF: { city:'Denver',        station:'Buckley SFB',           tz:'America/Denver', source:'metar', lockWindow:[13,15] },
  KHOU: { city:'Houston',       station:'William P. Hobby Airport', tz:'America/Chicago', source:'metar', lockWindow:[13,15] },
  KMIA: { city:'Miami',         station:'Miami Intl',            tz:'America/New_York', source:'metar', lockWindow:[13,15] },
  WSSS: { city:'Singapore',     station:'Changi Airport',        tz:'Asia/Singapore', source:'metar' },
};
// ── STATIONEDGE SUPABASE RESEARCH RECORDER ────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || null;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || null;

// Continuous forecast-trail snapshot — a NEW, separate table from the one
// above. seSaveForecastResearch only fires once/day inside the 11:00-13:00
// window on green setups (that's its whole job: a single clean research
// lock). This writes on EVERY sweep cycle, unconditionally, for every
// station regardless of stability/pattern/time — so we get a real
// timestamped trail of how the model's own forecast moved through the day,
// for charting alongside the observed temperature curve. Wrapped in its own
// try/catch and called separately from seSaveForecastResearch so a failure
// here can never affect the existing research lock or the engine itself.
async function seSaveForecastSnapshot(data) {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !data?.highForecast) return false;
  const hf = data.highForecast;
  const row = {
    station_code: data.code,
    city: data.city,
    forecast_date: data.localDay,
    snapshot_at: new Date().toISOString(),
    predicted_low_c: hf.predictedLowC,
    predicted_high_c: hf.predictedHighC,
    barbell_one: hf.primaryOutcomesC?.[0] ?? null,
    barbell_two: hf.primaryOutcomesC?.[1] ?? null,
    confidence: hf.confidence ?? null,
  };
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/stationedge_snapshots`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(row)
    });
    if (!response.ok) {
      console.error('[StationEdge Snapshot] Save failed:', await response.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error('[StationEdge Snapshot] Supabase error:', e.message);
    return false;
  }
}

async function seSaveForecastResearch(data) {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !data?.highForecast) return false;

  const meta = STATIONEDGE_STATIONS[data.code];
  if (!meta) return false;

  const localHour = seLocalHour(meta);

  // Pre-peak research signal window: 11:00–12:59 station local time.
  if (localHour < 11 || localHour >= 13) return false;

  // Record only green setups.
  if (data.stability < 70 || data.pattern < 70) return false;

  const hf = data.highForecast;
  const row = {
    station_code: data.code,
    city: data.city,
    forecast_date: data.localDay,
    local_signal_time: `${String(localHour).padStart(2, '0')}:00`,
    model_version: 'V2',
    forecast_low: hf.predictedLowC,
    forecast_high: hf.predictedHighC,
    barbell_one: hf.primaryOutcomesC?.[0] ?? null,
    barbell_two: hf.primaryOutcomesC?.[1] ?? null,
    confidence: hf.confidence,
    stability: data.stability,
    pattern_day: data.pattern,
    validation_score: hf.validation?.score ?? null,
    probability_ladder: hf.probabilityLadder ?? null,
    weather_snapshot: {
      driftC: hf.driftC,
      driftStatus: hf.driftStatus,
      heatingTrack: hf.heatingTrack,
      signalWindow: hf.signalWindow,
      officialForecastHighC: hf.officialForecastHighC,
      latest: data.latest,
      stabilityParts: data.stabilityParts,
      patternParts: data.patternParts
    }
  };

  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/stationedge_forecasts?on_conflict=station_code,forecast_date,model_version`,
      {
        method: 'POST',
        headers: {
          apikey: SUPABASE_SECRET_KEY,
          Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=ignore-duplicates'
        },
        body: JSON.stringify(row)
      }
    );

    if (!response.ok) {
      console.error('[StationEdge Research] Save failed:', await response.text());
      return false;
    }

    console.log(`[StationEdge Research] Recorded ${data.city} ${data.code} — ${hf.primaryOutcomesC?.join('/')}°C`);
    return true;
  } catch (e) {
    console.error('[StationEdge Research] Supabase error:', e.message);
    return false;
  }
}

async function seResearchSweep() {
  console.log('[StationEdge Research] Automatic sweep started');
  const codes = Object.keys(STATIONEDGE_STATIONS);

  for (const code of codes) {
    try {
      // Clear only StationEdge cache so the research sweep evaluates fresh station data.
      delete STATIONEDGE_CACHE[code];
      const data = await seStation(code);
      await seSaveForecastResearch(data);
      // Additive only — never lets a snapshot failure touch the sweep above.
      try { await seSaveForecastSnapshot(data); }
      catch (e) { console.error(`[StationEdge Snapshot] ${code} failed:`, e.message); }
    } catch (e) {
      console.error(`[StationEdge Research] ${code} sweep failed:`, e.message);
    }
  }
}

const STATIONEDGE_CACHE = {};
const STATIONEDGE_TTL = 5 * 60 * 1000;

function seNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function seSpreadScore(values, good, bad) {
  const a = values.filter(v => Number.isFinite(v));
  if (a.length < 3) return 50;
  const spread = Math.max(...a) - Math.min(...a);
  if (spread <= good) return 100;
  if (spread >= bad) return 0;
  return Math.round(100 * (bad - spread) / (bad - good));
}
function seRegime(o) {
  const wx = String(o.weather || '').toUpperCase();
  const cloud = String(o.clouds || '').toUpperCase();
  if (/(TS|SH|RA|DZ)/.test(wx)) return 'RAIN';
  if (/(FG|BR)/.test(wx)) return 'FOG/MIST';
  if (/(OVC|BKN)/.test(cloud)) return 'CLOUDY';
  if (/SCT/.test(cloud)) return 'PARTLY CLOUDY';
  if (/(FEW|SKC|CLR)/.test(cloud)) return 'CLEAR';
  return 'UNKNOWN';
}
function seScores(obs, forecast='') {
  const recent = obs.slice(-12);
  const stabilityParts = {
    dewpoint: seSpreadScore(recent.slice(-8).map(o => o.dewpointC), 1, 6),
    humidity: seSpreadScore(recent.slice(-8).map(o => o.humidityPct), 8, 35),
    pressure: seSpreadScore(recent.slice(-8).map(o => o.pressureHpa), 2, 10),
    wind: seSpreadScore(recent.slice(-8).map(o => o.windSpeedKt), 5, 25),
  };
  const stability = Math.round(Object.values(stabilityParts).reduce((a,b)=>a+b,0)/4);
  const regimes = recent.map(seRegime).filter(x => x !== 'UNKNOWN');
  let changes = 0;
  for (let i=1;i<regimes.length;i++) if (regimes[i] !== regimes[i-1]) changes++;
  const markers = (String(forecast).match(/\b(TEMPO|BECMG|PROB\d*)\b/g) || []).length;
  const pattern = regimes.length ? Math.max(0, 100 - changes*12 - Math.min(markers,4)*7) : 50;
  const dominant = regimes.length
    ? [...new Set(regimes)].sort((a,b)=>regimes.filter(x=>x===b).length-regimes.filter(x=>x===a).length)[0]
    : 'UNKNOWN';
  return { stability, stabilityParts, pattern, patternParts:{ dominant, changes, markers } };
}
function seState(meta, obs) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', {timeZone:meta.tz, hour:'2-digit', hour12:false}).format(new Date()));
  if (hour < 9) return 'TOO EARLY';
  if (hour < 11) return 'BUILDING';
  if (hour >= 17) return 'TOO LATE';
  const temps = obs.slice(-4).map(o=>o.temperatureC).filter(Number.isFinite);
  if (temps.length >= 3) {
    const delta = temps.at(-1) - temps[0];
    if (delta > 0.5) return 'TRADE WINDOW';
    if (delta <= -0.5) return 'PEAK RISK';
  }
  return 'PEAK APPROACH';
}
async function seFetchMetar(code) {
  const url = `https://aviationweather.gov/api/data/metar?ids=${encodeURIComponent(code)}&format=json&hours=24`;
  const r = await fetch(url, { headers:{'User-Agent':'PolyScan-StationEdge/1.0'} });
  if (!r.ok) throw new Error(`AWC METAR ${code}: HTTP ${r.status}`);
  const rows = await r.json();
  return rows.map(x => {
    const temp = seNum(x.temp), dew = seNum(x.dewp);
    let rh = null;
    if (temp !== null && dew !== null) {
      rh = Math.round(100 * Math.exp((17.625*dew)/(243.04+dew) - (17.625*temp)/(243.04+temp)));
    }
    return {
      observedAt: new Date((seNum(x.obsTime) || Date.now()/1000) * 1000).toISOString(),
      temperatureC: temp, dewpointC: dew, humidityPct: rh,
      pressureHpa: seNum(x.altim), windDirDeg: seNum(x.wdir), windSpeedKt: seNum(x.wspd),
      clouds: Array.isArray(x.clouds) ? x.clouds.map(c=>`${c.cover||''}${c.base||''}`).join(' ') : '',
      weather: x.wxString || '', raw: x.rawOb || '', source:'NOAA AWC METAR'
    };
  }).sort((a,b)=>new Date(a.observedAt)-new Date(b.observedAt));
}
async function seFetchTaf(code) {
  const r = await fetch(`https://aviationweather.gov/api/data/taf?ids=${encodeURIComponent(code)}&format=json`, { headers:{'User-Agent':'PolyScan-StationEdge/1.0'} });
  if (!r.ok) return '';
  const rows = await r.json();
  return rows?.[0]?.rawTAF || '';
}
function seDewpoint(temp, rh) {
  if (!Number.isFinite(temp) || !Number.isFinite(rh) || rh <= 0) return null;
  const a=17.625,b=243.04, alpha=Math.log(rh/100)+(a*temp)/(b+temp);
  return b*alpha/(a-alpha);
}
async function seFetchHko() {
  const base='https://data.weather.gov.hk/weatherAPI/opendata/weather.php';
  const r=await fetch(`${base}?dataType=rhrread&lang=en`);
  if (!r.ok) throw new Error(`HKO current: HTTP ${r.status}`);
  const x=await r.json();
  const find=(rows,name)=>seNum((rows||[]).find(v=>v.place===name)?.value);
  const temp=find(x.temperature?.data,'Hong Kong Observatory');
  const rh=find(x.humidity?.data,'Hong Kong Observatory');
  const obs=[{
    observedAt:x.updateTime || new Date().toISOString(), temperatureC:temp,
    dewpointC:seDewpoint(temp,rh), humidityPct:rh, pressureHpa:null,
    windDirDeg:null, windSpeedKt:null, clouds:'', weather:'', raw:JSON.stringify(x),
    source:'HKO Open Data'
  }];
  const fr=await fetch(`${base}?dataType=flw&lang=en`);
  const fx=fr.ok ? await fr.json() : {};
  const forecast=[fx.generalSituation,fx.forecastDesc,fx.outlook].filter(Boolean).join(' | ');
  return {obs, forecast};
}

function seLocalHour(meta) {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone:meta.tz, hour:'2-digit', hour12:false
  }).format(new Date()));
}
function seForecastTemps(forecast) {
  // TAF temperature groups such as TX30/1412Z. Do not treat unrelated TAF
  // numbers as temperatures.
  const vals = [];
  for (const m of String(forecast||'').matchAll(/\bTX(M?\d{2})\/\d{4}Z/g)) {
    vals.push(Number(m[1].replace('M','-')));
  }
  return vals.filter(Number.isFinite);
}
function seObsLocalHour(meta, observedAt) {
  return Number(new Intl.DateTimeFormat('en-GB',{timeZone:meta.tz,hour:'2-digit',hour12:false}).format(new Date(observedAt)));
}
// StationEdge's own code for Hong Kong is 'HKO'; the shared official-source
// routing elsewhere in this file (fetchOfficialForecast, STATION_META) keys
// it as 'VHHH' (the actual ICAO/resolution station code). This just maps
// between the two so StationEdge can reuse that existing infrastructure
// instead of re-implementing it.
function seOfficialLookupCode(code) { return code === 'HKO' ? 'VHHH' : code; }

// Resolves TODAY'S full daily high from a real forecast source — not the
// TAF's TX/TN group (US-format only, absent from most international TAFs,
// which was silently degrading this to a same-hour extrapolation for every
// non-US station) and not a third-party aggregator. Priority:
//   1. The national agency's own forecast (NWS/HKO/NEA/DWD) where wired.
//   2. MET Norway (api.met.no) — a national meteorological institute, not a
//      third-party site — used as the fallback for every other station,
//      taking the max of today's hourly temperatures it publishes.
// This is a forecast (a projection of where the day is headed), as opposed
// to "nowcasting" — very-short-range (0–2hr) extrapolation from current
// observations, which is what aviation TAF amendments and METAR trends are
// closer to. The old current+remaining-hours heuristic below is kept only
// as a same-hour nowcast floor, never as the primary daily-high signal.
const SE_OFFICIAL_HIGH_CACHE = {};
const SE_OFFICIAL_HIGH_TTL = 30 * 60 * 1000;
async function seOfficialDailyHighC(code) {
  const cached = SE_OFFICIAL_HIGH_CACHE[code];
  if (cached && (Date.now() - cached.ts) < SE_OFFICIAL_HIGH_TTL) return cached.data;
  const lookupCode = seOfficialLookupCode(code);
  const meta = STATION_META[lookupCode];
  let result = { highC: null, source: null };
  try {
    if (OFFICIAL_SOURCE_WIRED.has(lookupCode)) {
      const off = await fetchOfficialForecast(lookupCode);
      if (Number.isFinite(off.highC)) result = { highC: off.highC, source: `official:${off.source}` };
    }
    if (result.highC === null && meta) {
      const mn = await fetchHourlyMetNo(code, meta, null);
      const temps = (mn.rows || []).map(r => r.tempC).filter(Number.isFinite);
      if (temps.length) result = { highC: Math.max(...temps), source: 'official:met-norway' };
    }
  } catch (e) {
    console.error(`[StationEdge] Official forecast fetch failed for ${code}:`, e.message);
  }
  SE_OFFICIAL_HIGH_CACHE[code] = { data: result, ts: Date.now() };
  return result;
}

function seForecastCore(meta,obs,forecast,scores,hourOverride=null,officialHighC=null) {
  const temps=obs.map(o=>o.temperatureC).filter(Number.isFinite); if(!temps.length)return null;
  const current=temps.at(-1), observedMax=Math.max(...temps), recent=temps.slice(-4);
  const rise=recent.length>1?recent.at(-1)-recent[0]:0, hour=hourOverride??seLocalHour(meta);
  const latest=obs.at(-1)||{}, regime=seRegime(latest), tx=seForecastTemps(forecast), tafHigh=tx.length?Math.max(...tx):null;
  // Same-hour nowcast floor only — a short extrapolation of current
  // conditions, used to make sure the model never predicts a high BELOW
  // where the station already sits right now. This is not the day's
  // forecast; officialHighC (a real agency source) is.
  let remaining=hour<9?4:hour<11?3:hour<13?2:hour<15?1:0;
  if(rise>1.5)remaining+=1; if(rise<0)remaining-=.5;
  if(['CLOUDY','RAIN','FOG/MIST'].includes(regime))remaining-=.75;
  if(Number.isFinite(latest.humidityPct)&&latest.humidityPct>=80)remaining-=.5;
  if(Number.isFinite(latest.dewpointC)&&current-latest.dewpointC>=8)remaining+=.25;
  if(Number.isFinite(latest.windSpeedKt)&&latest.windSpeedKt>=20)remaining-=.25;
  remaining=Math.max(0,remaining);
  const nowcastFloor=Math.max(observedMax,current+remaining);
  let centre;
  if (officialHighC !== null) {
    // The real forecast leads; the nowcast floor only pulls it up if the
    // station has already observed something hotter than the forecast
    // expected (forecast running cold today).
    centre = Math.max(officialHighC, nowcastFloor*.15 + officialHighC*.85);
  } else if (tafHigh !== null) {
    centre = Math.max(observedMax, nowcastFloor*.35 + tafHigh*.65);
  } else {
    centre = nowcastFloor; // last resort — no real forecast source reachable
  }
  centre=Math.max(observedMax,centre);
  return{centre,current,observedMax,rise,hour,tafHigh,officialHighC,regime,latest};
}
function seProbabilityLadder(centre,scores,core) {
  const base=scores.stability*.45+scores.pattern*.45; let sigma=base>=80?.85:base>=70?1.05:1.35;
  if(['RAIN','FOG/MIST'].includes(core.regime))sigma+=.25; if(Math.abs(core.rise)>2)sigma+=.15;
  let ladder=[]; for(let t=Math.floor(centre)-3;t<=Math.ceil(centre)+3;t++)ladder.push({temperatureC:t,weight:Math.exp(-.5*Math.pow((t-centre)/sigma,2))});
  const total=ladder.reduce((a,x)=>a+x.weight,0);
  ladder=ladder.map(x=>({temperatureC:x.temperatureC,probability:Math.round(x.weight/total*100)}));
  ladder.sort((a,b)=>b.probability-a.probability); ladder[0].probability+=100-ladder.reduce((a,x)=>a+x.probability,0); ladder.sort((a,b)=>a.temperatureC-b.temperatureC);
  let pair=null; for(let i=0;i<ladder.length-1;i++){const score=ladder[i].probability+ladder[i+1].probability;if(!pair||score>pair.score)pair={score,outcomes:[ladder[i].temperatureC,ladder[i+1].temperatureC]};}
  const primary=new Set(pair.outcomes);
  ladder=ladder.map(x=>({...x,classification:primary.has(x.temperatureC)?'YES BARBELL':x.probability<=5?'STRONG NO CANDIDATE':x.probability<=12?'NO CANDIDATE':'WATCH / EDGE RISK'}));
  return{ladder,primaryOutcomesC:pair.outcomes,pairProbability:pair.score};
}
function seValidation(meta,obs,core,scores){
  const x=core.latest,c=[],add=(name,ok,detail)=>c.push({name,ok,detail});
  add('Temperature track',core.rise>=-.5,core.rise>.5?'HEATING':core.rise<-.5?'WEAKENING':'STEADY');
  add('Dew point',Number.isFinite(x.dewpointC),Number.isFinite(x.dewpointC)?`${x.dewpointC.toFixed(1)}°C`:'NO DATA');
  add('Humidity',!Number.isFinite(x.humidityPct)||x.humidityPct<85,Number.isFinite(x.humidityPct)?`${x.humidityPct}%`:'NO DATA');
  add('Cloud regime',!['RAIN','FOG/MIST'].includes(core.regime),core.regime);
  add('Wind',!Number.isFinite(x.windSpeedKt)||x.windSpeedKt<25,Number.isFinite(x.windSpeedKt)?`${x.windSpeedKt} kt`:'NO DATA');
  add('Pattern day',scores.pattern>=70,`${scores.pattern}%`); add('Stability',scores.stability>=70,`${scores.stability}%`);
  const score=Math.round(c.reduce((a,x)=>a+(x.ok?1:0),0)/c.length*100);
  return{score,status:score>=70?'SUPPORTED':score>=50?'WEAKENING':'BREAKING',checks:c};
}
async function seHighForecast(code,meta,obs,forecast,scores){
  const official=await seOfficialDailyHighC(code);
  const core=seForecastCore(meta,obs,forecast,scores,null,official.highC); if(!core)return null;
  const p=seProbabilityLadder(core.centre,scores,core),validation=seValidation(meta,obs,core,scores);
  const signalObs=obs.filter(o=>seObsLocalHour(meta,o.observedAt)<=11), ss=seScores(signalObs,forecast);
  const sc=signalObs.length?seForecastCore(meta,signalObs,forecast,ss,11,official.highC):null, sp=sc?seProbabilityLadder(sc.centre,ss,sc):null;
  const initial=sp?.primaryOutcomesC||null,current=p.primaryOutcomesC,drift=initial?((current[0]+current[1])/2)-((initial[0]+initial[1])/2):0;
  const hour=core.hour,signalWindow=hour<9?'COLLECTING DATA':hour<11?'BUILDING FORECAST':hour<13?'PRIMARY SIGNAL WINDOW':hour<14?'LATE SIGNAL / DRIFT MONITOR':'NO NEW SIGNAL';
  let confidence=Math.round(scores.stability*.35+scores.pattern*.35+validation.score*.2+(official.highC!==null?10:core.tafHigh!==null?7:4)); confidence=Math.max(25,Math.min(95,confidence));
  return{predictedLowC:current[0],predictedHighC:current[1],primaryOutcomesC:current,confidence,signalWindow,validation,probabilityLadder:p.ladder,pairProbability:p.pairProbability,initialSignalOutcomesC:initial,driftC:Number(drift.toFixed(1)),driftStatus:drift>=.75?'UPWARD DRIFT':drift<=-.75?'DOWNWARD DRIFT':'STABLE',heatingTrack:validation.status==='SUPPORTED'?'ON FORECAST':validation.status==='WEAKENING'?'WATCH':'OFF FORECAST',officialForecastHighC:official.highC??core.tafHigh,officialForecastSource:official.source,model:'StationEdge High Engine V2'};
}

async function seStation(code) {
  const meta=STATIONEDGE_STATIONS[code];
  if (!meta) throw new Error('Unknown StationEdge station');
  const cached=STATIONEDGE_CACHE[code];
  if (cached && Date.now()-cached.ts < STATIONEDGE_TTL) return cached.data;
  let obs=[], forecast='';
  if (meta.source === 'hko') ({obs,forecast}=await seFetchHko());
  else { obs=await seFetchMetar(code); forecast=await seFetchTaf(code); }
  // Use only the station's current LOCAL calendar day for daily-high analysis.
  const localDayKey = (dateValue) => new Intl.DateTimeFormat('en-CA', {
    timeZone: meta.tz, year:'numeric', month:'2-digit', day:'2-digit'
  }).format(new Date(dateValue));
  const todayKey = localDayKey(new Date());
  const todayObs = obs.filter(o => localDayKey(o.observedAt) === todayKey);

  const scores=seScores(todayObs,forecast);
  const temps=todayObs.map(o=>o.temperatureC).filter(Number.isFinite);
  const highForecast=await seHighForecast(code,meta,todayObs,forecast,scores);
  const data={code,...meta, observations:todayObs, forecast, latest:todayObs.at(-1)||null,
    observedMax:temps.length?Math.max(...temps):null, localDay:todayKey, ...scores,
    highForecast,
    tradeable:scores.stability>=70 && scores.pattern>=70, state:highForecast?.tradeWindow||seState(meta,todayObs)};
  STATIONEDGE_CACHE[code]={ts:Date.now(),data};
  return data;
}
// ── STATIONEDGE V3 — FORWARD-TEST PREDICTION ENGINE ────────────────────────
// V3 does not replace the V2 research engine above (that keeps running
// untouched, writing model_version:'V2' rows). V3 is a separate, simplified
// layer: it reduces the same internal engine's output down to exactly two
// temperature outcomes with probabilities, locks ONE prediction per
// station/day between 11:00–12:59 local station time (regardless of
// stability/pattern scores — we want ALL 15 cities forward-tested), and
// later resolves it against the actual observed high.
const SE_V3_MODEL_VERSION = 'V3-FORWARD';

// Accumulates HKO's daily high in-memory across sweeps, since the HKO Open
// Data feed only returns the CURRENT reading (no historical series like
// METAR does). This is a best-effort stand-in until a dedicated HKO
// historical scraper exists — it resets on server restart, same tradeoff as
// the existing DAILY_HIGHS tracker elsewhere in this file.
const SE_HKO_DAILY = {}; // { 'YYYY-MM-DD': { maxC, lastObservedAt } }

function seIsUsStation(code) {
  return /^K[A-Z0-9]{3}$/.test(code || '');
}
function seNativeUnit(code) {
  return seIsUsStation(code) ? 'F' : 'C';
}
function seToNative(tempC, unit) {
  if (!Number.isFinite(tempC)) return null;
  return unit === 'F' ? Math.round(tempC * 9 / 5 + 32) : Math.round(tempC);
}

// Reduces the existing internal forecast engine's output (probability
// ladder, primary barbell pair) to exactly two native-unit outcomes with
// probabilities. All the dew point / cloud / TAF / pattern analysis stays
// internal — this is the only place V3 looks at it, and only to read the
// two numbers it needs.
function seBuildV3Outcomes(data) {
  const hf = data.highForecast;
  if (!hf || !Array.isArray(hf.primaryOutcomesC) || hf.primaryOutcomesC.length < 2) return null;
  const unit = seNativeUnit(data.code);
  const [c1, c2] = hf.primaryOutcomesC;
  const findProb = (tC) => hf.probabilityLadder?.find(x => x.temperatureC === tC)?.probability ?? null;
  let outcomeOne = seToNative(c1, unit);
  let outcomeTwo = seToNative(c2, unit);
  if (outcomeOne === null || outcomeTwo === null) return null;
  if (outcomeOne === outcomeTwo) outcomeTwo += 1; // unit conversion collapsed two Celsius steps into one native step
  return {
    unit,
    outcomeOne, outcomeTwo,
    outcomeOneProbability: findProb(c1),
    outcomeTwoProbability: findProb(c2),
    pairProbability: hf.pairProbability ?? null,
  };
}

async function seSupabaseRequest(pathAndQuery, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) return null;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!r.ok) {
    console.error('[StationEdge V3] Supabase request failed:', r.status, await r.text());
    return null;
  }
  const text = await r.text();
  return text ? JSON.parse(text) : true;
}

// Locks the first V3 prediction for a station/day. Relies on the same
// (station_code, forecast_date, model_version) unique constraint as V2 —
// Prefer: resolution=ignore-duplicates means a second attempt later in the
// 11:00–12:59 window (or from another sweep) is silently dropped, never
// overwriting the locked row. No stability/pattern gate: every station is
// forward-tested every day.
async function seLockV3Prediction(data) {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) return false;
  const meta = STATIONEDGE_STATIONS[data.code];
  if (!meta) return false;
  const localHour = seLocalHour(meta);
  const [winStart, winEnd] = meta.lockWindow || [11, 13]; // end is exclusive
  if (localHour < winStart || localHour >= winEnd) return false;

  const outcomes = seBuildV3Outcomes(data);
  if (!outcomes) return false;

  const row = {
    station_code: data.code,
    city: data.city,
    forecast_date: data.localDay,
    local_signal_time: `${String(localHour).padStart(2, '0')}:00`,
    model_version: SE_V3_MODEL_VERSION,
    display_unit: outcomes.unit,
    outcome_one: outcomes.outcomeOne,
    outcome_two: outcomes.outcomeTwo,
    outcome_one_probability: outcomes.outcomeOneProbability,
    outcome_two_probability: outcomes.outcomeTwoProbability,
    pair_probability: outcomes.pairProbability,
    stability_score: Number.isFinite(data.stability) ? Math.round(data.stability) : null,
    pattern_score: Number.isFinite(data.pattern) ? Math.round(data.pattern) : null,
    result: null,
  };

  const res = await seSupabaseRequest(
    `stationedge_forecasts?on_conflict=station_code,forecast_date,model_version`,
    {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates' },
      body: JSON.stringify(row),
    }
  );
  if (res) console.log(`[StationEdge V3] Locked ${data.city} ${data.code} ${data.localDay} — ${outcomes.outcomeOne}/${outcomes.outcomeTwo}${outcomes.unit}`);
  return !!res;
}

// Pulls the direct-station actual high for a given local calendar day.
// METAR stations: filter the already-fetched 24h observation window to that
// local date and take the max. HKO: use the in-memory daily accumulator
// (see note above — best-effort until a dedicated historical scraper).
async function seActualHighC(code, forecastDate) {
  const meta = STATIONEDGE_STATIONS[code];
  if (!meta) return null;
  if (meta.source === 'hko') {
    return SE_HKO_DAILY[forecastDate]?.maxC ?? null;
  }
  const obs = await seFetchMetar(code);
  const localDayKey = (dateValue) => new Intl.DateTimeFormat('en-CA', {
    timeZone: meta.tz, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(dateValue));
  const dayTemps = obs.filter(o => localDayKey(o.observedAt) === forecastDate)
    .map(o => o.temperatureC).filter(Number.isFinite);
  return dayTemps.length ? Math.max(...dayTemps) : null;
}

// Resolves any locked-but-unresolved V3 predictions once it's safe to do so
// (station's local day has moved past the forecast date, or it's late —
// 20:00+ local — in the forecast date itself, i.e. well after the normal
// daily-high peak).
// Polymarket's US daily-high markets resolve in 2°F-wide buckets anchored on
// even numbers (88-89, 90-91, 92-93, 94-95...) — not single-degree exactness.
// So a 95°F prediction and a 94°F actual are the SAME winning outcome. This
// returns the low edge of the bucket a given whole-degree F reading falls
// into; two readings are "the same bucket" iff this returns the same value
// for both.
function sePolymarketBucketLowF(tempF) {
  const mod = ((tempF % 2) + 2) % 2;
  return tempF - mod;
}
function seSameOutcome(actualNative, predictedNative, unit) {
  if (unit === 'F') return sePolymarketBucketLowF(actualNative) === sePolymarketBucketLowF(predictedNative);
  return actualNative === predictedNative; // non-US markets: no confirmed bucket convention, keep exact match
}

// Drift-cover rule for the forward-test book. A forecast that misses its locked
// pair may still resolve HIT when the day lands immediately outside the pair in
// the implicated drift zone. We only allow this on a weak signal structure
// (stability or pattern below 70), matching the observed drift-alert condition.
// Tolerance: <=1°C outside the pair; US markets <=3°F. Larger moves remain MISS.
function seDriftAlertFromSignalTime(value) {
  const m = String(value || '').match(/\|DRIFT:([+-])([0-9.]+)@([0-9]{2}:[0-9]{2})/);
  return m ? { direction: m[1] === '+' ? 1 : -1, magnitude: Number(m[2]), time: m[3] } : null;
}
function seDriftCoveredHit(row, actualNative, unit) {
  if (![actualNative, row.outcome_one, row.outcome_two].every(Number.isFinite)) return false;
  const low = Math.min(row.outcome_one, row.outcome_two), high = Math.max(row.outcome_one, row.outcome_two);
  const outsideDistance = actualNative < low ? low - actualNative : actualNative > high ? actualNative - high : 0;
  const actualDirection = actualNative < low ? -1 : actualNative > high ? 1 : 0;
  if (!outsideDistance || !actualDirection) return false;
  const tolerance = unit === 'F' ? 3 : 1;
  if (outsideDistance > tolerance) return false;

  const alert = seDriftAlertFromSignalTime(row.local_signal_time);
  if (alert) {
    // Drift can be monitored/locked until 20:00, but the special
    // drift-covered HIT rule remains restricted to alerts raised in the
    // original 11:00-12:59 trade-protection window.
    const alertHour = Number(String(alert.time || '').split(':')[0]);
    const inProtectionWindow = Number.isFinite(alertHour) && alertHour >= 11 && alertHour < 13;
    return inProtectionWindow && alert.direction === actualDirection && alert.magnitude <= tolerance;
  }

  // Legacy V3 rows pre-date persisted drift markers. Preserve the existing
  // forward-test book by applying the discovered weak-structure proxy only to
  // those rows; every new row is judged from an actual 11:00-12:59 alert marker.
  return (Number.isFinite(row.stability_score) && row.stability_score < 70) ||
    (Number.isFinite(row.pattern_score) && row.pattern_score < 70);
}

function seV3Result(row, actualNative, unit) {
  const directHit = seSameOutcome(actualNative, row.outcome_one, unit) || seSameOutcome(actualNative, row.outcome_two, unit);
  const driftHit = !directHit && seDriftCoveredHit(row, actualNative, unit);
  return { result: directHit || driftHit ? 'HIT' : 'MISS', driftHit };
}

// Persist the first qualifying drift alert inside local_signal_time so no
// Supabase schema migration is required. Example: 11:00|DRIFT:+1@12:15.
async function seRecordV3DriftAlert(data) {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !data?.highForecast) return;
  const meta = STATIONEDGE_STATIONS[data.code]; if (!meta) return;
  const hour = seLocalHour(meta);
  // Drift locking/monitoring is active only from 11:00 until the 20:00
  // local resolution sweep for this station.
  if (hour < 11 || hour >= 20) return;
  const unit = seNativeUnit(data.code);
  const driftNative = unit === 'F' ? data.highForecast.driftC * 9 / 5 : data.highForecast.driftC;
  const tolerance = unit === 'F' ? 3 : 1;
  if (!Number.isFinite(driftNative) || Math.abs(driftNative) < 0.5 || Math.abs(driftNative) > tolerance) return;
  const rows = await seSupabaseRequest(`stationedge_forecasts?station_code=eq.${encodeURIComponent(data.code)}&forecast_date=eq.${encodeURIComponent(data.localDay)}&model_version=eq.${SE_V3_MODEL_VERSION}&select=local_signal_time&limit=1`);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row || String(row.local_signal_time || '').includes('|DRIFT:')) return;
  const localTime = new Intl.DateTimeFormat('en-GB',{timeZone:meta.tz,hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date());
  const marker = `${row.local_signal_time || String(hour).padStart(2,'0')+':00'}|DRIFT:${driftNative > 0 ? '+' : '-'}${Math.abs(driftNative).toFixed(unit === 'F' ? 1 : 1)}@${localTime}`;
  await seSupabaseRequest(`stationedge_forecasts?station_code=eq.${encodeURIComponent(data.code)}&forecast_date=eq.${encodeURIComponent(data.localDay)}&model_version=eq.${SE_V3_MODEL_VERSION}`, { method:'PATCH', body:JSON.stringify({ local_signal_time: marker }) });
  console.log(`[StationEdge V3] Drift alert persisted ${data.code} ${data.localDay} — ${marker}`);
}

async function seResolveV3Predictions() {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) return;
  const pending = await seSupabaseRequest(
    `stationedge_forecasts?model_version=eq.${SE_V3_MODEL_VERSION}&result=is.null&select=station_code,city,forecast_date,outcome_one,outcome_two,display_unit,stability_score,pattern_score,local_signal_time`
  );
  if (!Array.isArray(pending) || !pending.length) return;

  for (const row of pending) {
    try {
      const meta = STATIONEDGE_STATIONS[row.station_code];
      if (!meta) continue;
      const todayLocal = new Intl.DateTimeFormat('en-CA', { timeZone: meta.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const localHour = seLocalHour(meta);
      const dayHasPassed = todayLocal !== row.forecast_date;
      const lateInDay = todayLocal === row.forecast_date && localHour >= 20;
      if (!dayHasPassed && !lateInDay) continue;

      const actualC = await seActualHighC(row.station_code, row.forecast_date);
      if (actualC === null) continue; // data not available yet — retry next sweep

      const unit = row.display_unit || seNativeUnit(row.station_code);
      const actualNative = seToNative(actualC, unit);
      const verdict = seV3Result(row, actualNative, unit);
      const result = verdict.result;
      const error = Math.min(Math.abs(actualNative - row.outcome_one), Math.abs(actualNative - row.outcome_two));

      await seSupabaseRequest(
        `stationedge_forecasts?station_code=eq.${encodeURIComponent(row.station_code)}&forecast_date=eq.${encodeURIComponent(row.forecast_date)}&model_version=eq.${SE_V3_MODEL_VERSION}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            actual_high: actualNative,
            result,
            forecast_error: error,
            resolved_at: new Date().toISOString(),
          }),
        }
      );
      console.log(`[StationEdge V3] Resolved ${row.city} ${row.station_code} ${row.forecast_date} — ${result}${verdict.driftHit ? ' [DRIFT-COVERED]' : ''} (actual ${actualNative}${unit}, error ${error})`);
    } catch (e) {
      console.error(`[StationEdge V3] Resolve failed for ${row.station_code}:`, e.message);
    }
  }
}

// One pass over all 15 stations: track HKO's running daily high, then
// attempt to lock a V3 prediction if we're in the signal window.
async function seV3Sweep() {
  for (const code of Object.keys(STATIONEDGE_STATIONS)) {
    try {
      const data = await seStation(code);
      if (STATIONEDGE_STATIONS[code].source === 'hko' && Number.isFinite(data.latest?.temperatureC)) {
        const key = data.localDay;
        const prev = SE_HKO_DAILY[key]?.maxC;
        SE_HKO_DAILY[key] = { maxC: prev === undefined ? data.latest.temperatureC : Math.max(prev, data.latest.temperatureC), lastObservedAt: data.latest.observedAt };
        // Trim old days so this doesn't grow forever.
        for (const k of Object.keys(SE_HKO_DAILY)) if (k !== key) delete SE_HKO_DAILY[k];
      }
      await seLockV3Prediction(data);
      await seRecordV3DriftAlert(data);
    } catch (e) {
      console.error(`[StationEdge V3] Sweep failed for ${code}:`, e.message);
    }
  }
  await seResolveV3Predictions();
}

// One-time fix-up: re-scores every already-resolved V3 row against the
// correct Polymarket bucket logic above. Needed because rows resolved
// before this fix used exact-degree matching and may have wrongly recorded
// a MISS where the actual high shared a bucket with a predicted outcome.
// Safe to call more than once — it only re-derives result/error from the
// actual_high and outcomes already stored, nothing else changes.
app.get('/api/stationedge/rescore', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) return res.status(503).json({ error: 'Supabase not configured' });
  const rows = await seSupabaseRequest(
    `stationedge_forecasts?model_version=eq.${SE_V3_MODEL_VERSION}&result=not.is.null&select=station_code,forecast_date,display_unit,outcome_one,outcome_two,actual_high,result,stability_score,pattern_score,local_signal_time`
  );
  if (!Array.isArray(rows)) return res.status(502).json({ error: 'Could not load rows to rescore' });

  let corrected = 0;
  for (const row of rows) {
    if (!Number.isFinite(row.actual_high)) continue;
    const unit = row.display_unit || seNativeUnit(row.station_code);
    const correctResult = seV3Result(row, row.actual_high, unit).result;
    if (correctResult === row.result) continue;
    const error = Math.min(Math.abs(row.actual_high - row.outcome_one), Math.abs(row.actual_high - row.outcome_two));
    await seSupabaseRequest(
      `stationedge_forecasts?station_code=eq.${encodeURIComponent(row.station_code)}&forecast_date=eq.${encodeURIComponent(row.forecast_date)}&model_version=eq.${SE_V3_MODEL_VERSION}`,
      { method: 'PATCH', body: JSON.stringify({ result: correctResult, forecast_error: error }) }
    );
    corrected++;
  }
  res.json({ checked: rows.length, corrected });
});

app.get('/api/stationedge/audit', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }
  const rows = await seSupabaseRequest(
    `stationedge_forecasts?model_version=eq.${SE_V3_MODEL_VERSION}&select=*&order=forecast_date.desc,city.asc`
  );
  if (!Array.isArray(rows)) return res.status(502).json({ error: 'Could not load StationEdge audit data' });

  const enrichedRows = rows.map(r => {
    const driftAlert = seDriftAlertFromSignalTime(r.local_signal_time);
    const unit = r.display_unit || (SE_US_CODES.has(r.station_code) ? 'F' : 'C');
    const driftHit = r.result === 'HIT' && Number.isFinite(r.actual_high)
      ? (!seSameOutcome(r.actual_high, r.outcome_one, unit) &&
         !seSameOutcome(r.actual_high, r.outcome_two, unit) &&
         seDriftCoveredHit(r, r.actual_high, unit))
      : false;
    return {
      ...r,
      tz: STATIONEDGE_STATIONS[r.station_code]?.tz || null,
      driftAlertMagnitude: driftAlert?.magnitude ?? null,
      driftAlertDirection: driftAlert?.direction ?? null,
      driftAlertTime: driftAlert?.time ?? null,
      driftAlertForecastDate: driftAlert ? r.forecast_date : null,
      resolution_type: driftHit ? 'DRIFT_COVERED_HIT' : (r.result || 'PENDING')
    };
  });

  // Attach the LIVE drift reading (how far today's running forecast has moved
  // since the 11am-ish signal) so it's visible on the Forward Test card
  // without having to click into Live Monitor. Only fetched once per unique
  // station, not per historical row.
  const uniqueCodes = [...new Set(rows.map(r => r.station_code))];
  const driftByCode = {};
  await Promise.all(uniqueCodes.map(async code => {
    try {
      const data = await seStation(code);
      if (data?.highForecast) {
        driftByCode[code] = {
          driftC: data.highForecast.driftC,
          driftStatus: data.highForecast.driftStatus,
          heatingTrack: data.highForecast.heatingTrack,
          signalWindow: data.highForecast.signalWindow,
        };
      }
    } catch (e) { /* leave drift missing for this station rather than fail the whole response */ }
  }));
  for (const r of enrichedRows) {
    Object.assign(r, driftByCode[r.station_code] || {});
    // A persisted qualifying alert is historical evidence. Never replace it
    // visually with the station's current live drift after the row resolves.
    if (Number.isFinite(r.driftAlertMagnitude) && r.driftAlertDirection) {
      r.savedDrift = r.driftAlertDirection * r.driftAlertMagnitude;
      r.savedDriftStatus = r.driftAlertDirection > 0 ? 'UPWARD DRIFT' : 'DOWNWARD DRIFT';
    }
  }

  const resolved = rows.filter(r => r.result === 'HIT' || r.result === 'MISS');
  const hits = resolved.filter(r => r.result === 'HIT').length;
  const misses = resolved.filter(r => r.result === 'MISS').length;
  const errors = resolved.map(r => r.forecast_error).filter(Number.isFinite);
  const avgError = errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : null;

  res.json({
    totalPredictions: rows.length,
    resolvedPredictions: resolved.length,
    hits,
    misses,
    pairHitRate: resolved.length ? Math.round((hits / resolved.length) * 100) : null,
    averageError: avgError === null ? null : Math.round(avgError * 100) / 100,
    records: enrichedRows,
  });
});

app.get('/stationedge', (req,res) => res.sendFile(path.join(__dirname,'public','stationedge.html')));
app.get('/api/stationedge/stations', async (req,res) => {
  const codes=Object.keys(STATIONEDGE_STATIONS);
  const settled=await Promise.allSettled(codes.map(seStation));
  res.json(settled.map((x,i)=>x.status==='fulfilled'?x.value:{code:codes[i],...STATIONEDGE_STATIONS[codes[i]],error:x.reason?.message||'failed'}));
});
// Separate from fetchPolymarketEvent on purpose — that function and its cache
// are keyed by city name only and used everywhere same-day trading depends
// on. This fetches an arbitrary days-ahead event under its OWN cache key, so
// it can never collide with or slow down the existing same-day engine.
const POLY_ADVANCE_CACHE = {};
async function fetchPolymarketEventForDate(cityName, daysAhead) {
  const cacheKey = `${cityName}::${daysAhead}`;
  if (POLY_ADVANCE_CACHE[cacheKey] && (Date.now() - POLY_ADVANCE_CACHE[cacheKey].ts) < POLY_CACHE_TTL) {
    return POLY_ADVANCE_CACHE[cacheKey].data;
  }
  const eventSlug = buildEventSlug(cityName, daysAhead);
  if (!eventSlug) return null;
  try {
    const url = `https://gamma-api.polymarket.com/events?slug=${eventSlug}`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' }, timeout: 8000 });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json || !json.length) return null;
    const event = json[0];
    const markets = event.markets || [];
    const outcomes = markets.map(m => {
      let yesProb = null;
      try {
        const prices = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
        yesProb = prices && prices[0] ? Math.round(parseFloat(prices[0]) * 100) : null;
      } catch(e) {}
      return { bracket: m.groupItemTitle || m.question || '', slug: m.slug || '', prob: yesProb, volume: m.volume ? parseFloat(m.volume).toFixed(0) : '0' };
    }).filter(o => o.prob !== null);
    const data = { eventSlug, title: event.title || '', outcomes, volume: event.volume ? parseFloat(event.volume).toFixed(0) : '0' };
    POLY_ADVANCE_CACHE[cacheKey] = { data, ts: Date.now() };
    return data;
  } catch (e) {
    console.error(`[Advance Scan] ${cityName} +${daysAhead}d fetch failed:`, e.message);
    return null;
  }
}

app.get('/api/stationedge/advance-scan', async (req, res) => {
  try {
    const daysAhead = Math.max(1, Math.min(7, parseInt(req.query.daysAhead) || 2));
    const MIN_LEG_CENTS = 20, MAX_COMBINED_CENTS = 80;
    const cities = [...new Set(Object.values(STATIONEDGE_STATIONS).map(m => m.city))];

    const results = await Promise.all(cities.map(async city => {
      const data = await fetchPolymarketEventForDate(city, daysAhead);
      if (!data || !data.outcomes.length) return null;
      const top3 = data.outcomes.filter(o => Number.isFinite(o.prob)).sort((a,b) => b.prob - a.prob).slice(0, 3);
      if (top3.length < 3) return null;
      const combined = top3.reduce((s,o) => s + o.prob, 0);
      const allAbove20 = top3.every(o => o.prob > MIN_LEG_CENTS);
      if (!allAbove20 || combined > MAX_COMBINED_CENTS) return null;
      const code = Object.entries(STATIONEDGE_STATIONS).find(([,m]) => m.city === city)?.[0] || null;
      return { city, code, daysAhead, brackets: top3, combined, eventSlug: data.eventSlug };
    }));

    res.json({ daysAhead, minLegCents: MIN_LEG_CENTS, maxCombinedCents: MAX_COMBINED_CENTS, matches: results.filter(Boolean) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stationedge/station/:code', async (req,res) => {
  try { res.json(await seStation(String(req.params.code).toUpperCase())); }
  catch(e) { res.status(500).json({error:e.message}); }
});
// Today's forecast-trail snapshots for one station — how the model's own
// prediction moved through the day, for charting against observed temps.
// Read-only; does not touch the engine or the once-daily research lock.
app.get('/api/stationedge/snapshots/:code', async (req, res) => {
  try {
    const code = String(req.params.code).toUpperCase();
    const meta = STATIONEDGE_STATIONS[code];
    if (!meta) return res.status(404).json({ error: 'Unknown StationEdge station' });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: meta.tz, year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
    const rows = await seSupabaseRequest(
      `stationedge_snapshots?station_code=eq.${code}&forecast_date=eq.${today}&select=snapshot_at,predicted_low_c,predicted_high_c,barbell_one,barbell_two,confidence&order=snapshot_at.asc`
    );
    res.json(rows || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Automatic StationEdge research collection.
// Render/Uptime Robot keeps the service awake; this sweep evaluates all stations
// every 15 minutes and Supabase's unique key locks the first qualifying V2 signal.
setTimeout(() => seResearchSweep().catch(e =>
  console.error('[StationEdge Research] Initial sweep failed:', e.message)
), 30 * 1000);

setInterval(() => seResearchSweep().catch(e =>
  console.error('[StationEdge Research] Scheduled sweep failed:', e.message)
), 15 * 60 * 1000);

// StationEdge V3 forward-test engine — separate schedule, offset from the V2
// sweep above so the two don't hammer the upstream APIs at the exact same
// second. Runs all 15 stations, locks predictions in the 11:00–12:59 local
// window, and resolves any predictions whose station-day has ended.
setTimeout(() => seV3Sweep().catch(e =>
  console.error('[StationEdge V3] Initial sweep failed:', e.message)
), 45 * 1000);

setInterval(() => seV3Sweep().catch(e =>
  console.error('[StationEdge V3] Scheduled sweep failed:', e.message)
), 15 * 60 * 1000);

app.get('/health', (req, res) => {
  res.json({ status:'ok', uptime: process.uptime(), cached: Object.keys(CACHE).length, polyCached: Object.keys(POLY_CACHE).length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PolyScan 24/7 by Willow running on port ${PORT}`));
