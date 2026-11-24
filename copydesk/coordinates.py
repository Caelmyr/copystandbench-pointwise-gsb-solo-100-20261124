"""Validate coordinates in the upright source and derive the ruler scale."""

from math import hypot

from image_lab.validation import Invalid, integer, number


MIN_BOX = 24


def box_bounds(value, size):
    if not isinstance(value, list) or len(value) != 4:
        raise Invalid("检查框需要左、上、右、下四条像素边。")
    width, height = size
    left = integer(value[0], "左边", 0, width - 1)
    top = integer(value[1], "上边", 0, height - 1)
    right = integer(value[2], "右边", left + MIN_BOX, width)
    bottom = integer(value[3], "下边", top + MIN_BOX, height)
    return [left, top, right, bottom]


def ruler(value, size):
    if not isinstance(value, dict) or set(value) != {"from", "to", "millimeters"}:
        raise Invalid("标尺需要两个端点和实际毫米距离。")
    points = []
    for name in ("from", "to"):
        point = value[name]
        if not isinstance(point, list) or len(point) != 2:
            raise Invalid("请在原照上选择两个标尺端点。")
        points.append([integer(point[0], "端点横坐标", 0, size[0] - 1),
                       integer(point[1], "端点纵坐标", 0, size[1] - 1)])
    distance = hypot(points[1][0] - points[0][0], points[1][1] - points[0][1])
    if distance < 10:
        raise Invalid("两个标尺端点至少相隔 10 像素。")
    known = number(value["millimeters"], "实际长度（毫米）", 0.01, 5000)
    return {"from": points[0], "to": points[1], "millimeters": known,
            "pixel_distance": distance, "pixels_per_mm": distance / known}


def box_dimensions(bounds, scale):
    if scale is None:
        return None
    x0, y0, x1, y1 = bounds
    per_mm = scale["pixels_per_mm"]
    return {"width_mm": (x1 - x0) / per_mm, "height_mm": (y1 - y0) / per_mm,
            "pixels_per_inch": 25.4 * per_mm}
