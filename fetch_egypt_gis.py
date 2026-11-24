#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fetch_egypt_gis.py
==================
سكريبت اختياري لسحب بيانات منطقة مصرية من OpenStreetMap وحفظها كملف GeoJSON
محلي، فيحمّل التطبيق المنطقة فورًا على GitHub Pages بدون انتظار Overpass.

ما يفعله:
  1. يبحث عن المنطقة في Nominatim ويجلب حدودها الإدارية (Polygon).
  2. يجلب من Overpass الشوارع المسماة، المباني، وأرقام البيوت (addr:housenumber).
  3. يربط أرقام البيوت بالمباني التي تحتويها، ويُنشئ قطعًا صغيرة لأرقام البيوت المعزولة.
  4. يكتب ملفًا بصيغة FeatureCollection يحتوي على ثلاثة أنواع:
       kind = "boundary" | "street" | "parcel"

ملاحظة: القطع الناقصة لا يملؤها هذا السكريبت. يقوم التطبيق نفسه بتوليدها
عند التحميل (Smart Fallback) وتعليمها كـ "مقدّرة"، لذلك يبقى الملف الناتج نظيفًا.

التثبيت:
    pip install requests shapely

التشغيل:
    python fetch_egypt_gis.py --query "المرج، القاهرة، مصر" --out data/marg-cairo.geojson

بعد التشغيل، أضف الملف إلى CONFIG.prebuilt في app.js:
    prebuilt: [{ match: ['المرج'], file: 'data/marg-cairo.geojson' }],

احترام سياسة الاستخدام: Nominatim يطلب طلبًا واحدًا في الثانية كحد أقصى،
ولذلك يتضمن السكريبت تأخيرًا بعد كل طلب. ضع بريدك في HEADERS.
"""

import argparse
import json
import math
import re
import sys
import time
from pathlib import Path

import requests
from shapely.geometry import LineString, MultiPolygon, Point, Polygon, mapping, shape

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
HEADERS = {
    "User-Agent": "egypt-gis-blocks/1.0 (educational project; contact: your-email@example.com)",
    "Accept-Language": "ar,en;q=0.8",
}
HIGHWAY_TYPES = (
    "motorway|trunk|primary|secondary|tertiary|unclassified|"
    "residential|living_street|service|road"
)
PARCEL_HALF_LEN_M = 6.0  # نصف طول القطعة للبيت المعزول (بالمتر)


def log(msg):
    print(msg, file=sys.stderr)


def geocode(query):
    """يبحث عن المنطقة ويعيد أفضل نتيجة مع حدودها."""
    q = query if re.search(r"مصر|egypt", query, re.IGNORECASE) else f"{query}، مصر"
    params = {
        "q": q,
        "format": "json",
        "polygon_geojson": 1,
        "limit": 1,
        "accept-language": "ar",
        "countrycodes": "eg",
    }
    res = requests.get(NOMINATIM_URL, params=params, headers=HEADERS, timeout=30)
    res.raise_for_status()
    results = res.json()
    time.sleep(1.1)  # سياسة Nominatim: طلب واحد في الثانية
    if not results:
        raise SystemExit("لم يتم العثور على المنطقة. جرّب اسمًا أدق.")
    return results[0]


def boundary_of(place):
    """يعيد شكل المنطقة (Polygon/MultiPolygon). إن لم يتوفر، يستخدم مربعًا حول المركز."""
    geo = place.get("geojson")
    if geo and geo.get("type") in ("Polygon", "MultiPolygon"):
        return shape(geo)
    lat, lon = float(place["lat"]), float(place["lon"])
    d = 0.0135  # ~1.5 كم
    log("[!] لا يوجد مضلع إداري لهذه المنطقة، سيُستخدم مربع تقريبي حول المركز.")
    return Polygon([(lon - d, lat - d), (lon + d, lat - d), (lon + d, lat + d), (lon - d, lat + d)])


def overpass(bounds):
    """يجلب الشوارع والمباني وأرقام البيوت داخل المستطيل المحيط بالمنطقة."""
    minx, miny, maxx, maxy = bounds
    bbox = f"{miny},{minx},{maxy},{maxx}"
    query = f"""[out:json][timeout:120];
(
  way["highway"~"^({HIGHWAY_TYPES})$"]({bbox});
  way["building"]({bbox});
  way["addr:housenumber"]({bbox});
  node["addr:housenumber"]({bbox});
);
out geom;"""
    last_err = None
    for endpoint in OVERPASS_ENDPOINTS:
        try:
            log(f"[i] Overpass: {endpoint}")
            res = requests.post(endpoint, data={"data": query}, headers=HEADERS, timeout=180)
            res.raise_for_status()
            return res.json()
        except Exception as exc:  # noqa: BLE001 - نجرب الخادم التالي
            last_err = exc
            log(f"[!] فشل {endpoint}: {exc}")
    raise SystemExit(f"تعذّر الاتصال بـ Overpass: {last_err}")


def square_around(lng, lat, half_m):
    """مربع صغير حول نقطة (يُستخدم لبيت رقم معزول لا يقع داخل مبنى مسجّل)."""
    dlat = half_m / 111_320
    dlng = half_m / (111_320 * math.cos(math.radians(lat)))
    return Polygon([
        (lng - dlng, lat - dlat), (lng + dlng, lat - dlat),
        (lng + dlng, lat + dlat), (lng - dlng, lat + dlat),
    ])


def largest_part(geom):
    """يحوّل MultiPolygon إلى أكبر جزء (القطعة الواحدة لا تحتاج أكثر من جزء)."""
    if isinstance(geom, MultiPolygon):
        return max(geom.geoms, key=lambda g: g.area)
    return geom


def parcel_feature(geom, house, street):
    return {
        "type": "Feature",
        "geometry": mapping(largest_part(geom)),
        "properties": {"kind": "parcel", "house": house, "street": street, "source": "osm"},
    }


def build_collection(boundary, osm):
    streets, buildings, nodes = [], [], []

    for el in osm.get("elements", []):
        tags = el.get("tags", {})
        geom = el.get("geometry") or []

        if el["type"] == "way" and "highway" in tags and len(geom) > 1:
            line = LineString([(p["lon"], p["lat"]) for p in geom])
            if not line.intersects(boundary):
                continue
            name = tags.get("name:ar") or tags.get("name") or tags.get("ref") or "طريق داخلي"
            streets.append({
                "type": "Feature",
                "geometry": mapping(line),
                "properties": {"kind": "street", "name": name, "highway": tags["highway"]},
            })

        elif el["type"] == "way" and len(geom) >= 3 and ("building" in tags or "addr:housenumber" in tags):
            ring = [(p["lon"], p["lat"]) for p in geom]
            try:
                poly = Polygon(ring).buffer(0)
            except Exception:  # noqa: BLE001
                continue
            if poly.is_empty or not boundary.contains(poly.centroid):
                continue
            buildings.append({
                "geom": poly,
                "house": tags.get("addr:housenumber", ""),
                "street": tags.get("addr:street", ""),
            })

        elif el["type"] == "node" and "addr:housenumber" in tags:
            nodes.append({
                "pt": Point(el["lon"], el["lat"]),
                "house": tags["addr:housenumber"],
                "street": tags.get("addr:street", ""),
            })

    # ربط أرقام البيوت (nodes) بالمباني التي تحتويها
    orphans = []
    for n in nodes:
        hit = next((b for b in buildings if b["geom"].contains(n["pt"])), None)
        if hit:
            hit["house"] = hit["house"] or n["house"]
            hit["street"] = hit["street"] or n["street"]
        else:
            orphans.append(n)

    features = [{"type": "Feature", "geometry": mapping(boundary), "properties": {"kind": "boundary"}}]
    features.extend(streets)
    features.extend(parcel_feature(b["geom"], b["house"], b["street"]) for b in buildings)

    for n in orphans:
        if boundary.contains(n["pt"]):
            features.append(parcel_feature(square_around(n["pt"].x, n["pt"].y, PARCEL_HALF_LEN_M),
                                           n["house"], n["street"]))

    return features, {"streets": len(streets), "buildings": len(buildings), "orphans": len(orphans)}


def main():
    ap = argparse.ArgumentParser(description="سحب بيانات منطقة مصرية من OSM إلى GeoJSON محلي")
    ap.add_argument("--query", default="المرج، القاهرة، مصر", help="اسم المنطقة")
    ap.add_argument("--out", default="data/marg-cairo.geojson", help="مسار ملف الإخراج")
    args = ap.parse_args()

    log(f"[i] البحث عن: {args.query}")
    place = geocode(args.query)
    log(f"[i] وُجدت: {place.get('display_name', '')}")

    boundary = boundary_of(place)
    features, stats = build_collection(boundary, overpass(boundary.bounds))

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "type": "FeatureCollection",
        "meta": {
            "query": args.query,
            "display_name": place.get("display_name", ""),
            "source": "OpenStreetMap (ODbL) via Overpass API",
            **stats,
        },
        "features": features,
    }
    out.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    log(f"[✓] تم الحفظ: {out}  |  شوارع: {stats['streets']}  مباني: {stats['buildings']}  "
        f"أرقام معزولة: {stats['orphans']}")


if __name__ == "__main__":
    main()
