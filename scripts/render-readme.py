"""Rasterize captured ANSI frames. Requires Pillow; no desktop automation."""
import json
import re
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
CAPTURES = ROOT / ".local" / "readme-captures"
OUTPUT = ROOT / "docs" / "images"
OUTPUT.mkdir(parents=True, exist_ok=True)

# Consolas is available on the capture host. It is used only to generate PNGs;
# readers do not need it installed to view the README.
REGULAR = ImageFont.truetype("C:/Windows/Fonts/consola.ttf", 32)
BOLD = ImageFont.truetype("C:/Windows/Fonts/consolab.ttf", 32)
CELL = REGULAR.getlength("M")
LINE = 44
PAD = 40
CHROME = 90
BG = "#0d1117"
FG = "#e6edf3"
PALETTE = ["#0d1117", "#ff7b72", "#7ee787", "#e3b341", "#58a6ff", "#d2a8ff", "#56d4dd", "#e6edf3",
           "#8b949e", "#ffa198", "#a5f3b2", "#f2cc60", "#79c0ff", "#e2c5ff", "#a5f3fc", "#ffffff"]
SGR = re.compile(r"\x1b\[([\d;]*)m")

def rgb256(index):
    if index < 16:
        return PALETTE[index]
    if index >= 232:
        value = 8 + (index - 232) * 10
        return (value, value, value)
    value = index - 16
    levels = [0, 95, 135, 175, 215, 255]
    return (levels[value // 36], levels[value // 6 % 6], levels[value % 6])

def rasterize(path):
    capture = json.loads(path.read_text(encoding="utf-8"))
    width = round(capture["columns"] * CELL + PAD * 2)
    height = (capture["rows"] - 1) * LINE + CHROME + PAD
    image = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(image)
    draw.line((0, CHROME - 1, width, CHROME - 1), fill="#26303d", width=2)
    for index, color in enumerate(["#ff6058", "#febc2e", "#28c840"]):
        x = PAD + index * 30
        draw.ellipse((x, 32, x + 16, 48), fill=color)
    draw.text((width / 2, 40), capture["title"], font=REGULAR.font_variant(size=25), fill="#8b949e", anchor="mm")
    for row, line in enumerate(capture["frame"].splitlines()):
        fg, bg, bold, dim, inverse = FG, BG, False, False, False
        x, y, last = PAD, CHROME + 20 + row * LINE, 0
        for match in list(SGR.finditer(line)) + [None]:
            end = match.start() if match else len(line)
            text = line[last:end]
            if text:
                color, background = (bg, fg) if inverse else (fg, bg)
                length = len(text) * CELL
                if background != BG:
                    draw.rectangle((round(x), y, round(x + length), y + LINE), fill=background)
                if dim and not inverse:
                    color = "#8b949e"
                font = BOLD if bold else REGULAR
                # Fixed cells match the terminal's monospace positioning.
                for char in text:
                    draw.text((round(x), y + 2), char, font=font, fill=color)
                    x += CELL
            if match is None:
                break
            codes = [int(code or 0) for code in match.group(1).split(";")]
            i = 0
            while i < len(codes):
                code = codes[i]
                if code == 0: fg, bg, bold, dim, inverse = FG, BG, False, False, False
                elif code == 1: bold = True
                elif code == 2: dim = True
                elif code == 7: inverse = True
                elif code == 22: bold, dim = False, False
                elif code == 27: inverse = False
                elif 30 <= code <= 37: fg = PALETTE[code - 30]
                elif 90 <= code <= 97: fg = PALETTE[code - 90 + 8]
                elif 40 <= code <= 47: bg = PALETTE[code - 40]
                elif 100 <= code <= 107: bg = PALETTE[code - 100 + 8]
                elif code == 39: fg = FG
                elif code == 49: bg = BG
                elif code in (38, 48):
                    if codes[i + 1] == 5:
                        color = rgb256(codes[i + 2])
                        i += 2
                    else:
                        color = tuple(codes[i + 2:i + 5])
                        i += 4
                    if code == 38: fg = color
                    else: bg = color
                i += 1
            last = match.end()
    image = image.resize((width // 2, height // 2), Image.Resampling.LANCZOS)
    destination = OUTPUT / (path.stem + ".png")
    image.save(destination, optimize=True)
    print(f"Rendered {destination.relative_to(ROOT)} ({image.width} x {image.height})")

for capture in sorted(CAPTURES.glob("*.json")):
    rasterize(capture)
