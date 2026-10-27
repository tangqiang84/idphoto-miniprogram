#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
批量验收报告生成（2026-10-27，问题台账 #67 整改落地）

读取 素材/测试截图/acceptance/results.json + 落盘的成品 JPG，做像素级自动判定：
  ① 背景色估计：四角 20×20 中位数
  ② 边框带残留率（连通域口径）：左/右/顶 8% 边框带内、与背景色距离 >120 且
     **不与人物主体连通**的像素占比。人物合法贴边（头发/肩膀/躯干延伸）不计入——
     实测 123.png 人占满小图、images(2) 长发及左缘均为合法贴边，纯边框带口径会误报。
     连通域在 4px 降采样网格上做 BFS，最大连通域 = 人物主体。
  ③ 残留像素 bbox

判定规则（显式、可核对，不粉饰）：
  FAIL     未跑完 / 运行异常 / 状态行含「失败」
  DEGRADED 状态行含「降级」→ 云端没交付，是端侧结果（事实陈述，不算成功）
  WARN     完成且云端精修，但边框带残留率 > 2%
  PASS     完成 + 云端精修 + 边框带残留率 ≤ 2%
  特例：文件名含 FaceQ（卡通头像）按 #49 为负例——预期降级，判 EXPECTED-DEGRADE

产物：素材/测试截图/acceptance/report.html（原图 vs 成品对照 + 全部指标）

用法：NODE_OPTIONS= python3 工具链/report_acceptance.py
"""

import json
import os
import sys
import html
import urllib.parse
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 【2026-10-28】结果目录可切：T2 用 acceptance/、T3 用 acceptance_suit/（batch_acceptance.js 的 SUBDIR）。
# 踩坑提醒（#69 同类）：报告必须读**与被测工具对应的目录**，否则会拿 T2 的结果判 T3（读错数据）。
# 用法：python3 工具链/report_acceptance.py [子目录]
SUBDIR_ARG = sys.argv[1] if len(sys.argv) > 1 else 'acceptance'
OUTDIR = os.path.join(ROOT, '素材', '测试截图', SUBDIR_ARG)
IMGDIR_REL = '../../真实头像'  # report.html 相对真实头像目录


def px_stats(img_path, band_ratio=0.08, dist_thr=40):
    """返回 (bg_rgb, band_residual_ratio, residual_bbox, (w, h))
    残留 = 边框带内「非背景色」且「不与最大连通域（人物主体）连通」的像素。"""
    im = Image.open(img_path).convert('RGB')
    w, h = im.size
    px = im.load()
    # 四角背景色
    cs = 20
    samples = []
    for cx, cy in [(0, 0), (w - cs, 0), (0, h - cs), (w - cs, h - cs)]:
        for y in range(cy, cy + cs):
            for x in range(cx, cx + cs):
                samples.append(px[x, y])
    samples.sort(key=lambda c: sum(c))
    bg = samples[len(samples) // 2]

    # 4px 网格非背景掩码
    cell = 4
    gw, gh = (w + cell - 1) // cell, (h + cell - 1) // cell
    thr = dist_thr * 3
    mask = bytearray(gw * gh)
    for gy in range(gh):
        for gx in range(gw):
            x = min(gx * cell, w - 1)
            y = min(gy * cell, h - 1)
            c = px[x, y]
            if abs(c[0] - bg[0]) + abs(c[1] - bg[1]) + abs(c[2] - bg[2]) > thr:
                mask[gy * gw + gx] = 1

    # BFS 连通域，找最大（人物主体）
    comp = [-1] * (gw * gh)
    sizes = []
    for i in range(gw * gh):
        if not mask[i] or comp[i] >= 0:
            continue
        cid = len(sizes)
        stack = [i]
        comp[i] = cid
        n = 0
        while stack:
            cur = stack.pop()
            n += 1
            cy, cx = divmod(cur, gw)
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = cx + dx, cy + dy
                if 0 <= nx < gw and 0 <= ny < gh:
                    j = ny * gw + nx
                    if mask[j] and comp[j] < 0:
                        comp[j] = cid
                        stack.append(j)
        sizes.append(n)
    main = sizes.index(max(sizes)) if sizes else -1

    # 边框带残留（左/右/顶三边；底部不纳入——躯干合法触底）：
    # 只统计「不属于主体连通域」的非背景格
    bw = max(1, int(gw * band_ratio))
    bh = max(1, int(gh * band_ratio))
    total = 0
    bad = 0
    minx, miny, maxx, maxy = w, h, -1, -1
    for gy in range(gh):
        for gx in range(gw):
            in_band = gx < bw or gx >= gw - bw or gy < bh
            if not in_band:
                continue
            total += 1
            i = gy * gw + gx
            if mask[i] and comp[i] != main:
                bad += 1
                x, y = gx * cell, gy * cell
                if x < minx: minx = x
                if y < miny: miny = y
                if x > maxx: maxx = x
                if y > maxy: maxy = y
    ratio = bad / total if total else 0
    bbox = (minx, miny, maxx, maxy) if bad else None
    return bg, ratio, bbox, (w, h)


def parse_audit(audit_lines):
    """从 [audit] 日志行提取关键事实"""
    facts = {'stages': []}
    for line in audit_lines:
        if 'upload_region' in line:
            facts['stages'].append('upload_region')
            for key in ('"mode"', '"rect"', '"fgRatio"'):
                i = line.find(key)
                if i >= 0:
                    facts.setdefault('upload_region', '')
                    facts['upload_region'] += line[i:i + 80] + ' '
        elif 'cloud_ok' in line:
            facts['stages'].append('cloud_ok')
            facts['cloud_ok'] = line[line.find('cloud_ok'):][:200]
        elif 'cloud_fail' in line:
            facts['stages'].append('cloud_fail')
            facts['cloud_fail'] = line[line.find('cloud_fail'):][:250]
        elif 'cloud_degraded_quality' in line:
            facts['stages'].append('cloud_degraded_quality')
            facts['cloud_degraded_quality'] = line[line.find('cloud_degraded_quality'):][:250]
        elif 'blocked_no_consent' in line:
            facts['stages'].append('blocked_no_consent')
    return facts


SHOULDER_LIMIT_DEG = 8  # 【P1 #78】肩线贴合度达标线（模板旋转角 vs 实测肩线夹角）


def classify(rec, band_ratio):
    st = rec.get('status') or ''
    if rec.get('error'):
        return 'FAIL', '运行异常'
    if not rec.get('finished'):
        return 'FAIL', '处理超时'
    if '失败' in st:
        return 'FAIL', '状态行=失败'
    # 【P1 #78】肩线贴合度：超标即 FAIL（与状态行无关——几何不合格就是不合格）
    if rec.get('shoulderOk') is False:
        return 'FAIL', '肩线夹角 %.1f° > %d°（source=%s）' % (
            rec.get('shoulderAngleDeg') or 0.0, SHOULDER_LIMIT_DEG, rec.get('suitSource') or '-')
    is_cartoon = 'FaceQ' in rec.get('file', '')
    if '降级' in st:
        return ('EXPECTED-DEGRADE', '卡通负例，按 #49 预期降级') if is_cartoon else ('DEGRADED', '云端未交付（见 audit 原因码）')
    shoulder_txt = ''
    if rec.get('shoulderOk') is True:
        shoulder_txt = ' + 肩线 %.1f° ≤ %d°' % (rec.get('shoulderAngleDeg') or 0.0, SHOULDER_LIMIT_DEG)
    if '云端精修' in st and band_ratio is not None:
        if band_ratio > 0.02:
            return 'WARN', '边框带残留率 %.1f%% > 2%%%s' % (band_ratio * 100, shoulder_txt)
        return 'PASS', '云端精修 + 边框带残留率 %.2f%%%s' % (band_ratio * 100, shoulder_txt)
    if '端侧' in st and '云端精修' not in st:
        return 'DEGRADED', '走了端侧（未触发云端）'
    return 'WARN', '状态行无法归类: ' + st[:50]


def main():
    # T3 的结果文件名是 results_suit.json（batch_acceptance.js 按 SUBDIR 命名）
    rj = os.path.join(OUTDIR, 'results.json')
    if not os.path.exists(rj):
        alt = os.path.join(OUTDIR, 'results_suit.json')
        if os.path.exists(alt):
            rj = alt
    if not os.path.exists(rj):
        print('缺 results.json，先跑 batch_acceptance.js')
        sys.exit(2)
    with open(rj, encoding='utf-8') as f:
        data = json.load(f)
    # 【P1 #78】results.json 结构升级为 {results, summary}（含 source 分层与肩线统计）；
    # 兼容旧版纯数组结构。
    if isinstance(data, dict):
        results = data.get('results') or []
        stat = data.get('summary') or {}
    else:
        results = data
        stat = {}

    rows = []
    counts = {}
    for rec in results:
        bg = ratio = bbox = size = None
        if rec.get('resultImage'):
            p = os.path.join(ROOT, '素材', '测试截图', rec['resultImage'])
            if os.path.exists(p):
                bg, ratio, bbox, size = px_stats(p)
        verdict, reason = classify(rec, ratio)
        counts[verdict] = counts.get(verdict, 0) + 1
        facts = parse_audit(rec.get('audit') or [])
        rec['_verdict'] = verdict
        rec['_reason'] = reason
        rec['_bg'] = bg
        rec['_bandRatio'] = ratio
        rec['_bbox'] = bbox
        rec['_size'] = size
        rec['_facts'] = facts
        rows.append(rec)

    # HTML 报告
    def esc(s):
        return html.escape(str(s if s is not None else ''))

    def img_url(rel):
        return urllib.parse.quote(rel)

    cards = []
    for rec in rows:
        orig = img_url(IMGDIR_REL + '/' + rec['file'])
        res = img_url(rec['resultImage']) if rec.get('resultImage') else ''
        v = rec['_verdict']
        color = {'PASS': '#1a7f37', 'WARN': '#bf8700', 'FAIL': '#cf222e',
                 'DEGRADED': '#bf8700', 'EXPECTED-DEGRADE': '#6e7781'}[v]
        facts_html = ''
        for k in ('upload_region', 'cloud_ok', 'cloud_fail', 'cloud_degraded_quality'):
            if k in rec['_facts']:
                facts_html += '<div class="fact"><b>%s</b>: %s</div>' % (k, esc(rec['_facts'][k]))
        suit_html = ''
        if rec.get('suitSource'):
            deg = rec.get('shoulderAngleDeg')
            suit_html = ('<div class="fact"><b>换装信号</b>: source=%s ｜ 肩线夹角 %s ｜ 肩宽 %s px ｜ 规格 %s</div>'
                         % (esc(rec.get('suitSource')),
                            ('%.1f°' % deg) if deg is not None else '-',
                            esc(rec.get('shoulderSpan')),
                            esc(rec.get('suitSpec') or '-')))
        metric = ''
        if rec['_bandRatio'] is not None:
            metric = ('尺寸 %s×%s ｜ 背景色 #%02X%02X%02X ｜ 边框带残留 <b>%.2f%%</b> ｜ 残留bbox %s'
                      % (rec['_size'][0], rec['_size'][1], rec['_bg'][0], rec['_bg'][1], rec['_bg'][2],
                         rec['_bandRatio'] * 100, esc(rec['_bbox'])))
        cards.append('''
        <div class="card">
          <h3>%s <span class="verdict" style="background:%s">%s</span></h3>
          <div class="imgs">
            <div><div class="cap">原图</div><img src="%s"></div>
            <div><div class="cap">成品（白底）</div>%s</div>
          </div>
          <div class="row">状态行：%s</div>
          <div class="row">判定：%s</div>
          <div class="row">%s</div>
          %s
          %s
          %s
        </div>''' % (
            esc(rec['file']), color, v,
            orig,
            ('<img src="%s">' % res) if res else '<div class="noimg">无成品</div>',
            esc(rec.get('status') or '(无)'),
            esc(rec['_reason']),
            esc(metric),
            suit_html,
            facts_html,
            ('<div class="err">错误: %s</div>' % esc(rec.get('error'))) if rec.get('error') else '',
        ))

    summary = ' ｜ '.join('%s: %d' % (k, counts[k]) for k in
                      ['PASS', 'WARN', 'FAIL', 'DEGRADED', 'EXPECTED-DEGRADE'] if k in counts)
    # 【P1 #78】信号来源分层 + 肩线达标率
    if stat:
        by_src = stat.get('bySource') or {}
        sh = stat.get('shoulder') or {}
        src_txt = ' ｜ 信号来源: ' + ' / '.join('%s=%d' % (k, v) for k, v in sorted(by_src.items()))
        sh_txt = (' ｜ 肩线贴合度(≤%s°): 评估 %s / 达标 %s / 超标 %s'
                  % (sh.get('limitDeg', SHOULDER_LIMIT_DEG), sh.get('evaluated', 0),
                     sh.get('pass', 0), sh.get('fail', 0)))
        summary = summary + src_txt + sh_txt
    html_doc = '''<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><title>真实头像批量验收报告</title>
<style>
body{font-family:-apple-system,"PingFang SC",sans-serif;margin:24px;background:#f6f8fa;color:#1f2328}
h1{font-size:20px} h3{font-size:15px;margin:0 0 8px}
.card{background:#fff;border:1px solid #d0d7de;border-radius:8px;padding:16px;margin-bottom:16px}
.imgs{display:flex;gap:16px;margin-bottom:8px}
.imgs img{max-height:320px;max-width:280px;border:1px solid #d0d7de}
.cap{font-size:12px;color:#57606a;margin-bottom:4px}
.verdict{color:#fff;font-size:12px;padding:2px 8px;border-radius:10px;vertical-align:middle}
.row{font-size:13px;margin:2px 0}
.fact{font-size:12px;color:#57606a;font-family:monospace;word-break:break-all}
.err{font-size:12px;color:#cf222e}
.noimg{color:#cf222e}
.meta{font-size:13px;color:#57606a;margin-bottom:16px}
</style></head><body>
<h1>真实头像批量验收报告（T2 单独换底色 · 真实云函数链路）</h1>
<div class="meta">生成时间: %s ｜ 判定口径见《问题台账》#67：本报告只陈述事实，PASS/WARN/FAIL 规则见 report_acceptance.py 头注释。<br><b>%s</b></div>
%s
</body></html>''' % (
        __import__('datetime').datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        esc(summary), '\n'.join(cards))

    out = os.path.join(OUTDIR, 'report.html')
    with open(out, 'w', encoding='utf-8') as f:
        f.write(html_doc)
    print('报告已生成:', out)
    print('汇总:', summary)


if __name__ == '__main__':
    main()
