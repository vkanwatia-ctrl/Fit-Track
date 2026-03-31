// ═══════════════════════════════════════════════════
// FitTrack — Strava OAuth2 Backend
// Deploy to Railway, Render, or Fly.io (free tier)
// ═══════════════════════════════════════════════════
//
// SETUP (5 minutes):
//   1. Go to https://www.strava.com/settings/api
//   2. Create an app — any name, set website to your Railway URL
//   3. Set "Authorization Callback Domain" to your Railway domain
//      e.g.  fittrack-abc123.railway.app
//   4. Copy your Client ID and Client Secret
//   5. Deploy this file to Railway with env vars set (see below)
//
// ENV VARS to set in Railway dashboard:
//   STRAVA_CLIENT_ID      = your numeric client ID
//   STRAVA_CLIENT_SECRET  = your client secret string
//   APP_URL               = https://your-app.railway.app
//   SESSION_SECRET        = any long random string
//   FRONTEND_URL          = URL of your FitTrack PWA (for redirect after auth)
// ═══════════════════════════════════════════════════

const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
const session = require('express-session');
const cors    = require('cors');

const app = express();

// ── CONFIG ──────────────────────────────────────────
const PORT                = process.env.PORT               || 3000;
const STRAVA_CLIENT_ID    = process.env.STRAVA_CLIENT_ID   || 'YOUR_CLIENT_ID';
const STRAVA_CLIENT_SECRET= process.env.STRAVA_CLIENT_SECRET|| 'YOUR_CLIENT_SECRET';
const SESSION_SECRET      = process.env.SESSION_SECRET     || crypto.randomBytes(32).toString('hex');
const APP_URL             = process.env.APP_URL            || `http://localhost:${PORT}`;
const FRONTEND_URL        = process.env.FRONTEND_URL       || 'https://your-fittrack-pwa-url.com';

const STRAVA_AUTH_URL     = 'https://www.strava.com/oauth/authorize';
const STRAVA_TOKEN_URL    = 'https://www.strava.com/oauth/token';
const STRAVA_API          = 'https://www.strava.com/api/v3';
const REDIRECT_URI        = `${APP_URL}/auth/strava/callback`;

// ── MIDDLEWARE ───────────────────────────────────────
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 } // 30 days
}));

// ── TOKEN STORE (in-memory — survives restarts via session) ──
// For production, replace with a database
let tokenStore = null; // { access_token, refresh_token, expires_at, athlete }

// ── HEALTH CHECK ─────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    stravaConnected: !!tokenStore && Date.now() < tokenStore.expires_at + 3600000,
    athlete: tokenStore?.athlete ? {
      name: `${tokenStore.athlete.firstname} ${tokenStore.athlete.lastname}`,
      profile: tokenStore.athlete.profile_medium
    } : null,
    timestamp: new Date().toISOString()
  });
});

// ── STEP 1: Kick off Strava OAuth ─────────────────────
app.get('/auth/strava', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;

  const params = new URLSearchParams({
    client_id:     STRAVA_CLIENT_ID,
    redirect_uri:  REDIRECT_URI,
    response_type: 'code',
    approval_prompt: 'auto',          // 'force' to always show consent screen
    scope:         'activity:read_all',
    state:         state
  });

  res.redirect(`${STRAVA_AUTH_URL}?${params}`);
});

// ── STEP 2: Strava redirects back here with code ──────
app.get('/auth/strava/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    console.error('Strava auth error:', error, error_description);
    return res.send(htmlPage('❌ Authorisation Failed',
      `Strava returned: ${error_description || error}`,
      'var(--red)'));
  }

  if (state !== req.session.oauthState) {
    return res.status(400).send(htmlPage('❌ Security Error',
      'State mismatch — possible CSRF. Please try again.',
      'var(--red)'));
  }

  try {
    const r = await axios.post(STRAVA_TOKEN_URL, {
      client_id:     STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      code,
      grant_type:    'authorization_code'
    });

    tokenStore = {
      access_token:  r.data.access_token,
      refresh_token: r.data.refresh_token,
      expires_at:    r.data.expires_at * 1000,   // convert to ms
      athlete:       r.data.athlete
    };

    const name = r.data.athlete?.firstname || 'Athlete';
    console.log(`✅ Strava connected for ${name}`);

    res.send(htmlPage(
      `✅ Connected, ${name}!`,
      'Your Strava account is linked. Close this tab and return to FitTrack — tap ⟳ Sync to pull your runs.',
      'var(--green)'
    ));

  } catch (e) {
    console.error('Token exchange failed:', e.response?.data || e.message);
    res.status(500).send(htmlPage('❌ Token Exchange Failed',
      e.response?.data?.message || e.message,
      'var(--red)'));
  }
});

// ── TOKEN REFRESH HELPER ──────────────────────────────
async function getValidToken() {
  if (!tokenStore) throw new Error('NOT_CONNECTED');

  // If token still valid (with 5 min buffer), return it
  if (Date.now() < tokenStore.expires_at - 300000) {
    return tokenStore.access_token;
  }

  // Refresh
  console.log('Refreshing Strava token...');
  const r = await axios.post(STRAVA_TOKEN_URL, {
    client_id:     STRAVA_CLIENT_ID,
    client_secret: STRAVA_CLIENT_SECRET,
    refresh_token: tokenStore.refresh_token,
    grant_type:    'refresh_token'
  });

  tokenStore.access_token = r.data.access_token;
  tokenStore.refresh_token = r.data.refresh_token || tokenStore.refresh_token;
  tokenStore.expires_at    = r.data.expires_at * 1000;

  return tokenStore.access_token;
}

// ── GET ACTIVITIES (called by FitTrack app) ───────────
// Returns normalised activity list compatible with the app's run log format
app.get('/activities', async (req, res) => {
  try {
    const token   = await getValidToken();
    const perPage = Math.min(parseInt(req.query.limit) || 20, 100);
    const page    = parseInt(req.query.page) || 1;
    // Optional: only fetch activities after a given timestamp
    const after   = req.query.after ? parseInt(req.query.after) : undefined;

    const params = { per_page: perPage, page };
    if (after) params.after = after;

    const r = await axios.get(`${STRAVA_API}/athlete/activities`, {
      headers: { Authorization: `Bearer ${token}` },
      params
    });

    // Normalise to FitTrack format
    const activities = r.data
      .filter(a => ['Run','Trail Run','VirtualRun','Walk','Hike'].includes(a.type))
      .map(a => ({
        id:            a.id,
        name:          a.name,
        type:          a.type,
        date:          a.start_date_local?.split('T')[0],
        dist:          parseFloat((a.distance / 1000).toFixed(2)),     // metres → km
        duration:      Math.round(a.moving_time / 60),                 // seconds → minutes
        pace:          a.average_speed > 0
                         ? formatPace(1000 / a.average_speed)          // m/s → min/km
                         : null,
        elevation:     a.total_elevation_gain ? Math.round(a.total_elevation_gain) : null,
        avgHR:         a.average_heartrate    ? Math.round(a.average_heartrate)    : null,
        maxHR:         a.max_heartrate        ? Math.round(a.max_heartrate)        : null,
        calories:      a.calories             || null,
        kudos:         a.kudos_count          || 0,
        src:           'strava'
      }));

    res.json({ activities, total: activities.length, page });

  } catch (e) {
    if (e.message === 'NOT_CONNECTED') {
      return res.status(401).json({ error: 'Strava not connected', code: 'NOT_CONNECTED' });
    }
    console.error('/activities error:', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// ── GET ATHLETE STATS ─────────────────────────────────
app.get('/athlete', async (req, res) => {
  try {
    const token = await getValidToken();
    const [athlete, stats] = await Promise.all([
      axios.get(`${STRAVA_API}/athlete`,                                     { headers: { Authorization: `Bearer ${token}` } }),
      axios.get(`${STRAVA_API}/athletes/${tokenStore.athlete.id}/stats`,     { headers: { Authorization: `Bearer ${token}` } })
    ]);
    res.json({
      name:          `${athlete.data.firstname} ${athlete.data.lastname}`,
      profile:       athlete.data.profile_medium,
      city:          athlete.data.city,
      totalRunsYTD:  stats.data.ytd_run_totals?.count          || 0,
      totalKmYTD:    ((stats.data.ytd_run_totals?.distance||0) / 1000).toFixed(0),
      totalRunsAll:  stats.data.all_run_totals?.count          || 0,
      totalKmAll:    ((stats.data.all_run_totals?.distance||0) / 1000).toFixed(0),
    });
  } catch (e) {
    if (e.message === 'NOT_CONNECTED') return res.status(401).json({ error: 'NOT_CONNECTED' });
    res.status(500).json({ error: e.message });
  }
});

// ── DISCONNECT ────────────────────────────────────────
app.post('/auth/disconnect', (req, res) => {
  tokenStore = null;
  res.json({ ok: true });
});

// ── HELPERS ───────────────────────────────────────────
function formatPace(secondsPerKm) {
  const m = Math.floor(secondsPerKm / 60);
  const s = Math.round(secondsPerKm % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function htmlPage(title, message, color = 'var(--green)') {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  :root{--bg:#0d0f0f;--green:#4ade80;--red:#f87171;--text:#e8edec;--muted:#8a9e9a}
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:var(--bg);color:var(--text);font-family:-apple-system,sans-serif;
    min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center}
  .box{max-width:340px}
  .icon{font-size:52px;margin-bottom:16px}
  h1{font-size:22px;font-weight:800;color:${color};margin-bottom:10px;letter-spacing:-.5px}
  p{font-size:14px;color:var(--muted);line-height:1.7}
  .btn{display:inline-block;margin-top:20px;padding:12px 24px;background:${color};color:#0d1210;
    border-radius:12px;font-weight:700;font-size:14px;text-decoration:none;cursor:pointer}
</style></head>
<body><div class="box">
  <div class="icon">${color.includes('red') ? '❌' : '🏃'}</div>
  <h1>${title}</h1>
  <p>${message}</p>
  <a class="btn" onclick="window.close()">Close Tab</a>
</div></body></html>`;
}

// ── START ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║   FitTrack · Strava Backend Running    ║
╠════════════════════════════════════════╣
║  Port:     ${String(PORT).padEnd(29)}║
║  APP_URL:  ${APP_URL.slice(0,29).padEnd(29)}║
╠════════════════════════════════════════╣
║  1. Set env vars in Railway            ║
║  2. Visit /auth/strava to connect      ║
║  3. Paste APP_URL into FitTrack app    ║
╚════════════════════════════════════════╝
  `);
});
