"""使用已有Pillow独立读微信实际文件；目标常量摘自确认参考表，不调用产品函数。"""
from pathlib import Path
from PIL import Image
import argparse,json,hashlib,datetime
p=argparse.ArgumentParser();p.add_argument('--matrix',required=True);p.add_argument('--tools',required=True);p.add_argument('--out',required=True);a=p.parse_args();matrix=Path(a.matrix);tools=Path(a.tools)
sizes={'one-inch':[(295,413),(591,827)],'small-one-inch':[(260,378),(520,756)],'driver-license':[(260,378),(520,756)],'two-inch':[(413,579),(827,1157)],'small-two-inch':[(413,531),(827,1063)],'big-one-inch':[(390,567),(780,1134)],'big-two-inch':[(413,626),(827,1252)],'passport-cn':[(390,567),(780,1134)],'visa-us':[(600,600),(1200,1200)]}
expected={f'T5-{key}-{dpi}.jpg':size for key,rows in sizes.items() for dpi,size in zip([300,600],rows)}
expected.update({'T6-six-one.jpg':(1795,1205),'T6-six-two-rotated.jpg':(1205,1795),'T6-instax-one.jpg':(1016,638),'T6-zink-one.jpg':(937,628),'T6-twelve-one.jpg':(3000,3602)})
records=[];errors=[]
def check(file,size,fmt):
 try:
  with Image.open(file) as im:
   im.load();ok=im.size==size and im.format==fmt
   if fmt=='PNG':ok=ok and im.mode=='RGBA' and im.getchannel('A').getextrema()[0]<255
   raw=file.read_bytes();rec={'file':str(file),'status':'PASS' if ok else 'FAIL','size':im.size,'format':im.format,'mode':im.mode,'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'observed_dpi':im.info.get('dpi'),'jfif_density':im.info.get('jfif_density'),'metadata_contract':'应用未主动写入DPI；平台附带值不视为用户选定像素档位'}
   if file.name.startswith('T6-'):rec['white_corner']=all(v>245 for v in im.convert('RGB').getpixel((0,0)));ok=ok and rec['white_corner'];rec['status']='PASS' if ok else 'FAIL'
   records.append(rec)
   if not ok:errors.append(str(file))
 except Exception as e:errors.append(str(file)+':'+type(e).__name__)
report=json.loads((matrix/'report.json').read_text())
if report['status']!='PASS' or report['runtimeErrors'] or len(report['cases'])!=24:errors.append('SDK矩阵不完整')
for name,size in expected.items():check(matrix/name,size,'JPEG')
for tool in ['T1','T2','T3','T5']:
 report=json.loads((tools/tool/'report.json').read_text())
 if report['status']!='PASS' or report.get('outcome') or report['runtimeErrors']:errors.append(tool+'无成功实际成品')
 check(tools/tool/('result.png' if tool=='T2' else 'result.jpg'),(591,827) if tool=='T2' else (295,413),'PNG' if tool=='T2' else 'JPEG')
out={'status':'FAIL' if errors else 'PASS','timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat(),'records':records,'errors':errors,'scope':'固定授权样本27个实际文件；非模型质量、真机或实体冲印认证'}
with Path(a.out).open('x') as f:json.dump(out,f,ensure_ascii=False,indent=2)
print(json.dumps({'status':out['status'],'files':len(records),'errors':errors},ensure_ascii=False));raise SystemExit(bool(errors))
