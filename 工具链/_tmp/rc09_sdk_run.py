"""RC-09禁云微信SDK串行关联回归，输出独占新目录。"""
from pathlib import Path
import argparse,subprocess,json
p=argparse.ArgumentParser();p.add_argument('--app',required=True);p.add_argument('--port',required=True);p.add_argument('--out',required=True);a=p.parse_args();out=Path(a.out);out.mkdir()
results=[]
for tool in ['T1','T2','T3','T5']:
 command=['node','工具链/smoke_rc07.js','--app',a.app,'--port',a.port,'--out',str(out/tool),'--tool',tool,'--consents','local','--matting','yes']
 if tool=='T1':command+=['--withdraw','yes']
 with (out/(tool+'.log')).open('x') as f:run=subprocess.run(command,stdout=f,stderr=subprocess.STDOUT)
 results.append({'tool':tool,'exit_code':run.returncode});print(json.dumps(results[-1]),flush=True)
 if run.returncode:break
with (out/'summary.json').open('x') as f:json.dump(results,f,indent=2)
raise SystemExit(0 if len(results)==4 and all(x['exit_code']==0 for x in results) else 1)
