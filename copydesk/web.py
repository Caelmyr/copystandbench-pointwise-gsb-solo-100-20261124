"""Expose the copy-stand inspection desk and photo preparation transfer."""

from io import BytesIO
from pathlib import Path
import re

from flask import Blueprint, jsonify, render_template, request, send_file

from image_lab import create_app as create_preparation
from image_lab.validation import Invalid, object_value

from . import analysis, lighting, photos
from .workspace import Workspace, capture_at, region_at


def body():
    return object_value(request.get_json(silent=True), "俯拍台操作")


def png(data, filename, attachment=False):
    return send_file(BytesIO(data), mimetype="image/png", max_age=0, download_name=filename,
                     as_attachment=attachment)


def create_app(root):
    app = create_preparation(root / "prepare")
    library = Workspace(root)
    desk = Blueprint("copydesk", __name__, url_prefix="/copydesk")

    @app.get("/")
    def home():
        return render_template("copystand.html")

    @desk.get("/health")
    def health():
        return jsonify(status="ready", service="copystand")

    @desk.route("/projects", methods=["GET", "POST"])
    def projects():
        if request.method == "GET":
            return jsonify(library.list())
        return jsonify(library.create(body().get("title"))), 201

    @desk.post("/demo")
    def demo():
        return jsonify(library.create("合成校准片 · A3 复制台", synthetic=True)), 201

    @desk.get("/projects/<project>")
    def open_project(project):
        return jsonify(library.record(project))

    @desk.post("/projects/<project>/captures")
    def upload(project):
        source = request.files.get("image")
        if source is None or not source.filename:
            raise Invalid("请选择一张原照。")
        image = photos.decode(source.stream.read(photos.MAX_UPLOAD + 1))
        record = library.add_capture(project, request.form.get("revision"), request.form.get("step"), image,
                                     Path(source.filename).stem)
        return jsonify(record), 201

    @desk.post("/projects/<project>/prepared")
    def prepared(project):
        value = body()
        prep_project, result = value.get("project"), value.get("result")
        if not isinstance(prep_project, str) or not isinstance(result, str):
            raise Invalid("请选择已经生成的照片准备结果。")
        preparation = app.extensions["results"]
        if preparation.metadata(prep_project, result)["stale"]:
            raise Invalid("请先重新计算照片准备结果。")
        with preparation.image_path(prep_project, "image", result).open("rb") as file:
            image = photos.decode(file.read(photos.MAX_UPLOAD + 1))
        origin = {"preparation_project": prep_project, "preparation_result": result}
        return jsonify(library.add_capture(project, value.get("revision"), value.get("step"), image,
                                           "照片准备结果", origin)), 201

    @desk.post("/projects/<project>/boxes")
    def add_region(project):
        value = body()
        return jsonify(library.edit_region(project, value.get("revision"), value)), 201

    @desk.route("/projects/<project>/boxes/<region>", methods=["PATCH", "DELETE"])
    def edit_region(project, region):
        value = body()
        if request.method == "DELETE":
            return jsonify(library.delete_region(project, value.get("revision"), region))
        return jsonify(library.edit_region(project, value.get("revision"), value, region))

    @desk.patch("/projects/<project>/scale")
    def scale(project):
        value = body()
        return jsonify(library.set_scale(project, value.get("revision"), value.get("ruler")))

    @desk.patch("/projects/<project>/adopt")
    def adopt(project):
        value = body()
        return jsonify(library.adopt(project, value.get("revision"), value.get("capture")))

    @desk.get("/projects/<project>/captures/<capture>/source.png")
    def source(project, capture):
        return send_file(library.capture_path(project, capture), mimetype="image/png",
                         download_name=capture + ".png", as_attachment="download" in request.args)

    @desk.get("/projects/<project>/captures/<capture>/thumb.jpg")
    def thumb(project, capture):
        return send_file(library.capture_path(project, capture, preview=True), mimetype="image/jpeg")

    @desk.get("/projects/<project>/captures/<capture>/exposure")
    def exposure(project, capture):
        return jsonify(photos.exposure(library.capture_path(project, capture)))

    @desk.get("/projects/<project>/captures/<capture>/clipping.png")
    def clipping(project, capture):
        return png(analysis.clipping_overlay(library.capture_path(project, capture)), "clipping.png")

    @desk.get("/projects/<project>/captures/<capture>/boxes/<region>")
    def inspect(project, capture, region):
        record = library.record(project)
        return jsonify(analysis.inspect_path(library.capture_path(project, capture, record=record),
                                             region_at(record, region), record["scale"]))

    @desk.get("/projects/<project>/captures/<capture>/boxes/<region>/detail.png")
    def detail(project, capture, region):
        from PIL import Image

        record = library.record(project)
        bounds = region_at(record, region)["bounds"]
        with Image.open(library.capture_path(project, capture, record=record)) as source:
            crop = photos.png(source.crop(bounds))
        return png(crop, "crop-" + capture + "-" + region + ".png", "download" in request.args)

    @desk.get("/projects/<project>/boxes/<region>/curve")
    def curve(project, region):
        record = library.record(project)
        return jsonify(analysis.single_box_curve(record["captures"], region_at(record, region),
                                                lambda capture: library.capture_path(project, capture, record=record)))

    @desk.get("/projects/<project>/contact.png")
    def contact(project):
        record = library.record(project)
        sheet = analysis.contact_sheet(record["captures"],
                                       lambda capture: library.capture_path(project, capture, record=record),
                                       record["selected"])
        return png(sheet, "copystand-contact.png", "download" in request.args)

    @desk.route("/projects/<project>/proofs", methods=["GET", "POST"])
    def proofs(project):
        if request.method == "GET":
            return jsonify(library.proof_list(project))
        value = body()
        return jsonify(library.seal(project, value.get("revision"), value.get("box"))), 201

    @desk.post("/projects/<project>/lighting/check")
    def lighting_check(project):
        value = body()
        record = library.record(project)
        first = capture_at(record, value.get("first"))
        second = capture_at(record, value.get("second"))
        region = region_at(record, value.get("box"))
        result = lighting.analyze(
            [first, second], region,
            lambda capture: library.capture_path(project, capture, record=record))
        lighting.attach_inline_crops(
            result, lambda capture: library.capture_path(project, capture, record=record))
        return jsonify(result)

    @desk.post("/projects/<project>/lighting/proofs")
    def lighting_seal(project):
        value = body()
        proof = library.seal_lighting(project, value.get("revision"), value.get("first"),
                                      value.get("second"), value.get("box"))
        return jsonify(proof), 201

    @desk.get("/projects/<project>/proofs/<proof>")
    def proof_record(project, proof):
        return jsonify(library.proof(project, proof)[1])

    @desk.get("/projects/<project>/proofs/<proof>/<file>")
    def proof_file(project, proof, file):
        folder, _ = library.proof(project, proof)
        allowed = {"review.json", "review.zip", "source.png", "detail.png"}
        if file not in allowed and re.fullmatch(r"p[123]-[ab]-(left|right)\.png", file) is None:
            raise Invalid("这不是复核单的附件。")
        path = folder / file
        if not path.is_file():
            raise Invalid("这不是复核单的附件。")
        return send_file(path, download_name=file,
                         as_attachment=file == "review.zip" or "download" in request.args)

    app.register_blueprint(desk)
    return app
