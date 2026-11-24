"""Store a calibration sweep, its registered coordinates and sealed evidence."""

from hashlib import sha256
import json
from pathlib import Path
import re
from shutil import rmtree
from threading import RLock
from uuid import uuid4

from werkzeug.exceptions import NotFound

from image_lab.validation import Conflict, Invalid, integer, text, timestamp

from . import coordinates, demo, lighting, photos, reporting


ID_PATTERN = re.compile("[a-f0-9]{16}")
MAX_SHOTS = 25
MAX_STORED = 160 * 1024 * 1024
MAX_BOXES = 8


def key(value):
    if not isinstance(value, str) or ID_PATTERN.fullmatch(value) is None:
        raise NotFound("找不到这一组校准记录。")
    return value


def read(path):
    try:
        return json.loads(path.read_bytes())
    except FileNotFoundError:
        raise NotFound("找不到这一组校准记录。") from None


def put_json(path, record):
    temp = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    try:
        temp.write_text(json.dumps(record, ensure_ascii=False, allow_nan=False), encoding="utf-8")
        temp.replace(path)
    finally:
        temp.unlink(missing_ok=True)


def record_item(items, identifier, label):
    key(identifier)
    for item in items:
        if item["id"] == identifier:
            return item
    raise NotFound(f"找不到所选{label}。")


def capture_at(record, identifier):
    return record_item(record["captures"], identifier, "原照")


def region_at(record, identifier):
    return record_item(record["boxes"], identifier, "检查框")


class Workspace:
    def __init__(self, root):
        self.root = Path(root) / "sweeps"
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = RLock()

    def folder(self, project):
        return self.root / key(project)

    def record(self, project):
        return read(self.folder(project) / "sweep.json")

    def list(self):
        projects = (read(path) for path in self.root.glob("[0-9a-f]*/sweep.json"))
        rows = [{name: record[name] for name in ("id", "title", "created", "synthetic")} for record in projects]
        return sorted(rows, key=lambda item: item["created"], reverse=True)

    def create(self, title, synthetic=False):
        identifier = uuid4().hex[:16]
        final = self.folder(identifier)
        staging = self.root / ("." + identifier)
        staging.mkdir()
        try:
            (staging / "photos").mkdir()
            (staging / "proofs").mkdir()
            record = {"id": identifier, "title": text(title, "台位名称", 84, empty=False), "created": timestamp(),
                      "synthetic": synthetic, "revision": 1, "size": None, "captures": [], "boxes": [],
                      "selected": None, "scale": None}
            if synthetic:
                for step, frame in demo.sequence():
                    self.store_capture(staging, record, step, frame, f"校准卡 {step:+d}", {"synthetic": True})
                for box in demo.BOXES:
                    record["boxes"].append({"id": uuid4().hex[:16], **box})
                record["scale"] = coordinates.ruler(demo.SCALE, record["size"])
            put_json(staging / "sweep.json", record)
            staging.rename(final)
            return record
        finally:
            if staging.exists():
                rmtree(staging)

    def current(self, project, revision):
        record = self.record(project)
        if integer(revision, "修订号", 1) != record["revision"]:
            raise Conflict("这组校准记录已有新变化，请重新打开。")
        return record

    def commit(self, folder, record):
        record["revision"] += 1
        put_json(folder / "sweep.json", record)
        return record

    def store_capture(self, folder, record, step, image, name, origin):
        if len(record["captures"]) >= MAX_SHOTS:
            raise Invalid("每组最多保存 25 档。")
        if any(shot["step"] == step for shot in record["captures"]):
            raise Invalid("该档位已有原照，请选择空档。")
        size = list(image.size)
        if record["size"] is not None and size != record["size"]:
            raise Invalid("同组原照转正后的像素尺寸必须相同。")
        raw = photos.png(image)
        if len(raw) + sum(shot["bytes"] for shot in record["captures"]) > MAX_STORED:
            raise Invalid("本组保存的原照不能超过 160 MiB。")
        identifier = uuid4().hex[:16]
        originals = folder / "photos"
        source, preview = originals / f"{identifier}.png", originals / f"{identifier}.jpg"
        preview_bytes = photos.thumbnail(image)
        try:
            source.write_bytes(raw)
            preview.write_bytes(preview_bytes)
        except OSError:
            source.unlink(missing_ok=True)
            preview.unlink(missing_ok=True)
            raise
        stored = {"id": identifier, "step": step, "name": name, "bytes": len(raw),
                  "sha256": sha256(raw).hexdigest(), "origin": origin}
        record["size"] = size
        record["captures"].append(stored)
        record["captures"].sort(key=lambda shot: shot["step"])
        return stored

    def add_capture(self, project, revision, step, image, name, origin=None):
        step = integer(step, "档位", -99, 99)
        title = text(name.strip()[:84], "照片名称", 84) or "原照"
        with self.lock:
            record = self.current(project, revision)
            folder = self.folder(project)
            stored = self.store_capture(folder, record, step, image, title, origin)
            try:
                self.commit(folder, record)
            except OSError:
                for suffix in ("png", "jpg"):
                    (folder / "photos" / f"{stored['id']}.{suffix}").unlink(missing_ok=True)
                raise
        return record

    def capture_path(self, project, identifier, preview=False, record=None):
        record = self.record(project) if record is None else record
        capture = capture_at(record, identifier)
        return self.folder(project) / "photos" / (capture["id"] + (".jpg" if preview else ".png"))

    def edit_region(self, project, revision, value, region_id=None):
        with self.lock:
            record = self.current(project, revision)
            if record["size"] is None:
                raise Invalid("请先导入一档照片。")
            if region_id is None:
                if len(record["boxes"]) >= MAX_BOXES:
                    raise Invalid("每组最多保留八个检查框。")
                region = {"id": uuid4().hex[:16]}
                record["boxes"].append(region)
            else:
                region = region_at(record, region_id)
            region.update(name=text(value.get("name"), "检查框名称", 48, empty=False),
                          bounds=coordinates.box_bounds(value.get("bounds"), record["size"]))
            return self.commit(self.folder(project), record)

    def delete_region(self, project, revision, region_id):
        with self.lock:
            record = self.current(project, revision)
            record["boxes"].remove(region_at(record, region_id))
            return self.commit(self.folder(project), record)

    def set_scale(self, project, revision, value):
        with self.lock:
            record = self.current(project, revision)
            if record["size"] is None:
                raise Invalid("请先导入原照。")
            record["scale"] = coordinates.ruler(value, record["size"]) if value is not None else None
            return self.commit(self.folder(project), record)

    def adopt(self, project, revision, capture_id):
        with self.lock:
            record = self.current(project, revision)
            record["selected"] = capture_at(record, capture_id)["id"]
            return self.commit(self.folder(project), record)

    def proof_list(self, project):
        self.record(project)
        proofs = (read(path) for path in (self.folder(project) / "proofs").glob("[0-9a-f]*/review.json"))
        return sorted((dict(proof, kind=proof.get("kind", "capture")) for proof in proofs),
                      key=lambda item: item["created"], reverse=True)

    def proof(self, project, identifier):
        folder = self.folder(project) / "proofs" / key(identifier)
        record = read(folder / "review.json")
        record.setdefault("kind", "capture")
        return folder, record

    def seal(self, project, revision, region_id):
        with self.lock:
            record = self.current(project, revision)
            if record["selected"] is None:
                raise Invalid("请先采用一档原照。")
            capture = capture_at(record, record["selected"])
            region = region_at(record, region_id)
            identifier = uuid4().hex[:16]
            parent = self.folder(project) / "proofs"
            staging = parent / ("." + identifier)
            staging.mkdir()
            try:
                proof = reporting.seal(staging, identifier, record, capture, region,
                                       self.capture_path(project, capture["id"], record=record))
                staging.rename(parent / identifier)
                return proof
            finally:
                if staging.exists():
                    rmtree(staging)

    def seal_lighting(self, project, revision, first_id, second_id, region_id):
        with self.lock:
            record = self.current(project, revision)
            first = capture_at(record, first_id)
            second = capture_at(record, second_id)
            if first["id"] == second["id"]:
                raise Invalid("布光检查需要两张不同的换位原照。")
            region = region_at(record, region_id)
            result = lighting.analyze(
                [first, second], region,
                lambda capture: self.capture_path(project, capture, record=record))
            assets = lighting.crop_assets(
                result, lambda capture: self.capture_path(project, capture, record=record))
            identifier = uuid4().hex[:16]
            parent = self.folder(project) / "proofs"
            staging = parent / ("." + identifier)
            staging.mkdir()
            try:
                for name, data in assets.items():
                    (staging / name).write_bytes(data)
                proof = {"id": identifier, "kind": "lighting", "created": timestamp(),
                         "project": record["id"], "title": record["title"],
                         "synthetic": record["synthetic"], "project_revision": record["revision"],
                         "lighting": result,
                         "crops_sha256": {name: sha256(data).hexdigest() for name, data in assets.items()}}
                put_json(staging / "review.json", proof)
                staging.rename(parent / identifier)
                self.commit(self.folder(project), record)
                return proof
            finally:
                if staging.exists():
                    rmtree(staging)
