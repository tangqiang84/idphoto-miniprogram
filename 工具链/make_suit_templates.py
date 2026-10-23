#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""自绘西装换装模板（透明 PNG）。

产出 3 套 V 领西装正面模板，自有版权（AI 自绘），不存在盗用风险（PRD Q3）。
供 T3 端侧贴图合成使用；正式商用版可替换设计师素材，接口（透明 PNG + 顶部领口居中）不变。

用法:
    python 工具链/make_suit_templates.py
输出:
    idphoto-miniprogram/src/assets/suits/suit_black.png  黑西装+白衬衫
    idphoto-miniprogram/src/assets/suits/suit_navy.png   深蓝西装+白衬衫
    idphoto-miniprogram/src/assets/suits/suit_gray.png   灰西装+浅蓝衬衫
"""
import os
from PIL import Image, ImageDraw

W = H = 400
OUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'idphoto-miniprogram', 'src', 'assets', 'suits')

# 配色（RGB）：(西装主色, 驳领色, 衬衫色)
STYLES = {
    'suit_black': ((32, 32, 36), (48, 48, 54), (245, 245, 242)),
    'suit_navy': ((28, 44, 84), (40, 60, 108), (245, 245, 242)),
    'suit_gray': ((96, 100, 108), (116, 120, 128), (226, 236, 248)),
}


def draw_suit(main, lapel, shirt):
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx = W // 2
    # 衣身：领口(100,40)-(300,40) → 肩部外扩(20,120)/(380,120) → 底部
    d.polygon([(100, 40), (300, 40), (380, 120), (370, H), (30, H), (20, 120)], fill=main + (255,))
    # 衬衫 V 领（白色三角，开口向下）
    d.polygon([(cx - 34, 40), (cx + 34, 40), (cx, 152)], fill=shirt + (255,))
    # 驳领（左右两块，盖住衬衫两侧边缘，形成西装领型）
    d.polygon([(100, 40), (168, 40), (146, 168), (56, 118)], fill=lapel + (255,))
    d.polygon([(300, 40), (232, 40), (254, 168), (344, 118)], fill=lapel + (255,))
    # 领口小三角内衬（增强 V 领层次）
    d.polygon([(cx - 14, 44), (cx + 14, 44), (cx, 108)], fill=shirt + (255,))
    return img


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for name, (c_main, c_lapel, c_shirt) in STYLES.items():
        img = draw_suit(c_main, c_lapel, c_shirt)
        path = os.path.join(OUT_DIR, name + '.png')
        img.save(path)
        print(f'OK {path}')


if __name__ == '__main__':
    main()
