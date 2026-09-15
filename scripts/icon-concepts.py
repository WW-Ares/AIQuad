# -*- coding: utf-8 -*-
"""
生成 AIQuad 图标候选方案预览（全部纯几何绘制，4x 超采样抗锯齿）。
产物: build/icon-concepts/concept-{a,b,c,d}.png (256px)
      build/icon-concepts/contact-sheet.png
"""
from PIL import Image, ImageDraw, ImageFont
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'build', 'icon-concepts')
os.makedirs(OUT, exist_ok=True)

SS = 4  # supersample


def canvas(size):
    im = Image.new('RGBA', (size * SS, size * SS), (0, 0, 0, 0))
    return im, ImageDraw.Draw(im)


def rrect(d, box, r, fill):
    d.rounded_rectangle(box, radius=r, fill=fill)


def lerp(c1, c2, t):
    return tuple(int(round(a + (b - a) * t)) for a, b in zip(c1, c2))


def vgrad_roundrect(im, box, r, c_top, c_bottom):
    """在已有画布上画竖向渐变圆角矩形"""
    x0, y0, x1, y1 = [int(v) for v in box]
    w, h = x1 - x0, y1 - y0
    grad = Image.new('RGBA', (w, h))
    gd = ImageDraw.Draw(grad)
    for y in range(h):
        gd.line([(0, y), (w, y)], fill=lerp(c_top, c_bottom, y / max(1, h - 1)))
    mask = Image.new('L', (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, h - 1], radius=r, fill=255)
    im.paste(grad, (x0, y0), mask)


# ---------- 概念 A：四宫格（深底 + 四块圆角格，一格高亮） ----------
def concept_a(size=256):
    S = size * SS
    im, d = canvas(size)
    m = S * 0.05
    rrect(d, [m, m, S - m, S - m], S * 0.23, (23, 26, 34, 255))  # 深色底
    gap = S * 0.055
    inner0 = S * 0.16
    inner1 = S * 0.84
    tile = (inner1 - inner0 - gap) / 2
    tr = tile * 0.26
    accent = (96, 145, 255, 255)
    plain = (232, 236, 245, 255)
    tiles = [
        (inner0, inner0, plain),
        (inner0 + tile + gap, inner0, plain),
        (inner0, inner0 + tile + gap, accent),
        (inner0 + tile + gap, inner0 + tile + gap, plain),
    ]
    for x, y, c in tiles:
        rrect(d, [x, y, x + tile, y + tile], tr, c)
    return im.resize((size, size), Image.LANCZOS)


# ---------- 概念 B：十字分格（渐变底 + 白色十字留白） ----------
def concept_b(size=256):
    S = size * SS
    im, d = canvas(size)
    m = S * 0.05
    vgrad_roundrect(im, (m, m, S - m, S - m), S * 0.23, (79, 70, 229, 255), (59, 130, 246, 255))
    d = ImageDraw.Draw(im)
    w = S * 0.075  # 十字臂宽
    cx = S / 2
    # 竖条 + 横条，端头圆角由两端半圆实现
    d.rounded_rectangle([cx - w / 2, S * 0.16, cx + w / 2, S * 0.84], radius=w / 2, fill=(255, 255, 255, 255))
    d.rounded_rectangle([S * 0.16, cx - w / 2, S * 0.84, cx + w / 2], radius=w / 2, fill=(255, 255, 255, 255))
    return im.resize((size, size), Image.LANCZOS)


# ---------- 概念 C：四角括弧（白底 + 四个向内角标） ----------
def concept_c(size=256):
    S = size * SS
    im, d = canvas(size)
    m = S * 0.05
    rrect(d, [m, m, S - m, S - m], S * 0.23, (247, 248, 251, 255))
    stroke = S * 0.085
    L = S * 0.24  # 角标臂长
    p = S * 0.19  # 角标距边
    col = (59, 130, 246, 255)
    # 四角：每个角一横一竖两根圆头条
    for ox in (p, S - p):
        for oy in (p, S - p):
            hx = ox if ox < S / 2 else ox - L
            hy = oy if oy < S / 2 else oy - L
            d.rounded_rectangle([min(ox, hx), oy - stroke / 2, max(ox, hx) + L * 0 if ox < S / 2 else max(ox, hx) , oy + stroke / 2], radius=stroke / 2, fill=col)
    # 上面写得啰嗦，重画干净的
    im, d = canvas(size)
    rrect(d, [m, m, S - m, S - m], S * 0.23, (247, 248, 251, 255))
    corners = [
        (p, p, 1, 1),
        (S - p, p, -1, 1),
        (p, S - p, 1, -1),
        (S - p, S - p, -1, -1),
    ]
    for x, y, sx, sy in corners:
        # 横臂
        d.rounded_rectangle(
            [x if sx > 0 else x - L, y - stroke / 2, x + L if sx > 0 else x, y + stroke / 2],
            radius=stroke / 2, fill=col)
        # 竖臂
        d.rounded_rectangle(
            [x - stroke / 2, y if sy > 0 else y - L, x + stroke / 2, y + L if sy > 0 else y],
            radius=stroke / 2, fill=col)
    return im.resize((size, size), Image.LANCZOS)


# ---------- 概念 D：一格点亮（线框四格，只有一格实心） ----------
def concept_d(size=256):
    S = size * SS
    im, d = canvas(size)
    m = S * 0.05
    vgrad_roundrect(im, (m, m, S - m, S - m), S * 0.23, (30, 34, 44, 255), (16, 18, 24, 255))
    d = ImageDraw.Draw(im)
    gap = S * 0.06
    inner0 = S * 0.17
    inner1 = S * 0.83
    tile = (inner1 - inner0 - gap) / 2
    tr = tile * 0.28
    line = max(int(S * 0.045), 2)
    frame = (120, 130, 150, 255)
    accent = (96, 145, 255, 255)
    boxes = [
        (inner0, inner0), (inner0 + tile + gap, inner0),
        (inner0, inner0 + tile + gap), (inner0 + tile + gap, inner0 + tile + gap),
    ]
    for i, (x, y) in enumerate(boxes):
        if i == 0:
            rrect(d, [x, y, x + tile, y + tile], tr, accent)
        else:
            d.rounded_rectangle([x, y, x + tile, y + tile], radius=tr, outline=frame, width=line)
    return im.resize((size, size), Image.LANCZOS)


CONCEPTS = [('a', concept_a), ('b', concept_b), ('c', concept_c), ('d', concept_d)]


def main():
    paths = []
    for name, fn in CONCEPTS:
        im = fn(256)
        p = os.path.join(OUT, f'concept-{name}.png')
        im.save(p)
        paths.append(p)
        print('concept', name, '->', p)

    # 联系表：256 大图 + 64/32/16 小图，检验小尺寸辨识度
    pad = 24
    label_h = 56
    small_sizes = [64, 32, 16]
    label_w = 420
    cell_w = 256 + sum(small_sizes) + pad * (len(small_sizes) + 3) + label_w
    W = cell_w
    H = (256 + label_h + pad) * len(CONCEPTS) + pad
    sheet = Image.new('RGBA', (W, H), (255, 255, 255, 255))
    sd = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 26)
    except OSError:
        font = ImageFont.load_default()
    titles = {
        'a': 'A · 四宫格（深底，左下高亮）',
        'b': 'B · 十字分格（渐变底+白十字）',
        'c': 'C · 四角括弧（白底蓝角标）',
        'd': 'D · 一格点亮（线框四格）',
    }
    y = pad
    for name, fn in CONCEPTS:
        big = fn(256)
        sheet.paste(big, (pad, y), big)
        x = pad + 256 + pad
        for s in small_sizes:
            sm = fn(256).resize((s, s), Image.LANCZOS)
            sheet.paste(sm, (x, y), sm)
            x += s + pad
        sd.text((pad + 256 + pad + sum(small_sizes) + pad * 3 + 8, y + 100),
                titles[name], font=font, fill=(30, 30, 30, 255))
        y += 256 + label_h + pad
    sp = os.path.join(OUT, 'contact-sheet.png')
    sheet.convert('RGB').save(sp)
    print('contact sheet ->', sp)


if __name__ == '__main__':
    main()
