"""Observe one region of an upright source without resampling."""

import cv2
import numpy as np
from PIL import Image, ImageDraw

from image_lab.arrays import luminance

from .coordinates import box_dimensions
from .photos import png


def focus_reading(gray):
    detail = cv2.Laplacian(gray, cv2.CV_32F, ksize=3)
    score = float(np.mean(np.square(detail[2:-2, 2:-2])))
    low, high = np.percentile(gray, (5, 95))
    return {"score": round(score, 4), "tone_span": round(float(high - low), 2)}


def lighting_reading(raster, gray):
    cells = [[float(np.median(cell)) for cell in np.array_split(row, 3, axis=1)]
             for row in np.array_split(gray, 3, axis=0)]
    values = np.asarray(cells)
    center = float(values[1, 1])
    channel_mean = raster.mean(axis=(0, 1))
    usable = center > 0.5
    return {"median_grid": np.round(values, 1).tolist(),
            "center_falloff_pct": round(100 * (center - float(values.min())) / center, 2) if usable else None,
            "rgb_means": np.round(channel_mean, 1).tolist(),
            "channel_spread": round(float(np.ptp(channel_mean)), 2),
            "clippedWhitePct": round(100 * float(np.mean(np.all(raster >= 250, axis=2))), 2)}


def inspect_image(source, region, scale=None):
    patch = source.crop(region["bounds"])
    raster = np.asarray(patch)
    gray = luminance(raster)
    return {"box": region, "focus": focus_reading(gray), "lighting": lighting_reading(raster, gray),
            "physical": box_dimensions(region["bounds"], scale)}


def inspect_path(path, region, scale=None):
    with Image.open(path) as source:
        return inspect_image(source, region, scale)


def single_box_curve(captures, region, source_path):
    curve = []
    for capture in sorted(captures, key=lambda shot: shot["step"]):
        with Image.open(source_path(capture["id"])) as source:
            gray = luminance(np.asarray(source.crop(region["bounds"])))
            curve.append({"capture": capture["id"], "step": capture["step"], **focus_reading(gray)})
    return {"box": region, "samples": curve}


def clipping_overlay(path):
    with Image.open(path) as source:
        image = source.copy()
    pixels = np.asarray(image)
    clipped = np.all(pixels >= 250, axis=2)
    under = np.all(pixels <= 5, axis=2)
    dimmed = np.round(pixels.astype(np.float32) * 0.70).astype(np.uint8)
    dimmed[clipped] = [250, 65, 36]
    dimmed[under] = [42, 120, 248]
    return png(Image.fromarray(dimmed))


def contact_sheet(captures, source_path, selected):
    columns, tile_width, tile_height = 5, 196, 152
    rows = max(1, (len(captures) + columns - 1) // columns)
    sheet = Image.new("RGB", (columns * tile_width, rows * tile_height), "#162014")
    draw = ImageDraw.Draw(sheet)
    for index, shot in enumerate(sorted(captures, key=lambda item: item["step"])):
        x = index % columns * tile_width
        y = index // columns * tile_height
        with Image.open(source_path(shot["id"])) as source:
            source.thumbnail((tile_width - 18, tile_height - 32), Image.Resampling.LANCZOS)
            sheet.paste(source, (x + (tile_width - source.width) // 2, y + (tile_height - 28 - source.height) // 2))
        chosen = shot["id"] == selected
        color = "#e4f476" if chosen else "#dce8d3"
        draw.text((x + 10, y + tile_height - 23), f"STEP {shot['step']:+d}" + (" / ADOPTED" if chosen else ""), fill=color)
        if chosen:
            draw.rectangle((x + 3, y + 3, x + tile_width - 4, y + tile_height - 4), outline=color, width=2)
    return png(sheet)
