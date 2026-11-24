"""Recommend a repeatable focus starting step from a calibration sweep.

The same calibration card is shot once per integer focus step under one fixed
camera position, lens and framing. For every checked inspection box, each box
is compared only with its own sharpest *valid* reading in this sweep:

* a reading counts as evidence only when the grey tone span is at least
  ``MIN_TONE_SPAN``; flat regions cannot serve as a focus reference;
* a capture passes a box when its score reaches ``PASS_RATIO`` of that box's
  highest valid score;
* a starting step is usable only when it and one integer step on either side
  were actually shot and every checked box passes on all three captures.
"""

import numpy as np
from PIL import Image

from image_lab.arrays import luminance
from image_lab.validation import Invalid

from .analysis import focus_reading

PASS_RATIO = 0.85
MIN_TONE_SPAN = 8.0


def _round(value, digits=4):
    return round(float(value), digits)


def checked_regions(record, box_ids):
    """Resolve and validate the checked boxes for an evaluation/adoption."""
    from .workspace import region_at

    if not isinstance(box_ids, list) or not box_ids or \
            not all(isinstance(item, str) for item in box_ids):
        raise Invalid("请至少勾选两个已有检查框。")
    unique = list(dict.fromkeys(box_ids))
    if len(unique) < 2:
        raise Invalid("请至少勾选两个已有检查框。")
    return [region_at(record, box_id) for box_id in unique]


def evaluate(captures, regions, source_path):
    """Return the full start-step evaluation for the checked regions.

    ``source_path(capture_id)`` resolves a stored capture to its upright PNG.
    The result is plain JSON-safe data so it can be shown in the desk and
    embedded verbatim in a sealed review.
    """
    shots = sorted(captures, key=lambda item: item["step"])
    steps = {shot["step"]: shot["id"] for shot in shots}
    failures = []
    warnings = []
    box_results = []

    for region in regions:
        samples = []
        valid = []
        for shot in shots:
            with Image.open(source_path(shot["id"])) as source:
                gray = luminance(np.asarray(source.crop(region["bounds"])))
            reading = focus_reading(gray)
            sample = {"capture": shot["id"], "step": shot["step"],
                      "score": reading["score"], "tone_span": reading["tone_span"],
                      "tone_valid": reading["tone_span"] >= MIN_TONE_SPAN}
            samples.append(sample)
            if sample["tone_valid"]:
                valid.append(sample)
        if not valid:
            reference = threshold = None
            for sample in samples:
                sample["passes"] = False
            failures.append({"kind": "box_no_evidence", "box": region["id"],
                             "name": region["name"],
                             "message": f"检查框“{region['name']}”没有灰阶跨度不低于 "
                                        f"{MIN_TONE_SPAN:g} 的有效读数，不能作为证据。"})
        else:
            reference = max(valid, key=lambda item: item["score"])
            threshold = _round(reference["score"] * PASS_RATIO)
            for sample in samples:
                sample["passes"] = bool(sample["tone_valid"] and sample["score"] >= threshold)
                if not sample["tone_valid"]:
                    warnings.append({"kind": "invalid_reading", "box": region["id"],
                                     "step": sample["step"], "name": region["name"],
                                     "message": f"检查框“{region['name']}”在档位 {sample['step']:+d} "
                                                f"灰阶跨度仅 {sample['tone_span']:g}，低于 "
                                                f"{MIN_TONE_SPAN:g}，该读数不能作为有效证据。"})
        box_results.append({"box": region["id"], "name": region["name"],
                            "bounds": region["bounds"], "samples": samples,
                            "reference": reference, "threshold": threshold})

    if not shots:
        failures.append({"kind": "no_captures", "message": "这一组台位还没有任何实拍照。"})

    candidates = []
    if shots and not any(item["kind"] == "box_no_evidence" for item in failures):
        # A capture only clears the line when every checked box clears it.
        overall = {}
        for step in steps:
            overall[step] = all(
                next(sample for sample in result["samples"] if sample["step"] == step)["passes"]
                for result in box_results)
        for step, capture_id in steps.items():
            missing = [neighbor for neighbor in (step - 1, step, step + 1)
                       if neighbor not in steps]
            if missing or not all(overall[neighbor] for neighbor in (step - 1, step, step + 1)):
                continue
            left = step
            while left - 1 in steps and overall[left - 1]:
                left -= 1
            right = step
            while right + 1 in steps and overall[right + 1]:
                right += 1
            weakest_margin = None
            weakest_box = None
            for result in box_results:
                center = next(sample for sample in result["samples"] if sample["step"] == step)
                margin = (center["score"] - result["threshold"]) / result["threshold"]
                if weakest_margin is None or margin < weakest_margin:
                    weakest_margin, weakest_box = margin, result["box"]
            candidates.append({"step": step, "capture": capture_id,
                               "run_length": right - left + 1,
                               "run_steps": [value for value in range(left, right + 1)],
                               "weakest_margin_pct": _round(100 * weakest_margin, 2),
                               "weakest_box": weakest_box})

    if not candidates:
        evidence_failed = any(item["kind"] in ("box_no_evidence", "no_captures") for item in failures)
        # If every available reading clears the line, the only thing blocking
        # a start step is a missing neighbour shot. Otherwise the failing box
        # readings (or invalid evidence) are the real cause; an unshootable
        # edge neighbour such as -5 next to -4 is never actionable.
        all_readings_pass = bool(box_results) and all(
            sample["passes"] for result in box_results for sample in result["samples"])
        if not evidence_failed and all_readings_pass:
            for step in steps:
                missing = [neighbor for neighbor in (step - 1, step, step + 1)
                           if neighbor not in steps]
                for neighbor in missing:
                    message = f"缺少档位 {neighbor:+d} 的实拍，无法凑齐起始档与前后各一档。"
                    if not any(item.get("step") == neighbor and item["message"] == message
                               for item in failures):
                        failures.append({"kind": "missing_capture", "step": neighbor, "message": message})
        if not any(item["kind"] == "missing_capture" for item in failures) and not evidence_failed:
            failing = []
            for result in box_results:
                bad = [sample["step"] for sample in result["samples"]
                       if sample["tone_valid"] and not sample["passes"]]
                if bad:
                    failing.append(f"检查框“{result['name']}”在档位 "
                                   + "、".join(f"{step:+d}" for step in bad) + " 未过线")
            message = ("没有起始档能让每个勾选框在三档内全部过线：" + "；".join(failing) + "。") \
                if failing else "没有可用的起始档。"
            if not any(item.get("message") == message for item in failures):
                failures.append({"kind": "no_candidate", "message": message})

    recommendation = None
    if candidates:
        recommendation = sorted(candidates,
                                key=lambda item: (-item["run_length"],
                                                  -item["weakest_margin_pct"],
                                                  abs(item["step"]), item["step"]))[0]
    return {"pass_ratio": PASS_RATIO, "min_tone_span": MIN_TONE_SPAN,
            "steps": [shot["step"] for shot in shots],
            "box_results": box_results, "candidates": candidates,
            "recommendation": recommendation,
            "failures": failures, "warnings": warnings,
            "ok": recommendation is not None}
