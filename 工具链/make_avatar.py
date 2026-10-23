# 生成小程序头像 144x144 png（蓝底 + 证件照相框图标）
# 用法: python make_avatar.py
from PIL import Image, ImageDraw, ImageFont, ImageChops
import os

S = 576  # 4x master, downscale to 144 for crisp edges
OUT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

BLUE = (24, 95, 165, 255)    # #185FA5
LIGHT = (181, 212, 244, 255) # #B5D4F4
WHITE = (255, 255, 255, 255)

d.rounded_rectangle([0, 0, S - 1, S - 1], radius=120, fill=BLUE)

fx0, fy0, fx1, fy1 = 168, 88, 408, 328
d.rounded_rectangle([fx0, fy0, fx1, fy1], radius=28, fill=WHITE)

sil = Image.new("L", (S, S), 0)
sd = ImageDraw.Draw(sil)
sd.ellipse([244, 124, 332, 212], fill=255)   # head
sd.ellipse([206, 236, 370, 420], fill=255)   # shoulders
frame_mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(frame_mask).rounded_rectangle([fx0, fy0, fx1, fy1], radius=28, fill=255)
alpha = ImageChops.darker(sil, frame_mask)
img.paste(Image.new("RGBA", (S, S), LIGHT), (0, 0), alpha)

font = ImageFont.truetype("/System/Library/Fonts/Hiragino Sans GB.ttc", 96, index=0)
text = "证件照"
bbox = d.textbbox((0, 0), text, font=font)
w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
d.text(((S - w) / 2 - bbox[0], 378 - bbox[1]), text, font=font, fill=WHITE)

img.resize((144, 144), Image.LANCZOS).save(os.path.join(OUT_DIR, "小程序头像-144.png"))
img.save(os.path.join(OUT_DIR, "小程序头像-576.png"))
print("OK: 小程序头像-144.png / 小程序头像-576.png")
