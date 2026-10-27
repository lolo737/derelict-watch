"""Render the PNG app icons from public/icons/icon.svg using headless Chromium.

Usage:  pip install playwright && python -m playwright install chromium
        python scripts/render_icons.py
"""
from pathlib import Path
from playwright.sync_api import sync_playwright

ICONS = Path(__file__).resolve().parent.parent / "public" / "icons"
SVG = (ICONS / "icon.svg").read_text()

# (filename, canvas size, icon size, background) — maskable icons need a
# safe zone, so the artwork is shrunk onto a full-bleed green square.
TARGETS = [
    ("icon-192.png", 192, 192, "transparent"),
    ("icon-512.png", 512, 512, "transparent"),
    ("apple-touch-icon.png", 180, 180, "#0b5d45"),
    ("icon-maskable-512.png", 512, 380, "#0b5d45"),
]

with sync_playwright() as p:
    browser = p.chromium.launch()
    for name, canvas, size, bg in TARGETS:
        page = browser.new_page(viewport={"width": canvas, "height": canvas})
        svg = SVG.replace("<svg ", f'<svg width="{size}" height="{size}" ', 1)
        page.set_content(
            f"<html><body style='margin:0;width:{canvas}px;height:{canvas}px;display:grid;"
            f"place-items:center;background:{bg}'>{svg}</body></html>"
        )
        page.screenshot(path=str(ICONS / name), omit_background=(bg == "transparent"))
        page.close()
        print("wrote", name)
    browser.close()
