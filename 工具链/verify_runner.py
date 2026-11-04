#!/usr/bin/env python3
"""RC-02验证调度：隔离快照、真实退出码和不可覆盖的证据。"""

import argparse
import datetime
import hashlib
import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
STATES = ('PASS', 'FAIL', 'BLOCKED', 'SKIPPED', 'N/A')


class UsageError(ValueError):
    pass


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise UsageError(message)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def redact(text):
    text = re.sub(r'data:image/[^;\s]+;base64,[A-Za-z0-9+/=]+', '[图片已脱敏]', text)
    text = re.sub(r'(?i)(["\']?(?:imageB64|alphaB64|base64|image|access_token|secret_key|api_key)["\']?\s*[:=]\s*)["\'][^"\']*["\']',
                  r'\1"[已脱敏]"', text)
    return re.sub(r'[A-Za-z0-9+/]{256,}={0,2}', '[长编码已脱敏]', text)


def write_json(path, data):
    with path.open('x', encoding='utf-8') as stream:
        json.dump(data, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


def capture(command, cwd, timeout):
    started = time.monotonic()
    process = None
    try:
        process = subprocess.Popen(command, cwd=str(cwd), stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, start_new_session=True)
        output, _ = process.communicate(timeout=timeout)
        return process.returncode, redact(output.decode('utf-8', errors='replace')), round(time.monotonic() - started, 3)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            output, _ = process.communicate(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            output, _ = process.communicate()
        return None, 'VERIFY_TIMEOUT：检查超时\n' + redact(output.decode('utf-8', errors='replace')), round(time.monotonic() - started, 3)
    except OSError:
        return None, 'VERIFY_EXEC_UNAVAILABLE：无法启动检查命令，请检查本机依赖与路径。', round(time.monotonic() - started, 3)


def snapshot(root, workspace):
    """只复制可执行所需输入，不读.env/密钥/证书，不复制历史报告。"""
    workspace.mkdir()
    ignored = shutil.ignore_patterns('node_modules', 'dist', '.git', '.env*', '*.pem', '*.key',
                                     '*.p12', '*.pfx', '*.crt', '*.cer', 'project.private.config.json',
                                     '__pycache__', '_tmp', '验证记录', '.swc')
    app = root / 'idphoto-miniprogram'
    target = workspace / app.name
    target.mkdir()
    for name in ['src', 'types', 'config', 'cloudfunctions', 'poc']:
        if (app / name).is_dir():
            shutil.copytree(str(app / name), str(target / name), ignore=ignored)
    for name in ['package.json', 'package-lock.json', 'tsconfig.json', 'babel.config.js', 'project.config.json']:
        if (app / name).is_file():
            shutil.copyfile(str(app / name), str(target / name))
    if (app / 'node_modules').is_dir():
        (target / 'node_modules').symlink_to(app / 'node_modules', target_is_directory=True)
    shutil.copytree(str(root / '工具链'), str(workspace / '工具链'), ignore=ignored)
    lint_modules = root / '工具链/lint/node_modules'
    if lint_modules.is_dir():
        (workspace / '工具链/lint/node_modules').symlink_to(lint_modules, target_is_directory=True)
    for name in ['真实头像', '测试图']:
        source = root / '素材' / name
        if source.is_dir():
            shutil.copytree(str(source), str(workspace / '素材' / name), ignore=ignored)
    if (root / 'prototype.html').is_file():
        shutil.copyfile(str(root / 'prototype.html'), str(workspace / 'prototype.html'))
    baseline = root / 'docs/rc01-baseline.json'
    if baseline.is_file():
        (workspace / 'docs').mkdir()
        shutil.copyfile(str(baseline), str(workspace / 'docs/rc01-baseline.json'))
    manifest = {}
    for base, dirs, files in os.walk(str(workspace), followlinks=False):
        dirs[:] = [name for name in dirs if name != 'node_modules']
        for name in files:
            path = Path(base) / name
            manifest[str(path.relative_to(workspace))] = digest(path)
    return manifest


def plan(args):
    milestone = args.profile == 'milestone'
    steps = [
        {'id': 'unit', 'command': ['npm', 'run', 'test:core'], 'app': True},
        {'id': 'types', 'command': ['node', 'node_modules/typescript/bin/tsc', '--noEmit'], 'app': True},
        {'id': 'lint', 'command': ['npm', 'run', 'lint'], 'app': True},
        {'id': 'build', 'command': ['npm', 'run', 'build:weapp'], 'app': True,
         'skip': args.no_build or args.quick, 'required': milestone or not (args.no_build or args.quick)},
        {'id': 'coverage', 'command': ['node', '工具链/coverage_matrix.js', '--check'],
         'skip': not milestone or args.quick, 'required': milestone},
    ]
    for tool, script in [('t1', 'smoke_auto.js'), ('t2', 'smoke_t2.js'), ('t3', 'smoke_t3.js'),
                         ('t4', 'smoke_face.js'), ('t5', 'smoke_t5.js'), ('t6', 'smoke_print.js')]:
        steps.append({'id': 'smoke-' + tool, 'command': ['node', '工具链/' + script],
                      'skip': not milestone or args.no_ide or args.quick, 'required': milestone, 'ide': True})
    steps.append({'id': 'batch', 'command': ['node', '工具链/batch_real.js', '--negatives', '--out', 'batch-products'],
                  'skip': not milestone or args.no_ide or args.quick, 'required': milestone, 'ide': True})
    for step in steps:
        step.setdefault('required', True)
    return steps


def batch_verdict(path):
    try:
        data = json.loads(path.read_text())
        summary = data['summary']
        business = summary['business']
        connectivity = summary['connectivity']
        if summary['total'] <= 0 or not data['results']:
            return 'BLOCKED', '批验没有任何样本证据', None
        if connectivity['fail'] or business['fail']:
            return 'FAIL', '批验报告存在连通性或业务失败', summary
        if business['notEvaluated'] or business['envLimited'] or business['notApplicable']:
            return 'BLOCKED', '批验仍有未评估、环境受限或不适用断言，需逐项审查', summary
        if (business['evaluated'] != summary['total'] or business['pass'] != summary['total'] or
                connectivity['pass'] != summary['total'] or len(data['results']) != summary['total']):
            return 'FAIL', '批验汇总数量不一致', summary
        if any(row.get('connectivity') is not True or not isinstance(row.get('assertions'), dict) or
               row['assertions'].get('pass') is not True for row in data['results']):
            return 'FAIL', '批验逐项结果与成功汇总不一致', summary
        return 'PASS', '当前批验报告已执行且无失败/受限项', summary
    except (OSError, ValueError, KeyError, TypeError):
        return 'FAIL', '批验返回成功但报告缺失或格式不完整', None


def aggregate(results):
    if any(row['status'] == 'FAIL' for row in results):
        return 'FAIL', 1
    if any(row['required'] and row['status'] != 'PASS' for row in results):
        return 'BLOCKED', 3
    return 'PASS', 0


def run(args, root=ROOT):
    zone = datetime.timezone(datetime.timedelta(hours=8))
    run_id = datetime.datetime.now(zone).strftime('run-%Y%m%d-%H%M%S-') + uuid.uuid4().hex[:8]
    parent = Path(args.output_root).resolve() if args.output_root else root / 'docs/验证记录/verify-runs'
    for source in [root / '工具链', root / 'idphoto-miniprogram', root / '素材']:
        try:
            parent.relative_to(source.resolve())
        except ValueError:
            continue
        raise UsageError('输出父目录不能位于源码/工具/素材目录内，以免快照递归或污染输入。')
    parent.mkdir(parents=True, exist_ok=True)
    out = parent / run_id
    out.mkdir()
    trace_id = 'verify-' + uuid.uuid4().hex
    metadata = {'run_id': run_id, 'trace_id': trace_id, 'timezone': 'Asia/Taipei',
                'created_at': datetime.datetime.now(zone).isoformat(), 'profile': args.profile,
                'scope': '开发范围检查（不含IDE/发布资格）' if args.profile == 'development' else '里程碑自动检查（不替代真机与发布审批）',
                'options': vars(args), 'workspace': str(out / 'workspace'),
                'platform': sys.platform, 'python': sys.version.split()[0], 'provider': 'N/A：尚未执行云端业务',
                'device': '本机检查；IDE/真机情况按各步骤证据判断', 'build_id': None}
    _, head, _ = capture(['git', 'rev-parse', 'HEAD'], root, 10)
    _, status, _ = capture(['git', 'status', '--porcelain'], root, 10)
    _, diff, _ = capture(['git', 'diff', '--binary'], root, 10)
    metadata.update(git_head=head.strip(), worktree_status=status.splitlines(),
                    tracked_diff_sha256=hashlib.sha256(diff.encode()).hexdigest())
    for name in ['node', 'npm']:
        code, value, _ = capture([name, '--version'], root, 10)
        metadata[name + '_version'] = value.strip() if code == 0 else 'unavailable'
    results = []
    try:
        inputs = snapshot(root, out / 'workspace')
        write_json(out / 'inputs.json', inputs)
        metadata['input_manifest_sha256'] = digest(out / 'inputs.json')
        metadata['dataset'] = {name: sha for name, sha in inputs.items() if name.startswith('素材/')}
        steps = plan(args)
        halted = False
        previous_ide = False
        for step in steps:
            row = {'id': step['id'], 'required': step['required'], 'command': step['command'],
                   'status': 'SKIPPED', 'exit_code': None, 'seconds': 0, 'reason': ''}
            if step.get('skip'):
                row['status'] = 'SKIPPED' if step['required'] or step['id'] == 'build' else 'N/A'
                row['reason'] = '用户显式跳过，不能算已执行' if row['status'] == 'SKIPPED' else '开发检查范围不包含此项'
                if step['required']:
                    halted = True
            elif halted:
                row['reason'] = '上游检查未通过，本项未执行'
            else:
                if step.get('ide') and previous_ide and args.ide_wait:
                    time.sleep(args.ide_wait)
                cwd = out / 'workspace'
                if step.get('app'):
                    cwd = cwd / 'idphoto-miniprogram'
                code, output, seconds = capture(step['command'], cwd, args.timeout)
                row.update(exit_code=code, seconds=seconds)
                log = out / (step['id'] + '.log')
                with log.open('x', encoding='utf-8') as stream:
                    stream.write(output)
                row['log'] = log.name
                if code is None:
                    row.update(status='BLOCKED', reason='命令无法启动或超时，参见脱敏日志')
                elif code == 0:
                    row.update(status='PASS', reason='命令实际退出0')
                elif step['id'] == 'coverage' and code == 1:
                    row.update(status='BLOCKED', reason='需求覆盖存在已知缺口，不能算里程碑通过')
                elif step['id'] == 'lint' and code == 3:
                    row.update(status='BLOCKED', reason='隔离Lint依赖未安装，不能跳过后报告通过')
                elif step.get('ide') and code == 3:
                    row.update(status='BLOCKED', reason='IDE环境不可用，未完成业务验收')
                else:
                    row.update(status='FAIL', reason='检查非零退出（含未知退出码），禁止当成功')
                if row['status'] == 'PASS' and step['id'] == 'build':
                    build = out / 'workspace/idphoto-miniprogram/dist'
                    if not (build / 'app.json').is_file():
                        row.update(status='FAIL', reason='编译返回成功，但新快照没有dist/app.json')
                    else:
                        tree = {str(p.relative_to(build)): digest(p) for p in sorted(build.rglob('*')) if p.is_file()}
                        write_json(out / 'build-files.json', tree)
                        metadata['build_id'] = digest(out / 'build-files.json')
                if row['status'] == 'PASS' and step['id'] == 'batch':
                    row['status'], row['reason'], summary = batch_verdict(out / 'workspace/batch-products/results.json')
                    row['business_summary'] = summary
                    metadata['provider'] = '参见当前batch-products结果的backend/source；未据状态行推断'
                if step.get('ide'):
                    previous_ide = True
                if row['status'] != 'PASS':
                    halted = True
            results.append(row)
            print('[{}] {}：{}'.format(row['status'], row['id'], row['reason']), flush=True)
    except (OSError, ValueError, TypeError) as error:
        results.append({'id': 'runner', 'required': True, 'status': 'FAIL', 'exit_code': None,
                        'reason': 'VERIFY_INTERNAL_ERROR：验证准备或证据写入失败', 'error_type': type(error).__name__,
                        'trace_id': trace_id})
    overall, code = aggregate(results)
    summary = {state: sum(row['status'] == state for row in results) for state in STATES}
    report = {'status': overall, 'exit_code': code, 'scope': metadata['scope'],
              'counts': summary, 'metadata': metadata, 'steps': results,
              'limitations': ['覆盖映射的语义正确性归RC-03；脚本成功不代表所有需求已验收',
                              '真机、部署、资质与正式发布审批不在本命令自动检查结论内']}
    write_json(out / 'report.json', report)
    print(json.dumps({'status': overall, 'scope': metadata['scope'], 'counts': summary,
                      'report': str(out / 'report.json'), 'trace_id': trace_id}, ensure_ascii=False), flush=True)
    return code


def main():
    parser = Parser(description=__doc__)
    parser.add_argument('--profile', choices=['development', 'milestone'], default='development')
    parser.add_argument('--no-build', action='store_true')
    parser.add_argument('--no-ide', action='store_true')
    parser.add_argument('--quick', action='store_true')
    parser.add_argument('--strict', action='store_true', help='兼容旧参数；里程碑本身已严格阻断必需未验项')
    parser.add_argument('--output-root', help='在此目录下新建唯一run目录，不复用旧目录')
    parser.add_argument('--timeout', type=float, default=600, help='每条检查命令超时秒数')
    parser.add_argument('--ide-wait', type=float, default=30, help='串行IDE检查之间等待秒数（0–60）')
    try:
        args = parser.parse_args()
        if not math.isfinite(args.timeout) or args.timeout <= 0 or not math.isfinite(args.ide_wait) or not 0 <= args.ide_wait <= 60:
            raise UsageError('timeout必须大于0，ide-wait必须在0至60秒之间')
        return run(args)
    except (UsageError, OSError, ValueError) as error:
        print(json.dumps({'status': 'FAIL', 'code': 'VERIFY_USAGE_OR_OUTPUT_ERROR',
                          'message': str(error) if isinstance(error, UsageError) else '参数或输出目录不可用，请检查路径。',
                          'trace_id': 'verify-' + uuid.uuid4().hex}, ensure_ascii=False))
        return 2


if __name__ == '__main__':
    sys.exit(main())
