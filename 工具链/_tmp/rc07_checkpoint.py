"""登记RC-07开发中源码证据，不认领任务完成。"""
from pathlib import Path
import hashlib,json
root=Path(__file__).resolve().parents[2]
p=root/'docs/rc01-baseline.json';b=json.loads(p.read_text());name='idphoto-miniprogram/src/core/t1Workflow.js'
h=hashlib.sha256((root/name).read_bytes()).hexdigest();old=b['code_sha256'][name]
if old==h:raise SystemExit('源码证据已登记')
b['code_sha256'][name]=h
b['evidence_revisions'].append({'task':'RC-07开发中','date':'2026-11-04','file':name,'previous_sha256':old,'sha256':h,'reason':'新增可选工具流程策略，默认T1；其他页面未迁移，RC-07仍进行中，不认领业务完成。'})
p.write_text(json.dumps(b,ensure_ascii=False,indent=2)+'\n')
