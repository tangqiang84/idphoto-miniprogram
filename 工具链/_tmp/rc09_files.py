"""独立读真实微信本地文件，不把文件成功视作模型/视觉质量验收。"""
from pathlib import Path
from PIL import Image
import json,hashlib,argparse,datetime
p=argparse.ArgumentParser();p.add_argument('--sdk',required=True);p.add_argument('--model',required=True);p.add_argument('--out',required=True);a=p.parse_args();sdk=Path(a.sdk);model=Path(a.model);records=[]
for name,folder,size,fmt in [('T1',sdk/'T1',(295,413),'JPEG'),('T2',sdk/'T2',(591,827),'PNG'),('T3',sdk/'T3',(295,413),'JPEG'),('T5',sdk/'T5',(295,413),'JPEG'),('model-smoke-traditional',model,(295,413),'JPEG')]:
 file=folder/('result.png' if name=='T2' else 'result.jpg');report=json.loads((folder/'report.json').read_text());raw=file.read_bytes()
 with Image.open(file) as im:
  im.load();ok=im.size==size and im.format==fmt and hashlib.sha256(raw).hexdigest()==report['result']['sha256'] and len(raw)==report['result']['bytes']
  records.append({'id':name,'status':'PASS' if ok else 'FAIL','format':im.format,'size':im.size,'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'observed_dpi':im.info.get('dpi'),'scope':'仅文件与SDK证据一致，非模型质量'})
result={'status':'PASS' if all(r['status']=='PASS' for r in records) else 'FAIL','timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat(),'records':records}
with Path(a.out).open('x') as f:json.dump(result,f,ensure_ascii=False,indent=2)
print(json.dumps({'status':result['status'],'files':len(records)}));raise SystemExit(result['status']!='PASS')
