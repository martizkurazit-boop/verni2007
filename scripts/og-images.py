#!/usr/bin/env python3
"""Рисует картинку для соцсетей с заголовком статьи.

Запускается в сборке перед выкладкой. Для статей с обложкой картинка не нужна —
там в соцсети уходит сама обложка; эта нужна тем, у кого обложки нет, и как
запасной вариант. Шрифт берётся из репозитория, стиль — фирменный.
"""
import json, os, re, sys
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, 'dist')
FONTS = os.path.join(ROOT, 'assets-src', 'fonts')
BG, ACC, WHITE, GREY = (10, 10, 10), (204, 255, 4), (255, 255, 255), (154, 154, 154)

def font(name, size):
    return ImageFont.truetype(os.path.join(FONTS, name), size)

def wrap(draw, text, f, max_w, max_lines):
    words, lines, cur = text.split(), [], ''
    for w in words:
        probe = (cur + ' ' + w).strip()
        if draw.textlength(probe, font=f) <= max_w:
            cur = probe
        else:
            if cur:
                lines.append(cur)
            cur = w
            if len(lines) == max_lines:
                break
    if cur and len(lines) < max_lines:
        lines.append(cur)
    if len(lines) == max_lines and len(' '.join(lines)) < len(text):
        lines[-1] = lines[-1].rstrip('.,;:') + '…'
    return lines

def draw_card(title, category, out_path):
    img = Image.new('RGB', (1200, 630), BG)
    d = ImageDraw.Draw(img)
    # Вордмарк
    fw = font('Gilroy-Heavy.ttf', 26)
    d.text((80, 70), 'ВЕРНИТЕ МОЙ', font=fw, fill=WHITE)
    x = 80 + d.textlength('ВЕРНИТЕ МОЙ', font=fw) + 12
    b = d.textbbox((0, 0), '2007', font=fw)
    d.rectangle([x, 70 + b[1] - 5, x + (b[2] - b[0]) + 18, 70 + b[3] + 7], fill=ACC)
    d.text((x + 9, 70), '2007', font=fw, fill=(0, 0, 0))
    if category:
        d.text((80, 130), category.upper(), font=font('Gilroy-Extrabold.ttf', 20), fill=(255, 59, 48))
    # Заголовок: размер подбирается так, чтобы уместиться в три строки
    for size in (72, 64, 56, 48, 42):
        ft = font('Gilroy-Heavy.ttf', size)
        lines = wrap(d, title.upper(), ft, 1040, 3)
        if len(lines) <= 3:
            break
    y = 500 - len(lines) * (size + 8)
    for line in lines:
        d.text((80, y), line, font=ft, fill=WHITE)
        y += size + 8
    d.rectangle([80, 520, 176, 526], fill=ACC)
    d.text((80, 552), 'vernitemoy2007.ru', font=font('Gilroy-Bold.ttf', 22), fill=GREY)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    img.save(out_path, optimize=True)

def main():
    manifest = os.path.join(DIST, 'og-manifest.json')
    if not os.path.exists(manifest):
        print('Нет списка статей для картинок — пропускаем.')
        return
    items = json.load(open(manifest, encoding='utf-8'))
    for it in items:
        draw_card(it['title'], it.get('category', ''), os.path.join(DIST, it['path'].lstrip('/')))
    print('Картинок для соцсетей нарисовано: %d' % len(items))
    os.remove(manifest)

main()
