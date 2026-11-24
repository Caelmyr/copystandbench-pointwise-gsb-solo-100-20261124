"""Seal one adopted starting step and its checked boxes as immutable proof."""

from hashlib import sha256
import json
from pathlib import Path
from shutil import copyfile
from zipfile import ZIP_DEFLATED, ZipFile

from PIL import Image

from image_lab.validation import timestamp

from .analysis import inspect_image
from .photos import png


def _safe_name(region):
    return "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in region["id"])


def seal(folder, identifier, record, capture, regions, focus_start, source_path):
    """Write the adopted frame and a native crop of every checked box.

    Each box is stored together with the reading at the adopted step and the
    reference used for the 85% pass line, so a review stays usable even when
    the live boxes are later redrawn or removed.
    """
    folder = Path(folder)
    copyfile(source_path, folder / "source.png")
    evaluation = focus_start["evaluation"]
    box_results = {item["box"]: item for item in evaluation["box_results"]}
    boxes = []
    with Image.open(folder / "source.png") as original:
        for region in regions:
            detail_name = "detail-" + _safe_name(region) + ".png"
            image = png(original.crop(region["bounds"]))
            (folder / detail_name).write_bytes(image)
            result = box_results[region["id"]]
            adopted_sample = next(sample for sample in result["samples"]
                                  if sample["capture"] == capture["id"])
            boxes.append({
                "box": region["id"], "name": region["name"], "bounds": region["bounds"],
                "detail": detail_name, "detail_sha256": sha256(image).hexdigest(),
                "reading": inspect_image(original, region, record["scale"]),
                "adopted_sample": adopted_sample,
                "reference": result["reference"], "threshold": result["threshold"],
                "samples": result["samples"],
            })
    proof = {"id": identifier, "created": timestamp(), "project": record["id"],
             "title": record["title"], "synthetic": record["synthetic"],
             "project_revision": record["revision"], "kind": "focus_start",
             "capture": capture, "step": capture["step"],
             "pass_ratio": evaluation["pass_ratio"],
             "min_tone_span": evaluation["min_tone_span"],
             "recommendation": evaluation["recommendation"],
             "candidates": evaluation["candidates"],
             "scale": record["scale"], "boxes": boxes,
             # Legacy single-box fields keep old review renderers and ZIP
             # consumers working: the first checked box is the headline one.
             "region": regions[0],
             "reading": boxes[0]["reading"]}
    (folder / "review.json").write_text(json.dumps(proof, ensure_ascii=False, allow_nan=False, indent=2),
                                        encoding="utf-8")
    with ZipFile(folder / "review.zip", "w", compression=ZIP_DEFLATED) as archive:
        archive.write(folder / "review.json", "review.json")
        archive.write(folder / "source.png", "source.png")
        for box in boxes:
            archive.write(folder / box["detail"], box["detail"])
    return proof
