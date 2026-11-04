"""RC-07应用、构建、SDK证据与文档一致性收尾；报告独占创建。"""
from pathlib import Path
import hashlib,json,subprocess,re,datetime,urllib.parse,argparse
root=Path(__file__).resolve().parents[2]
parser=argparse.ArgumentParser();parser.add_argument('--out',default='checks.json');args=parser.parse_args()
out=root/'docs/验证记录/RC-07-implementation'
prod=root/'docs/验证记录/verify-runs/run-20261104-161039-97ac5613'
local=root/'docs/验证记录/t1-local-builds/run-57f193b741ed'
read=lambda p:json.loads(p.read_text())
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
checks=[]
def check(name,count,errors):checks.append({'name':name,'count':count,'status':'FAIL' if errors else 'PASS','errors':errors})
inputs=read(prod/'inputs.json');app={p:h for p,h in inputs.items() if p.startswith('idphoto-miniprogram/')}
check('当前应用与生产构建输入',len(app),[p for p,h in app.items() if not (root/p).is_file() or sha(root/p)!=h])
src=root/'idphoto-miniprogram/src';copy=local/'workspace/idphoto-miniprogram/src';exceptions=['services/cloudFnAdapter.ts','services/poseService.ts']
sources=[p for p in src.rglob('*') if p.is_file() and str(p.relative_to(src)) not in exceptions]
check('禁云UI副本源码（两项明确网络适配替换除外）',len(sources),[str(p.relative_to(src)) for p in sources if not (copy/p.relative_to(src)).is_file() or sha(p)!=sha(copy/p.relative_to(src))])
for name,base in [('生产',prod),('禁云',local)]:
 files=read(base/'build-files.json');dist=base/'workspace/idphoto-miniprogram/dist'
 check(name+'构建产物',len(files),[p for p,h in files.items() if not (dist/p).is_file() or sha(dist/p)!=h])
old=read(root/'docs/验证记录/verify-runs/run-20261104-150526-754e5728/inputs.json')
deps=[p for p in inputs if p.endswith(('package.json','package-lock.json'))]
check('依赖及锁文件不变',len(deps),[p for p in deps if old[p]!=sha(root/p)])
sdk=out/'sdk-complete';summary=read(sdk/'summary.json')
check('四工具微信串行回归',4,[] if len(summary)==4 and all(r['exit_code']==0 for r in summary) else ['SDK退出码不完整'])
for tool in ['T1','T2','T3','T5']:
 r=read(sdk/tool/'report.json')
 check(tool+'实际成功处理（非预期拒绝）',len(r['checks']),[] if r['status']=='PASS' and r['runtimeErrors']==0 and r.get('result') and not r.get('outcome') else ['没有成功成品证据'])
files=read(out/'files-complete.json');check('独立文件与颜色验证',len(files['checks']),[] if files['status']=='PASS' else ['文件验证失败'])
docs=['docs/RC-07开发记录.md','docs/RC-07迁移说明.md','docs/验证记录/RC-07-implementation/验收报告.md','docs/整改开发任务.md','项目资产与工具手册.md','开发任务台账.md','技术架构说明.md','小程序开发指南.md','页面原型设计.md','产品功能清单.md','测试用例与验收清单.md','docs/验证体系说明.md','问题台账.md','每日开发日志/2026-11-04.md']
count=0;errors=[]
for name in docs:
 p=root/name;s=p.read_text();marker='## RC-07迁移交付（2026-11-04）'
 if marker in s:s=s.split(marker,1)[1]
 for target in re.findall(r'\]\(([^)]+)\)',s):
  if re.match(r'^[a-z]+://',target) or target.startswith('#'):continue
  target=urllib.parse.unquote(target.split('#')[0].strip('<>'));count+=1
  if not (p.parent/target).exists():errors.append(name+':'+target)
check('本轮文档链接',count,errors)
record={'status':'FAIL' if any(c['status']=='FAIL' for c in checks) else 'PASS','timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat(),'checks':checks,
 'git_head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=str(root)).decode().strip(),
 'tracked_diff_sha256':hashlib.sha256(subprocess.check_output(['git','diff','--binary'],cwd=str(root))).hexdigest(),
 'worktree_status':subprocess.check_output(['git','status','--porcelain'],cwd=str(root)).decode().splitlines(),
 'production_input_manifest':sha(prod/'inputs.json'),'ui_input_manifest':sha(local/'production-inputs.json'),
 'artifacts':{str(p.relative_to(out)):sha(p) for p in sorted(sdk.rglob('*')) if p.is_file()},
 'documents':{name:sha(root/name) for name in docs},'logs':{p.name:sha(p) for p in sorted(out.glob('*.log'))},
 'scope':'迁移/控制/固定本地样例，不代表云模型、全规格、模板视觉质量或真机通过'}
if Path(args.out).name!=args.out:raise SystemExit('报告名称无效')
with (out/args.out).open('x') as f:json.dump(record,f,ensure_ascii=False,indent=2)
print(json.dumps({'status':record['status'],'checks':checks},ensure_ascii=False))
raise SystemExit(0 if record['status']=='PASS' else 1)
