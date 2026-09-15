# -*- coding: utf-8 -*-
"""
生成 AIQuad 全部图标资源（方案 E「四格悬浮」，纯图形透明底，4x 超采样）。

设计：2x2 圆角格悬浮，无底板；三格主蓝 #3B82F6，右下一格浅蓝 #93C5FD。
几何参数集中在 draw_icon()，改样式只动这里。

产物：
  src/renderer/icon.ico          7 档尺寸（16/24/32/48/64/128/256），安装包 / exe / 任务栏
  src/renderer/tray.png          托盘（64px，Windows 自行缩放）
  src/renderer/assets/logo.png   顶栏品牌标（128px）

用法：python scripts/make-icons.py
"""
from PIL import Image, ImageDraw
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

MAIN = (59, 130, 246, 255)    # #3B82F6
SOFT = (147, 197, 253, 255)   # #93C5FD
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
SS = 4  # 超采样倍数


def draw_icon(size):
    """按方案 E 几何画 size×size 的 RGBA 图（内部 4 倍超采样再缩小）"""
    S = size * SS
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    gap = S * 0.075
    inner0 = S * 0.06
    inner1 = S * 0.94
    tile = (inner1 - inner0 - gap) / 2
    tr = tile * 0.30
    tiles = [
        (inner0, inner0, MAIN),
        (inner0 + tile + gap, inner0, MAIN),
        (inner0, inner0 + tile + gap, MAIN),
        (inner0 + tile + gap, inner0 + tile + gap, SOFT),
    ]
    for x, y, c in tiles:
        d.rounded_rectangle([x, y, x + tile, y + tile], radius=tr, fill=c)
    if SS > 1:
        im = im.resize((size, size), Image.LANCZOS)
    return im


def main():
    base = draw_icon(1024)

    out_ico = os.path.join(ROOT, 'src', 'renderer', 'icon.ico')
    base.save(out_ico, sizes=[(s, s) for s in ICO_SIZES])
    print('icon.ico   ->', os.path.getsize(out_ico), 'bytes', ICO_SIZES)

    out_tray = os.path.join(ROOT, 'src', 'renderer', 'tray.png')
    base.resize((64, 64), Image.LANCZOS).save(out_tray)
    print('tray.png   ->', os.path.getsize(out_tray), 'bytes 64x64')

    out_logo = os.path.join(ROOT, 'src', 'renderer', 'assets', 'logo.png')
    base.resize((128, 128), Image.LANCZOS).save(out_logo)
    print('logo.png   ->', os.path.getsize(out_logo), 'bytes 128x128')


if __name__ == '__main__':
    sys.exit(main())
