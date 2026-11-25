/* =========================================================================
   excel.js — تصدير تفاصيل البلوكات والمنطقة إلى ملفات Excel (XLSX)
   يعتمد على مكتبة SheetJS (xlsx) المحمّلة في index.html
   ملف البلوك:  ملخص | القطع | الشوارع
   ملف المنطقة: ملخص | البلوكات | كل القطع | الشوارع
   ========================================================================= */
(function (global) {
  'use strict';

  const HOUSE_SOURCE = {
    osm: 'مسجّل في OpenStreetMap',
    estimated: 'مستنتج من موقع الشارع',
    generated: 'مُولَّد تلقائيًا',
  };
  const PARCEL_SOURCE = { osm: 'OpenStreetMap', synthetic: 'تقدير مكاني' };

  const pad2 = (n) => String(n).padStart(2, '0');
  const safeName = (s) => String(s || 'map').replace(/[\\/:*?"<>|]+/g, '').trim() || 'map';
  const houseNum = (h) => {
    const n = Number(h);
    return String(h).trim() !== '' && Number.isFinite(n) ? n : String(h ?? '');
  };

  function sortParcels(parcels) {
    return parcels.slice().sort((a, b) =>
      a.block - b.block ||
      a.street.localeCompare(b.street, 'ar') ||
      (Number(a.house) || 0) - (Number(b.house) || 0));
  }

  function parcelRows(parcels) {
    return sortParcels(parcels).map((p) => ({
      'رقم البلوك': p.block,
      'الشارع': p.street,
      'رقم البيت': houseNum(p.house),
      'المساحة (م²)': p.area,
      'Lat': +p.lat.toFixed(6),
      'Lng': +p.lng.toFixed(6),
      'مصدر القطعة': PARCEL_SOURCE[p.source] || p.source,
      'مصدر رقم البيت': HOUSE_SOURCE[p.houseSource] || '',
    }));
  }

  function streetRows(parcels) {
    const map = new Map();
    for (const p of parcels) {
      const h = Number(p.house);
      const s = map.get(p.street) || { count: 0, min: Infinity, max: -Infinity, area: 0 };
      s.count += 1;
      s.area += p.area;
      if (Number.isFinite(h)) {
        s.min = Math.min(s.min, h);
        s.max = Math.max(s.max, h);
      }
      map.set(p.street, s);
    }
    return [...map.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([name, s]) => ({
        'الشارع': name,
        'عدد القطع': s.count,
        'أقل رقم بيت': Number.isFinite(s.min) ? s.min : '',
        'أكبر رقم بيت': Number.isFinite(s.max) ? s.max : '',
        'إجمالي المساحة (م²)': Math.round(s.area),
      }));
  }

  /** ينشئ مصنف Excel مع أوراق بعرض أعمدة مناسب واتجاه من اليمين لليسار */
  function book(sheets) {
    const wb = XLSX.utils.book_new();
    sheets.forEach(({ name, rows, widths }) => {
      const data = rows.length ? rows : [{ 'ملاحظة': 'لا توجد بيانات' }];
      const ws = XLSX.utils.json_to_sheet(data);
      ws['!cols'] = widths.map((w) => ({ wch: w }));
      XLSX.utils.book_append_sheet(wb, ws, name);
    });
    wb.Workbook = {
      Views: [{ RTL: true }],
      Sheets: sheets.map(() => ({ RTL: true })),
    };
    return wb;
  }

  function exportBlock(areaLabel, block) {
    const summary = [
      { 'البند': 'المنطقة', 'القيمة': areaLabel },
      { 'البند': 'رقم البلوك', 'القيمة': `#${pad2(block.number)}` },
      { 'البند': 'كود البلوك', 'القيمة': block.code },
      { 'البند': 'إجمالي القطع / المباني', 'القيمة': block.count },
      { 'البند': 'مسجّلة (OpenStreetMap)', 'القيمة': block.real },
      { 'البند': 'مقدّرة', 'القيمة': block.synthetic },
      { 'البند': 'عدد الشوارع', 'القيمة': block.streets.size },
      { 'البند': 'مساحة البلوك (م²)', 'القيمة': block.area },
      { 'البند': 'مركز البلوك (Lat)', 'القيمة': +block.centroid[1].toFixed(6) },
      { 'البند': 'مركز البلوك (Lng)', 'القيمة': +block.centroid[0].toFixed(6) },
    ];

    const wb = book([
      { name: 'ملخص', rows: summary, widths: [28, 30] },
      { name: 'القطع', rows: parcelRows(block.parcels), widths: [12, 30, 12, 14, 12, 12, 22, 28] },
      { name: 'الشوارع', rows: streetRows(block.parcels), widths: [32, 14, 14, 14, 20] },
    ]);
    XLSX.writeFile(wb, `${safeName(areaLabel)} - بلوك ${pad2(block.number)}.xlsx`);
  }

  function exportArea(areaLabel, blocks, parcels) {
    const realCount = parcels.filter((p) => p.source === 'osm').length;
    const summary = [
      { 'البند': 'المنطقة', 'القيمة': areaLabel },
      { 'البند': 'عدد البلوكات', 'القيمة': blocks.length },
      { 'البند': 'إجمالي القطع / المباني', 'القيمة': parcels.length },
      { 'البند': 'مسجّلة (OpenStreetMap)', 'القيمة': realCount },
      { 'البند': 'مقدّرة', 'القيمة': parcels.length - realCount },
      { 'البند': 'عدد الشوارع', 'القيمة': new Set(parcels.map((p) => p.street)).size },
    ];

    const blockRows = blocks.map((b) => ({
      'رقم البلوك': b.number,
      'الكود': b.code,
      'القطع': b.count,
      'مسجّلة': b.real,
      'مقدّرة': b.synthetic,
      'الشوارع': b.streets.size,
      'المساحة (م²)': b.area,
    }));

    const wb = book([
      { name: 'ملخص', rows: summary, widths: [28, 30] },
      { name: 'البلوكات', rows: blockRows, widths: [12, 16, 10, 10, 10, 10, 14] },
      { name: 'كل القطع', rows: parcelRows(parcels), widths: [12, 30, 12, 14, 12, 12, 22, 28] },
      { name: 'الشوارع', rows: streetRows(parcels), widths: [32, 14, 14, 14, 20] },
    ]);
    XLSX.writeFile(wb, `${safeName(areaLabel)} - تفاصيل المنطقة.xlsx`);
  }

  global.BlockExcel = { exportBlock, exportArea };
})(window);
