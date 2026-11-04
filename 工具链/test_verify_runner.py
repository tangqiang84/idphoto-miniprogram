#!/usr/bin/env python3
"""RC-02隔离验收夹具；所有文件保留，不修改真实业务文件或删除目录。"""

import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import unittest
import uuid
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
sys.dont_write_bytecode = True
FIXTURES = ROOT / '工具链/_tmp' / ('rc02-fixtures-' + uuid.uuid4().hex[:10])

SHIM = '''import json,os,sys,time
from pathlib import Path
scenario=Path(os.environ['RC02_FIXTURE_CONFIG'])
config=json.loads(scenario.read_text())
args=sys.argv[1:]
if args==['--version']:
 print('fixture-1.0');sys.exit(0)
if Path(sys.argv[0]).name=='npm':
 kind={'test:core':'unit','lint':'lint','build:weapp':'build'}[args[1]]
elif args and args[0].endswith('/tsc'):kind='types'
elif args and args[0].endswith('coverage_matrix.js'):kind='coverage'
elif args and args[0].endswith('batch_real.js'):kind='batch'
else:kind='smoke'
with (scenario.parent/'calls.jsonl').open('a') as f:f.write(json.dumps({'kind':kind})+'\\n')
if config.get('sleep')==kind:time.sleep(2)
print('fixture '+kind+' api_key="fixture-secret"')
code=config.get('codes',{}).get(kind,0)
if code==0 and kind=='build' and not config.get('missing_build'):
 p=Path.cwd()/'dist';p.mkdir();(p/'app.json').write_text('{}')
if code==0 and kind=='batch' and not config.get('missing_batch'):
 total=0 if config.get('empty_batch') else 1
 data={'summary':{'total':total,'connectivity':{'pass':total,'fail':0},'business':{'evaluated':total,'pass':total,'fail':0,'notEvaluated':0,'envLimited':config.get('env_limited',0),'notApplicable':config.get('not_applicable',0)}},'results':[] if total==0 else [{'connectivity':True,'assertions':{'pass':not config.get('false_row',False)}}]}
 p=Path.cwd()/args[args.index('--out')+1];p.mkdir();(p/'results.json').write_text(json.dumps(data))
sys.exit(code)
'''


class RunnerTests(unittest.TestCase):
    def test_snapshot_includes_coverage_baseline(self):
        spec = importlib.util.spec_from_file_location('runner_rc03', ROOT / '工具链/verify_runner.py')
        runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runner)
        home, _ = self.fixture()
        (home / 'docs').mkdir()
        baseline = home / 'docs/rc01-baseline.json'
        baseline.write_text('{"requirements": [{"id": "fixture"}]}')
        (home / 'docs/history.md').write_text('不属于执行输入')
        workspace = home / 'snapshot'
        manifest = runner.snapshot(home, workspace)
        self.assertEqual((workspace / 'docs/rc01-baseline.json').read_bytes(), baseline.read_bytes())
        self.assertEqual(manifest['docs/rc01-baseline.json'], hashlib.sha256(baseline.read_bytes()).hexdigest())
        self.assertFalse((workspace / 'docs/history.md').exists())

    def test_daily_summary_supports_rc_and_legacy_tables(self):
        spec = importlib.util.spec_from_file_location('daily_summary_rc02', ROOT / '工具链/daily_summary.py')
        daily = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(daily)
        text = ('| # | 任务 | 状态 | 负责人 |\n|---|---|---|---|\n'
                '| 14 | 真机 | 🔵 进行中 | 唐强 |\n| 1 | 旧完成 | ✅ 完成 | AI |\n'
                '| ID | 优先级 | 任务 | 依赖 | 状态 |\n|---|---|---|---|---|\n'
                '| RC-01 | P0 | 基线 | 无 | 完成 |\n'
                '| RC-02 | P0 | 验证 | RC-01 | 进行中 |\n'
                '| RC-03 | P0 | 映射 | RC-02 | 待办 |\n')
        rows = daily.parse_task_rows(text)
        self.assertEqual([row[0] for row in rows], ['14', 'RC-02', 'RC-03'])
        self.assertEqual(rows[0][3], '唐强')
        self.assertEqual(rows[1][3], '按任务依赖安排')

    def fixture(self, config=None):
        home = FIXTURES / ('case-' + uuid.uuid4().hex[:8])
        tools = home / '工具链'
        tools.mkdir(parents=True)
        for name in ['verify_runner.py', 'verify.sh', 'verify_all.sh']:
            shutil.copyfile(str(ROOT / '工具链' / name), str(tools / name))
        app = home / 'idphoto-miniprogram'
        (app / 'src').mkdir(parents=True)
        (app / 'src/sentinel.ts').write_text('export const sentinel = 1;\n')
        (app / 'dist').mkdir()
        (app / 'dist/sentinel.txt').write_text('不得覆盖')
        (app / 'node_modules/typescript/bin').mkdir(parents=True)
        (app / 'node_modules/typescript/bin/tsc').write_text('// fixture')
        (app / 'package.json').write_text('{}')
        config_path = home / 'scenario.json'
        config_path.write_text(json.dumps(config or {}))
        binary = home / 'bin'
        binary.mkdir()
        for name in ['npm', 'node']:
            p = binary / name
            p.write_text('#!' + sys.executable + '\n' + SHIM)
            p.chmod(0o755)
        env = dict(os.environ, PATH=str(binary) + os.pathsep + os.environ['PATH'],
                   RC02_FIXTURE_CONFIG=str(config_path))
        return home, env

    def invoke(self, config=None, wrapper='verify_all.sh', options=None, fixture=None):
        home, env = fixture or self.fixture(config)
        command = ['bash', str(home / '工具链' / wrapper), '--ide-wait', '0'] + (options or [])
        result = subprocess.run(command, env=env, cwd=str(home), capture_output=True, text=True, timeout=30)
        reports = sorted((home / 'docs/验证记录/verify-runs').glob('*/report.json'), key=lambda p: p.stat().st_mtime)
        self.assertTrue(reports, result.stdout + result.stderr)
        report = json.loads(reports[-1].read_text())
        self.assertEqual((home / 'idphoto-miniprogram/dist/sentinel.txt').read_text(), '不得覆盖')
        self.assertFalse((home / 'idphoto-miniprogram/dist/app.json').exists())
        self.assertEqual((home / 'idphoto-miniprogram/src/sentinel.ts').read_text(), 'export const sentinel = 1;\n')
        calls = [json.loads(line)['kind'] for line in (home / 'calls.jsonl').read_text().splitlines()]
        self.assertLessEqual(calls.count('unit'), 1, 'core单测不得为计数而重复执行')
        return result, report, reports[-1], calls

    def test_success_and_redaction(self):
        result, report, path, _ = self.invoke()
        self.assertEqual(result.returncode, 0)
        self.assertEqual(report['status'], 'PASS')
        self.assertEqual(report['counts']['PASS'], 12)
        self.assertTrue(report['metadata']['build_id'])
        self.assertNotIn('fixture-secret', ''.join(p.read_text() for p in path.parent.glob('*.log')))

    def test_development_is_scoped(self):
        result, report, _, _ = self.invoke(wrapper='verify.sh', options=['--quick'])
        self.assertEqual(result.returncode, 0)
        self.assertIn('开发范围', report['scope'])
        self.assertEqual(next(s for s in report['steps'] if s['id'] == 'build')['status'], 'SKIPPED')
        self.assertGreater(report['counts']['N/A'], 0)
        self.assertNotIn('全量验证通过', result.stdout)

    def test_types_fail_both_wrappers(self):
        for wrapper in ['verify.sh', 'verify_all.sh']:
            with self.subTest(wrapper=wrapper):
                result, report, _, calls = self.invoke({'codes': {'types': 17}}, wrapper=wrapper)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(next(s for s in report['steps'] if s['id'] == 'types')['exit_code'], 17)
                self.assertNotIn('build', calls)

    def test_unit_lint_build_failures(self):
        for kind in ['unit', 'lint', 'build']:
            with self.subTest(kind=kind):
                result, report, _, _ = self.invoke({'codes': {kind: 19}})
                self.assertEqual(result.returncode, 1)
                self.assertEqual(next(s for s in report['steps'] if s['id'] == kind)['status'], 'FAIL')

    def test_missing_lint_dependency(self):
        result, report, _, _ = self.invoke({'codes': {'lint': 3}})
        self.assertEqual(result.returncode, 3)
        self.assertEqual(next(s for s in report['steps'] if s['id'] == 'lint')['status'], 'BLOCKED')

    def test_milestone_skips_block(self):
        for option in ['--no-ide', '--no-build', '--quick', 'downgrade']:
            with self.subTest(option=option):
                options = ['--profile', 'development', '--no-ide'] if option == 'downgrade' else [option]
                result, report, _, _ = self.invoke(options=options)
                self.assertEqual(result.returncode, 3)
                self.assertEqual(report['status'], 'BLOCKED')
                self.assertEqual(report['metadata']['profile'], 'milestone')

    def test_ide_blocked_not_passed(self):
        for kind in ['smoke', 'batch']:
            with self.subTest(kind=kind):
                result, report, _, _ = self.invoke({'codes': {kind: 3}})
                self.assertEqual(result.returncode, 3)
                self.assertEqual(report['status'], 'BLOCKED')

    def test_unknown_exit_and_business_failure(self):
        for kind, code in [('batch', 42), ('batch', 4), ('coverage', 2)]:
            with self.subTest(kind=kind, code=code):
                result, report, _, _ = self.invoke({'codes': {kind: code}})
                self.assertEqual(result.returncode, 1)
                self.assertEqual(report['status'], 'FAIL')

    def test_coverage_gap_blocks(self):
        result, report, _, _ = self.invoke({'codes': {'coverage': 1}})
        self.assertEqual(result.returncode, 3)
        self.assertEqual(report['status'], 'BLOCKED')

    def test_success_without_products_is_failure(self):
        for config in [{'missing_build': True}, {'missing_batch': True}, {'false_row': True}]:
            with self.subTest(config=config):
                result, report, _, _ = self.invoke(config)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(report['status'], 'FAIL')

    def test_batch_limited_or_empty_is_blocked(self):
        for config in [{'empty_batch': True}, {'env_limited': 1}, {'not_applicable': 1}]:
            with self.subTest(config=config):
                result, report, _, _ = self.invoke(config)
                self.assertEqual(result.returncode, 3)
                self.assertEqual(report['status'], 'BLOCKED')

    def test_timeout_blocks(self):
        result, report, _, _ = self.invoke({'sleep': 'types'}, options=['--timeout', '0.4'])
        self.assertEqual(result.returncode, 3)
        self.assertEqual(report['status'], 'BLOCKED')

    def test_repeated_run_preserves_previous(self):
        fixture = self.fixture()
        _, _, path, _ = self.invoke(wrapper='verify.sh', fixture=fixture)
        old = hashlib.sha256(path.read_bytes()).hexdigest()
        # 第二次独立运行的单测应执行一次；将调用计数按本次读取切片。
        (fixture[0] / 'calls.jsonl').rename(fixture[0] / 'first-calls.jsonl')
        _, _, new_path, _ = self.invoke(wrapper='verify.sh', fixture=fixture)
        self.assertNotEqual(path, new_path)
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), old)

    def test_invalid_arguments(self):
        home, env = self.fixture()
        for options in [['--not-a-real-option'], ['--timeout', '0'], ['--timeout', 'nan'],
                        ['--timeout', 'inf'], ['--output-root', str(home / '工具链/runs')]]:
            result = subprocess.run(['bash', str(home / '工具链/verify.sh')] + options,
                                    env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn('VERIFY_USAGE_OR_OUTPUT_ERROR', result.stdout)


if __name__ == '__main__':
    print('隔离夹具保留在：' + str(FIXTURES), flush=True)
    suite = unittest.main(verbosity=2, exit=False)
    FIXTURES.mkdir(parents=True, exist_ok=True)
    with (FIXTURES / 'summary.json').open('x', encoding='utf-8') as stream:
        json.dump({'status': 'PASS' if suite.result.wasSuccessful() else 'FAIL',
                   'tests': suite.result.testsRun, 'failures': len(suite.result.failures),
                   'errors': len(suite.result.errors), 'scope': '隔离模拟夹具，不是业务/真机验收'},
                  stream, ensure_ascii=False, indent=2)
    sys.exit(0 if suite.result.wasSuccessful() else 1)
