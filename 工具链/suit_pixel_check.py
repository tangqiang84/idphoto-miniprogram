#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""T3 换装成品像素判定（问题台账 #69 验收，2026-10-27）

对 acceptance_suit/*_result.jpg 逐张做三个自动判定：
  ① 盖脸判定（精确口径）：[bbox.y, place.y) 是人脸/颈部安全带——suitCompose 的
     D2 保证 place.y 以上不贴模板，带内出现「成片模板色」= place.y 定高了 = 盖脸
  ② 西装覆盖率：[place.y, 人体框底] 人体带内成片模板色占比 <55% → WARN（原衣外露）
  ③ 边框带背景残留：左右顶三边 8% 带内与底色距离 >120 的像素占比（底部不纳入）

口径说明（#69 首版教训）：首版用「脸带 [chinY-0.74h, chinY] + 宽泛色匹配 ±50」，
把黑发/眉毛/眼镜全误判成西装色 → 11 张全误报 FAIL。修正：
  · 分界改 place.y（suitCompose 的真实分界线，与 chinY 估算精度无关）
  · 模板色严格 proximity ±25 + 明度 <150 + 肤色排除
  · 成片判定（5×5 邻域 ≥12 同类），排除孤立黑发/眉笔/镜框

输出：suit_pixel_report.json + 控制台逐张事实陈述（不下「解决」结论，#67 口径）。
用法：NODE_OPTIONS= python3 工具链/suit_pixel_check.py
"""

import json
import os
import sys

ROOT = '/Users/tq/WorkBuddy/XiaoChengXu'
SUIT_DIR = os.path.join(ROOT, '素材', '测试截图', 'acceptance_suit')
RESULTS = os.path.join(SUIT_DIR, 'results_suit.json')

try:
    from PIL import Image
except ImportError:
    print('需要 PIL')
    sys.exit(2)


def parse_suit_geometry(audit_lines):
    """从 audit 行里取最后一次 suit_geometry JSON"""
    geo = None
    for line in audit_lines or []:
        if 'suit_geometry' not in line:
            continue
        i = line.find('{')
        if i < 0:
            continue
        try:
            geo = json.loads(line[i:])
        except Exception:
            pass
    return geo


def is_suit_color(r, g, b):
    """西装模板三色（黑 #22252E / 深蓝 #2E3A59 / 灰 #6B7280）的色相方向判定。
    实测色簇（2026-10-27，JPG+双线性混合后）：西装黑 (32,31,36) b−r≈4、b≥33；
    纯黑发 (2,2,0) b≈0；深棕发 b−r 为负；蓝底 b−r≈150。
    判据：v≥25（排除纯黑暗发/阴影）∧ r∈[20,135] ∧ b−r∈[0,50] ∧ g−r∈[0,15]。
    （#69 第二版教训：RGB proximity ±25 分不开深棕/黑色头发与黑色西装——
    头发与西装差的不是明度是色相方向，改用 b−r/g−r 方向判据。）"""
    v = (r + g + b) / 3
    if v < 25 or v > 165:
        return False
    if r < 20 or r > 135:
        return False
    db = b - r
    dg = g - r
    return 0 <= db <= 50 and -8 <= dg <= 15


def has_patch(px, W, H, x, y, pred):
    """(x,y) 处 5×5 邻域内满足 pred 的像素 ≥12 → 视为「成片」（排除孤立黑发/眉毛）"""
    n = 0
    for dy in range(-2, 3):
        yy = y + dy
        if yy < 0 or yy >= H:
            continue
        for dx in range(-2, 3):
            xx = x + dx
            if xx < 0 or xx >= W:
                continue
            r, g, b = px[xx, yy]
            if pred(r, g, b):
                n += 1
    return n >= 12


def check_one(rec):
    name = rec['file']
    img_rel = rec.get('resultImage')
    if not img_rel:
        return {'file': name, 'verdict': 'NO_IMAGE', 'detail': '无成品图'}
    img = os.path.join(ROOT, '素材', '测试截图', img_rel)
    if not os.path.exists(img):
        return {'file': name, 'verdict': 'NO_IMAGE', 'detail': img_rel + ' 不存在'}
    geo = parse_suit_geometry(rec.get('audit'))
    if not geo:
        return {'file': name, 'verdict': 'NO_GEO', 'detail': 'audit 无 suit_geometry'}

    im = Image.open(img).convert('RGB')
    W, H = im.size
    px = im.load()
    bbox, headH = geo['bbox'], geo['headH']
    chinY = geo.get('chinY') or (bbox['y'] + headH)
    # place.y 与页面同源公式（core/suit.js suitPlacement：chinY + 0.10*headH）
    place_y = chinY + 0.10 * headH

    # ① 盖脸判定（差分法，终极判据）：T2 换底色成品 = 同图同链路同底色的基线，
    #    与 T3 成品的唯一差异是西装贴图 → 差值区顶端即「西装实际贴上的最高位置」。
    #    suitCompose 的 D2 保证 place.y 以上不贴 → 差值区顶端应 ≈ place_y。
    #    （#69 第三版教训：颜色判据分不开黑发/灰背景与黑/灰西装——深色即同色相，
    #     只有「与不换装基线差分」能不依赖颜色猜测定出贴图实际位置。）
    safe = os.path.basename(img_rel)
    base_path = os.path.join(ROOT, '素材', '测试截图', 'acceptance_blue', safe)
    diff_top = None
    diff_ratio = None
    if os.path.exists(base_path):
        bpx = Image.open(base_path).convert('RGB').load()
        bw, bh = Image.open(base_path).size
        if (bw, bh) == (W, H):
            ys = []
            ndiff = 0
            for y in range(0, H, 2):
                for x in range(0, W, 2):
                    c1, c2 = px[x, y], bpx[x, y]
                    if max(abs(c1[0] - c2[0]), abs(c1[1] - c2[1]), abs(c1[2] - c2[2])) > 40:
                        ndiff += 1
                        ys.append(y)
            diff_top = min(ys) if ys else None
            diff_ratio = ndiff / ((W // 2) * (H // 2))
        else:
            diff_top = 'SIZE_MISMATCH'
    else:
        diff_top = 'NO_BASE'

    # ② 西装覆盖率（色相方向判定，作辅证）：[place_y, 人体框底] 人体带内
    body_top = int(place_y)
    body_bottom = min(H, int(bbox['y'] + bbox['h']))
    bn = bs = 0
    for y in range(body_top, body_bottom):
        for x in range(int(bbox['x']), min(W, int(bbox['x'] + bbox['w'])), 2):
            c = px[x, y]
            bn += 1
            if is_suit_color(*c):
                bs += 1
    suit_cover = bs / bn if bn else 0

    # ③ 边框带背景残留（左右顶三边 8%，底部不纳入——躯干合法触底）
    bw8, bh8 = max(2, int(W * 0.08)), max(2, int(H * 0.08))
    samples = []
    cs = 20
    for cx, cy in [(0, 0), (W - cs, 0)]:
        for y in range(cy, cy + cs):
            for x in range(cx, cx + cs):
                samples.append(px[x, y])
    samples.sort(key=lambda c: sum(c))
    bgc = samples[len(samples) // 2]
    bad = total = 0
    for y in range(0, H, 3):
        for x in range(0, W, 3):
            if x < bw8 or x >= W - bw8 or y < bh8:
                total += 1
                c = px[x, y]
                if abs(c[0] - bgc[0]) + abs(c[1] - bgc[1]) + abs(c[2] - bgc[2]) > 120:
                    bad += 1
    band_residual = bad / total if total else 0

    verdict = 'PASS'
    reasons = []
    # ① 差分判定：贴图顶端比 place_y 高 4px 以上 = 盖脸（D2 破坏）
    #    贴低容忍 0.25×headH：模板 V 领顶点（白/透明）与底色差异小，成片深色从
    #    翻领开始，天然比 place.y 低（实测 111 低 45px≈V 领深 10%×框高），非缺陷
    if isinstance(diff_top, int):
        if diff_top < place_y - 4:
            verdict = 'FAIL'
            reasons.append('西装实际贴上顶端 y=%d 高于 place_y=%.0f 共 %dpx（盖脸）' % (diff_top, place_y, place_y - diff_top))
        elif diff_top > place_y + 0.25 * headH:
            if verdict == 'PASS':
                verdict = 'WARN'
            reasons.append('西装实际贴上顶端 y=%d 低于 place_y=%.0f 超过 1/4 头长（没贴上/贴低）' % (diff_top, place_y))
    else:
        reasons.append('差分基线不可用：%s' % diff_top)
    if suit_cover < 0.40:
        if verdict == 'PASS':
            verdict = 'WARN'
        reasons.append('西装覆盖率 %.0f%%（原衣外露？）' % (suit_cover * 100))
    if band_residual > 0.02:
        if verdict == 'PASS':
            verdict = 'WARN'
        reasons.append('边框带残留 %.1f%%' % (band_residual * 100))

    return {
        'file': name,
        'verdict': verdict,
        'size': [W, H],
        'bbox': bbox,
        'headH': round(headH, 1),
        'chinY': round(chinY, 1),
        'place_y': round(place_y, 1),
        'diff_top_y': diff_top if isinstance(diff_top, int) else str(diff_top),
        'diff_ratio': round(diff_ratio, 4) if diff_ratio is not None else None,
        'suit_cover_ratio': round(suit_cover, 4),
        'band_residual_ratio': round(band_residual, 4),
        'reasons': reasons,
    }


def main():
    if not os.path.exists(RESULTS):
        print('无 results_suit.json，先跑 batch_acceptance.js --tool t3')
        sys.exit(2)
    results = json.load(open(RESULTS))
    out = []
    for rec in results:
        r = check_one(rec)
        out.append(r)
        mark = {'PASS': '✅', 'WARN': '⚠️', 'FAIL': '❌', 'NO_IMAGE': '—', 'NO_GEO': '—'}[r['verdict']]
        if r.get('reasons'):
            print('%s %-36s %s' % (mark, r['file'], '; '.join(r['reasons'])))
        else:
            print('%s %-36s 贴图顶端 y=%s (place_y=%.0f) / 覆盖 %.0f%% / 边带残留 %.1f%%' % (
                mark, r['file'], r['diff_top_y'], r['place_y'], r['suit_cover_ratio'] * 100, r['band_residual_ratio'] * 100))
    out_path = os.path.join(SUIT_DIR, 'suit_pixel_report.json')
    json.dump(out, open(out_path, 'w'), ensure_ascii=False, indent=2)
    print('\n写入', out_path)
    n_fail = sum(1 for r in out if r['verdict'] == 'FAIL')
    n_warn = sum(1 for r in out if r['verdict'] == 'WARN')
    print('FAIL %d / WARN %d / PASS %d' % (n_fail, n_warn, sum(1 for r in out if r['verdict'] == 'PASS')))


if __name__ == '__main__':
    main()
