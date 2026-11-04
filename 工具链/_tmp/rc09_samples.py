"""固定版本：程序生成技术样本及既有授权REAL-111的本地缩小副本；不联网。"""
from pathlib import Path
from PIL import Image
import argparse,math,json,hashlib
p=argparse.ArgumentParser();p.add_argument('--out',required=True);a=p.parse_args();out=Path(a.out);out.mkdir()
records=[]
for kind in ['complex-background','light-clothes','thin-hair']:
 w,h=160,224;rgba=bytearray();truth=bytearray()
 for y in range(h):
  for x in range(w):
   head=((x-80)/29)**2+((y-73)/42)**2<=1;body=y>108 and abs(x-80)<(y-90)*0.65
   hair=kind=='thin-hair' and 27<y<64 and 46<x<115 and (x+2*y)%11==0
   foreground=head or body or hair
   if kind=='complex-background':bg=(180+(x//8%2)*50,170+(y//7%2)*55,190);fg=(191,169,150) if head else (45,65,90)
   elif kind=='light-clothes':bg=(245,245,245);fg=(190,149,125) if head else (242,242,239)
   else:bg=(218,227,238);fg=(40,31,26) if hair or head and y<44 else (185,145,120) if head else (35,60,75)
   rgba.extend((* (fg if foreground else bg),255));truth.append(255 if foreground else 0)
 base=out/kind;Path(str(base)+'.rgba').write_bytes(rgba);Image.frombytes('RGBA',(w,h),bytes(rgba)).save(str(base)+'.png');Image.frombytes('L',(w,h),bytes(truth)).save(str(base)+'-truth.png')
 records.append({'id':kind,'kind':'synthetic','width':w,'height':h,'rgba':kind+'.rgba','truth':kind+'-truth.png','source_sha256':hashlib.sha256(rgba).hexdigest(),'consent':'程序生成非真实人像','version':'RC09-synthetic-v1'})
root=Path(__file__).resolve().parents[2];src=root/'素材/真实头像/111.jpg';im=Image.open(src).convert('RGBA');original=im.size;im.thumbnail((256,342));im.save(out/'REAL-111.png');(out/'REAL-111.rgba').write_bytes(im.tobytes());records.append({'id':'REAL-111','kind':'authorized-portrait','width':im.width,'height':im.height,'original_size':original,'rgba':'REAL-111.rgba','truth':None,'source_sha256':hashlib.sha256(src.read_bytes()).hexdigest(),'consent':'沿用RC-07/08固定授权素材，仅本地验证','version':'REAL-111-sha256'})
(out/'manifest.json').write_text(json.dumps({'version':'RC09-local-v1','cases':records},ensure_ascii=False,indent=2))
