"""Renders the icon set from the geometry in hordecode-mark.svg.

Usage: python3 render.py <icons-dir>
Needs Pillow (MIT-CMU licence). Writes prod, dev and beta next to this directory.
"""
import os
import sys

from PIL import Image, ImageDraw

SS = 8
VIEW = 512
RADIUS = 112
LETTER = [(115, 80), (193, 80), (193, 221), (319, 221), (319, 80), (397, 80), (397, 432), (319, 432), (319, 291), (193, 291), (193, 432), (115, 432)]
CHANNELS = {
    "prod": ((0x2B, 0x2B, 0x2B), (0xEC, 0xEC, 0xEA)),
    "dev": ((0x4F, 0x85, 0xF4), (0xFF, 0xFF, 0xFF)),
    "beta": ((0xEC, 0xEC, 0xEC), (0x11, 0x11, 0x11)),
}


def mark(size, channel, shape="rounded", scale=1.0):
    """shape: rounded (corner alpha), circle, square (full bleed). scale shrinks the shape inside the canvas."""
    bg, fg = CHANNELS[channel]
    big = size * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    side = big * scale
    off = (big - side) / 2
    k = side / VIEW
    box = [off, off, off + side - 1, off + side - 1]
    if shape == "circle":
        d.ellipse(box, fill=bg + (255,))
    elif shape == "square":
        d.rectangle([0, 0, big - 1, big - 1], fill=bg + (255,))
    else:
        d.rounded_rectangle(box, radius=RADIUS * k, fill=bg + (255,))
    d.polygon([(off + x * k, off + y * k) for x, y in LETTER], fill=fg + (255,))
    return img.resize((size, size), Image.LANCZOS)


def save(img, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, optimize=True)


def render(root, channel):
    out = os.path.join(root, channel)
    for name, size in [("32x32", 32), ("64x64", 64), ("128x128", 128), ("128x128@2x", 256), ("icon", 512), ("StoreLogo", 50)]:
        save(mark(size, channel), f"{out}/{name}.png")
    for size in (30, 44, 71, 89, 107, 142, 150, 284, 310):
        save(mark(size, channel), f"{out}/Square{size}x{size}Logo.png")
    save(mark(256, channel, scale=824 / 1024), f"{out}/dock.png")
    android = {"mdpi": 48, "hdpi": 49, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
    for density, size in android.items():
        save(mark(size, channel, scale=0.835), f"{out}/android/mipmap-{density}/ic_launcher.png")
        save(mark(size, channel, shape="circle", scale=0.92), f"{out}/android/mipmap-{density}/ic_launcher_round.png")
        fg = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}[density]
        save(mark(fg, channel), f"{out}/android/mipmap-{density}/ic_launcher_foreground.png")
    for name, size in {
        "AppIcon-20x20@1x": 20, "AppIcon-20x20@2x": 40, "AppIcon-20x20@2x-1": 40, "AppIcon-20x20@3x": 60,
        "AppIcon-29x29@1x": 29, "AppIcon-29x29@2x": 58, "AppIcon-29x29@2x-1": 58, "AppIcon-29x29@3x": 87,
        "AppIcon-40x40@1x": 40, "AppIcon-40x40@2x": 80, "AppIcon-40x40@2x-1": 80, "AppIcon-40x40@3x": 120,
        "AppIcon-512@2x": 1024, "AppIcon-60x60@2x": 120, "AppIcon-60x60@3x": 180,
        "AppIcon-76x76@1x": 76, "AppIcon-76x76@2x": 152, "AppIcon-83.5x83.5@2x": 167,
    }.items():
        save(mark(size, channel, shape="square").convert("RGB").convert("RGBA"), f"{out}/ios/{name}.png")
    # Windows: full canvas rounded mark at the sizes the ICO container carries.
    base = mark(256, channel)
    base.save(f"{out}/icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (256, 256)])
    # macOS: Big Sur inset (824 of 1024), no shadow.
    mac = mark(1024, channel, scale=824 / 1024)
    mac.save(f"{out}/icon.icns")


if __name__ == "__main__":
    root = sys.argv[1]
    for channel in CHANNELS:
        render(root, channel)
