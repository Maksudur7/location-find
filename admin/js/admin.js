/* ═════════════════════════════════════════════════════════
   ADMIN.JS — Dashboard Logic
   Auth guard, data fetch, table render, map, search, export
   ═════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ── Auth Guard ──────────────────────────────────────────
  const token = localStorage.getItem('_admin_token');
  if (!token) { window.location.href = '/admin'; return; }

  const AUTH = { headers: { Authorization: `Bearer ${token}` } };

  // ── State ───────────────────────────────────────────────
  let allVisitors = [];
  let mapInstance = null;
  let mapMarkers  = [];
  let miniMapInstance = null;
  let currentView = 'overview';
  let refreshInterval = null;

  // ── DOM Refs ────────────────────────────────────────────
  const views      = { overview: 'view-overview', visitors: 'view-visitors', map: 'view-map' };
  const navLinks   = document.querySelectorAll('.sb-link[data-view]');
  const sidebarEl  = document.getElementById('sidebar');
  const mainEl     = document.querySelector('.dash-main');
  const pageTitle  = document.getElementById('page-title');

  // ════════════════════════════════════════════════════════
  //  NAVIGATION
  // ════════════════════════════════════════════════════════
  function switchView(view) {
    currentView = view;
    Object.entries(views).forEach(([k, id]) => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('hidden', k !== view);
    });
    navLinks.forEach(l => l.classList.toggle('active', l.dataset.view === view));
    const titles = { overview: 'Overview', visitors: 'All Visitors', map: 'Map View' };
    if (pageTitle) pageTitle.textContent = titles[view] || view;

    if (view === 'map') {
      initMap();
      setTimeout(() => {
        if (mapInstance) mapInstance.invalidateSize();
      }, 150);
    }
  }

  navLinks.forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      switchView(link.dataset.view);
    });
  });

  // Sidebar toggle
  const sbToggle = document.getElementById('sidebar-toggle');
  if (sbToggle) {
    sbToggle.addEventListener('click', () => {
      sidebarEl.classList.toggle('collapsed');
      mainEl.classList.toggle('expanded');
    });
  }

  // Overview "See All"
  const seeAllBtn = document.getElementById('ov-see-all-btn');
  if (seeAllBtn) seeAllBtn.addEventListener('click', () => switchView('visitors'));

  // Logout
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      localStorage.removeItem('_admin_token');
      window.location.href = '/admin';
    });
  }

  // ════════════════════════════════════════════════════════
  //  DATA FETCH
  // ════════════════════════════════════════════════════════
  async function fetchStats() {
    try {
      const res  = await fetch('/api/admin/stats', AUTH);
      if (res.status === 401 || res.status === 403) {
        localStorage.removeItem('_admin_token');
        window.location.href = '/admin';
        return;
      }
      const data = await res.json();
      setText('stat-total',     data.total);
      setText('stat-gps',       data.withGPS);
      setText('stat-today',     data.today);
      setText('stat-countries', data.countries);
    } catch { /* silent */ }
  }

  async function fetchVisitors() {
    try {
      const res = await fetch('/api/admin/visitors', AUTH);
      if (!res.ok) {
        localStorage.removeItem('_admin_token');
        window.location.href = '/admin';
        return;
      }
      allVisitors = await res.json();
      renderOverviewTable();
      renderVisitorsTable(filteredVisitors());
      refreshMapMarkers();
      updateLastRefresh();
    } catch { /* silent */ }
  }

  function updateLastRefresh() {
    const el = document.getElementById('last-refresh');
    if (el) el.textContent = 'Refreshed just now';
  }

  // ════════════════════════════════════════════════════════
  //  RENDERING
  // ════════════════════════════════════════════════════════
  function formatTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return d.toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });
  }

  function safe(val, fallback = '—') {
    return val !== null && val !== undefined && val !== '' ? val : fallback;
  }

  function renderOverviewTable() {
    const tbody = document.getElementById('overview-tbody');
    if (!tbody) return;
    const rows = allVisitors.slice(0, 10);
    tbody.innerHTML = rows.length ? rows.map(v => `
      <tr data-id="${v.id}" class="row-click">
        <td>${formatTime(v.visit_time)}</td>
        <td>${safe(v.ip_address)}</td>
        <td>${safe(v.country_code)} ${safe(v.country)}</td>
        <td>${safe(v.city)}</td>
        <td>${v.gps_latitude ? `<span class="badge-gps">✓ GPS</span>` : '<span class="badge-nogps">No GPS</span>'}</td>
        <td>${safe(v.device_type)}</td>
        <td>${safe(v.browser)} ${safe(v.browser_ver, '')}</td>
      </tr>
    `).join('') : '<tr><td colspan="7" class="loading-row">No visitors yet</td></tr>';

    attachRowClicks(tbody);
  }

  function renderVisitorsTable(data) {
    const tbody  = document.getElementById('visitors-tbody');
    const countEl = document.getElementById('vis-count');
    if (!tbody) return;
    if (countEl) countEl.textContent = data.length;

    tbody.innerHTML = data.length ? data.map(v => `
      <tr data-id="${v.id}" class="row-click">
        <td title="${v.visit_time}">${formatTime(v.visit_time)}</td>
        <td>${safe(v.ip_address)}</td>
        <td>${safe(v.country_code)} ${safe(v.country)}</td>
        <td>${safe(v.region)}</td>
        <td>${safe(v.city)}</td>
        <td>${v.gps_latitude  ? v.gps_latitude.toFixed(5)  : '—'}</td>
        <td>${v.gps_longitude ? v.gps_longitude.toFixed(5) : '—'}</td>
        <td>${v.gps_accuracy  ? Math.round(v.gps_accuracy) + 'm' : '—'}</td>
        <td title="${safe(v.full_address)}">${v.full_address ? v.full_address.slice(0, 40) + '…' : '—'}</td>
        <td>${safe(v.isp)}</td>
        <td>${safe(v.device_type)}</td>
        <td>${safe(v.os)} ${safe(v.os_ver, '')}</td>
        <td>${safe(v.browser)} ${safe(v.browser_ver, '')}</td>
        <td>${safe(v.language)}</td>
        <td>${safe(v.screen_res)}</td>
        <td><button class="btn-delete" data-id="${v.id}">Delete</button></td>
      </tr>
    `).join('') : '<tr><td colspan="16" class="loading-row">No visitors found</td></tr>';

    attachRowClicks(tbody);
    attachDeleteButtons(tbody);
  }

  function attachRowClicks(tbody) {
    tbody.querySelectorAll('tr.row-click').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.classList.contains('btn-delete')) return;
        const id = row.dataset.id;
        const v  = allVisitors.find(x => x.id === id);
        if (v) showModal(v);
      });
    });
  }

  function attachDeleteButtons(tbody) {
    tbody.querySelectorAll('.btn-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        if (!confirm('Delete this visitor record?')) return;
        try {
          await fetch(`/api/admin/visitors/${id}`, { method: 'DELETE', ...AUTH });
          allVisitors = allVisitors.filter(v => v.id !== id);
          renderOverviewTable();
          renderVisitorsTable(filteredVisitors());
          refreshMapMarkers();
        } catch { alert('Failed to delete'); }
      });
    });
  }

  // ════════════════════════════════════════════════════════
  //  DETAIL MODAL
  // ════════════════════════════════════════════════════════
  function showModal(v) {
    const modal  = document.getElementById('detail-modal');
    const body   = document.getElementById('modal-body');
    if (!modal || !body) return;

    if (miniMapInstance) {
      try { miniMapInstance.remove(); } catch {}
      miniMapInstance = null;
    }

    const hasGPS = v.gps_latitude && v.gps_longitude;

    body.innerHTML = `
      <div class="mb-field"><span class="mb-label">Visit Time</span><span class="mb-val">${formatTime(v.visit_time)}</span></div>
      <div class="mb-field"><span class="mb-label">IP Address</span><span class="mb-val">${safe(v.ip_address)}</span></div>
      <div class="mb-field"><span class="mb-label">Country</span><span class="mb-val">${safe(v.country_code)} ${safe(v.country)}</span></div>
      <div class="mb-field"><span class="mb-label">Region</span><span class="mb-val">${safe(v.region)}</span></div>
      <div class="mb-field"><span class="mb-label">City</span><span class="mb-val">${safe(v.city)}</span></div>
      <div class="mb-field"><span class="mb-label">Postal</span><span class="mb-val">${safe(v.postal)}</span></div>
      <div class="mb-field"><span class="mb-label">IP Latitude</span><span class="mb-val">${safe(v.latitude)}</span></div>
      <div class="mb-field"><span class="mb-label">IP Longitude</span><span class="mb-val">${safe(v.longitude)}</span></div>
      <div class="mb-field"><span class="mb-label">GPS Latitude</span><span class="mb-val">${hasGPS ? v.gps_latitude.toFixed(7) : '—'}</span></div>
      <div class="mb-field"><span class="mb-label">GPS Longitude</span><span class="mb-val">${hasGPS ? v.gps_longitude.toFixed(7) : '—'}</span></div>
      <div class="mb-field"><span class="mb-label">GPS Accuracy</span><span class="mb-val">${v.gps_accuracy ? Math.round(v.gps_accuracy) + ' m' : '—'}</span></div>
      <div class="mb-field"><span class="mb-label">Timezone</span><span class="mb-val">${safe(v.timezone)}</span></div>
      <div class="mb-field"><span class="mb-label">ISP / Org</span><span class="mb-val">${safe(v.isp)}</span></div>
      <div class="mb-field"><span class="mb-label">Device</span><span class="mb-val">${safe(v.device_type)}</span></div>
      <div class="mb-field"><span class="mb-label">OS</span><span class="mb-val">${safe(v.os)} ${safe(v.os_ver, '')}</span></div>
      <div class="mb-field"><span class="mb-label">Browser</span><span class="mb-val">${safe(v.browser)} ${safe(v.browser_ver, '')}</span></div>
      <div class="mb-field"><span class="mb-label">Language</span><span class="mb-val">${safe(v.language)}</span></div>
      <div class="mb-field"><span class="mb-label">Screen</span><span class="mb-val">${safe(v.screen_res)}</span></div>
      <div class="mb-field"><span class="mb-label">Referrer</span><span class="mb-val">${safe(v.referrer)}</span></div>
      <div class="mb-field full"><span class="mb-label">Full Address</span><span class="mb-val">${safe(v.full_address)}</span></div>
      <div class="mb-field full"><span class="mb-label">User Agent</span><span class="mb-val">${safe(v.user_agent)}</span></div>
      ${hasGPS ? `<div class="mb-field full mb-map" id="modal-mini-map"></div>` : ''}
    `;

    modal.style.display = 'flex';

    if (hasGPS) {
      setTimeout(() => {
        const miniMapContainer = document.getElementById('modal-mini-map');
        if (!miniMapContainer) return;
        miniMapInstance = L.map(miniMapContainer, { zoomControl: false, attributionControl: false });
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(miniMapInstance);
        const latlng = [v.gps_latitude, v.gps_longitude];
        miniMapInstance.setView(latlng, 15);
        L.circleMarker(latlng, {
          radius: 8,
          color: '#C9A96E', fillColor: '#C9A96E', fillOpacity: 0.8, weight: 2
        }).addTo(miniMapInstance);
      }, 100);
    }
  }

  document.getElementById('close-modal')?.addEventListener('click', () => {
    document.getElementById('detail-modal').style.display = 'none';
    if (miniMapInstance) { try { miniMapInstance.remove(); } catch {} miniMapInstance = null; }
  });
  document.getElementById('detail-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      e.currentTarget.style.display = 'none';
      if (miniMapInstance) { try { miniMapInstance.remove(); } catch {} miniMapInstance = null; }
    }
  });

  // ════════════════════════════════════════════════════════
  //  MAP VIEW
  // ════════════════════════════════════════════════════════
  function initMap() {
    if (mapInstance) { refreshMapMarkers(); return; }
    mapInstance = L.map('leaflet-map', { attributionControl: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
    }).addTo(mapInstance);
    refreshMapMarkers();
  }

  function refreshMapMarkers() {
    if (!mapInstance) return;
    mapMarkers.forEach(m => m.remove());
    mapMarkers = [];

    const gpsVisitors = allVisitors.filter(v => v.gps_latitude && v.gps_longitude);
    const subtitleEl  = document.getElementById('map-subtitle');
    if (subtitleEl) subtitleEl.textContent = `${gpsVisitors.length} GPS-tracked visitors`;

    gpsVisitors.forEach(v => {
      const marker = L.circleMarker([v.gps_latitude, v.gps_longitude], {
        radius: 7,
        color: '#C9A96E', fillColor: '#C9A96E',
        fillOpacity: 0.85, weight: 2,
      });
      marker.bindPopup(`
        <strong>${safe(v.city)}, ${safe(v.country)}</strong><br>
        <small>IP: ${safe(v.ip_address)}</small><br>
        <small>${safe(v.device_type)} · ${safe(v.browser)}</small><br>
        <small>${formatTime(v.visit_time)}</small>
      `);
      marker.addTo(mapInstance);
      mapMarkers.push(marker);
    });

    if (gpsVisitors.length) {
      const group = L.featureGroup(mapMarkers);
      mapInstance.fitBounds(group.getBounds().pad(0.1));
    } else {
      mapInstance.setView([20, 0], 2);
    }
  }

  // ════════════════════════════════════════════════════════
  //  SEARCH & FILTER
  // ════════════════════════════════════════════════════════
  function filteredVisitors() {
    const search    = (document.getElementById('search-input')?.value || '').toLowerCase();
    const gpsFilter = document.getElementById('filter-gps')?.value || 'all';

    return allVisitors.filter(v => {
      const matchSearch = !search ||
        (v.country      || '').toLowerCase().includes(search) ||
        (v.region       || '').toLowerCase().includes(search) ||
        (v.city         || '').toLowerCase().includes(search) ||
        (v.full_address || '').toLowerCase().includes(search) ||
        (v.ip_address   || '').toLowerCase().includes(search) ||
        (v.isp          || '').toLowerCase().includes(search) ||
        (v.browser      || '').toLowerCase().includes(search) ||
        (v.os           || '').toLowerCase().includes(search);

      const matchGPS =
        gpsFilter === 'all'    ? true :
        gpsFilter === 'gps'    ? !!v.gps_latitude :
        gpsFilter === 'no-gps' ? !v.gps_latitude : true;

      return matchSearch && matchGPS;
    });
  }

  document.getElementById('search-input')?.addEventListener('input', () => {
    renderVisitorsTable(filteredVisitors());
  });
  document.getElementById('filter-gps')?.addEventListener('change', () => {
    renderVisitorsTable(filteredVisitors());
  });

  // ════════════════════════════════════════════════════════
  //  CLEAR ALL
  // ════════════════════════════════════════════════════════
  document.getElementById('clear-all-btn')?.addEventListener('click', async () => {
    if (!confirm('⚠️ This will permanently delete ALL visitor records. Are you sure?')) return;
    try {
      await fetch('/api/admin/visitors', { method: 'DELETE', ...AUTH });
      allVisitors = [];
      renderOverviewTable();
      renderVisitorsTable([]);
      refreshMapMarkers();
      fetchStats();
    } catch { alert('Failed to clear'); }
  });

  // ════════════════════════════════════════════════════════
  //  EXPORT CSV
  // ════════════════════════════════════════════════════════
  document.getElementById('export-btn')?.addEventListener('click', () => {
    const data = currentView === 'visitors' ? filteredVisitors() : allVisitors;
    if (!data.length) { alert('No data to export'); return; }

    const headers = [
      'Visit Time','IP Address','Country','Country Code','Region','City','Postal',
      'IP Latitude','IP Longitude','GPS Latitude','GPS Longitude','GPS Accuracy (m)','Full Address',
      'Timezone','ISP','Device','OS','OS Ver','Browser','Browser Ver',
      'Screen Res','Language','Referrer','User Agent','Page URL'
    ];

    const rows = data.map(v => [
      formatTime(v.visit_time), v.ip_address, v.country, v.country_code, v.region, v.city, v.postal,
      v.latitude, v.longitude, v.gps_latitude, v.gps_longitude, v.gps_accuracy ? Math.round(v.gps_accuracy) : '',
      v.full_address, v.timezone, v.isp, v.device_type, v.os, v.os_ver, v.browser, v.browser_ver,
      v.screen_res, v.language, v.referrer, v.user_agent, v.page_url
    ].map(cell => `"${String(cell || '').replace(/"/g, '""')}"`));

    const csv  = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), {
      href: url, download: `visitors_${new Date().toISOString().slice(0,10)}.csv`
    });
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  });

  // ════════════════════════════════════════════════════════
  //  REFRESH
  // ════════════════════════════════════════════════════════
  document.getElementById('refresh-btn')?.addEventListener('click', () => {
    const btn = document.getElementById('refresh-btn');
    if (btn) btn.style.transform = 'rotate(360deg)';
    setTimeout(() => { if (btn) btn.style.transform = ''; }, 500);
    fetchStats();
    fetchVisitors();
  });

  // Auto-refresh every 30s
  refreshInterval = setInterval(() => {
    fetchStats();
    fetchVisitors();
  }, 30000);

  // ── Helpers ─────────────────────────────────────────────
  function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val !== undefined ? val : '—';
  }

  // ── Init ────────────────────────────────────────────────
  fetchStats();
  fetchVisitors();

})();
