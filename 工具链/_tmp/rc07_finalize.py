"""RC-07最终渲染边界证据登记，不改需求描述。"""
from pathlib import Path
import hashlib,json
root=Path(__file__).resolve().parents[2]
p=root/'docs/rc01-baseline.json';b=json.loads(p.read_text())
for name in b['code_sha256']:
 h=hashlib.sha256((root/name).read_bytes()).hexdigest();old=b['code_sha256'][name]
 if h!=old:
  b['code_sha256'][name]=h;b['evidence_revisions'].append({'task':'RC-07收尾','date':'2026-11-04','file':name,'previous_sha256':old,'sha256':h,'reason':'T2底色在最终照片坐标合成，避免工作余量裁掉渐变端点；T1/T3规则不放宽。'})
p.write_text(json.dumps(b,ensure_ascii=False,indent=2)+'\n')
