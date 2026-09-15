# -*- coding: utf-8 -*-
"""
第二批图标候选：纯图形、无底色（透明底），4x 超采样。
E 四格悬浮 / F 十字负形 / G 四角括弧 / H 四瓣拼圆
产物: build/icon-concepts/concept-{e,f,g,h}.png + contact-sheet-2.png
"""
from PIL import Image, ImageDraw, ImageFont
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'build', 'icon-concepts')
os.makedirs(OUT, exist_ok=True)

SS = 4
BLUE = (59, 130, 246, 255)
INDIGO = (79, 70, 229, 255)
INK = (30, 34, 44, 255)


def canvas(size):
    im = Image.new('RGBA', (size * SS, size * SS), (0, 0, 0, 0))
    return im, ImageDraw.Draw(im)


# ---------- E：2x2 圆角格悬浮（一块浅色，无底板） ----------
def concept_e(size=256):
    S = size * SS
    im, d = canvas(size)
    gap = S * 0.075
    inner0 = S * 0.06
    inner1 = S * 0.94
    tile = (inner1 - inner0 - gap) / 2
    tr = tile * 0.30
    main = BLUE
    soft = (147, 197, 253, 255)
    tiles = [
        (inner0, inner0, main),
        (inner0 + tile + gap, inner0, main),
        (inner0, inner0 + tile + gap, main),
        (inner0 + tile + gap, inner0 + tile + gap, soft),
    ]
    for x, y, c in tiles:
        d.rounded_rectangle([x, y, x + tile, y + tile], radius=tr, fill=c)
    return im.resize((size, size), Image.LANCZOS)


# ---------- F：圆角方块挖十字（负形十字） ----------
def concept_f(size=256):
    S = size * SS
    im, d = canvas(size)
    m = S * 0.06
    d.rounded_rectangle([m, m, S - m, S - m], radius=S * 0.26, fill=INDIGO)
    w = S * 0.085
    cx = S / 2
    hole = (0, 0, 0, 0)
    d.rounded_rectangle([cx - w / 2, S * 0.16, cx + w / 2, S * 0.84], radius=w / 2, fill=hole)
    d.rounded_rectangle([S * 0.16, cx - w / 2, S * 0.84, cx + w / 2], radius=w / 2, fill=hole)
    return im.resize((size, size), Image.LANCZOS)


# ---------- G：四角括弧围合（无底板） ----------
def concept_g(size=256):
    S = size * SS
    im, d = canvas(size)
    stroke = S * 0.11
    L = S * 0.26
    p = S * 0.10
    col = BLUE
    corners = [
        (p, p, 1, 1),
        (S - p, p, -1, 1),
        (p, S - p, 1, -1),
        (S - p, S - p, -1, -1),
    ]
    for x, y, sx, sy in corners:
        d.rounded_rectangle(
            [x if sx > 0 else x - L, y - stroke / 2, x + L if sx > 0 else x, y + stroke / 2],
            radius=stroke / 2, fill=col)
        d.rounded_rectangle(
            [x - stroke / 2, y if sy > 0 else y - L, x + stroke / 2, y + L if sy > 0 else y],
            radius=stroke / 2, fill=col)
    return im.resize((size, size), Image.LANCZOS)


# ---------- H：四瓣拼圆（每瓣是 1/4 圆，十字缝） ----------
def concept_h(size=256):
    S = size * SS
    im, d = canvas(size)
    cx = S / 2
    cy = S / 2
    gap = S * 0.05  # 十字缝半宽
    R = S * 0.44    # 外圆半径
    cols = [BLUE, INDIGO, INDIGO, BLUE]
    quads = [
        (180, 270),  # 左上
        (270, 360),  # 右上
        (90, 180),   # 左下
        (0, 90),     # 右下
    ]
    for i, (a0, a1) in enumerate(quads):
        ox = -gap if a0 in (90, 180) else gap
        oy = -gap if a0 in (180, 270) else gap
        d.pieslice([cx + ox - R, cy + oy - R, cx + ox + R, cy + oy + R],
                   start=a0, end=a1, fill=cols[i])
    return im.resize((size, size), Image.LANCZOS)


CONCEPTS = [('e', concept_e), ('f', concept_f), ('g', concept_g), ('h', concept_h)]


def main():
    for name, fn in CONCEPTS:
        p = os.path.join(OUT, f'concept-{name}.png')
        fn(256).save(p)
        print('concept', name, '->', p)

    # 联系表：浅灰底看透明边缘 + 深色底小图看任务栏效果
    pad = 24
    label_h = 10
    small_sizes = [64, 32, 16]
    label_w = 400
    W = 256 + sum(small_sizes) * 2 + pad * (len(small_sizes) * 2 + 3) + label_w
    H = (256 + pad) * len(CONCEPTS) + pad
    sheet = Image.new('RGBA', (W, H), (240, 241, 245, 255))
    sd = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 26)
    except OSError:
        font = ImageFont.load_default()
    titles = {
        'e': 'E · 四格悬浮（一格浅色）',
        'f': 'F · 十字负形（整块挖空）',
        'g': 'G · 四角括弧（无底板）',
        'h': 'H · 四瓣拼圆（十字缝）',
    }
    dark = Image.new('RGBA', (max(small_sizes), max(small_sizes)), (32, 34, 40, 255))
    y = pad
    for name, fn in CONCEPTS:
        big = fn(256)
        sheet.paste(big, (pad, y), big)
        x = pad + 256 + pad
        for s in small_sizes:  # 浅底小图
            sm = fn(256).resize((s, s), Image.LANCZOS)
            sheet.paste(sm, (x, y), sm)
            x += s + pad
        for s in small_sizes:  # 深底小图（模拟深色任务栏）
            bg = dark.resize((s, s))
            sm = fn(256).resize((s, s), Image.LANCZOS)
            bg.paste(sm, (0, 0), sm)
            sheet.paste(bg, (x, y))
            x += s + pad
        sd.text((x + 8, y + 100), titles[name], font=font, fill=(30, 30, 30, 255))
        y += 256 + pad
    sp = os.path.join(OUT, 'contact-sheet-2.png')
    sheet.convert('RGB').save(sp)
    print('contact sheet ->', sp)


if __name__ == '__main__':
    main()
