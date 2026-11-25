/* =========================================================================
   exporter.js — محرك التصدير عالي الدقة (نسخة 2)
   أنماط التصدير:
     البلوك:    context  = البلوك مع الخريطة والشوارع والقطع والأرقام
                outline  = حدود البلوك فقط (PNG شفاف، بدون أي خريطة)
     الكاملة:   detailed = حدود المنطقة + أسماء الشوارع + أرقام البيوت (بدون خريطة)
                boundary = حدود المنطقة فقط
   الرسم يتم على Canvas من الإحداثيات الهندسية (Web Mercator)، فالحدود والحروف
   تبقى حادة مهما كبر المقاس.
   ========================================================================= */
(function (global) {
  'use strict';

  /* ---- إعدادات قابلة للتعديل ---- */
  const CONFIG = {
    FULL_SHOW_BLOCK_LINES: false,   // إظهار حدود البلوكات داخل الخريطة الكاملة المفصّلة
    FULL_SHOW_PARCELS: false,       // إظهار حدود القطع داخل الخريطة الكاملة (الأرقام تظهر دائماً)
    FULL_STREET_LABEL_MAX: 3000,    // أقصى عدد لأسماء الشوارع في الخريطة الكاملة
    BLOCK_STREET_LABEL_MAX: 120,    // أقصى عدد لأسماء الشوارع في تصدير البلوك
  };

  const REF_WIDTH = 4000;
  const HALF_WORLD = 20037508.342789244;
  const EARTH_R = 6378137;
  const TILE_M_PER_PX_Z0 = 156543.03392;
  const PRINT_DPI = 300;

  const PALETTE = {
    dark: {
      bg: '#0E1A24', header: '#15263A', text: '#F7F3EA', sub: 'rgba(247,243,234,0.72)',
      amber: '#E8A33D', amberInk: '#1A1206', teal: '79,209,192',
      street: '#F7F3EA', streetCasing: 'rgba(14,26,36,0.65)', wash: 'rgba(14,26,36,0.30)',
      badgeBg: 'rgba(14,26,36,0.88)', halo: 'rgba(14,26,36,0.85)',
    },
    light: {
      bg: '#F7F3EA', header: '#EFE8D8', text: '#0E1A24', sub: 'rgba(14,26,36,0.68)',
      amber: '#B9761A', amberInk: '#FFF8EA', teal: '31,125,114',
      street: '#FFFFFF', streetCasing: 'rgba(14,26,36,0.45)', wash: 'rgba(247,243,234,0.18)',
      badgeBg: 'rgba(247,243,234,0.94)', halo: 'rgba(247,243,234,0.85)',
    },
  };

  /* ---------- Math helpers ---------- */
  const mercX = (lng) => EARTH_R * lng * Math.PI / 180;
  const mercY = (lat) => EARTH_R * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
  const latFromMercY = (y) => (2 * Math.atan(Math.exp(y / EARTH_R)) - Math.PI / 2) * 180 / Math.PI;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const fmt = (n) => Number(n || 0).toLocaleString('ar-EG');
  const pad2 = (n) => String(n).padStart(2, '0');
  const safeName = (s) => String(s || 'map').replace(/[\\/:*?"<>|]+/g, '').trim() || 'map';
  const unitOf = (W) => W / REF_WIDTH;
  const tick = () => new Promise((r) => setTimeout(r, 0));

  function mercBoundsOfBBox(bb) {
    return { minX: mercX(bb[0]), minY: mercY(bb[1]), maxX: mercX(bb[2]), maxY: mercY(bb[3]) };
  }

  /** تخطيط الصورة. يمكن إلغاء الترويسة والتذييل للتصدير بالحدود فقط */
  function buildLayout(W, mb, { pad = 0.06, maxAspect = 1.6, header = true, footer = true } = {}) {
    const margin = W * 0.03;
    const headerH = header ? W * 0.1 : 0;
    const footerH = footer ? W * 0.05 : 0;

    const dx = (mb.maxX - mb.minX) * (1 + 2 * pad);
    const dy = (mb.maxY - mb.minY) * (1 + 2 * pad);
    const cx = (mb.minX + mb.maxX) / 2;
    const cy = (mb.minY + mb.maxY) / 2;
    const bounds = { minX: cx - dx / 2, maxX: cx + dx / 2, minY: cy - dy / 2, maxY: cy + dy / 2 };

    const availW = W - 2 * margin;
    const availH = W * maxAspect;
    const scale = Math.min(availW / dx, availH / dy);
    const mapW = dx * scale;
    const mapH = dy * scale;
    const mapX0 = (W - mapW) / 2;
    const mapY0 = headerH + margin;
    const H = Math.round(mapY0 + mapH + margin + footerH);

    const cosLat0 = Math.cos(latFromMercY(cy) * Math.PI / 180);
    const toPx = (mx, my) => [mapX0 + (mx - bounds.minX) * scale, mapY0 + (bounds.maxY - my) * scale];

    return {
      W, H, margin, headerH, footerH, bounds, scale,
      mapX0, mapY0, mapW, mapH,
      pxPerMeter: scale / cosLat0,
      toPx,
      project: (lng, lat) => toPx(mercX(lng), mercY(lat)),
    };
  }

  /* ---------- Geometry tracing ---------- */
  function tracePolygon(g, geom, L) {
    const polys = geom.type === 'Polygon' ? [geom.coordinates]
      : geom.type === 'MultiPolygon' ? geom.coordinates : [];
    for (const rings of polys) {
      for (const ring of rings) {
        ring.forEach((c, i) => {
          const [x, y] = L.project(c[0], c[1]);
          if (i) g.lineTo(x, y); else g.moveTo(x, y);
        });
        g.closePath();
      }
    }
  }

  function tracePath(g, coords, L) {
    coords.forEach((c, i) => {
      const [x, y] = L.project(c[0], c[1]);
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    });
  }

  function roundRect(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  /* ---------- Text helpers ---------- */
  function drawText(g, text, x, y, o) {
    g.save();
    g.translate(x, y);
    if (o.rotate) g.rotate(o.rotate);
    g.font = o.font;
    g.textAlign = o.align || 'center';
    g.textBaseline = o.baseline || 'middle';
    if (o.halo) {
      g.lineJoin = 'round';
      g.lineWidth = o.lineW;
      g.strokeStyle = o.halo;
      g.strokeText(text, 0, 0);
    }
    g.fillStyle = o.fill;
    g.fillText(text, 0, 0);
    g.restore();
  }

  function drawBadge(g, text, x, y, fs, o) {
    g.save();
    g.globalAlpha = o.opacity ?? 1;
    g.font = `800 ${fs}px Cairo, sans-serif`;
    const tw = g.measureText(text).width;
    const padX = fs * 0.6;
    const h = fs * 1.55;
    const w = tw + padX * 2;
    roundRect(g, x - w / 2, y - h / 2, w, h, h / 2);
    g.fillStyle = o.active ? o.amber : o.bg;
    g.fill();
    g.lineWidth = Math.max(2, fs * 0.08);
    g.strokeStyle = o.amber;
    g.stroke();
    g.fillStyle = o.active ? o.amberInk : o.fg;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, x, y + fs * 0.04);
    g.restore();
  }

  /* ---------- Fonts & basemap tiles ---------- */
  async function ensureFonts() {
    try {
      await Promise.all([
        document.fonts.load('800 64px Cairo'),
        document.fonts.load('600 32px Cairo'),
      ]);
    } catch (_) { /* خط احتياطي */ }
  }

  function loadTile(url, timeoutMs = 9000) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      const timer = setTimeout(() => { img.src = ''; resolve(null); }, timeoutMs);
      img.onload = () => { clearTimeout(timer); resolve(img); };
      img.onerror = () => { clearTimeout(timer); resolve(null); };
      img.src = url;
    });
  }

  async function drawBasemap(g, L, templates, dark, onProgress) {
    const tileM = (z) => (2 * HALF_WORLD) / Math.pow(2, z);
    const rangeFor = (z) => {
      const t = tileM(z);
      return {
        x0: Math.floor((L.bounds.minX + HALF_WORLD) / t),
        x1: Math.floor((L.bounds.maxX + HALF_WORLD) / t),
        y0: Math.max(0, Math.floor((HALF_WORLD - L.bounds.maxY) / t)),
        y1: Math.min(Math.pow(2, z) - 1, Math.floor((HALF_WORLD - L.bounds.minY) / t)),
      };
    };

    let z = clamp(Math.round(Math.log2(L.scale * TILE_M_PER_PX_Z0)), 1, 19);
    let r = rangeFor(z);
    while ((r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1) > 220 && z > 1) {
      z -= 1;
      r = rangeFor(z);
    }

    const t = tileM(z);
    const size = t * L.scale;
    let loaded = 0;

    for (let ti = 0; ti < templates.length; ti++) {
      const tpl = templates[ti];
      const jobs = [];
      for (let tx = r.x0; tx <= r.x1; tx++) {
        for (let ty = r.y0; ty <= r.y1; ty++) {
          const url = tpl
            .replace('{z}', z).replace('{x}', tx).replace('{y}', ty)
            .replace('{s}', 'a').replace('{r}', '');
          const mxL = -HALF_WORLD + tx * t;
          const myT = HALF_WORLD - ty * t;
          const [px, py] = L.toPx(mxL, myT);
          jobs.push(loadTile(url).then((img) => {
            if (img) g.drawImage(img, px, py, size + 0.5, size + 0.5);
            return !!img;
          }));
        }
      }
      const res = await Promise.all(jobs);
      loaded += res.filter(Boolean).length;
      onProgress?.(15 + ((ti + 1) / templates.length) * 15, 'تحميل خلفية الخريطة');
    }

    if (loaded) {
      g.fillStyle = dark ? PALETTE.dark.wash : PALETTE.light.wash;
      g.fillRect(0, L.mapY0, L.W, L.mapH);
    }
    return loaded;
  }

  function streetWidth(h) {
    return { motorway: 16, trunk: 16, primary: 14, secondary: 11, tertiary: 9, residential: 6, unclassified: 6, living_street: 5, service: 4 }[h] || 6;
  }

  /* ---------- Presets: each export style is a set of switches ---------- */
  function bgOf(ctx) {
    return (ctx.dark ? PALETTE.dark : PALETTE.light).bg;
  }

  function presetOptions(style, ctx, format) {
    if (style === 'outline') {
      return {
        dark: false,
        background: format === 'png' ? null : '#FFFFFF',   // PNG شفاف، JPEG بخلفية بيضاء
        useBasemap: false,
        blockFill: true, fillAlpha: 0, selAlpha: 0.22, otherAlpha: 0,
        blockLines: true, onlySelected: true,
        showAreaBoundary: false, showParcels: false, showStreets: false,
        streetLabels: 'none', showHouses: 'none', blockLabels: 'selected',
        showHeader: false, showFooter: false,
      };
    }
    if (style === 'context') {
      return {
        dark: ctx.dark, background: bgOf(ctx), useBasemap: true,
        blockFill: true, fillAlpha: 0.24, selAlpha: 0.40, otherAlpha: 0.08,
        blockLines: true, onlySelected: false,
        showAreaBoundary: false, showParcels: true, showStreets: true,
        streetLabels: 'all', showHouses: 'selected', blockLabels: 'all',
        showHeader: true, showFooter: true,
      };
    }
    if (style === 'detailed') {
      return {
        dark: ctx.dark, background: bgOf(ctx), useBasemap: false,
        blockFill: false, blockLines: CONFIG.FULL_SHOW_BLOCK_LINES, onlySelected: false,
        showAreaBoundary: true, showParcels: CONFIG.FULL_SHOW_PARCELS, showStreets: true,
        streetLabels: 'all', showHouses: 'all',
        blockLabels: CONFIG.FULL_SHOW_BLOCK_LINES ? 'all' : 'none',
        showHeader: true, showFooter: true,
      };
    }
    // boundary: حدود المنطقة فقط
    return {
      dark: ctx.dark, background: bgOf(ctx), useBasemap: false,
      blockFill: false, blockLines: false, onlySelected: false,
      showAreaBoundary: true, showParcels: false, showStreets: false,
      streetLabels: 'none', showHouses: 'none', blockLabels: 'none',
      showHeader: true, showFooter: true,
    };
  }

  /* ---------- Scene ---------- */
  async function drawScene(ctx, L, o) {
    await ensureFonts();
    const pal = o.dark ? PALETTE.dark : PALETTE.light;
    const u = unitOf(L.W);
    const sel = o.block || null;
    const plain = !o.useBasemap;
    const teal = pal.teal;
    const streetFill = plain ? pal.text : pal.street;
    const streetCase = plain ? pal.bg : pal.streetCasing;

    const canvas = document.createElement('canvas');
    canvas.width = L.W;
    canvas.height = L.H;
    const g = canvas.getContext('2d');

    if (o.background) {
      g.fillStyle = o.background;
      g.fillRect(0, 0, L.W, L.H);
    }

    if (o.useBasemap && ctx.basemap && ctx.basemap.length) {
      await drawBasemap(g, L, ctx.basemap, o.dark, o.onProgress);
    }

    // 1) حدود المنطقة
    if (o.showAreaBoundary) {
      g.beginPath();
      tracePolygon(g, ctx.boundary.geometry, L);
      g.lineJoin = 'round';
      g.strokeStyle = pal.amber;
      g.lineWidth = 7 * u;
      g.stroke();
    }

    // 2) البلوكات
    o.onProgress?.(35, 'رسم البلوكات');
    for (const b of ctx.blocks) {
      if (!b.feature) continue;
      const isSel = !!sel && b.number === sel.number;
      if (o.onlySelected && !isSel) continue;
      if (!o.blockFill && !o.blockLines && !isSel) continue;
      g.beginPath();
      tracePolygon(g, b.feature.geometry, L);
      if (o.blockFill) {
        const a = isSel ? o.selAlpha : sel ? o.otherAlpha : o.fillAlpha;
        g.fillStyle = `hsla(${b.hue}, 72%, 58%, ${a})`;
        g.fill('evenodd');
      }
      if (o.blockLines || isSel) {
        g.strokeStyle = `hsl(${b.hue}, 80%, ${o.dark ? 72 : 38}%)`;
        g.lineWidth = (isSel ? 7 : 3) * u;
        g.stroke();
      }
    }

    // 3) القطع
    if (o.showParcels) {
      o.onProgress?.(45, 'رسم القطع');
      for (const p of ctx.parcels) {
        const inSel = sel ? p.block === sel.number : true;
        g.beginPath();
        tracePolygon(g, p.geometry, L);
        g.fillStyle = `rgba(${teal}, ${inSel ? 0.20 : 0.06})`;
        g.fill('evenodd');
        g.setLineDash(p.source === 'synthetic' ? [5 * u, 4 * u] : []);
        g.lineWidth = (inSel ? 1.8 : 1) * u;
        g.strokeStyle = `rgba(${teal}, ${inSel ? 0.95 : 0.25})`;
        g.stroke();
      }
      g.setLineDash([]);
    }

    // 4) الشوارع
    if (o.showStreets) {
      o.onProgress?.(55, 'رسم الشوارع');
      g.lineCap = 'round';
      g.lineJoin = 'round';
      for (const s of ctx.streets) {
        g.beginPath();
        tracePath(g, s.geometry.coordinates, L);
        g.strokeStyle = streetCase;
        g.lineWidth = streetWidth(s.properties.highway) * u + 2.5 * u;
        g.stroke();
      }
      for (const s of ctx.streets) {
        g.beginPath();
        tracePath(g, s.geometry.coordinates, L);
        g.strokeStyle = streetFill;
        g.lineWidth = streetWidth(s.properties.highway) * u;
        g.stroke();
      }
    }

    // 5) أسماء الشوارع على خطوطها
    if (o.showStreets && o.streetLabels === 'all') {
      o.onProgress?.(65, 'كتابة أسماء الشوارع');
      const font = `600 ${(plain ? 22 : 26) * u}px Cairo, sans-serif`;
      const max = sel ? CONFIG.BLOCK_STREET_LABEL_MAX : CONFIG.FULL_STREET_LABEL_MAX;
      g.font = font;
      let count = 0;
      for (const s of ctx.streets) {
        if (count >= max) break;
        const c = s.geometry.coordinates;
        if (c.length < 2) continue;
        const mid = Math.floor(c.length / 2);
        const [mx, my] = L.project(c[mid][0], c[mid][1]);
        if (mx < L.mapX0 || mx > L.mapX0 + L.mapW || my < L.mapY0 || my > L.mapY0 + L.mapH) continue;

        const a = L.project(c[Math.max(0, mid - 1)][0], c[Math.max(0, mid - 1)][1]);
        const b = L.project(c[Math.min(c.length - 1, mid + 1)][0], c[Math.min(c.length - 1, mid + 1)][1]);
        const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const textW = g.measureText(s.properties.name).width;
        if (segLen < textW * 1.1) continue;

        let ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
        if (ang > Math.PI / 2) ang -= Math.PI;
        if (ang < -Math.PI / 2) ang += Math.PI;

        drawText(g, s.properties.name, mx, my, {
          font, fill: pal.text, halo: pal.halo, lineW: 6 * u, rotate: ang,
        });
        count++;
      }
    }

    // 6) أرقام البيوت
    if (o.showHouses !== 'none') {
      o.onProgress?.(75, 'كتابة أرقام البيوت');
      const fill = plain ? pal.text : '#FFFFFF';
      const halo = plain ? pal.bg : 'rgba(0,0,0,0.85)';
      const minFs = (plain ? 9 : 12) * u;
      const maxFs = (plain ? 26 : 34) * u;
      for (const p of ctx.parcels) {
        if (o.showHouses === 'selected' && (!sel || p.block !== sel.number)) continue;
        const [x, y] = L.project(p.lng, p.lat);
        if (x < L.mapX0 - 50 || x > L.mapX0 + L.mapW + 50 || y < L.mapY0 - 50 || y > L.mapY0 + L.mapH + 50) continue;
        const fs = clamp(Math.sqrt(p.area) * L.pxPerMeter * 0.42, minFs, maxFs);
        drawText(g, String(p.house), x, y, {
          font: `700 ${fs}px Cairo, sans-serif`, fill, halo, lineW: fs * 0.18,
        });
      }
    }

    // 7) شارات البلوكات
    if (o.blockLabels !== 'none') {
      o.onProgress?.(85, 'كتابة أرقام البلوكات');
      for (const b of ctx.blocks) {
        if (!b.feature) continue;
        const isSel = !!sel && b.number === sel.number;
        if (o.blockLabels === 'selected' && !isSel) continue;
        const [x, y] = L.project(b.labelLL[0], b.labelLL[1]);
        const fs = (isSel ? 62 : sel ? 30 : 40) * u;
        drawBadge(g, `بلوك #${pad2(b.number)}`, x, y, fs, {
          bg: pal.badgeBg, fg: pal.text, amber: pal.amber, amberInk: pal.amberInk,
          active: isSel, opacity: sel && !isSel ? 0.65 : 1,
        });
      }
    }

    // 8) الترويسة والمفتاح والإطار
    if (o.showHeader) {
      g.strokeStyle = pal.sub;
      g.lineWidth = 2 * u;
      g.strokeRect(L.mapX0, L.mapY0, L.mapW, L.mapH);

      g.fillStyle = pal.header;
      g.fillRect(0, 0, L.W, L.headerH);
      g.fillStyle = pal.amber;
      g.fillRect(0, L.headerH - 4 * u, L.W, 4 * u);

      g.textBaseline = 'middle';
      g.textAlign = 'right';
      g.fillStyle = pal.text;
      g.font = `800 ${74 * u}px Cairo, sans-serif`;
      g.fillText(o.title, L.W - L.margin, L.headerH * 0.36);
      g.font = `600 ${38 * u}px Cairo, sans-serif`;
      g.fillStyle = pal.sub;
      g.fillText(o.subtitle, L.W - L.margin, L.headerH * 0.7);

      drawLegend(g, L, legendItems(o), pal, u, streetFill);
    }

    // 9) التذييل
    if (o.showFooter) {
      drawNorth(g, L, pal, u);
      drawScaleBar(g, L, pal, u);
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      g.fillStyle = pal.sub;
      g.font = `500 ${24 * u}px Cairo, sans-serif`;
      g.fillText(o.footer, L.margin, L.H - L.footerH / 2);
    }

    return canvas;
  }

  function legendItems(o) {
    const items = [];
    if (o.showAreaBoundary) items.push({ kind: 'area', label: 'حدود المنطقة' });
    if (o.blockLines) items.push({ kind: 'block', label: 'حدود البلوك' });
    if (o.showParcels) {
      items.push({ kind: 'parcel', label: 'قطعة مسجّلة' });
      items.push({ kind: 'estimate', label: 'قطعة مقدّرة' });
    }
    if (o.showStreets) items.push({ kind: 'street', label: 'شارع' });
    if (o.showHouses !== 'none') items.push({ kind: 'house', label: 'رقم البيت' });
    return items;
  }

  function drawLegend(g, L, items, pal, u, streetFill) {
    const n = items.length;
    const lx = L.margin;
    const sw = 60 * u;
    const sh = 26 * u;
    items.forEach((item, i) => {
      const y = n > 1 ? L.headerH * (0.25 + i * (0.55 / (n - 1))) : L.headerH * 0.5;
      g.save();
      g.lineWidth = 3 * u;
      if (item.kind === 'area') {
        g.strokeStyle = pal.amber; g.lineWidth = 6 * u;
        g.beginPath(); g.moveTo(lx, y); g.lineTo(lx + sw, y); g.stroke();
      } else if (item.kind === 'block') {
        g.strokeStyle = pal.amber; g.lineWidth = 3 * u;
        g.strokeRect(lx, y - sh / 2, sw, sh);
      } else if (item.kind === 'parcel') {
        g.fillStyle = `rgba(${pal.teal}, 0.25)`; g.strokeStyle = `rgba(${pal.teal}, 0.95)`; g.lineWidth = 2 * u;
        g.fillRect(lx, y - sh / 2, sw, sh); g.strokeRect(lx, y - sh / 2, sw, sh);
      } else if (item.kind === 'estimate') {
        g.fillStyle = `rgba(${pal.teal}, 0.25)`; g.strokeStyle = `rgba(${pal.teal}, 0.95)`; g.lineWidth = 2 * u;
        g.setLineDash([5 * u, 4 * u]);
        g.fillRect(lx, y - sh / 2, sw, sh); g.strokeRect(lx, y - sh / 2, sw, sh);
      } else if (item.kind === 'street') {
        g.strokeStyle = streetFill; g.lineWidth = 8 * u; g.lineCap = 'round';
        g.beginPath(); g.moveTo(lx, y); g.lineTo(lx + sw, y); g.stroke();
      } else if (item.kind === 'house') {
        g.restore();
        drawText(g, '12', lx + sw / 2, y, { font: `700 ${30 * u}px Cairo, sans-serif`, fill: pal.text, halo: pal.bg, lineW: 4 * u });
        g.save();
      }
      g.restore();
      drawText(g, item.label, lx + sw + 16 * u, y, {
        font: `600 ${30 * u}px Cairo, sans-serif`, fill: pal.text, align: 'left',
      });
    });
  }

  function drawNorth(g, L, pal, u) {
    const x = L.mapX0 + L.mapW - 50 * u;
    const y = L.mapY0 + 60 * u;
    g.save();
    g.fillStyle = pal.text;
    g.beginPath();
    g.moveTo(x, y - 40 * u);
    g.lineTo(x + 22 * u, y + 30 * u);
    g.lineTo(x, y + 14 * u);
    g.lineTo(x - 22 * u, y + 30 * u);
    g.closePath();
    g.fill();
    g.restore();
    drawText(g, 'ش', x, y + 52 * u, { font: `800 ${30 * u}px Cairo, sans-serif`, fill: pal.text, baseline: 'top' });
  }

  function drawScaleBar(g, L, pal, u) {
    const candidates = [50, 100, 200, 500, 1000, 2000, 5000];
    let len = 50;
    for (const c of candidates) {
      if (c * L.pxPerMeter <= L.W * 0.2) len = c;
    }
    const px = len * L.pxPerMeter;
    const x = L.mapX0 + 30 * u;
    const y = L.mapY0 + L.mapH - 40 * u;
    g.save();
    g.fillStyle = pal.header;
    g.fillRect(x - 20 * u, y - 70 * u, px + 40 * u, 90 * u);
    g.strokeStyle = pal.text;
    g.lineWidth = 4 * u;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + px, y);
    g.stroke();
    g.restore();
    drawText(g, len >= 1000 ? `${len / 1000} كم` : `${len} م`, x, y - 10 * u, {
      font: `700 ${26 * u}px Cairo, sans-serif`, fill: pal.text, align: 'left', baseline: 'bottom',
    });
  }

  /* ---------- PNG DPI metadata (pHYs) ---------- */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function makePngChunk(type, data) {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  }

  async function setPngDpi(blob, dpi) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const ppm = Math.round(dpi / 0.0254);
    const data = new Uint8Array(9);
    const dv = new DataView(data.buffer);
    dv.setUint32(0, ppm);
    dv.setUint32(4, ppm);
    data[8] = 1;
    const chunk = makePngChunk('pHYs', data);
    const out = new Uint8Array(buf.length + chunk.length);
    out.set(buf.subarray(0, 33), 0);
    out.set(chunk, 33);
    out.set(buf.subarray(33), 33 + chunk.length);
    return new Blob([out], { type: 'image/png' });
  }

  function canvasToBlob(canvas, format) {
    return new Promise((resolve, reject) => {
      const type = format === 'jpeg' ? 'image/jpeg' : 'image/png';
      canvas.toBlob(async (blob) => {
        if (!blob) return reject(new Error('تعذّر إنشاء الصورة. جرّب دقة أقل'));
        try {
          resolve(type === 'image/png' ? await setPngDpi(blob, PRINT_DPI) : blob);
        } catch (err) {
          reject(err);
        }
      }, type, 0.95);
    });
  }

  /* ---------- Public API ---------- */
  function footerText(ctx) {
    return `${ctx.attribution ? ctx.attribution + '  ·  ' : ''}المصدر: OpenStreetMap  ·  القطع المقدّرة تقريبية وليست سجلاً رسمياً`;
  }

  function extOf(format) {
    return format === 'jpeg' ? 'jpg' : 'png';
  }

  /** تصدير بلوك واحد: style = 'context' | 'outline' */
  async function renderBlockBlob(ctx, block, { width, format, style, onProgress }) {
    const outline = style === 'outline';
    const layout = outline
      ? buildLayout(width, mercBoundsOfBBox(block.bbox), { pad: 0.06, maxAspect: 1.4, header: false, footer: false })
      : buildLayout(width, mercBoundsOfBBox(block.bbox), { pad: 0.16, maxAspect: 1.5 });
    const canvas = await drawScene(ctx, layout, {
      ...presetOptions(style, ctx, format),
      block,
      title: ctx.areaLabel,
      subtitle: `بلوك #${pad2(block.number)}  ·  ${fmt(block.count)} قطعة  ·  ${fmt(block.streets.size)} شارع  ·  ${fmt(block.area)} م²`,
      footer: footerText(ctx),
      onProgress,
    });
    onProgress?.(92, 'إنشاء ملف الصورة');
    const blob = await canvasToBlob(canvas, format);
    canvas.width = 0;
    canvas.height = 0;
    return blob;
  }

  /** تصدير الخريطة الكاملة: style = 'detailed' | 'boundary' */
  async function renderFullBlob(ctx, { width, format, style, onProgress }) {
    const layout = buildLayout(width, mercBoundsOfBBox(ctx.bbox), { pad: 0.03, maxAspect: 1.4 });
    const canvas = await drawScene(ctx, layout, {
      ...presetOptions(style, ctx, format),
      block: null,
      title: ctx.areaLabel,
      subtitle: style === 'boundary'
        ? `حدود المنطقة  ·  ${fmt(ctx.blocks.length)} بلوك`
        : `خريطة مفصّلة  ·  ${fmt(ctx.streets.length)} شارع  ·  ${fmt(ctx.parcels.length)} بيت`,
      footer: footerText(ctx),
      onProgress,
    });
    onProgress?.(92, 'إنشاء ملف الصورة');
    const blob = await canvasToBlob(canvas, format);
    canvas.width = 0;
    canvas.height = 0;
    return blob;
  }

  async function exportBlock(ctx, block, opts = {}) {
    const style = opts.style || 'context';
    const format = opts.format || 'png';
    const blob = await renderBlockBlob(ctx, block, { width: opts.width || 3508, format, style, onProgress: opts.onProgress });
    const suffix = style === 'outline' ? 'حدود بلوك' : 'بلوك';
    saveAs(blob, `${safeName(ctx.areaLabel)} - ${suffix} ${pad2(block.number)}.${extOf(format)}`);
    opts.onProgress?.(100, 'تم الحفظ');
  }

  async function exportFull(ctx, opts = {}) {
    const style = opts.style || 'detailed';
    const format = opts.format || 'png';
    const blob = await renderFullBlob(ctx, { width: opts.width || 3508, format, style, onProgress: opts.onProgress });
    const name = style === 'boundary' ? 'حدود المنطقة' : 'خريطة مفصّلة';
    saveAs(blob, `${safeName(ctx.areaLabel)} - ${name}.${extOf(format)}`);
    opts.onProgress?.(100, 'تم الحفظ');
  }

  async function exportBatch(ctx, opts = {}) {
    const style = opts.style || 'context';
    const format = opts.format || 'png';
    const total = ctx.blocks.length;
    const zip = new JSZip();

    for (let i = 0; i < total; i++) {
      const b = ctx.blocks[i];
      const base = (i / total) * 100;
      const span = 100 / total;
      const blob = await renderBlockBlob(ctx, b, {
        width: opts.width || 3508,
        format,
        style,
        onProgress: (p, text) => opts.onProgress?.(base + (span * p) / 100, `بلوك ${i + 1} من ${total} · ${text || ''}`.trim()),
      });
      zip.file(`block-${pad2(b.number)}.${extOf(format)}`, blob);
      await tick();
    }

    opts.onProgress?.(98, 'ضغط الملفات');
    const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    const suffix = style === 'outline' ? 'حدود البلوكات' : 'كل البلوكات';
    saveAs(zipBlob, `${safeName(ctx.areaLabel)} - ${suffix}.zip`);
    opts.onProgress?.(100, 'تم');
  }

  global.BlockExporter = { exportBlock, exportFull, exportBatch };
})(window);
