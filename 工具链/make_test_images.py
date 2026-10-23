# 生成证件照测试用例图集（合成图，用于自动化冒烟与人工测试）
# 用法：
#   /Users/tq/.workbuddy/binaries/python/envs/default/bin/python 工具链/make_test_images.py
# 产物：素材/测试图/ 目录下 3 张 PNG
#   test_standard.png   800x1067 白墙正面人像（基线）
#   test_complex.png    800x1067 花纹复杂背景（考验抠图）
#   test_lowres.png     400x533  低分辨率（<600x800，用于 AC3 引导重拍）
# 注意：合成图仅用于跑通链路，不能用于评估抠图质量（真人照片请自行补充）。

import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, '素材', '测试图')
os.makedirs(OUT, exist_ok=True)


def draw_person(img, bg_draw, scale=1.0):
    """在给定画布上画一个头肩人像（简单几何合成）"""
    w, h = img.size
    d = ImageDraw.Draw(img)
    cx = w // 2
    head_r = int(w * 0.22 * scale)
    head_cy = int(h * 0.36)
    # 肩（梯形）
    shoulder_top = head_cy + head_r + int(h * 0.04)
    d.polygon(
        [(cx - int(w * 0.42), h), (cx - int(w * 0.26), shoulder_top),
         (cx + int(w * 0.26), shoulder_top), (cx + int(w * 0.42), h)],
        fill=(60, 70, 90),
    )
    # 脸
    d.ellipse([cx - head_r, head_cy - head_r, cx + head_r, head_cy + head_r], fill=(232, 195, 170))
    # 头发
    d.ellipse([cx - head_r, head_cy - head_r, cx + head_r, head_cy + int(head_r * 0.1)], fill=(40, 35, 35))
    # 眼睛/嘴
    eye_dx = int(head_r * 0.42)
    eye_dy = int(head_r * 0.1)
    for sx in (-eye_dx, eye_dx):
        d.ellipse([cx + sx - 4, head_cy + eye_dy - 4, cx + sx + 4, head_cy + eye_dy + 4], fill=(50, 50, 50))
    d.line([cx - int(head_r * 0.25), head_cy + int(head_r * 0.45),
            cx + int(head_r * 0.25), head_cy + int(head_r * 0.45)], fill=(180, 110, 100), width=3)
    if bg_draw:
        bg_draw(d, w, h)


def plain_bg(d, w, h):
    pass  # 底色已填充


def complex_bg(d, w, h):
    """花纹背景：斜条纹 + 圆点"""
    for i in range(0, w + h, 24):
        d.line([(i, 0), (i - h, h)], fill=(200, 160, 120), width=8)
    for y in range(30, h, 90):
        for x in range(30, w, 90):
            d.ellipse([x - 12, y - 12, x + 12, y + 12], fill=(150, 170, 190))


def make(name, size, bg_color, bg_fn, scale=1.0):
    img = Image.new('RGB', size, bg_color)
    draw_person(img, bg_fn, scale)
    path = os.path.join(OUT, name)
    img.save(path)
    print('生成:', path, size)


if __name__ == '__main__':
    make('test_standard.png', (800, 1067), (245, 245, 248), plain_bg)
    make('test_complex.png', (800, 1067), (230, 225, 215), complex_bg)
    make('test_lowres.png', (400, 533), (245, 245, 248), plain_bg)
    print('完成。目录:', OUT)
