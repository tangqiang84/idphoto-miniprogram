"""RC-07最终微信会话串行回归；唯一目录、保留失败证据。"""
from pathlib import Path
import subprocess,json,argparse
root=Path(__file__).resolve().parents[2]
parser=argparse.ArgumentParser();parser.add_argument('--app',required=True);parser.add_argument('--port',required=True);parser.add_argument('--out',required=True);args=parser.parse_args()
out=Path(args.out).resolve();out.mkdir()
results=[]
for tool in ['T1','T2','T3','T5']:
 command=['node','工具链/smoke_rc07.js','--app',args.app,'--port',args.port,'--tool',tool,'--consents','local','--out',str(out/tool)]
 if tool=='T1':command+=['--withdraw','yes']
 with (out/(tool+'.log')).open('x') as log:
  run=subprocess.run(command,cwd=str(root),stdout=log,stderr=subprocess.STDOUT)
 results.append({'tool':tool,'exit_code':run.returncode})
 print(json.dumps(results[-1]),flush=True)
 if run.returncode:break
with (out/'summary.json').open('x') as f:json.dump(results,f,indent=2)
raise SystemExit(0 if len(results)==4 and all(r['exit_code']==0 for r in results) else 1)
