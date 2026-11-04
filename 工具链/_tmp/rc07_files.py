"""独立读取微信实际产物；固定期望取已确认规格表，不调用产品规格函数。"""
from pathlib import Path
import argparse,hashlib,json
from PIL import Image
p=argparse.ArgumentParser();p.add_argument('--sdk',required=True);p.add_argument('--out',required=True);a=p.parse_args()
base=Path(a.sdk);checks=[];files={}
for tool,size,fmt in [('T1',(295,413),'JPEG'),('T2',(591,827),'PNG'),('T3',(295,413),'JPEG'),('T5',(295,413),'JPEG')]:
 report=json.loads((base/tool/'report.json').read_text());path=base/tool/('result.png' if tool=='T2' else 'result.jpg')
 im=Image.open(path);im.load();digest=hashlib.sha256(path.read_bytes()).hexdigest()
 ok=im.size==size and im.format==fmt and digest==report['result']['sha256'] and report['status']=='PASS' and report['runtimeErrors']==0
 if tool!='T2':ok=ok and 20*1024<=path.stat().st_size<=200*1024
 if tool=='T2':ok=ok and im.mode=='RGBA' and im.getextrema()[3][0]<255
 checks.append({'tool':tool,'status':'PASS' if ok else 'FAIL'})
 files[tool]={'size':im.size,'format':im.format,'mode':im.mode,'bytes':path.stat().st_size,'sha256':digest}
solid=[base/'T2'/('color-'+str(i)+'.jpg') for i in range(2)]
checks.append({'name':'HEX/RGB实际文件等价','status':'PASS' if solid[0].read_bytes()==solid[1].read_bytes() else 'FAIL'})
gradient=Image.open(base/'T2/gradient.jpg').convert('RGB');foreground=Image.open(base/'T2/result.png').convert('RGBA').resize(gradient.size);mask=foreground.getchannel('A')
w,h=gradient.size;errors=[]
for y in range(8,h-8,8):
 for x in range(8,w-8,8):
  low,high=mask.crop((x-3,y-3,x+4,y+4)).getextrema()
  if high>=64 or high-low>12:continue
  t=(y+.5)/h
  pixel=foreground.getpixel((x,y));alpha=pixel[3]/255
  expected=[round(pixel[c]*alpha+(255+(end-255)*t)*(1-alpha)) for c,end in enumerate([67,142,219])]
  errors.append(max(abs(actual-target) for actual,target in zip(gradient.getpixel((x,y)),expected)))
avg=sum(errors)/len(errors) if errors else 999
checks.append({'name':'渐变90度向下与最终照片坐标一致','status':'PASS' if len(errors)>16 and avg<16 else 'FAIL','background_samples':len(errors),'mean_max_channel_error':avg,'basis':'独立线性白→(67,142,219)，按PNG连续Alpha混合；低Alpha平滑区域、JPEG容差16，不假定二值mask'})
result={'status':'PASS' if all(c['status']=='PASS' for c in checks) else 'FAIL','checks':checks,'files':files,'scope':'仅固定样本的实际格式/尺寸/颜色/Alpha，非全规格或换装视觉质量验收'}
with Path(a.out).open('x') as f:json.dump(result,f,ensure_ascii=False,indent=2)
print(json.dumps(result,ensure_ascii=False));raise SystemExit(0 if result['status']=='PASS' else 1)
