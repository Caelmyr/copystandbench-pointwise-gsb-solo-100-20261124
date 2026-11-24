"""Seal one selected frame and one named detail as immutable proof."""

from hashlib import sha256
import json
from pathlib import Path
from shutil import copyfile
from zipfile import ZIP_DEFLATED, ZipFile

from PIL import Image

from image_lab.validation import timestamp

from .analysis import inspect_image
from .photos import png


def seal(folder, identifier, record, capture, region, source_path):
    """Write the crop at native source resolution, together with its reference."""
    folder = Path(folder)
    copyfile(source_path, folder / "source.png")
    with Image.open(folder / "source.png") as original:
        image = png(original.crop(region["bounds"]))
        reading = inspect_image(original, region, record["scale"])
    (folder / "detail.png").write_bytes(image)
    proof = {"id": identifier, "created": timestamp(), "project": record["id"],
             "title": record["title"], "synthetic": record["synthetic"],
             "project_revision": record["revision"], "capture": capture, "region": region,
             "scale": record["scale"], "reading": reading, "detail_sha256": sha256(image).hexdigest()}
    (folder / "review.json").write_text(json.dumps(proof, ensure_ascii=False, allow_nan=False, indent=2),
                                        encoding="utf-8")
    with ZipFile(folder / "review.zip", "w", compression=ZIP_DEFLATED) as archive:
        for name in ("review.json", "source.png", "detail.png"):
            archive.write(folder / name, name)
    return proof
