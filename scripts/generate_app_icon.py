"""Generate native and web icons from the user-provided master artwork."""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


def main():
    with Image.open(ROOT / "mewmo-icon-1024.png") as source:
        if source.width != source.height or source.width < 1024:
            raise ValueError("Master artwork must be square and at least 1024px.")
        if source.convert("RGBA").getchannel("A").getextrema() != (255, 255):
            raise ValueError("Master artwork must be opaque for the iOS app icon.")
        image = source.convert("RGB")

    outputs = {
        "frontend/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png": 1024,
        "frontend/public/icon-192.png": 192,
        "frontend/public/icon-512.png": 512,
        "frontend/public/apple-touch-icon.png": 180,
        "frontend/public/favicon.png": 32,
    }
    for relative_path, size in outputs.items():
        image.resize((size, size), Image.Resampling.LANCZOS).save(
            ROOT / relative_path, optimize=True
        )
        print(f"Generated {relative_path} ({size}x{size})")
    image.save(
        ROOT / "frontend/public/favicon.ico",
        sizes=[(16, 16), (32, 32), (48, 48)],
    )


if __name__ == "__main__":
    main()
