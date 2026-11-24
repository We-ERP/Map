/* =========================================================================
   app.js — منطق التطبيق
   - جلب الحدود والشوارع والمباني من Nominatim و Overpass (OpenStreetMap)
   - توليد تلقائي للقطع الناقصة (Smart Fallback) بخوارزمية مكانية
   - تقسيم المنطقة إلى بلوكات: K-Means + Voronoi مقصوص بحدود المنطقة (Turf.js)
   - الخرائط التفاعلية، لوحة التفاصيل، والبحث الفوري
   ========================================================================= */
'use strict';

/* ---------- Configuration ---------- */
const CONFIG = {
  defaultQuery: 'المرج، القاهرة، مصر',
  defaultLabel: 'المرج - القاهرة',
  // ملفات GeoJSON مُجهّزة مسبقًا عبر fetch_egypt_gis.py (اختياري)
  prebuilt: [{ match: ['المرج'], file: 'data/marg-cairo.geojson' }],
  nominatimUrl: 'https://nominatim.openstreetmap.org/search',
  overpassEndpoints: [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ],
  syntheticSpacingM: 18,   // المسافة بين نقاط توليد القطع على طول الشارع
  sideOffsetM: 11,         // بُعد القطعة عن محور الشارع
  maxSynthetic: 7000,      // سقف القطع المولّدة للحفاظ على الأداء
  houseLabelMinZoom: 17,
  blockCountDefault: 35,
  blockCountMax: 200,
};

const TILE = {
  carto: (dark) => `https://{s}.basemaps.cartocdn.com/${dark ? 'dark_all' : 'light_all'}/{z}/{x}/{y}{r}.png`,
  osm: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  esri: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  esriLabels: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
};

const ATTR = {
  carto: '© OpenStreetMap · © CARTO',
  osm: '© OpenStreetMap contributors',
  esri: 'Tiles © Esri',
};

/* ---------- Utilities ---------- */
const $ = (id) => document.getElementById(id);
const pad2 = (n) => String(n).padStart(2, '0');
const fmtNum = (n) => Number(n || 0).toLocaleString('ar-EG');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const norm = (s) => String(s ?? '')
  .replace(/[\u064B-\u0652]/g, '')
  .replace(/[إأآ]/g, 'ا')
  .replace(/ى/g, 'ي')
  .replace(/ة/g, 'ه')
  .toLowerCase()
  .trim();
const toLatinDigits = (s) => s.replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const tick = () => new Promise((r) => setTimeout(r, 30));
const isDark = () => document.documentElement.dataset.theme !== 'light';

function hashStr(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* ---------- State ---------- */
const state = {
  map: null,
  renderer: null,
  baseLayer: null,
  labelLayer: null,
  layerMode: 'streets',
  area: null,
  blocks: [],
  blockByNum: new Map(),
  blockCount: CONFIG.blockCountDefault,
  colorSeed: 28,
  selectedBlock: null,
  selectedParcel: null,
  layers: { blocks: null, streets: null, parcels: null, labels: null, houses: null },
  searchActions: [],
  introPlayed: false,
  busy: false,
};

/* ---------- Feedback: progress & toast ---------- */
function showProgress(title, pct = 0) {
  $('progressTitle').textContent = title;
  $('progress').hidden = false;
  setProgress(pct, '');
}
function setProgress(pct, text) {
  const p = clamp(Math.round(pct), 0, 100);
  $('progressFill').style.width = `${p}%`;
  $('progressText').textContent = `${text ? text + ' · ' : ''}${p}%`;
}
function hideProgress() {
  $('progress').hidden = true;
}

let toastTimer;
function toast(msg, ms = 3200) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('is-show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('is-show');
    setTimeout(() => { el.hidden = true; }, 350);
  }, ms);
}

/* ---------- Theme & map ---------- */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
  localStorage.setItem('gis-theme', document.documentElement.dataset.theme);
  document.querySelector('meta[name="theme-color"]')
    .setAttribute('content', theme === 'light' ? '#F7F3EA' : '#0E1A24');
  if (state.map) {
    setBasemap(state.layerMode);
    if (state.area) render();
  }
}

function initMap() {
  const map = L.map('map', { zoomControl: false, minZoom: 8, maxZoom: 20, preferCanvas: true });
  map.setView([30.0, 31.3], 13);
  L.control.zoom({ position: 'bottomleft' }).addTo(map);
  L.control.scale({ position: 'bottomleft', imperial: false }).addTo(map);
  state.map = map;
  state.renderer = L.canvas({ padding: 0.4 });
  setBasemap(state.layerMode);
  map.on('moveend', updateHouseLabels);
}

function setBasemap(mode) {
  state.layerMode = mode;
  const m = state.map;
  if (state.baseLayer) m.removeLayer(state.baseLayer);
  if (state.labelLayer) m.removeLayer(state.labelLayer);

  const opts = { maxZoom: 20, maxNativeZoom: 19, crossOrigin: true };
  let base;
  let labels = null;

  if (mode === 'streets') {
    base = L.tileLayer(TILE.carto(isDark()), { ...opts, subdomains: 'abcd', attribution: ATTR.carto });
  } else if (mode === 'osm') {
    base = L.tileLayer(TILE.osm, { ...opts, attribution: ATTR.osm });
  } else {
    base = L.tileLayer(TILE.esri, { ...opts, attribution: ATTR.esri });
    if (mode === 'hybrid') labels = L.tileLayer(TILE.esriLabels, { ...opts, attribution: '' });
  }

  base.addTo(m);
  if (labels) labels.addTo(m);
  state.baseLayer = base;
  state.labelLayer = labels;

  document.querySelectorAll('#layerSegment button').forEach((b) => {
    const on = b.dataset.layer === mode;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-checked', String(on));
  });
}

/* ---------- Boot ---------- */
function init() {
  applyTheme(localStorage.getItem('gis-theme') || 'dark');
  initMap();
  bindUI();
  document.querySelectorAll('.preset').forEach((b) =>
    b.classList.toggle('is-active', +b.dataset.count === state.blockCount));
  $('blockCountChip').textContent = `${state.blockCount} بلوك`;
  loadArea(CONFIG.defaultQuery, CONFIG.defaultLabel);
}

function bindUI() {
  $('searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('areaInput').value.trim();
    if (!q) return toast('اكتب اسم المنطقة أولاً');
    loadArea(q, q);
  });

  $('themeBtn').addEventListener('click', () => applyTheme(isDark() ? 'light' : 'dark'));
  $('panelToggle').addEventListener('click', () => $('panel').classList.toggle('is-hidden'));

  document.querySelectorAll('.preset').forEach((btn) =>
    btn.addEventListener('click', () => setBlockCount(+btn.dataset.count)));
  $('applyCount').addEventListener('click', () => setBlockCount(+$('customCount').value));
  $('customCount').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); setBlockCount(+e.target.value); }
  });

  $('colorSeed').addEventListener('input', debounce((e) => {
    state.colorSeed = +e.target.value;
    if (state.area) rebuildBlocks();
  }, 140));

  document.querySelectorAll('#layerSegment button').forEach((b) =>
    b.addEventListener('click', () => setBasemap(b.dataset.layer)));

  ['toggleParcels', 'toggleStreets', 'toggleLabels', 'toggleHouseNumbers'].forEach((id) =>
    $(id).addEventListener('change', attachLayers));

  $('innerSearch').addEventListener('input', debounce((e) => runInnerSearch(e.target.value), 150));
  $('searchResults').addEventListener('click', onResultActivate);
  $('searchResults').addEventListener('keydown', (e) => { if (e.key === 'Enter') onResultActivate(e); });

  $('inspClose').addEventListener('click', closeInspector);
  $('inspBody').addEventListener('click', (e) => {
    const li = e.target.closest('[data-parcel]');
    if (li) selectParcel(li.dataset.parcel);
  });
  $('inspExport').addEventListener('click', () => exportBlock(state.selectedBlock));
  $('inspZoom').addEventListener('click', () => state.selectedBlock && focusBlock(state.selectedBlock));

  $('exportBlockBtn').addEventListener('click', () => exportBlock(state.selectedBlock));
  $('exportFullBtn').addEventListener('click', exportFull);
  $('exportBatchBtn').addEventListener('click', exportBatch);

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeInspector(); });
}

/* =========================================================================
   1) Loading the area
   ========================================================================= */
function findPrebuilt(label) {
  const n = norm(label);
  const hit = CONFIG.prebuilt.find((p) => p.match.some((m) => n.includes(norm(m))));
  return hit ? hit.file : null;
}

async function loadArea(query, label) {
  if (state.busy) return toast('جارٍ تحميل منطقة أخرى، لحظة…');
  state.busy = true;
  $('searchBtn').disabled = true;
  showProgress('تحميل المنطقة', 3);

  try {
    let data = null;
    const file = findPrebuilt(label);
    if (file) data = await loadPrebuilt(file).catch(() => null);
    if (!data) data = await loadFromNetwork(query);
    setProgress(96, 'رسم البلوكات');
    await tick();
    applyArea(label, data);
    toast(`تم تحميل ${label} — ${fmtNum(data.parcels.length)} قطعة`);
  } catch (err) {
    console.error(err);
    toast(`تعذّر التحميل: ${err.message || 'خطأ غير معروف'}`, 5200);
  } finally {
    state.busy = false;
    $('searchBtn').disabled = false;
    hideProgress();
  }
}

async function loadPrebuilt(file) {
  const res = await fetch(file, { cache: 'no-cache' });
  if (!res.ok) return null;
  const fc = await res.json();
  const feats = fc.features || [];
  const bf = feats.find((f) => f.properties?.kind === 'boundary');
  if (!bf) return null;

  setProgress(30, 'قراءة الملف المُجهّز');
  await tick();
  const boundary = turf.feature(bf.geometry, { name: 'boundary' });
  const streets = feats
    .filter((f) => f.properties?.kind === 'street')
    .map((f) => turf.feature(f.geometry, { name: f.properties.name, highway: f.properties.highway }));
  const raw = feats
    .filter((f) => f.properties?.kind === 'parcel' && f.geometry?.type === 'Polygon')
    .map((f) => {
      const c = turf.centroid(f).geometry.coordinates;
      return {
        ring: f.geometry.coordinates[0], lng: c[0], lat: c[1],
        house: f.properties.house ?? '', street: f.properties.street ?? '', source: 'osm',
      };
    });

  setProgress(55, 'توليد البيانات الناقصة');
  await tick();
  return finalizeData(raw, streets, boundary, 'بيانات مُجهّزة مسبقًا من OpenStreetMap');
}

async function loadFromNetwork(query) {
  setProgress(8, 'البحث عن الحدود الإدارية');
  const place = await geocode(query);
  const boundary = placeToBoundary(place);

  setProgress(22, 'جلب الشوارع والمباني من OpenStreetMap');
  const osm = await fetchOverpass(boundary);

  setProgress(55, 'تحليل الشبكة');
  await tick();
  const parsed = parseOSM(osm, boundary);

  setProgress(70, 'توليد القطع الناقصة بذكاء');
  await tick();
  return finalizeData(parsed.rawParcels, parsed.streets, boundary,
    'بيانات OpenStreetMap مع استكمال مكاني للقطع الناقصة');
}

async function geocode(query) {
  const q = /مصر|egypt/i.test(query) ? query : `${query}، مصر`;
  const url = `${CONFIG.nominatimUrl}?format=json&polygon_geojson=1&limit=1&accept-language=ar&countrycodes=eg&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Nominatim: HTTP ${res.status}`);
  const list = await res.json();
  if (!list.length) throw new Error('لم يتم العثور على المنطقة، جرّب اسمًا أدق');
  return list[0];
}

function placeToBoundary(place) {
  const g = place.geojson;
  if (g && (g.type === 'Polygon' || g.type === 'MultiPolygon')) {
    return turf.feature(g, { name: place.display_name });
  }
  // لا يوجد مضلع إداري: نستخدم مربعًا بمساحة 3 كم حول المركز
  const lat = +place.lat;
  const lon = +place.lon;
  return turf.buffer(turf.point([lon, lat]), 1.5, { units: 'kilometers' });
}

async function fetchOverpass(boundary) {
  const [w, s, e, n] = turf.bbox(boundary);
  const bbox = `${s},${w},${n},${e}`;
  const cacheKey = `gis-osm:${hashStr(bbox)}`;

  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch (_) { /* التخزين المحلي غير متاح */ }

  const query = `[out:json][timeout:90];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road)$"](${bbox});
  way["building"](${bbox});
  way["addr:housenumber"](${bbox});
  node["addr:housenumber"](${bbox});
);
out geom;`;

  let lastErr = null;
  for (const endpoint of CONFIG.overpassEndpoints) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      try {
        const str = JSON.stringify(json);
        if (str.length < CONFIG.cacheLimitChars) localStorage.setItem(cacheKey, str);
      } catch (_) { /* تجاوز التخزين عند امتلائه */ }
      return json;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`تعذّر الاتصال بـ Overpass API (${lastErr?.message || 'لا استجابة'})`);
}

/* ---------- Parse OSM into streets + raw parcels ---------- */
function parseOSM(osm, boundary) {
  const streets = [];
  const buildings = [];
  const addrNodes = [];
  let unnamed = 0;

  for (const el of osm.elements || []) {
    const tags = el.tags || {};
    const geom = el.geometry || [];

    if (el.type === 'way' && tags.highway && geom.length > 1) {
      const name = tags['name:ar'] || tags.name || tags.ref || `طريق داخلي ${++unnamed}`;
      streets.push(turf.lineString(geom.map((g) => [g.lon, g.lat]), { name, highway: tags.highway }));
    } else if (el.type === 'way' && geom.length >= 3 && (tags.building || tags['addr:housenumber'])) {
      const ring = geom.map((g) => [g.lon, g.lat]);
      const first = ring[0];
      const last = ring[ring.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
      if (ring.length >= 4) {
        buildings.push({ ring, house: tags['addr:housenumber'] || '', street: tags['addr:street'] || '' });
      }
    } else if (el.type === 'node' && tags['addr:housenumber']) {
      addrNodes.push({ lng: el.lon, lat: el.lat, house: tags['addr:housenumber'], street: tags['addr:street'] || '' });
    }
  }

  const inside = streets.filter((s) => {
    try { return turf.booleanIntersects(s, boundary); } catch (_) { return false; }
  });

  // ربط أرقام البيوت (nodes) بالمباني التي تحتويها
  const polys = [];
  for (const b of buildings) {
    try {
      const poly = turf.polygon([b.ring]);
      polys.push({ ...b, poly, bb: turf.bbox(poly) });
    } catch (_) { /* مضلع غير صالح */ }
  }

  const orphans = [];
  for (const n of addrNodes) {
    const hit = polys.find((b) =>
      n.lng >= b.bb[0] && n.lng <= b.bb[2] && n.lat >= b.bb[1] && n.lat <= b.bb[3] &&
      turf.booleanPointInPolygon([n.lng, n.lat], b.poly));
    if (hit) {
      if (!hit.house) hit.house = n.house;
      if (!hit.street) hit.street = n.street;
    } else {
      orphans.push(n);
    }
  }

  const rawParcels = [];
  for (const b of polys) {
    const c = turf.centroid(b.poly).geometry.coordinates;
    rawParcels.push({ ring: b.ring, lng: c[0], lat: c[1], house: b.house, street: b.street, source: 'osm' });
  }
  for (const n of orphans) {
    const rect = rectAt([n.lng, n.lat], 0, 12, 9).geometry.coordinates[0];
    rawParcels.push({ ring: rect, lng: n.lng, lat: n.lat, house: n.house, street: n.street, source: 'osm' });
  }

  return { streets: inside, rawParcels };
}

/* =========================================================================
   2) Smart Fallback: توليد القطع الناقصة بشكل منطقي
   - تُعيّن كل قطعة إلى شارع قريب، ورقم بيت متسلسل بالجانبين (زوجي/فردي)
   - القطع المولّدة تُعلَّم صراحةً (synthetic) لتمييزها عن السجلات الرسمية
   ========================================================================= */
function finalizeData(rawIn, streetsIn, boundary, baseNote) {
  const bb = turf.bbox(boundary);
  const midLat = (bb[1] + bb[3]) / 2;
  const rng = mulberry32(hashStr(bb.join(',')));

  const raw = rawIn.filter((p) =>
    p.lng >= bb[0] && p.lng <= bb[2] && p.lat >= bb[1] && p.lat <= bb[3] &&
    turf.booleanPointInPolygon([p.lng, p.lat], boundary));

  let note = baseNote;
  let sampleLines = streetsIn;
  if (streetsIn.length < 3) {
    sampleLines = virtualGrid(bb);
    note += ' · شبكة الطرق غير مكتملة، تم استخدام شبكة مرجعية للتوليد';
  }

  const cands = sampleStreets(sampleLines, boundary, bb, CONFIG.syntheticSpacingM, CONFIG.sideOffsetM);

  const hash = makeHash(12, midLat);
  for (const p of raw) {
    hash.add(p.lng, p.lat);
    for (const v of p.ring) hash.add(v[0], v[1]);
  }

  const counters = new Map();
  const nextHouse = (street, side) => {
    if (!counters.has(street)) counters.set(street, [2, 1]);
    const c = counters.get(street);
    const v = c[side];
    c[side] += 2;
    return v;
  };

  const synth = [];
  for (const c of cands) {
    if (synth.length >= CONFIG.maxSynthetic) break;
    if (hash.near(c.lng, c.lat, 11)) continue;
    hash.add(c.lng, c.lat);
    const len = 11 + rng() * 3;
    const wid = 8 + rng() * 2;
    const ring = rectAt([c.lng, c.lat], c.bearing, len, wid).geometry.coordinates[0];
    synth.push({
      ring, lng: c.lng, lat: c.lat, street: c.street,
      house: nextHouse(c.street, c.side),
      source: 'synthetic', houseSource: 'generated',
    });
  }

  const kx = 111320 * Math.cos(midLat * Math.PI / 180);
  const ky = 111320;
  const nearestCand = (lng, lat) => {
    let best = null;
    let bd = Infinity;
    for (const c of cands) {
      const dx = (c.lng - lng) * kx;
      const dy = (c.lat - lat) * ky;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  };

  const realOut = raw.map((p) => {
    let street = p.street;
    let side = 0;
    if (!street || !p.house) {
      const c = nearestCand(p.lng, p.lat);
      if (c) {
        side = c.side;
        if (!street) street = c.street;
      }
    }
    if (!street) street = 'شارع غير مسمّى';
    return {
      ring: p.ring, lng: p.lng, lat: p.lat, street,
      house: p.house ? String(p.house) : String(nextHouse(street, side)),
      source: 'osm',
      houseSource: p.house ? 'osm' : 'estimated',
    };
  });

  const all = [...realOut, ...synth];
  const parcels = [];
  all.forEach((p, i) => {
    try {
      const feature = turf.polygon([p.ring]);
      parcels.push({
        id: `P${String(i + 1).padStart(5, '0')}`,
        geometry: feature.geometry,
        lng: p.lng,
        lat: p.lat,
        street: p.street,
        house: p.house,
        area: Math.round(turf.area(feature)),
        source: p.source,
        houseSource: p.houseSource,
        block: null,
      });
    } catch (_) { /* تجاهل مضلع غير صالح */ }
  });

  const pct = parcels.length ? Math.round((synth.length / parcels.length) * 100) : 0;
  note += ` · مسجّلة: ${fmtNum(realOut.length)} · مقدّرة: ${fmtNum(synth.length)} (${pct}%)`;

  return {
    boundary,
    streets: streetsIn,
    parcels,
    note,
  };
}

function sampleStreets(lines, boundary, bb, spacing, offset) {
  const out = [];
  for (const line of lines) {
    const len = turf.length(line, { units: 'meters' });
    if (len < 4) continue;
    const name = line.properties.name;
    for (let d = spacing / 2; d < len; d += spacing) {
      const p = turf.along(line, d, { units: 'meters' }).geometry.coordinates;
      const a = turf.along(line, Math.max(0, d - 1), { units: 'meters' }).geometry.coordinates;
      const b = turf.along(line, Math.min(len, d + 1), { units: 'meters' }).geometry.coordinates;
      const bearing = turf.bearing(a, b);
      for (const sd of [-1, 1]) {
        const q = turf.destination(p, offset, bearing + 90 * sd, { units: 'meters' }).geometry.coordinates;
        if (q[0] < bb[0] || q[0] > bb[2] || q[1] < bb[1] || q[1] > bb[3]) continue;
        if (!turf.booleanPointInPolygon(q, boundary)) continue;
        out.push({ lng: q[0], lat: q[1], street: name, bearing, side: sd > 0 ? 1 : 0 });
      }
    }
  }
  return out;
}

function virtualGrid(bb) {
  const lines = [];
  const midLat = (bb[1] + bb[3]) / 2;
  const dLat = 120 / 111320;
  const dLng = 120 / (111320 * Math.cos(midLat * Math.PI / 180));
  let n = 1;
  for (let y = bb[1]; y <= bb[3]; y += dLat) {
    lines.push(turf.lineString([[bb[0], y], [bb[2], y]], { name: `شارع فرعي ${n++}`, virtual: true }));
  }
  for (let x = bb[0]; x <= bb[2]; x += dLng) {
    lines.push(turf.lineString([[x, bb[1]], [x, bb[3]]], { name: `شارع فرعي ${n++}`, virtual: true }));
  }
  return lines;
}

/** مجزّئ مكاني خفيف (Spatial hash) لفحص التعارض بالمسافة بالمتر */
function makeHash(cellM, refLat) {
  const kx = 111320 * Math.cos(refLat * Math.PI / 180);
  const ky = 111320;
  const cells = new Map();
  const cidx = (lng, lat) => [Math.floor(lng * kx / cellM), Math.floor(lat * ky / cellM)];
  return {
    add(lng, lat) {
      const [i, j] = cidx(lng, lat);
      const k = `${i}:${j}`;
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push([lng, lat]);
    },
    near(lng, lat, r) {
      const [i, j] = cidx(lng, lat);
      const r2 = r * r;
      for (let a = i - 1; a <= i + 1; a++) {
        for (let b = j - 1; b <= j + 1; b++) {
          const arr = cells.get(`${a}:${b}`);
          if (!arr) continue;
          for (const [x, y] of arr) {
            const dx = (x - lng) * kx;
            const dy = (y - lat) * ky;
            if (dx * dx + dy * dy < r2) return true;
          }
        }
      }
      return false;
    },
  };
}

/** مستطيل (قطعة) مُحاذٍ لاتجاه الشارع */
function rectAt(center, bearing, lenM, widM) {
  const hl = lenM / 2;
  const hw = widM / 2;
  const mv = (pt, d, b) => turf.destination(pt, d, b, { units: 'meters' }).geometry.coordinates;
  const a = mv(center, hl, bearing);
  const b = mv(center, hl, bearing + 180);
  const c0 = mv(a, hw, bearing + 90);
  const c1 = mv(b, hw, bearing + 90);
  const c2 = mv(b, hw, bearing - 90);
  const c3 = mv(a, hw, bearing - 90);
  return turf.polygon([[c0, c1, c2, c3, c0]]);
}

/* =========================================================================
   3) Dynamic block partitioning: K-Means + Voronoi مقصوص بحدود المنطقة
   ========================================================================= */
function partitionBlocks(parcels, boundary, k, seed, colorSeed) {
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const bb = turf.bbox(boundary);
  const cosLat = Math.cos(((bb[1] + bb[3]) / 2) * Math.PI / 180);

  let pts = parcels.map((p) => [p.lng, p.lat]);
  if (pts.length < k * 2) {
    const grid = turf.pointGrid(bb, 40, { units: 'meters', mask: boundary });
    pts = pts.concat(grid.features.map((f) => f.geometry.coordinates));
  }
  if (pts.length < k) throw new Error('المنطقة صغيرة جدًا لهذا العدد من البلوكات');

  // تصحيح مقياس خط الطول بحسب خط العرض
  const n = pts.length;
  const xs = pts.map((p) => p[0] * cosLat);
  const ys = pts.map((p) => p[1]);

  // K-Means++ initialisation
  const cx = [];
  const cy = [];
  const first = Math.floor(rng() * n);
  cx.push(xs[first]);
  cy.push(ys[first]);
  const d2 = new Float64Array(n).fill(Infinity);
  while (cx.length < k) {
    const lx = cx[cx.length - 1];
    const ly = cy[cy.length - 1];
    let total = 0;
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - lx;
      const dy = ys[i] - ly;
      const d = dx * dx + dy * dy;
      if (d < d2[i]) d2[i] = d;
      total += d2[i];
    }
    let r = rng() * total;
    let pick = n - 1;
    for (let i = 0; i < n; i++) {
      r -= d2[i];
      if (r <= 0) { pick = i; break; }
    }
    cx.push(xs[pick]);
    cy.push(ys[pick]);
  }

  // Lloyd iterations
  const assign = new Int32Array(n).fill(-1);
  for (let it = 0; it < 40; it++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bd = Infinity;
      for (let c = 0; c < k; c++) {
        const dx = xs[i] - cx[c];
        const dy = ys[i] - cy[c];
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = c; }
      }
      if (assign[i] !== best) { assign[i] = best; moved++; }
    }
    const sx = new Float64Array(k);
    const sy = new Float64Array(k);
    const cnt = new Int32Array(k);
    for (let i = 0; i < n; i++) {
      const c = assign[i];
      sx[c] += xs[i];
      sy[c] += ys[i];
      cnt[c]++;
    }
    for (let c = 0; c < k; c++) {
      if (cnt[c]) {
        cx[c] = sx[c] / cnt[c];
        cy[c] = sy[c] / cnt[c];
      } else {
        const r = Math.floor(rng() * n);
        cx[c] = xs[r];
        cy[c] = ys[r];
      }
    }
    if (moved === 0) break;
  }
  const sites = cx.map((x, c) => [x / cosLat, cy[c]]);

  // Voronoi clipped to the boundary
  const pad = 0.01;
  const vbox = [bb[0] - pad, bb[1] - pad, bb[2] + pad, bb[3] + pad];
  const vor = turf.voronoi(turf.featureCollection(sites.map((s) => turf.point(s))), { bbox: vbox });
  const cells = (vor?.features || []).filter(Boolean);

  const raw = [];
  for (const s of sites) {
    const cell = cells.find((c) => turf.booleanPointInPolygon(s, c));
    if (!cell) continue;
    let clipped = null;
    try { clipped = turf.intersect(cell, boundary); } catch (_) { clipped = null; }
    if (clipped) raw.push({ site: s, feature: clipped });
  }

  // ترقيم منطقي من الشمال للجنوب ومن الغرب للشرق (بنظام الصف المتعرج)
  const width = turf.distance([bb[0], bb[1]], [bb[2], bb[1]], { units: 'meters' });
  const height = turf.distance([bb[0], bb[1]], [bb[0], bb[3]], { units: 'meters' });
  const aspect = Math.max(width, 1) / Math.max(height, 1);
  const cols = clamp(Math.round(Math.sqrt(raw.length * aspect)), 1, Math.max(1, raw.length));

  const byLat = raw.slice().sort((a, b) => b.site[1] - a.site[1]);
  const ordered = [];
  for (let r = 0; r * cols < byLat.length; r++) {
    const row = byLat.slice(r * cols, (r + 1) * cols)
      .sort((a, b) => (r % 2 === 0 ? a.site[0] - b.site[0] : b.site[0] - a.site[0]));
    ordered.push(...row);
  }

  const areaCode = `EG${String(seed % 1000).padStart(3, '0')}`;
  return ordered.map((r, i) => {
    const number = i + 1;
    return {
      number,
      code: `${areaCode}-${pad2(number)}`,
      feature: r.feature,
      bbox: turf.bbox(r.feature),
      labelLL: turf.pointOnFeature(r.feature).geometry.coordinates,
      site: r.site,
      hue: (colorSeed + i * 137.508) % 360,
      parcels: [],
      count: 0,
      real: 0,
      synthetic: 0,
      streets: new Set(),
      area: 0,
      centroid: r.site,
    };
  });
}

function assignParcels(parcels, blocks) {
  blocks.forEach((b) => { b.parcels = []; });

  for (const p of parcels) {
    const pt = [p.lng, p.lat];
    let hit = null;
    for (const b of blocks) {
      const bb = b.bbox;
      if (p.lng < bb[0] || p.lng > bb[2] || p.lat < bb[1] || p.lat > bb[3]) continue;
      if (turf.booleanPointInPolygon(pt, b.feature)) { hit = b; break; }
    }
    if (!hit) hit = nearestBlock(p.lng, p.lat, blocks);
    p.block = hit.number;
    hit.parcels.push(p);
  }

  // لا يُترك أي بلوك فارغ: نأخذ أقرب القطع من البلوكات الكبيرة
  for (const b of blocks) {
    if (b.parcels.length) continue;
    const near = parcels
      .map((p) => ({ p, d: (p.lng - b.site[0]) ** 2 + (p.lat - b.site[1]) ** 2 }))
      .sort((x, y) => x.d - y.d);
    let moved = 0;
    for (const { p } of near) {
      if (moved >= 6) break;
      const donor = blocks.find((x) => x.number === p.block);
      if (donor && donor.parcels.length > 8) {
        donor.parcels = donor.parcels.filter((q) => q !== p);
        p.block = b.number;
        b.parcels.push(p);
        moved++;
      }
    }
  }

  blocks.forEach(computeBlockStats);
}

function nearestBlock(lng, lat, blocks) {
  let best = blocks[0];
  let bd = Infinity;
  for (const b of blocks) {
    const d = (lng - b.site[0]) ** 2 + (lat - b.site[1]) ** 2;
    if (d < bd) { bd = d; best = b; }
  }
  return best;
}

function computeBlockStats(b) {
  b.count = b.parcels.length;
  b.real = b.parcels.filter((p) => p.source === 'osm').length;
  b.synthetic = b.count - b.real;
  b.streets = new Set(b.parcels.map((p) => p.street));
  b.area = Math.round(turf.area(b.feature));
  b.centroid = turf.centroid(b.feature).geometry.coordinates;
}

/* =========================================================================
   4) Rendering
   ========================================================================= */
function applyArea(label, data) {
  const streetIndex = new Map();
  data.parcels.forEach((p) => streetIndex.set(p.street, (streetIndex.get(p.street) || 0) + 1));

  state.area = {
    label,
    note: data.note,
    boundary: data.boundary,
    bbox: turf.bbox(data.boundary),
    streets: data.streets,
    parcels: data.parcels,
    parcelById: new Map(data.parcels.map((p) => [p.id, p])),
    streetIndex,
    seed: hashStr(label),
  };

  $('activeAreaLabel').textContent = label;
  state.map.fitBounds(L.geoJSON(data.boundary).getBounds(), { padding: [40, 40], maxZoom: 16 });
  rebuildBlocks();
  ['exportBlockBtn', 'exportFullBtn', 'exportBatchBtn'].forEach((id) => { $(id).disabled = false; });
}

function rebuildBlocks() {
  const a = state.area;
  if (!a) return;
  try {
    state.blocks = partitionBlocks(a.parcels, a.boundary, state.blockCount, a.seed, state.colorSeed);
  } catch (err) {
    toast(err.message, 4500);
    return;
  }
  assignParcels(a.parcels, state.blocks);
  state.blockByNum = new Map(state.blocks.map((b) => [b.number, b]));
  state.selectedBlock = null;
  state.selectedParcel = null;
  state.introPlayed = false;
  closeInspector();
  render();
  setTimeout(() => { state.introPlayed = true; }, 1400);
  updateStats();
  $('blockCountChip').textContent = `${state.blocks.length} بلوك`;
}

function setBlockCount(k) {
  k = Math.round(Number(k));
  if (!Number.isFinite(k) || k < 2 || k > CONFIG.blockCountMax) {
    return toast(`أدخل عددًا بين 2 و ${CONFIG.blockCountMax}`);
  }
  state.blockCount = k;
  $('customCount').value = k;
  document.querySelectorAll('.preset').forEach((b) => b.classList.toggle('is-active', +b.dataset.count === k));
  $('blockCountChip').textContent = `${k} بلوك`;
  if (state.area) {
    showProgress('إعادة تقسيم المنطقة', 40);
    setTimeout(() => {
      rebuildBlocks();
      hideProgress();
      if (state.blocks.length) toast(`تم تقسيم المنطقة إلى ${state.blocks.length} بلوك`);
    }, 60);
  }
}

function render() {
  const a = state.area;
  if (!a) return;
  state.layers.streets = L.geoJSON(turf.featureCollection(a.streets), {
    interactive: false,
    style: streetStyle,
    renderer: L.canvas({ padding: 0.3 }),
  });
  state.layers.blocks = L.geoJSON(blocksFC(), {
    renderer: state.renderer,
    style: blockStyle,
    onEachFeature: bindBlockEvents,
  });
  state.layers.parcels = L.geoJSON(parcelsFC(), {
    renderer: state.renderer,
    style: parcelStyle,
    onEachFeature: bindParcelEvents,
  });
  state.layers.labels = L.layerGroup(blockBadges());
  state.layers.houses = L.layerGroup();
  attachLayers();
}

function attachLayers() {
  const m = state.map;
  const L_ = state.layers;
  if (!L_.blocks) return;
  const t = (id) => $(id).checked;

  [L_.streets, L_.blocks, L_.parcels, L_.labels, L_.houses].forEach((l) => {
    if (l && m.hasLayer(l)) m.removeLayer(l);
  });

  if (t('toggleStreets')) L_.streets.addTo(m);
  L_.blocks.addTo(m);
  if (t('toggleParcels')) L_.parcels.addTo(m);
  if (t('toggleLabels')) L_.labels.addTo(m);
  updateHouseLabels();
}

function blocksFC() {
  return turf.featureCollection(
    state.blocks.map((b) => turf.feature(b.feature.geometry, { number: b.number })));
}

function parcelsFC() {
  return turf.featureCollection(
    state.area.parcels.map((p) => turf.feature(p.geometry, { id: p.id })));
}

function streetStyle(f) {
  const h = f.properties.highway;
  const w = { motorway: 5, trunk: 5, primary: 4.5, secondary: 3.5, tertiary: 3, residential: 2, unclassified: 2, living_street: 1.8, service: 1.5 }[h] || 1.6;
  return { color: isDark() ? '#E8A33D' : '#B9761A', weight: w, opacity: 0.55 };
}

function blockStyle(f) {
  const b = state.blockByNum.get(f.properties.number);
  const sel = state.selectedBlock && state.selectedBlock.number === f.properties.number;
  const dark = isDark();
  return {
    color: `hsl(${b.hue} 80% ${dark ? 72 : 38}%)`,
    weight: sel ? 3.5 : 1.8,
    fillColor: `hsl(${b.hue} 72% 58%)`,
    fillOpacity: sel ? 0.42 : 0.22,
    className: sel ? 'block-path is-selected' : 'block-path',
  };
}

function parcelStyle(f) {
  const p = state.area.parcelById.get(f.properties.id);
  const sel = state.selectedParcel === f.properties.id;
  const dark = isDark();
  return {
    color: dark ? '#4FD1C0' : '#1F7D72',
    weight: sel ? 2.6 : 1,
    fillColor: '#2A9D8F',
    fillOpacity: sel ? 0.5 : 0.2,
    dashArray: p && p.source === 'synthetic' ? '4 4' : null,
  };
}

function bindBlockEvents(f, layer) {
  layer.on('click', (e) => {
    L.DomEvent.stopPropagation(e);
    selectBlock(f.properties.number);
  });
  layer.on('mouseover', () => {
    if (state.selectedBlock?.number !== f.properties.number) layer.setStyle({ fillOpacity: 0.34 });
  });
  layer.on('mouseout', () => layer.setStyle(blockStyle(layer.feature)));
}

function bindParcelEvents(f, layer) {
  layer.on('click', (e) => {
    L.DomEvent.stopPropagation(e);
    selectParcel(f.properties.id);
  });
  layer.on('mouseover', () => layer.setStyle({ fillOpacity: 0.4 }));
  layer.on('mouseout', () => layer.setStyle(parcelStyle(layer.feature)));
}

function blockBadges() {
  const intro = state.introPlayed ? 'animation:none;' : '';
  return state.blocks.map((b, i) => {
    const [lng, lat] = b.labelLL;
    const isSel = state.selectedBlock && state.selectedBlock.number === b.number;
    const icon = L.divIcon({
      className: `block-badge${isSel ? ' is-selected' : ''}`,
      html: `<span style="--i:${i};${intro}">بلوك #${pad2(b.number)}</span>`,
      iconSize: null,
    });
    const mk = L.marker([lat, lng], { icon, title: `بلوك ${b.number}`, keyboard: false });
    mk.on('click', () => selectBlock(b.number));
    return mk;
  });
}

function refreshBadges() {
  const m = state.map;
  const old = state.layers.labels;
  const was = old && m.hasLayer(old);
  if (old && was) m.removeLayer(old);
  state.layers.labels = L.layerGroup(blockBadges());
  if (was) state.layers.labels.addTo(m);
}

function updateHouseLabels() {
  const H = state.layers.houses;
  if (!H || !state.area) return;
  const m = state.map;
  H.clearLayers();
  const on = $('toggleHouseNumbers').checked && m.getZoom() >= CONFIG.houseLabelMinZoom;
  if (!on) {
    if (m.hasLayer(H)) m.removeLayer(H);
    return;
  }
  const view = m.getBounds();
  let count = 0;
  for (const p of state.area.parcels) {
    if (!view.contains([p.lat, p.lng])) continue;
    if (++count > 1500) break;
    H.addLayer(L.marker([p.lat, p.lng], {
      interactive: false,
      icon: L.divIcon({ className: 'house-badge', html: `<span>${esc(p.house)}</span>`, iconSize: null }),
    }));
  }
  if (!m.hasLayer(H)) H.addTo(m);
}

function updateStats() {
  const a = state.area;
  if (!a) return;
  $('statBlocks').textContent = fmtNum(state.blocks.length);
  $('statParcels').textContent = fmtNum(a.parcels.length);
  $('statStreets').textContent = fmtNum(a.streetIndex.size);
  const syn = a.parcels.filter((p) => p.source === 'synthetic').length;
  const pct = a.parcels.length ? Math.round((syn / a.parcels.length) * 100) : 0;
  $('dataNote').textContent =
    `${a.note}. القطع المقدّرة تظهر بخط متقطع وتُعلَّم في اللوحة، وهي تقديرات مكانية وليست سجلات رسمية (${pct}%).`;
}

/* =========================================================================
   5) Selection & inspector
   ========================================================================= */
function setSelectedBlock(n) {
  const b = state.blockByNum.get(n) || null;
  state.selectedBlock = b;
  if (state.layers.blocks) state.layers.blocks.eachLayer((l) => l.setStyle(blockStyle(l.feature)));
  refreshBadges();
  return b;
}

function focusBlock(b) {
  state.map.flyToBounds(L.geoJSON(b.feature).getBounds(), { padding: [80, 80], duration: 0.9, maxZoom: 18 });
}

function selectBlock(n, { fly = true } = {}) {
  const b = setSelectedBlock(n);
  if (!b) return;
  state.selectedParcel = null;
  if (fly) focusBlock(b);
  showBlockInspector(b);
}

function selectParcel(id) {
  const p = state.area?.parcelById.get(id);
  if (!p) return;
  setSelectedBlock(p.block);
  state.selectedParcel = id;
  if (state.layers.parcels) state.layers.parcels.eachLayer((l) => l.setStyle(parcelStyle(l.feature)));
  state.map.flyTo([p.lat, p.lng], Math.max(state.map.getZoom(), 18), { duration: 0.8 });
  showParcelInspector(p);
}

function openInspector(kicker, title, html) {
  $('inspKicker').textContent = kicker;
  $('inspTitle').textContent = title;
  $('inspBody').innerHTML = html;
  $('inspector').classList.add('is-open');
  $('inspector').setAttribute('aria-hidden', 'false');
  const hasBlock = !!state.selectedBlock;
  $('inspExport').disabled = !hasBlock;
  $('inspZoom').disabled = !hasBlock;
}

function closeInspector() {
  $('inspector').classList.remove('is-open');
  $('inspector').setAttribute('aria-hidden', 'true');
}

const kv = (k, v) => `<div class="kv"><span>${esc(k)}</span><span>${esc(v)}</span></div>`;
const houseSourceLabel = (s) => ({
  osm: 'مسجّل في OpenStreetMap',
  estimated: 'مستنتج من موقع الشارع',
  generated: 'مُولَّد تلقائيًا',
}[s] || '—');

function showBlockInspector(b) {
  const sorted = b.parcels.slice().sort((x, y) =>
    x.street.localeCompare(y.street, 'ar') || (+x.house - +y.house));
  const list = sorted.slice(0, 120).map((p) =>
    `<li data-parcel="${esc(p.id)}"><span>${esc(p.street)} · ${esc(p.house)}</span><span>${fmtNum(p.area)} م²</span></li>`
  ).join('');
  const more = sorted.length > 120 ? `<p class="data-note">يُعرض أول 120 قطعة من ${fmtNum(sorted.length)}.</p>` : '';
  const badge = b.synthetic ? `<span class="badge-synth">يحتوي على ${fmtNum(b.synthetic)} قطعة مقدّرة</span>` : '';
  const rows = [
    kv('المنطقة', state.area.label),
    kv('رقم البلوك', `#${pad2(b.number)}`),
    kv('كود البلوك', b.code),
    kv('إجمالي القطع / المباني', fmtNum(b.count)),
    kv('مسجّلة (OSM)', fmtNum(b.real)),
    kv('مقدّرة', fmtNum(b.synthetic)),
    kv('عدد الشوارع', fmtNum(b.streets.size)),
    kv('مساحة البلوك', `${fmtNum(b.area)} م²`),
    kv('مركز البلوك', `Lat ${b.centroid[1].toFixed(6)}, Lng ${b.centroid[0].toFixed(6)}`),
  ].join('');
  openInspector('بلوك', `بلوك #${pad2(b.number)}`,
    `<div>${rows}</div>${badge}
     <h4 style="margin:16px 0 4px;font-size:.92rem">القطع (${fmtNum(b.count)})</h4>
     <ul class="parcel-list">${list}</ul>${more}`);
}

function showParcelInspector(p) {
  const b = state.blockByNum.get(p.block);
  const rows = [
    kv('الشارع', p.street),
    kv('رقم البيت', p.house),
    kv('البلوك', b ? `#${pad2(b.number)} · ${b.code}` : '—'),
    kv('مساحة القطعة', `${fmtNum(p.area)} م²`),
    kv('Lat', p.lat.toFixed(6)),
    kv('Lng', p.lng.toFixed(6)),
    kv('مصدر القطعة', p.source === 'osm' ? 'OpenStreetMap' : 'تقدير مكاني'),
    kv('مصدر رقم البيت', houseSourceLabel(p.houseSource)),
  ].join('');
  const badge = p.source === 'synthetic' ? '<span class="badge-synth">قطعة مقدّرة وليست سجلاً رسمياً</span>' : '';
  openInspector('قطعة', `${p.street} — ${p.house}`, `<div>${rows}</div>${badge}`);
}

/* =========================================================================
   6) Inner search
   ========================================================================= */
function runInnerSearch(raw) {
  const list = $('searchResults');
  const q = norm(toLatinDigits(raw));
  state.searchActions = [];
  if (!state.area || !q) { list.innerHTML = ''; return; }

  const items = [];
  const digits = q.match(/\d+/);
  if (digits) {
    const n = parseInt(digits[0], 10);
    const blk = state.blockByNum.get(n);
    if (blk) {
      items.push({ tag: 'بلوك', text: `بلوك #${pad2(n)}`, meta: `${fmtNum(blk.count)} قطعة`, act: () => selectBlock(n) });
    }
    state.area.parcels
      .filter((p) => norm(p.house) === String(n))
      .slice(0, 12)
      .forEach((p) => items.push({
        tag: 'بيت', text: `${p.street} — ${p.house}`, meta: `بلوك #${pad2(p.block)}`,
        act: () => selectParcel(p.id),
      }));
  }

  for (const [name, count] of state.area.streetIndex) {
    if (items.length >= 30) break;
    if (norm(name).includes(q)) {
      items.push({ tag: 'شارع', text: name, meta: `${fmtNum(count)} قطعة`, act: () => flyToStreet(name) });
    }
  }

  const shown = items.slice(0, 30);
  state.searchActions = shown.map((i) => i.act);
  list.innerHTML = shown.length
    ? shown.map((it, idx) =>
      `<li tabindex="0" data-idx="${idx}"><span>${esc(it.text)} <span class="muted">${esc(it.tag)}</span></span><span class="muted">${esc(it.meta)}</span></li>`
    ).join('')
    : '<li class="empty">لا توجد نتائج مطابقة</li>';
}

function onResultActivate(e) {
  const li = e.target.closest('li[data-idx]');
  if (!li) return;
  state.searchActions[+li.dataset.idx]?.();
}

function flyToStreet(name) {
  const pts = state.area.parcels.filter((p) => p.street === name);
  if (!pts.length) return;
  const bounds = L.latLngBounds(pts.map((p) => [p.lat, p.lng]));
  state.map.flyToBounds(bounds.pad(0.3), { duration: 0.9, maxZoom: 18 });
  selectBlock(pts[0].block, { fly: false });
}

/* =========================================================================
   7) Export bridge (exporter.js)
   ========================================================================= */
function currentBasemap() {
  const mode = state.layerMode;
  if (mode === 'streets') return { templates: [TILE.carto(isDark())], attribution: ATTR.carto };
  if (mode === 'osm') return { templates: [TILE.osm], attribution: ATTR.osm };
  const templates = [TILE.esri];
  if (mode === 'hybrid') templates.push(TILE.esriLabels);
  return { templates, attribution: ATTR.esri };
}

function exportContext() {
  const bm = currentBasemap();
  return {
    areaLabel: state.area.label,
    bbox: state.area.bbox,
    boundary: state.area.boundary,
    streets: state.area.streets,
    parcels: state.area.parcels,
    blocks: state.blocks,
    basemap: bm.templates,
    attribution: bm.attribution,
    dark: isDark(),
  };
}

function requireArea() {
  if (!state.area) { toast('حمّل منطقة أولاً'); return false; }
  return true;
}

function waitFor(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function exportBlock(block) {
  if (!requireArea()) return;
  if (!block) return toast('اختر بلوكًا أولاً من الخريطة');

  const width = +$('exportPreset').value;
  const format = $('exportFormat').value;

  focusBlock(block);          // Auto-Zoom للمستخدم على الشاشة
  await waitFor(900);

  showProgress(`تصدير البلوك #${pad2(block.number)}`, 2);
  try {
    await BlockExporter.exportBlock(exportContext(), block, { width, format, onProgress: setProgress });
    toast('تم حفظ صورة البلوك بجودة عالية');
  } catch (err) {
    console.error(err);
    toast(`فشل التصدير: ${err.message}`, 5200);
  } finally {
    hideProgress();
  }
}

async function exportFull() {
  if (!requireArea()) return;
  const width = +$('exportPreset').value;
  const format = $('exportFormat').value;
  showProgress('تصدير الخريطة الكاملة', 2);
  try {
    await BlockExporter.exportFull(exportContext(), { width, format, onProgress: setProgress });
    toast('تم حفظ الخريطة الكاملة');
  } catch (err) {
    console.error(err);
    toast(`فشل التصدير: ${err.message}`, 5200);
  } finally {
    hideProgress();
  }
}

async function exportBatch() {
  if (!requireArea()) return;
  const width = +$('exportPreset').value;
  const format = $('exportFormat').value;
  showProgress(`تصدير ${state.blocks.length} بلوك`, 1);
  try {
    await BlockExporter.exportBatch(exportContext(), { width, format, onProgress: setProgress });
    toast('تم تجهيز ملف ZIP بجميع البلوكات');
  } catch (err) {
    console.error(err);
    toast(`فشل التصدير: ${err.message}`, 5200);
  } finally {
    hideProgress();
  }
}

/* ---------- Go ---------- */
init();
