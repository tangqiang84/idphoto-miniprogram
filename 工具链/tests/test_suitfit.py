import importlib.util,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('suitfit',Path(__file__).resolve().parents[2]/'idphoto-miniprogram/cloudfunctions/suitfit/index.py');backend=importlib.util.module_from_spec(spec);spec.loader.exec_module(backend)
class SuitfitContract(unittest.TestCase):
 def request(self):return dict(consent='faceCloudEnhance',suitConsent='suitSwap',purpose='suit_collar_fit',region='CN',retain=False,train=False,width=2,height=2,image='AAAA',alphaB64='/////w==',templateId='research-black',face=dict(x=0,y=0,w=1,h=1,chinY=1))
 def test_missing_consent(self):
  for key in ['consent','suitConsent']:
   r=self.request();r.pop(key);out=backend.main(r);self.assertEqual(out['code'],'CONSENT_REQUIRED');self.assertTrue(out['traceId'])
 def test_invalid_inputs(self):
  for patch in [dict(width=769),dict(width=True),dict(templateId='../private'),dict(face={'x':float('nan')}),dict(alphaB64='PRIVATE')]:
   r=self.request();r.update(patch);out=backend.main(r);self.assertEqual(out['code'],'SUIT_INPUT_INVALID');self.assertNotIn('PRIVATE',str(out))
 def test_policy(self):
  for patch in [dict(region='US'),dict(retain=True),dict(train=True),dict(purpose='unknown')]:
   r=self.request();r.update(patch);self.assertEqual(backend.main(r)['code'],'SUIT_POLICY_INVALID')
if __name__=='__main__':unittest.main()
