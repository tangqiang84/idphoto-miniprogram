"""人脸后端协议与安全拒绝测试；合成输入不作为视觉验收。"""
import base64,io,importlib.util,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from PIL import Image
spec=importlib.util.spec_from_file_location('facepoints',Path(__file__).resolve().parents[2]/'idphoto-miniprogram/cloudfunctions/facepoints/index.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class FaceTests(unittest.TestCase):
 def setUp(self):
  b=io.BytesIO();Image.new('RGB',(16,16)).save(b,format='PNG')
  self.req=dict(consent='faceCloudEnhance',suitConsent='suitSwap',purpose='suit_face_landmarks',region='CN',retain=False,train=False,width=16,height=16,image=base64.b64encode(b.getvalue()).decode())
 def test_invalid_never_loads_model(self):
  with patch.object(m,'_runtime') as runtime:
   for change in [{'consent':''},{'suitConsent':''},{'retain':0},{'width':True},{'height':2049},{'width':17},{'image':'bad!'}]:
    r=m.main(dict(self.req,**change));self.assertFalse(r['ok']);self.assertTrue(r['code']);self.assertTrue(r['traceId'])
   runtime.assert_not_called()
 def test_face_counts_and_points(self):
  points=[SimpleNamespace(x=.2+(i%2)*.4,y=.2+(i%3)*.2) for i in range(478)]
  for faces,expected in [([],False),([points,points],False),([points],True),([points[:5]],False),([[SimpleNamespace(x=float('nan'),y=.5)]*478],False)]:
   mp=SimpleNamespace(Image=lambda **k:None,ImageFormat=SimpleNamespace(SRGB=1));model=SimpleNamespace(detect=lambda _:SimpleNamespace(face_landmarks=faces))
   with patch.object(m,'_runtime',return_value=(mp,model)):
    r=m.main(self.req);self.assertEqual(r['ok'],expected)
    if expected:self.assertEqual(r['faceCount'],1);self.assertEqual(len(r['points']),478);self.assertIsNone(r['confidence'])
 def test_private_exception_not_exposed(self):
  with patch.object(m,'_runtime',side_effect=RuntimeError('PRIVATE_PAYLOAD')),self.assertLogs(level='WARNING') as logs:r=m.main(self.req)
  self.assertEqual(r['code'],'FACE_SERVICE_UNAVAILABLE');self.assertNotIn('PRIVATE_PAYLOAD',str(r)+str(logs.output));self.assertNotIn(self.req['image'],str(logs.output))
if __name__=='__main__':unittest.main()
