"""Synthetic test-card photographs for the built-in tour."""

from PIL import Image, ImageDraw, ImageFilter


SIZE = (1024, 704)
BOXES = [
    {"name": "中心细线", "bounds": [382, 245, 659, 445]},
    {"name": "左上边角", "bounds": [125, 111, 339, 270]},
    {"name": "右下纸边", "bounds": [690, 448, 906, 610]},
]
SCALE = {"from": [202, 643], "to": [802, 643], "millimeters": 150}


def card():
    image = Image.new("RGB", SIZE, "#343f34")
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((67, 57, 956, 671), radius=11, fill="#ddd8c7", outline="#a49c82", width=3)
    draw.rectangle((90, 78, 934, 645), outline="#6e6d5e", width=1)
    draw.text((103, 82), "COPY STAND  /  FIELD TEST CARD", fill="#354238")
    draw.text((737, 82), "SIMULATED SOURCE", fill="#354238")
    for x0, y0, x1, y1 in [box["bounds"] for box in BOXES]:
        draw.rectangle((x0, y0, x1, y1), fill="#eae6d4", outline="#3a463d", width=2)
        for interval, x_start in ((4, x0 + 14), (7, x0 + 71), (11, x0 + 136)):
            for x in range(x_start, min(x_start + 54, x1 - 7), interval * 2):
                draw.rectangle((x, y0 + 22, x + interval - 1, y0 + 84), fill="#192a23")
        for y in range(y0 + 108, y1 - 9, 11):
            draw.line((x0 + 16, y, x1 - 15, y + 7), fill="#2e4135", width=2)
    colors = ("#b0aa8e", "#7f8470", "#414f43", "#eee7d1", "#8f6350", "#546c6d")
    for index, color in enumerate(colors):
        left = 717 + 30 * (index % 3)
        top = 273 + 30 * (index // 3)
        draw.rectangle((left, top, left + 28, top + 28), fill=color)
    draw.line((202, 643, 802, 643), fill="#38453b", width=2)
    for x in range(202, 803, 20):
        draw.line((x, 631 if (x - 202) % 100 == 0 else 637, x, 648), fill="#38453b", width=2)
    draw.text((850, 625), "150 mm", fill="#354238")
    return image


def sequence():
    master = card()
    for step in range(-4, 5):
        blur = 0.2 + 0.38 * abs(step)
        yield step, master.filter(ImageFilter.GaussianBlur(blur))
