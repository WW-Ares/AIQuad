# -*- coding: utf-8 -*-
"""
从根目录的 LOGO.png 生成全部图标资源。

统一处理"源图留白"：LOGO.png 是 1024×1024 但图形只占 (95,95)-(930,929)，
直接 resize 会让图标四周多出一圈透明边，托盘上看起来比别的图标小一圈。
这里先按 alpha 通道裁到实际图形，再按目标尺寸回填等比例留白。

产物：
  src/renderer/icon.ico          7 档尺寸，给安装包 / exe / 任务栏
  src/renderer/tray.png          托盘（64px，Windows 会自己缩到 16/32）
  src/renderer/assets/logo.png   顶栏品牌标（128px）

用法：python scripts/make-icons.py
"""
from PIL import Image
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(os.path.dirname(ROOT), 'LOGO.png')
if not os.path.exists(SRC):
    SRC = os.path.join(ROOT, 'LOGO.png')

ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]


def load_trimmed():
    im = Image.open(SRC).convert('RGBA')
    box = im.getchannel('A').getbbox()
    if box:
        im = im.crop(box)
    return im


def fit(im, size, pad_ratio):
    """等比缩放到 size×(size*pad_ratio 为可用区) 的正方形画布上"""
    inner = max(1, int(round(size * (1 - pad_ratio * 2))))
    w, h = im.size
    k = inner / max(w, h)
    small = im.resize((max(1, int(round(w * k))), max(1, int(round(h * k)))), Image.LANCZOS)
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    canvas.paste(small, ((size - small.width) // 2, (size - small.height) // 2), small)
    return canvas


def main():
    src = load_trimmed()
    print('源图裁剪后:', src.size)

    out_ico = os.path.join(ROOT, 'src', 'renderer', 'icon.ico')
    fit(src, 256, 0.06).save(out_ico, sizes=[(s, s) for s in ICO_SIZES])
    print('icon.ico   →', os.path.getsize(out_ico), 'bytes', ICO_SIZES)

    out_tray = os.path.join(ROOT, 'src', 'renderer', 'tray.png')
    fit(src, 64, 0.04).save(out_tray)
    print('tray.png   →', os.path.getsize(out_tray), 'bytes 64×64')

    out_logo = os.path.join(ROOT, 'src', 'renderer', 'assets', 'logo.png')
    fit(src, 128, 0.02).save(out_logo)
    print('logo.png   →', os.path.getsize(out_logo), 'bytes 128×128')


if __name__ == '__main__':
    sys.exit(main())
