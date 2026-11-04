#!/usr/bin/env python3
"""只读检查 RC-01 需求基线；不生成报告、不覆盖历史文件。"""

import argparse
import copy
import hashlib
import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
BASELINE = ROOT / 'docs/rc01-baseline.json'


def ledger_ids(text):
    result = set()
    for line in text.splitlines():
        cells = [c.strip() for c in line.split('|')[1:-1]]
        if len(cells) in (6, 7) and re.fullmatch(r'\d+[a-z]?', cells[0]):
            result.add(cells[0])
    return result


def validate(data):
    errors = []

    def check(ok, message):
        if not ok:
            errors.append(message)

    rows = data.get('requirements', [])
    ids = [x.get('id') for x in rows]
    legacy = json.loads((ROOT / '工具链/prd_requirements.json').read_text())
    check(len(ids) == len(set(ids)), '需求编号重复')
    required = {x['id'] for x in legacy['requirements']}
    prd = (ROOT / '证件照小程序PRD正文.md').read_text()
    required.update(re.findall(r'\*\*([A-K]\d+(?:\.\d+)?)\s', prd))
    required.update(f'AC{i}' for i in range(1, 14))
    required.update(f'FLOW-{i}' for i in range(1, 7))
    required.update(f'EC-{i:02}' for i in range(1, 11))
    required.update(['K0', 'K2', 'H2.2', 'NFR-QUALITY', 'NFR-COMPAT',
                     'NFR-SECURITY', 'NFR-OFFLINE', 'METRIC-01', 'PRIV-01', 'REG-01'])
    check(required <= set(ids), '需求缺失：' + ','.join(sorted(required - set(ids))))
    screens = set(re.findall(r'id="((?:s_|m_)[^"]+)"', (ROOT / 'prototype.html').read_text()))
    tasks = set(re.findall(r'^## (RC-\d{2}) ', (ROOT / 'docs/整改开发任务.md').read_text(), re.M))
    statuses = {'部分实现', '待功能验收', '待真机验收', '待质量验收', '待外部证据'}
    for row in rows:
        key = row.get('id', '?')
        for field in ['source', 'tools', 'requirement', 'status', 'evidence', 'gap', 'acceptance', 'tasks']:
            check(bool(row.get(field)), f'{key} 缺少 {field}')
        check(row.get('status') in statuses, f'{key} 现状状态无效或未经业务验收标为完成')
        check(set(row.get('prototype', [])) <= screens, f'{key} 原型屏不存在')
        check(set(row.get('tools', [])) <= {f'T{i}' for i in range(1, 7)}, f'{key} 工具编号无效')
        check(set(row.get('tasks', [])) <= tasks, f'{key} 后续任务不存在')
        for path in row.get('evidence', []):
            target = (ROOT / path).resolve()
            try:
                target.relative_to(ROOT)
                inside = True
            except ValueError:
                inside = False
            check(inside and target.is_file(), f'{key} 证据路径无效：{path}')
    decisions = data.get('decisions', [])
    decision_ids = {d.get('id') for d in decisions}
    check({'D-01', 'D-02', 'D-03'} <= decision_ids and len(decision_ids) == len(decisions), '三项基础用户决策缺失或决策编号重复')
    for decision in decisions:
        check(decision.get('status') == '用户确认' and bool(decision.get('source')), '用户决策来源或状态无效')
    history = data.get('historical_tasks', [])
    historical_ids = [x.get('id') for x in history]
    check(len(historical_ids) == len(set(historical_ids)), '历史任务编号重复')
    check(set(historical_ids) == ledger_ids((ROOT / '开发任务台账.md').read_text()), '历史主表/P1任务复核遗漏或多录')
    for row in history:
        check(all(row.get(k) for k in ['title', 'previous_status', 'review_status', 'reason', 'tasks',
                                     'evidence', 'review_basis']),
              f'历史任务 {row.get("id")} 复核字段不全')
        check(set(row.get('tasks', [])) <= tasks, '历史复核后续任务不存在')
        check(row.get('review_status') != '待当前证据复核', f'历史任务 {row.get("id")} 仍为笼统复核结论')
        for path in row.get('evidence', []):
            check((ROOT / path).is_file(), f'历史任务 {row.get("id")} 证据不存在：{path}')
    hashes = data.get('code_sha256', {})
    code_paths = {p for row in rows for p in row.get('evidence', []) if p.startswith('idphoto-miniprogram/')}
    check(set(hashes) == code_paths, '代码证据哈希未完整绑定')
    for path, expected in hashes.items():
        file = ROOT / path
        check(file.is_file() and hashlib.sha256(file.read_bytes()).hexdigest() == expected,
              f'代码证据已变化，须重新复核基线：{path}')
    return errors


def check_documents(data, baseline_text=None):
    errors = []
    baseline = baseline_text if baseline_text is not None else (ROOT / 'docs/RC-01需求与现状基线.md').read_text()
    table = {}
    for line in baseline.splitlines():
        if not line.startswith('| '):
            continue
        cells = [cell.strip() for cell in line.split('|')[1:-1]]
        if cells:
            table.setdefault(cells[0], []).append(cells)

    def cell_text(value):
        return str(value).replace('|', '／').replace('\n', ' ')

    for row in data['requirements']:
        matches = table.get(row['id'], [])
        if len(matches) != 1 or len(matches[0]) != 7:
            errors.append(f'可读基线需求行缺失、重复或列数错误：{row["id"]}')
            continue
        cells = matches[0]
        if (cells[3] != cell_text(row['requirement']) or
                cells[5] != cell_text(row['acceptance']) or
                cells[6] != ','.join(row['tasks']) or
                not cells[4].startswith(cell_text(row['status'] + '：' + row['gap']))):
            errors.append(f'可读基线与机器清单语义不一致：{row["id"]}')
    for row in data['historical_tasks']:
        matches = table.get('#' + row['id'], [])
        if len(matches) != 1 or len(matches[0]) != 5:
            errors.append(f'可读历史复核行缺失、重复或列数错误：{row["id"]}')
            continue
        cells = matches[0]
        if cells[3] != cell_text(row['review_status']) or not cells[4].startswith(cell_text(row['reason'])):
            errors.append(f'可读历史复核与机器清单不一致：{row["id"]}')
        for path in row.get('evidence', []):
            if f'(../{path})' not in cells[4]:
                errors.append(f'历史复核未展示证据链接：{row["id"]} / {path}')
    files = ['docs/RC-01需求与现状基线.md', 'docs/整改开发任务.md', 'docs/规则约束审查.md',
             '证件照小程序PRD正文.md', '页面原型设计.md', '产品功能清单.md',
             '测试用例与验收清单.md', '小程序开发指南.md', '项目资产与工具手册.md',
             '开发任务台账.md', '问题台账.md', '每日开发日志/2026-10-28.md']
    for name in files:
        text = (ROOT / name).read_text()
        if 'RC-01' not in text:
            errors.append(f'{name} 无 RC-01 同步记录')
        for link in re.findall(r'\]\(([^\s)#]+)(?:#[^)]*)?\)', text):
            if '://' in link or link.startswith('mailto:'):
                continue
            if not ((ROOT / name).parent / link).exists():
                errors.append(f'{name} 链接目标不存在：{link}')
    tests = (ROOT / '测试用例与验收清单.md').read_text()
    for i in range(1, 14):
        if not re.search(r'\| \*\*AC' + str(i) + r'\*\*', tests):
            errors.append(f'测试用例未登记 AC{i}')
    if '| **AC11** 隐私政策' in tests:
        errors.append('AC11 仍与隐私政策用例撞号')
    prd = (ROOT / '证件照小程序PRD正文.md').read_text()
    for old in ['低分辨率原片 → 阻断', 'AC1：镜像自拍图应被识别']:
        if old in prd:
            errors.append('PRD 仍保留已作废口径：' + old)
    expected = {
        '证件照小程序PRD正文.md': ['不承诺自动识别', '低分辨率仅提示、允许继续', '渐变纳入本轮整改', 'HEX / RGB 输入'],
        '产品功能清单.md': ['镜像人工自查', '渐变纳入 RC-07', '自定义色值 HEX/RGB'],
        '页面原型设计.md': ['AC1：拍摄提示＋人工镜像自查', 'AC3：低分辨率只提示', '渐变、HEX/RGB 纳入本轮整改'],
        '测试用例与验收清单.md': ['镜像人工自查', '低分辨率提示本身不阻断', '自定义 HEX/RGB 与渐变'],
        'docs/整改开发任务.md': ['T2 接入渐变及 HEX/RGB 输入'],
    }
    for name, phrases in expected.items():
        content = (ROOT / name).read_text()
        for phrase in phrases:
            if phrase not in content:
                errors.append(f'{name} 用户决策未同步：{phrase}')
    baseline_rows = {row['id']: row for row in data['requirements']}
    legacy = json.loads((ROOT / '工具链/prd_requirements.json').read_text())
    for row in legacy['requirements']:
        if row['id'] in {'A3', 'AC1', 'AC3', 'C1', 'C2', 'H2', 'I4'}:
            if row['desc'] != baseline_rows[row['id']]['requirement']:
                errors.append(f'旧需求输入 {row["id"]} 与新基线不一致')
    return errors


def selftest(data):
    # 注入缺陷证明检查器会拒绝，不修改真实文件。
    mutations = [
        ('遗漏需求', lambda d: d['requirements'].pop(0)),
        ('重复编号', lambda d: d['requirements'].append(copy.deepcopy(d['requirements'][0]))),
        ('虚假证据', lambda d: d['requirements'][0]['evidence'].append('docs/不存在的RC01证据.md')),
        ('空验收条件', lambda d: d['requirements'][0].update(acceptance='')),
        ('伪造已确认', lambda d: d['decisions'][0].update(status='未确认')),
        ('源码哈希错配', lambda d: d['code_sha256'].update({next(iter(d['code_sha256'])): '0' * 64})),
        ('历史任务遗漏', lambda d: d['historical_tasks'].pop()),
        ('历史复核无定位证据', lambda d: d['historical_tasks'][0].update(evidence=[])),
        ('历史复核仍为空话', lambda d: d['historical_tasks'][0].update(review_status='待当前证据复核')),
        ('机器清单与可读表不同步', lambda d: d['requirements'][0].update(acceptance='篡改后的验收条件')),
    ]
    failures = []
    for label, mutate in mutations:
        sample = copy.deepcopy(data)
        mutate(sample)
        if not (validate(sample) + check_documents(sample)):
            failures.append('反例未被识别：' + label)
    baseline = (ROOT / 'docs/RC-01需求与现状基线.md').read_text()
    tampered = baseline.replace(data['requirements'][0]['acceptance'], '仅篡改可读表的验收条件', 1)
    if not check_documents(data, baseline_text=tampered):
        failures.append('反例未被识别：仅可读表被篡改')
    return failures, len(mutations) + 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--selftest', action='store_true', help='同时验证内存中的反例')
    args = parser.parse_args()
    try:
        data = json.loads(BASELINE.read_text())
        errors = validate(data) + check_documents(data)
        negative_cases = 0
        if args.selftest:
            failures, negative_cases = selftest(data)
            errors.extend(failures)
        print(json.dumps({'status': 'FAIL' if errors else 'PASS', 'scope': 'RC-01文档基线，不代表业务验收',
                          'requirements': len(data['requirements']), 'historical_tasks': len(data['historical_tasks']),
                          'negative_cases': negative_cases, 'errors': errors}, ensure_ascii=False, indent=2))
        return 1 if errors else 0
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(json.dumps({'status': 'FAIL', 'code': 'RC01_INPUT_ERROR',
                          'message': '基线或文档读取/格式异常，请检查输入文件。',
                          'error_type': type(error).__name__}, ensure_ascii=False))
        return 2


if __name__ == '__main__':
    sys.exit(main())
