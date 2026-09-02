require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { UAParser } = require('ua-parser-js');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ─────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── NeonDB Pool ────────────────────────────────────────────
const connectionString = process.env.DATABASE_URL;
const pool = new Pool({
  connectionString,
  ssl: {
    rejectUnauthorized: false,
  },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});


// ─── DB Init ────────────────────────────────────────────────
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS visitors (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id    TEXT UNIQUE,
        ip_address    TEXT,
        country       TEXT,
        country_code  TEXT,
        region        TEXT,
        city          TEXT,
        postal        TEXT,
        latitude      DOUBLE PRECISION,
        longitude     DOUBLE PRECISION,
        gps_latitude  DOUBLE PRECISION,
        gps_longitude DOUBLE PRECISION,
        gps_accuracy  DOUBLE PRECISION,
        full_address  TEXT,
        timezone      TEXT,
        isp           TEXT,
        org           TEXT,
        device_type   TEXT,
        browser       TEXT,
        browser_ver   TEXT,
        os            TEXT,
        os_ver        TEXT,
        screen_res    TEXT,
        language      TEXT,
        referrer      TEXT,
        user_agent    TEXT,
        page_url      TEXT,
        visit_time    TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('✅ Database initialized');
  } catch (err) {
    console.error('❌ DB init error:', err.message);
  } finally {
    client.release();
  }
}


// ─── Helper: Get Real IP ─────────────────────────────────────
function getRealIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.connection.remoteAddress ||
    req.socket.remoteAddress ||
    ''
  );
}

// ─── Helper: Fetch IP Info ───────────────────────────────────
async function fetchIPInfo(ip) {
  try {
    const cleanIP = ip.replace('::ffff:', '');
    const fetch = (await import('node-fetch')).default;
    const res = await fetch(`https://ipapi.co/${cleanIP}/json/`);
    if (!res.ok) return {};
    return await res.json();
  } catch {
    return {};
  }
}

// ─── Auth Middleware ─────────────────────────────────────────
function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ error: 'No token' });
  const token = authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.admin = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(403).json({ error: 'Invalid token' });
  }
}

// ═══════════════════════════════════════════════════════════
//  PUBLIC API
// ═══════════════════════════════════════════════════════════

// POST /api/track  — Receive visitor data (UPSERT on session_id)
app.post('/api/track', async (req, res) => {
  try {
    const ip  = getRealIP(req);
    const ua  = req.headers['user-agent'] || '';
    const parser   = new UAParser(ua);
    const uaResult = parser.getResult();
    const body = req.body || {};

    // ── Client sends real geo data (from ipapi.co browser-fetch) ──
    // If client provided geo data use it; else attempt server-side lookup
    // (server-side lookup fails on localhost ::1, so client-side is primary)
    const hasClientGeo = body.country || body.city;
    let ipInfo = {};
    if (!hasClientGeo) {
      ipInfo = await fetchIPInfo(ip);
    }

    const data = {
      session_id:    body.sessionId     || uuidv4(),
      ip_address:    body.clientIP      || ip,
      country:       body.country       || ipInfo.country_name  || null,
      country_code:  body.countryCode   || ipInfo.country_code  || null,
      region:        body.region        || ipInfo.region        || null,
      city:          body.city          || ipInfo.city          || null,
      postal:        body.postal        || ipInfo.postal        || null,
      latitude:      body.ipLat         || ipInfo.latitude      || null,
      longitude:     body.ipLng         || ipInfo.longitude     || null,
      gps_latitude:  body.gpsLat        || null,
      gps_longitude: body.gpsLng        || null,
      gps_accuracy:  body.gpsAccuracy   || null,
      full_address:  body.fullAddress   || null,
      timezone:      body.timezone      || ipInfo.timezone      || null,
      isp:           body.isp           || ipInfo.org           || null,
      org:           body.org           || ipInfo.asn           || null,
      device_type:   uaResult.device.type || 'desktop',
      browser:       uaResult.browser.name    || null,
      browser_ver:   uaResult.browser.version || null,
      os:            uaResult.os.name    || null,
      os_ver:        uaResult.os.version || null,
      screen_res:    body.screenRes     || null,
      language:      body.language      || null,
      referrer:      body.referrer      || null,
      user_agent:    ua,
      page_url:      body.pageUrl       || null,
    };

    // UPSERT — if same session sends GPS update later, it overwrites the row
    await pool.query(`
      INSERT INTO visitors (
        session_id, ip_address, country, country_code, region, city, postal,
        latitude, longitude, gps_latitude, gps_longitude, gps_accuracy, full_address,
        timezone, isp, org, device_type, browser, browser_ver, os, os_ver,
        screen_res, language, referrer, user_agent, page_url
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26
      )
      ON CONFLICT (session_id) DO UPDATE SET
        ip_address    = EXCLUDED.ip_address,
        country       = COALESCE(EXCLUDED.country,       visitors.country),
        country_code  = COALESCE(EXCLUDED.country_code,  visitors.country_code),
        region        = COALESCE(EXCLUDED.region,        visitors.region),
        city          = COALESCE(EXCLUDED.city,          visitors.city),
        postal        = COALESCE(EXCLUDED.postal,        visitors.postal),
        latitude      = COALESCE(EXCLUDED.latitude,      visitors.latitude),
        longitude     = COALESCE(EXCLUDED.longitude,     visitors.longitude),
        gps_latitude  = COALESCE(EXCLUDED.gps_latitude,  visitors.gps_latitude),
        gps_longitude = COALESCE(EXCLUDED.gps_longitude, visitors.gps_longitude),
        gps_accuracy  = COALESCE(EXCLUDED.gps_accuracy,  visitors.gps_accuracy),
        full_address  = COALESCE(EXCLUDED.full_address,  visitors.full_address),
        timezone      = COALESCE(EXCLUDED.timezone,      visitors.timezone),
        isp           = COALESCE(EXCLUDED.isp,           visitors.isp),
        org           = COALESCE(EXCLUDED.org,           visitors.org),
        screen_res    = COALESCE(EXCLUDED.screen_res,    visitors.screen_res),
        language      = COALESCE(EXCLUDED.language,      visitors.language)
    `, Object.values(data));

    res.json({ success: true });
  } catch (err) {
    console.error('Track error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});



// ═══════════════════════════════════════════════════════════
//  ADMIN API
// ═══════════════════════════════════════════════════════════

// POST /api/admin/login
app.post('/api/admin/login', async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });

  const match = password === process.env.ADMIN_PASSWORD;
  if (!match) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '24h' });
  res.json({ token });
});

// GET /api/admin/visitors  — Get all visitors
app.get('/api/admin/visitors', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM visitors ORDER BY visit_time DESC LIMIT 500'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/visitors/:id
app.delete('/api/admin/visitors/:id', authMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM visitors WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/visitors  — Clear all
app.delete('/api/admin/visitors', authMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM visitors');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/stats
app.get('/api/admin/stats', authMiddleware, async (req, res) => {
  try {
    const total = await pool.query('SELECT COUNT(*) FROM visitors');
    const withGPS = await pool.query('SELECT COUNT(*) FROM visitors WHERE gps_latitude IS NOT NULL');
    const today = await pool.query("SELECT COUNT(*) FROM visitors WHERE visit_time >= NOW() - INTERVAL '24 hours'");
    const countries = await pool.query('SELECT COUNT(DISTINCT country) FROM visitors');
    res.json({
      total:    parseInt(total.rows[0].count),
      withGPS:  parseInt(withGPS.rows[0].count),
      today:    parseInt(today.rows[0].count),
      countries: parseInt(countries.rows[0].count),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin page routes
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});
app.get('/admin/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'dashboard.html'));
});
app.use('/admin', express.static(path.join(__dirname, 'admin')));

// ─── Start ───────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
    console.log(`🔒 Admin panel: http://localhost:${PORT}/admin`);
  });
});
