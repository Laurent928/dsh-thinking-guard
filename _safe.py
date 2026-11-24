#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""安全区版横图：1280x640 画布，内容全部收进中心 640x640，左右两侧只留符号点阵。

为什么：GitHub social preview 是 1280x640，但手机上分享卡片会被裁成接近方形。
把内容压在中心，手机裁切后信息完整；桌面看到的是「中间一块 + 两侧纹理」，也不空。
"""
import math
import random
import sys

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

from PIL import Image, ImageDraw, ImageFont

W, H = 1280, 640
INK = (13, 13, 13)
MUTED = (112, 112, 114)
ACCENT = (42, 127, 255)
SYM = (128, 130, 138)

FB = r'C:\Windows\Fonts\msyhbd.ttc'
FR = r'C:\Windows\Fonts\msyh.ttc'
FM = r'C:\Windows\Fonts\consola.ttf'
FC = r'C:\Windows\Fonts\consola.ttf'
FG_ = r'C:\Windows\Fonts\georgia.ttf'

SP = 30
c = 0.7071067811865476
CX, CY = W / 2, H / 2
N = int((W + H) / SP) + 8
RAMP = ['.', '`', ',', ':', '-', '~', '=', '+', '*', '/', '|', '#', '%', '@']
OUT = r'E:\AI Project\01-Deepseek Harness\01 deepseek\personal\dsh-thinking-guard\assets\promo-safe.png'

# 中心安全区
SX0, SX1 = W / 2 - 320, W / 2 + 320      # 320 .. 960


def f(p, s):
    try:
        return ImageFont.truetype(p, s)
    except Exception:
        return ImageFont.load_default()


# 文字全部居中在安全区
LINES = [
    ('DEEPSEEK HARNESS  ·  PLUGIN', f(FM, 17), 640, 150, MUTED, 'center'),
    ('dsh-thinking-guard', f(FM, 40), 640, 196, INK, 'center'),
    ('思考空转守卫', f(FR, 22), 640, 250, MUTED, 'center'),
    ('它不是在思考', f(FR, 38), 640, 330, MUTED, 'center'),
    ('是卡住了', f(FB, 76), 640, 380, INK, 'center'),
    ('一档提示、一档掐断、一档熔断', f(FR, 21), 640, 500, MUTED, 'center'),
    ('It is not thinking. It is stuck.', f(FG_, 20), 640, 540, (150, 152, 158), 'center'),
]

# 先量文字包围盒做避让
canvas = Image.new('RGB', (W, H), (255, 255, 255))
tmp = ImageDraw.Draw(canvas)
TEXT_BOXES = []
for (text, font, x, y, _c, anchor) in LINES:
    l, t, r, b = tmp.textbbox((x, y), text, font=font, anchor=anchor)
    TEXT_BOXES.append((l - 8, t - 8, r + 8, b + 8))

img = Image.new('RGB', (W, H), (255, 255, 255))
d = ImageDraw.Draw(img)
for y in range(H):
    for x in range(0, W, 4):
        t = (x / W + (1 - y / H)) / 2
        v = 255 - 8 * (1 - t)
        d.line([(x, y), (min(x + 4, W), y)], fill=(int(v), int(v), int(v + 1)))


def in_text(x, y):
    for (x0, y0, x1, y1) in TEXT_BOXES:
        if x0 < x < x1 and y0 < y < y1:
            return True
    return False


random.seed(23)
layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
ld = ImageDraw.Draw(layer)
cache = {}


def gf(sz):
    if sz not in cache:
        cache[sz] = f(FC, sz)
    return cache[sz]


for i in range(-N, N + 1):
    for j in range(-N, N + 1):
        x = CX + i * c * SP + j * (-c) * SP
        y = CY + i * c * SP + j * c * SP
        if not (-15 <= x <= W + 15 and -15 <= y <= H + 15):
            continue
        # 从画面四周向中心加密：两侧更密，中心（安全区）更淡
        # 用「离中心的横向距离」当密度变量，左右两侧满密度
        dx = abs(x - 640) / 640.0
        tt = min(1.0, dx ** 0.9)
        gi = min(len(RAMP) - 1, int(tt * (len(RAMP) - 1) + 0.5))
        g = RAMP[gi]
        sz = int(13 + 9 * tt)
        a = int(48 + 120 * tt)
        if in_text(x, y):
            a = int(a * 0.10)
        a = max(10, min(175, a))
        ld.text((x, y), g, font=gf(sz), fill=(SYM[0], SYM[1], SYM[2], a), anchor='mm')

img = Image.alpha_composite(img.convert('RGBA'), layer).convert('RGB')

d = ImageDraw.Draw(img)
for (text, font, x, y, col, anchor) in LINES:
    d.text((x, y), text, font=font, fill=col, anchor=anchor)

# 安全区两侧各一条极淡的竖线，暗示「手机裁到这里」
for xx in (SX0, SX1):
    d.line([(xx, 60), (xx, H - 60)], fill=(228, 229, 233), width=1)

# 蓝线做分隔
d.line([(640 - 130, 300), (640 + 130, 300)], fill=ACCENT, width=2)

px = img.load()
for y in range(0, H, 2):
    for x in range(0, W, 2):
        n = random.randint(-2, 2)
        r, g, b = px[x, y]
        px[x, y] = (max(0, min(255, r + n)), max(0, min(255, g + n)), max(0, min(255, b + n)))

img.save(OUT, 'PNG', optimize=True)
print('saved', OUT, img.size)
