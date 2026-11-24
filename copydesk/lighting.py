"""左右灯布光检查：同一块灰卡转 180° 的两张原照对照。

检查框按 2 列 × 3 行切成左右六格，同一水平带的左右两格配成一对（共三对）。
灰卡围绕台面中心转 180° 后，原来在左格的卡面 P 落到右格、原来在右格的卡面 Q
落到左格。分别追踪 P、Q 两块卡面在换位前后的读数，得到两个方向一致的
「左位照度 / 右位照度」估计，卡面本身的深浅在比值里消掉，留下的只是左右灯的
照度差。亮度一律在 sRGB 反编码后的线性空间估计。
"""

import base64
from io import BytesIO

import numpy as np
from PIL import Image

from image_lab.arrays import srgb_decode
from image_lab.validation import Invalid

from .photos import png

NEAR_BLACK = 5
NEAR_WHITE = 250
CLIP_LIMIT = 0.25
RATIO_DRIFT = 0.10
DIM_LIMIT = 0.05
ROWS = 3
COLS = 2

# (左格 (列,行), 换位后该卡面落到的右格 (列,行))，行列均从 0 起。
# 围绕同一中心转 180° 后，一行左格的同一块卡面落到同一行的右格（同行配对），
# 这样两次观测处于同一条水平带上，不会把上下照度梯度算进左右灯差。
PAIRS = (
    {"id": "p1", "name": "上排 · 左上对右上", "left": (0, 0), "right": (1, 0)},
    {"id": "p2", "name": "中排 · 左中对右中", "left": (0, 1), "right": (1, 1)},
    {"id": "p3", "name": "下排 · 左下对右下", "left": (0, 2), "right": (1, 2)},
)


def split_edges(length, parts):
    """与 numpy.array_split 一致的等份边界（左上包含、右下不包含）。"""
    bounds, start = [], 0
    for index in range(parts):
        size = (length + parts - 1 - index) // parts
        bounds.append((start, start + size))
        start += size
    return bounds


def cell_bounds(box_bounds):
    x0, y0, x1, y1 = box_bounds
    xs = split_edges(x1 - x0, COLS)
    ys = split_edges(y1 - y0, ROWS)
    grid = {}
    for col, (cx0, cx1) in enumerate(xs):
        for row, (ry0, ry1) in enumerate(ys):
            grid[(col, row)] = [x0 + cx0, y0 + ry0, x0 + cx1, y0 + ry1]
    return grid


def linear_luminance(raster):
    linear = srgb_decode(raster.astype(np.float32) / 255.0)
    weights = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    return linear @ weights


def cell_observation(raster, bounds):
    x0, y0, x1, y1 = bounds
    patch = raster[y0:y1, x0:x1]
    if patch.shape[0] == 0 or patch.shape[1] == 0:
        raise Invalid("检查框分格后出现空格。")
    near_black = float(np.mean(np.all(patch <= NEAR_BLACK, axis=2)))
    near_white = float(np.mean(np.all(patch >= NEAR_WHITE, axis=2)))
    lum = linear_luminance(patch)
    return {"bounds": [int(v) for v in (x0, y0, x1, y1)],
            "mean_linear": float(lum.mean()),
            "near_black_pct": round(100.0 * near_black, 2),
            "near_white_pct": round(100.0 * near_white, 2),
            "clipped": near_black > CLIP_LIMIT or near_white > CLIP_LIMIT,
            "pixels": int(patch.shape[0] * patch.shape[1])}


def load_raster(path):
    with Image.open(path) as source:
        return np.asarray(source.convert("RGB"))


def pair_analysis(pair, cells, rasters):
    left_key, right_key = pair["left"], pair["right"]
    shots = []
    clipped = []
    for label, raster in (("a", rasters[0]), ("b", rasters[1])):
        left = cell_observation(raster, cells[left_key])
        right = cell_observation(raster, cells[right_key])
        shots.append({"shot": label, "left": left, "right": right})
        for side, cell in (("left", left), ("right", right)):
            if cell["clipped"]:
                clipped.append(f"照片{label.upper()}{'左' if side == 'left' else '右'}格"
                               f"近黑 {cell['near_black_pct']}%／近白 {cell['near_white_pct']}%")

    result = {"id": pair["id"], "name": pair["name"],
              "left_cell": list(left_key), "right_cell": list(right_key),
              "left_bounds": cells[left_key], "right_bounds": cells[right_key],
              "shots": shots, "usable": False, "excluded_reason": None,
              "ratio_a": None, "ratio_b": None, "ratio_drift_pct": None,
              "lighting_ratio": None, "bright_side": None, "dim_side": None,
              "dim_pct": None, "is_dim": False}

    if clipped:
        result["excluded_reason"] = "近黑或近白像素超过四分之一：" + "；".join(clipped)
        return result

    left_a, right_a = shots[0]["left"], shots[0]["right"]
    left_b, right_b = shots[1]["left"], shots[1]["right"]
    # 同一行的两个物理卡面：P 原在左格、Q 原在右格；转 180° 后 P 到 B 的右格、Q 到 B 的左格。
    # 两个观测都统一到「左位照度 / 右位照度」方向，卡面反射率在比值里消掉：
    # e1 追踪 P 卡（A 左位读数 / B 右位读数），e2 追踪 Q 卡（B 左位读数 / A 右位读数）。
    ratio_a = left_a["mean_linear"] / right_b["mean_linear"]
    ratio_b = left_b["mean_linear"] / right_a["mean_linear"]
    if not (np.isfinite(ratio_a) and np.isfinite(ratio_b)) or ratio_a <= 0 or ratio_b <= 0:
        result["excluded_reason"] = "分格亮度为零，无法估计亮度比。"
        return result
    drift = abs(ratio_a - ratio_b) / min(ratio_a, ratio_b)
    result["ratio_a"] = round(ratio_a, 4)
    result["ratio_b"] = round(ratio_b, 4)
    result["ratio_drift_pct"] = round(100.0 * drift, 2)
    if drift > RATIO_DRIFT:
        result["excluded_reason"] = f"两个换位观测的左右亮度比相差 {result['ratio_drift_pct']}%（超过 10%），证据对不上。"
        return result

    # e1、e2 追踪的是同一对左右位置，只是用了两块不同卡面；各自的卡面反射率已在
    # 交叉比值中消掉，几何平均给出更稳健的左位/右位照度比。
    lighting_ratio = float(np.sqrt(ratio_a * ratio_b))
    result["lighting_ratio"] = round(lighting_ratio, 4)
    result["usable"] = True
    if lighting_ratio >= 1.0:
        result["bright_side"] = "left"
        result["dim_side"] = "right"
        result["dim_pct"] = round(100.0 * (lighting_ratio - 1.0) / lighting_ratio, 2)
    else:
        result["bright_side"] = "right"
        result["dim_side"] = "left"
        result["dim_pct"] = round(100.0 * (1.0 - lighting_ratio), 2)
    result["is_dim"] = result["dim_pct"] >= 5.0
    return result


def recommendation(pairs):
    dim_pairs = [item for item in pairs if item["usable"] and item["is_dim"]]
    if not dim_pairs:
        return {"action": "none", "side": None, "support": [],
                "message": "可用配对的左右亮度差都在 5% 以内，两盏灯暂不需要补亮。"}
    votes = {"left": [item for item in dim_pairs if item["dim_side"] == "left"],
             "right": [item for item in dim_pairs if item["dim_side"] == "right"]}
    side = "left" if len(votes["left"]) >= len(votes["right"]) else "right"
    chosen = votes[side]
    if len(votes["left"]) == len(votes["right"]):
        side = "left" if max(item["dim_pct"] for item in votes["left"]) >= \
                         max(item["dim_pct"] for item in votes["right"]) else "right"
        chosen = votes[side]
    worst = max(chosen, key=lambda item: item["dim_pct"])
    label = "左" if side == "left" else "右"
    support = [item["name"] for item in chosen]
    message = (f"建议先补亮{label}侧灯：{len(chosen)} 对显示{label}侧偏暗"
               f"（最严重为{worst['name']}，偏暗 {worst['dim_pct']}%）。支持本次决定的配对："
               + "、".join(support) + "。")
    return {"action": "brighten", "side": side,
            "support": [item["id"] for item in chosen], "message": message}


def analyze(captures, region, path_for):
    """captures: (照片A, 照片B)；返回完整布光检查结果（含内联裁片）。"""
    if captures[0]["id"] == captures[1]["id"]:
        raise Invalid("布光检查需要两张不同的换位原照。")
    paths = [path_for(capture["id"]) for capture in captures]
    rasters = [load_raster(path) for path in paths]
    if rasters[0].shape[:2] != rasters[1].shape[:2]:
        raise Invalid("两张原照像素尺寸不一致，不能对照。")
    cells = cell_bounds(region["bounds"])
    pairs = [pair_analysis(pair, cells, rasters) for pair in PAIRS]
    usable = [item for item in pairs if item["usable"]]
    missing = [item["name"] for item in pairs if not item["usable"]]
    summary = {"usable_count": len(usable), "total_pairs": len(pairs),
               "missing": missing, "enough": len(usable) >= 2,
               "recommendation": recommendation(pairs)}
    if not summary["enough"]:
        summary["reshoot"] = ("可用配对不足两对（缺：" + "、".join(missing) +
                              "）。请保持机位、曝光与灯位不变，重新摆放灰卡后补拍两张换位原照。")
    else:
        summary["reshoot"] = None
    return {"kind": "lighting", "captures": [{"id": c["id"], "step": c["step"], "name": c["name"]}
                                             for c in captures],
            "region": {"id": region["id"], "name": region["name"], "bounds": region["bounds"]},
            "pairs": pairs, "summary": summary}


def crop_png(raster, bounds):
    x0, y0, x1, y1 = bounds
    return png(Image.fromarray(raster[y0:y1, x0:x1]))


def inline_crop(raster, bounds):
    return "data:image/png;base64," + base64.b64encode(crop_png(raster, bounds)).decode("ascii")


def attach_inline_crops(result, path_for):
    """给实时检查结果的每个观测格内嵌原像素裁片，点开即可看。"""
    rasters = {capture["id"]: load_raster(path_for(capture["id"]))
               for capture in result["captures"]}
    for pair in result["pairs"]:
        for shot in pair["shots"]:
            capture_id = result["captures"][0 if shot["shot"] == "a" else 1]["id"]
            shot["left"]["crop"] = inline_crop(rasters[capture_id], shot["left"]["bounds"])
            shot["right"]["crop"] = inline_crop(rasters[capture_id], shot["right"]["bounds"])
    return result


def crop_assets(result, path_for):
    """封存用：产出 {文件名: png 字节}，每对四张原像素裁片。"""
    rasters = {capture["id"]: load_raster(path_for(capture["id"]))
               for capture in result["captures"]}
    assets = {}
    for pair in result["pairs"]:
        for shot in pair["shots"]:
            capture_id = result["captures"][0 if shot["shot"] == "a" else 1]["id"]
            for side in ("left", "right"):
                name = f"{pair['id']}-{shot['shot']}-{side}.png"
                assets[name] = crop_png(rasters[capture_id], shot[side]["bounds"])
    return assets
