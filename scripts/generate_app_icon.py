"""Generate the native Mewmo monogram with Pillow; no external artwork."""
from pathlib import Path

from PIL import Image, ImageDraw

size = 2048
image = Image.new("RGB", (size, size), "#244c42")
draw = ImageDraw.Draw(image)
points = [(520, 1440), (520, 670), (610, 620), (1024, 1150), (1438, 620), (1528, 670), (1528, 1440)]
width = 160
draw.line(points, fill="#e4efce", width=width, joint="curve")
for x, y in points:
    draw.ellipse((x - width // 2, y - width // 2, x + width // 2, y + width // 2), fill="#e4efce")
path = Path(__file__).resolve().parents[1] / "frontend/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png"
image.resize((1024, 1024), Image.Resampling.LANCZOS).save(path)
print("Generated native Mewmo app icon")
