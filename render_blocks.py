#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
render_blocks.py
================
يقرأ ملف GeoJSON الناتج من fetch_egypt_gis.py، ويقسّم المنطقة إلى N بلوك
(K-Means + Voronoi مقصوص بحدود المنطقة)، ثم يرسم صورة PNG عالية الدقة لكل بلوك
ويجمعها في ملف ZIP.

الاستخدام:
    pip install numpy shapely matplotlib arabic-reshaper
    python render_blocks.py --geojson data/marg-cairo.geojson --blocks 35 --out out/blocks
"""

import argparse
import json
import math
import shutil
from pathlib import Path

import arabic_reshaper
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager
from matplotlib.patches import PathPatch
from matplotlib.path import Path as MplPath
import numpy as np
from shapely.geometry import MultiPoint, Point, box, shape
from shapely.ops import voronoi_diagram


def ar(text):
    """تشكيل النص العربي (الترتيب تتولاه matplotlib نفسها)."""
    return arabic_reshaper.reshape(str(text))


def pick_font():
    """يختار أول خط يدعم العربية من الموجود على الجهاز."""
    preferred = ["Noto Naskh Arabic", "Noto Sans Arabic", "Amiri", "Cairo", "DejaVu Sans"]
    names = {f.name for f in font_manager.fontManager.ttflist}
    for name in preferred:
        if name in names:
            return name
    return "DejaVu Sans"


def load_geojson(path):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    boundary = None
    streets, parcels = [], []
    for f in data.get("features", []):
        kind = f.get("properties", {}).get("kind")
        geom = shape(f["geometry"])
        if kind == "boundary":
            boundary = geom
        elif kind == "street":
            streets.append((geom, f["properties"].get("highway", "")))
        elif kind == "parcel":
            parcels.append({
                "geom": geom,
                "house": str(f["properties"].get("house", "")),
                "street": f["properties"].get("street", ""),
                "centroid": geom.centroid,
            })
    if boundary is None:
        raise SystemExit("الملف لا يحتوي على حدود المنطقة (kind: boundary)")
    return boundary, streets, parcels


def sample_grid_points(boundary, n, rng):
    """نقاط عشوائية داخل المنطقة، تُستخدم عندما تكون القطع قليلة."""
    minx, miny, maxx, maxy = boundary.bounds
    pts = []
    tries = 0
    while len(pts) < n and tries < n * 50:
        x = rng.uniform(minx, maxx)
        y = rng.uniform(miny, maxy)
        if boundary.contains(Point(x, y)):
            pts.append((x, y))
        tries += 1
    return pts


def kmeans(X, k, rng, iters=50):
    centers = [X[rng.integers(len(X))]]
    for _ in range(1, k):
        C = np.array(centers)
        d2 = np.min(((X[:, None, :] - C[None]) ** 2).sum(-1), axis=1)
        total = d2.sum()
        idx = rng.choice(len(X), p=d2 / total) if total > 0 else rng.integers(len(X))
        centers.append(X[idx])
    C = np.array(centers)
    for _ in range(iters):
        labels = np.argmin(((X[:, None, :] - C[None]) ** 2).sum(-1), axis=1)
        newC = np.array([
            X[labels == c].mean(axis=0) if np.any(labels == c) else X[rng.integers(len(X))]
            for c in range(k)
        ])
        if np.allclose(newC, C):
            break
        C = newC
    return C


def partition(boundary, points, k, seed):
    """يعيد قائمة بلوكات: (site, polygon) مرتبة بترقيم منطقي من الشمال للجنوب."""
    rng = np.random.default_rng(seed)
    cos_lat = math.cos(math.radians(boundary.centroid.y))

    if len(points) < k * 2:
        points = points + sample_grid_points(boundary, max(500, k * 40), rng)

    X = np.array(points, dtype=float)
    X[:, 0] *= cos_lat
    C = kmeans(X, k, rng)
    sites = C.copy()
    sites[:, 0] /= cos_lat

    minx, miny, maxx, maxy = boundary.bounds
    pad = max(maxx - minx, maxy - miny) * 0.2
    envelope = box(minx - pad, miny - pad, maxx + pad, maxy + pad)
    cells = list(voronoi_diagram(MultiPoint([tuple(s) for s in sites]), envelope=envelope).geoms)

    blocks = []
    for s in sites:
        pt = Point(s)
        cell = next((c for c in cells if c.contains(pt)), None)
        poly = cell.intersection(boundary) if cell is not None else None
        if poly is None or poly.is_empty:
            poly = pt.buffer(0.002)
        blocks.append({"site": (float(s[0]), float(s[1])), "geom": poly})

    # ترقيم منطقي: صفوف من الشمال للجنوب، والصف المتعرج من الغرب للشرق ثم العكس
    minx, miny, maxx, maxy = boundary.bounds
    width = (maxx - minx) * cos_lat
    height = maxy - miny
    aspect = max(width, 1e-9) / max(height, 1e-9)
    cols = max(1, round(math.sqrt(len(blocks) * aspect)))
    by_lat = sorted(blocks, key=lambda b: -b["site"][1])
    ordered = []
    for r in range(0, len(by_lat), cols):
        row = by_lat[r:r + cols]
        row.sort(key=lambda b: b["site"][0], reverse=(r // cols) % 2 == 1)
        ordered.extend(row)
    for i, b in enumerate(ordered, start=1):
        b["number"] = i
    return ordered


def assign_parcels(blocks, parcels):
    for b in blocks:
        b["parcels"] = []
    for p in parcels:
        hit = next((b for b in blocks if b["geom"].contains(p["centroid"])), None)
        if hit is None:
            hit = min(blocks, key=lambda b: (b["site"][0] - p["centroid"].x) ** 2
                      + (b["site"][1] - p["centroid"].y) ** 2)
        hit["parcels"].append(p)


def polygon_patch(geom, **kwargs):
    """يرسم Polygon أو MultiPolygon كمسار واحد مع دعم الثقوب."""
    geoms = geom.geoms if hasattr(geom, "geoms") else [geom]
    paths = []
    for g in geoms:
        for ring in [g.exterior, *g.interiors]:
            paths.append(np.asarray(ring.coords))
    vertices, codes = [], []
    for ring in paths:
        vertices.extend(ring.tolist())
        codes.extend([MplPath.MOVETO] + [MplPath.LINETO] * (len(ring) - 2) + [MplPath.CLOSEPOLY])
    return PathPatch(MplPath(vertices, codes), **kwargs)


STREET_WIDTH = {"motorway": 3.2, "trunk": 3.2, "primary": 2.8, "secondary": 2.2,
                "tertiary": 1.8, "residential": 1.2, "unclassified": 1.2}


def render_block(block, blocks, streets, boundary, area_name, out_file, dpi, size_in, font):
    minx, miny, maxx, maxy = block["geom"].bounds
    dx, dy = maxx - minx, maxy - miny
    pad = max(dx, dy) * 0.12
    xlim = (minx - pad, maxx + pad)
    ylim = (miny - pad, maxy + pad)

    aspect = (ylim[1] - ylim[0]) / (xlim[1] - xlim[0])
    fig, ax = plt.subplots(figsize=(size_in, size_in * aspect + 1.4), dpi=dpi)
    fig.patch.set_facecolor("#0E1A24")
    ax.set_facecolor("#0E1A24")
    ax.set_xlim(*xlim)
    ax.set_ylim(*ylim)
    ax.set_aspect(1 / math.cos(math.radians(block["site"][1])))
    ax.set_axis_off()

    # حدود المنطقة
    ax.add_patch(polygon_patch(boundary, facecolor="none", edgecolor="#3A4C5E", linewidth=1.5))

    # الشوارع
    for geom, hw in streets:
        xs, ys = geom.xy
        ax.plot(xs, ys, color="#E8A33D", alpha=0.55,
                linewidth=STREET_WIDTH.get(hw, 0.9), solid_capstyle="round", zorder=2)

    # القطع: الباقي خافت، وقطع البلوك المحدد واضحة
    for b in blocks:
        if b is block:
            continue
        for p in b["parcels"]:
            ax.add_patch(polygon_patch(p["geom"], facecolor="#2A9D8F", alpha=0.07,
                                       edgecolor="#2A9D8F", linewidth=0.2, zorder=3))
    for p in block["parcels"]:
        ax.add_patch(polygon_patch(p["geom"], facecolor="#2A9D8F", alpha=0.35,
                                   edgecolor="#4FD1C0", linewidth=0.8, zorder=4))
        if p["house"]:
            ax.text(p["centroid"].x, p["centroid"].y, p["house"], fontsize=5.5,
                    color="white", ha="center", va="center", zorder=6,
                    fontfamily=font,
                    path_effects=None)

    # حدود البلوك
    ax.add_patch(polygon_patch(block["geom"], facecolor="#E8A33D", alpha=0.12,
                               edgecolor="#E8A33D", linewidth=2.5, zorder=5))

    # رقم البلوك
    rp = block["geom"].representative_point()
    ax.text(rp.x, rp.y, ar(f"بلوك #{block['number']:02d}"), fontsize=16, fontweight="bold",
            color="#1A1206", ha="center", va="center", zorder=7, fontfamily=font,
            bbox=dict(boxstyle="round,pad=0.4", facecolor="#E8A33D", edgecolor="none"))

    # ترويسة
    n_streets = len({p["street"] for p in block["parcels"]})
    fig.text(0.04, 0.965, ar(area_name), fontsize=22, fontweight="bold",
             color="#F7F3EA", ha="left", va="top", fontfamily=font)
    fig.text(0.04, 0.925,
             ar(f"بلوك #{block['number']:02d}   ·   {len(block['parcels'])} قطعة   ·   {n_streets} شارع"),
             fontsize=12, color="#B8C2CC", ha="left", va="top", fontfamily=font)
    fig.text(0.04, 0.02,
             ar("المصدر: OpenStreetMap · القطع المقدّرة تقريبية وليست سجلاً رسمياً"),
             fontsize=8, color="#8A96A3", ha="left", va="bottom", fontfamily=font)

    fig.savefig(out_file, dpi=dpi, facecolor=fig.get_facecolor())
    plt.close(fig)


def main():
    ap = argparse.ArgumentParser(description="رسم صورة PNG لكل بلوك + ZIP")
    ap.add_argument("--geojson", required=True)
    ap.add_argument("--blocks", type=int, default=35)
    ap.add_argument("--out", default="out/blocks")
    ap.add_argument("--dpi", type=int, default=200)
    ap.add_argument("--size-in", type=float, default=12.0)
    ap.add_argument("--name", default=None, help="اسم المنطقة المكتوب على الصورة")
    args = ap.parse_args()

    boundary, streets, parcels = load_geojson(args.geojson)
    area_name = args.name or Path(args.geojson).stem
    font = pick_font()
    print(f"[i] الخط: {font}  |  قطع: {len(parcels)}  |  شوارع: {len(streets)}")

    points = [(p["centroid"].x, p["centroid"].y) for p in parcels]
    blocks = partition(boundary, points, args.blocks, seed=len(points) + args.blocks)
    assign_parcels(blocks, parcels)

    out_dir = Path(args.out)
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)

    for b in blocks:
        f = out_dir / f"block-{b['number']:02d}.png"
        render_block(b, blocks, streets, boundary, area_name, f, args.dpi, args.size_in, font)
        print(f"[✓] {f.name}  ({len(b['parcels'])} قطعة)")

    zip_base = out_dir.parent / f"{out_dir.name}"
    shutil.make_archive(str(zip_base), "zip", out_dir)
    print(f"[✓] ZIP: {zip_base}.zip  |  بلوكات: {len(blocks)}")


if __name__ == "__main__":
    main()
