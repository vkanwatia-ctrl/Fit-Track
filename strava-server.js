// ═══════════════════════════════════════════════════
// FitTrack — Strava OAuth2 Backend  v2.1
// Deploy to Railway (free tier)
// ═══════════════════════════════════════════════════
//
// ENV VARS (set in Railway dashboard → Variables):
//   STRAVA_CLIENT_ID      numeric ID from strava.com/settings/api
//   STRAVA_CLIENT_SECRET  secret string from strava.com/settings/api
//   APP_URL               https://your-app.railway.app   (your Railway URL)
//   FRONTEND_URL          URL where FitTrack-App.html is hosted
//                         e.g. https://yourname.github.io/fittrack
//                         or   file:// left blank to use a success page
//   SESSION_SECRET        any long random string
// ═══════════════════════════════════════════════════

const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
const session = require('express-session');
const cors    = require('cors');

const app = express();

// ── CONFIG ──────────────────────────────────────────
const PORT                 = process.env.PORT                || 3000;
const STRAVA_CLIENT_ID     = process.env.STRAVA_CLIENT_ID    || 'YOUR_CLIENT_ID';
const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET|| 'YOUR_CLIENT_SECRET';
const SESSION_SECRET       = process.env.SESSION_SECRET      || crypto.randomBytes(32).toString('hex');
const APP_URL              = process.env.APP_URL             || `http://localhost:${PORT}`;
const FRONTEND_URL         = process.env.FRONTEND_URL        || '';   // PWA URL — leave blank to use success page

const STRAVA_AUTH_URL  = 'https://www.strava.com/oauth/authorize';
const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';
const STRAVA_API       = 'https://www.strava.com/api/v3';
const REDIRECT_URI     = `${APP_URL}/auth/strava/callback`;

// ── MIDDLEWARE ───────────────────────────────────────
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

// ── TOKEN STORE (in-memory) ───────────────────────────
// Survives normal use; resets if Railway restarts the container.
// For permanent storage, replace with a small SQLite/Postgres store.
let tokenStore = null;

// ── HEALTH CHECK ─────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    stravaConnected: !!tokenStore && Date.now() < tokenStore.expires_at + 3600000,
    athlete: tokenStore?.athlete
      ? { name: `${tokenStore.athlete.firstname} ${tokenStore.athlete.lastname}`, profile: tokenStore.athlete.profile_medium }
      : null,
    timestamp: new Date().toISOString()
  });
});

// ── STEP 1: Start Strava OAuth ────────────────────────
app.get('/auth/strava', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  const params = new URLSearchParams({
    client_id:       STRAVA_CLIENT_ID,
    redirect_uri:    REDIRECT_URI,
    response_type:   'code',
    approval_prompt: 'auto',
    scope:           'activity:read_all',
    state
  });
  res.redirect(`${STRAVA_AUTH_URL}?${params}`);
});

// ── STEP 2: OAuth Callback ────────────────────────────
app.get('/auth/strava/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    return res.send(htmlPage('❌ Authorisation Failed',
      `Strava returned: ${error_description || error}`, '#f87171'));
  }
  if (state !== req.session.oauthState) {
    return res.status(400).send(htmlPage('❌ Security Error',
      'State mismatch — please try again.', '#f87171'));
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
      expires_at:    r.data.expires_at * 1000,
      athlete:       r.data.athlete
    };

    const name = r.data.athlete?.firstname || 'Athlete';
    console.log(`✅ Strava connected for ${name}`);

    // If FRONTEND_URL is set, redirect back to the PWA with ?strava=connected
    // so FitTrack auto-detects the successful auth and shows a toast.
    if (FRONTEND_URL) {
      const sep = FRONTEND_URL.includes('?') ? '&' : '?';
      return res.redirect(`${FRONTEND_URL}${sep}strava=connected`);
    }

    // Fallback: show a success page with a close-tab button
    res.send(htmlPage(
      `✅ Connected, ${name}!`,
      'Your Strava account is linked. You can close this tab and return to FitTrack — tap ⟳ Sync Now on the Running page.',
      '#4ade80'
    ));

  } catch (e) {
    console.error('Token exchange failed:', e.response?.data || e.message);
    res.status(500).send(htmlPage('❌ Token Exchange Failed',
      e.response?.data?.message || e.message, '#f87171'));
  }
});

// ── TOKEN REFRESH ─────────────────────────────────────
async function getValidToken() {
  if (!tokenStore) throw new Error('NOT_CONNECTED');
  if (Date.now() < tokenStore.expires_at - 300000) return tokenStore.access_token;

  console.log('Refreshing Strava token…');
  const r = await axios.post(STRAVA_TOKEN_URL, {
    client_id:     STRAVA_CLIENT_ID,
    client_secret: STRAVA_CLIENT_SECRET,
    refresh_token: tokenStore.refresh_token,
    grant_type:    'refresh_token'
  });
  tokenStore.access_token  = r.data.access_token;
  tokenStore.refresh_token = r.data.refresh_token || tokenStore.refresh_token;
  tokenStore.expires_at    = r.data.expires_at * 1000;
  return tokenStore.access_token;
}

// ── GET ACTIVITIES ────────────────────────────────────
app.get('/activities', async (req, res) => {
  try {
    const token   = await getValidToken();
    const perPage = Math.min(parseInt(req.query.limit) || 30, 100);
    const page    = parseInt(req.query.page) || 1;
    const after   = req.query.after ? parseInt(req.query.after) : undefined;

    const params = { per_page: perPage, page };
    if (after) params.after = after;

    const r = await axios.get(`${STRAVA_API}/athlete/activities`, {
      headers: { Authorization: `Bearer ${token}` },
      params
    });

    const activities = r.data
      .filter(a => ['Run','Trail Run','VirtualRun','Walk','Hike'].includes(a.type))
      .map(a => ({
        id:        a.id,
        name:      a.name,
        type:      a.type,
        date:      a.start_date_local?.split('T')[0],
        dist:      parseFloat((a.distance / 1000).toFixed(2)),
        duration:  Math.round(a.moving_time / 60),
        pace:      a.average_speed > 0 ? formatPace(1000 / a.average_speed) : null,
        elevation: a.total_elevation_gain ? Math.round(a.total_elevation_gain) : null,
        avgHR:     a.average_heartrate    ? Math.round(a.average_heartrate)   : null,
        maxHR:     a.max_heartrate        ? Math.round(a.max_heartrate)       : null,
        calories:  a.calories || null,
        kudos:     a.kudos_count || 0,
        src:       'strava'
      }));

    res.json({ activities, total: activities.length, page });

  } catch (e) {
    if (e.message === 'NOT_CONNECTED')
      return res.status(401).json({ error: 'Strava not connected', code: 'NOT_CONNECTED' });
    console.error('/activities error:', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// ── ATHLETE STATS ─────────────────────────────────────
app.get('/athlete', async (req, res) => {
  try {
    const token = await getValidToken();
    const [athlete, stats] = await Promise.all([
      axios.get(`${STRAVA_API}/athlete`, { headers: { Authorization: `Bearer ${token}` } }),
      axios.get(`${STRAVA_API}/athletes/${tokenStore.athlete.id}/stats`, { headers: { Authorization: `Bearer ${token}` } })
    ]);
    res.json({
      name:         `${athlete.data.firstname} ${athlete.data.lastname}`,
      profile:      athlete.data.profile_medium,
      city:         athlete.data.city,
      totalRunsYTD: stats.data.ytd_run_totals?.count || 0,
      totalKmYTD:   ((stats.data.ytd_run_totals?.distance || 0) / 1000).toFixed(0),
      totalRunsAll: stats.data.all_run_totals?.count || 0,
      totalKmAll:   ((stats.data.all_run_totals?.distance || 0) / 1000).toFixed(0),
    });
  } catch (e) {
    if (e.message === 'NOT_CONNECTED') return res.status(401).json({ error: 'NOT_CONNECTED' });
    res.status(500).json({ error: e.message });
  }
});

// ── DISCONNECT ────────────────────────────────────────
app.post('/auth/disconnect', (req, res) => {
  tokenStore = null;
  console.log('Strava disconnected');
  res.json({ ok: true });
});

// ── HELPERS ───────────────────────────────────────────
function formatPace(secondsPerKm) {
  const m = Math.floor(secondsPerKm / 60);
  const s = Math.round(secondsPerKm % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function htmlPage(title, message, color = '#4ade80') {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#0d0f0f;color:#e8edec;font-family:-apple-system,sans-serif;
    min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center}
  .box{max-width:340px}
  .icon{font-size:52px;margin-bottom:16px}
  h1{font-size:22px;font-weight:800;color:${color};margin-bottom:12px;letter-spacing:-.5px}
  p{font-size:14px;color:#8a9e9a;line-height:1.75}
  .btn{display:inline-block;margin-top:22px;padding:12px 28px;background:${color};color:#0d1210;
    border-radius:12px;font-weight:700;font-size:14px;text-decoration:none;cursor:pointer;border:none}
</style></head>
<body><div class="box">
  <div class="icon">${color.includes('f87171') ? '❌' : '🏃'}</div>
  <h1>${title}</h1>
  <p>${message}</p>
  <button class="btn" onclick="window.close()">Close Tab</button>
</div></body></html>`;
}

// ── START ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║   FitTrack · Strava Backend  v2.1        ║
╠══════════════════════════════════════════╣
║  Port:         ${String(PORT).padEnd(26)}║
║  APP_URL:      ${(APP_URL).slice(0,26).padEnd(26)}║
║  FRONTEND_URL: ${(FRONTEND_URL||'(not set — success page)').slice(0,26).padEnd(26)}║
╠══════════════════════════════════════════╣
║  Visit /auth/strava to connect           ║
╚══════════════════════════════════════════╝`);
});
