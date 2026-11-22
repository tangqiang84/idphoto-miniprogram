import base64, hashlib, json, logging, math, uuid
from pathlib import Path
MODEL_SHA='35ec1ecd9ee7f85073c99c00020b7f6751b69506eeacf683bc8665f6117f85b0'
MODEL_PATH=Path(__file__).parent/'model.onnx'
ASSETS=Path(__file__).parent/'assets'
PROVIDER='visible-neck-collar-cpu-v1'
_session=None

def main(event, context=None):
    trace='suitfit-'+uuid.uuid4().hex
    def fail(code,message):
        logging.warning(json.dumps({'code':code,'traceId':trace}))
        return dict(ok=False,code=code,message=message,traceId=trace)
    if not isinstance(event,dict):return fail('SUIT_INPUT_INVALID','换装输入无效')
    if event.get('consent')!='faceCloudEnhance' or event.get('suitConsent')!='suitSwap':return fail('CONSENT_REQUIRED','请分别同意上云和换装')
    if event.get('purpose')!='suit_collar_fit' or event.get('region')!='CN' or event.get('retain') is not False or event.get('train') is not False:return fail('SUIT_POLICY_INVALID','换装处理参数无效')
    w,h=event.get('width'),event.get('height');template=event.get('templateId');image=event.get('image');encoded_alpha=event.get('alphaB64');face=event.get('face')
    if type(w) is not int or type(h) is not int or not 1<=w<=768 or not 1<=h<=768 or template not in ['research-navy','research-black','research-white'] or not isinstance(image,str) or not 0<len(image)<=4*1024*1024 or not isinstance(encoded_alpha,str) or len(encoded_alpha)!=4*((w*h+2)//3):return fail('SUIT_INPUT_INVALID','换装图片尺寸或模板无效')
    keys=['x','y','w','h','chinY']
    if not isinstance(face,dict) or not all(type(face.get(k)) in [int,float] and math.isfinite(face[k]) for k in keys):return fail('SUIT_INPUT_INVALID','面部定位无效')
    if not (0<=face['x']<w and 0<=face['y']<h and face['w']>0 and face['h']>0 and face['x']+face['w']<=w and face['y']+face['h']<=h and face['y']<face['chinY']<h):return fail('SUIT_INPUT_INVALID','面部定位超出图片')
    try:
        import cv2,numpy as np
        raw=base64.b64decode(image,validate=True);alpha=base64.b64decode(encoded_alpha,validate=True)
        if len(alpha)!=w*h:return fail('SUIT_INPUT_INVALID','人像透明度尺寸不符')
        # 先解析头信息，避免畸形压缩图片在完整解码时分配超大内存。
        from PIL import Image
        import io
        with Image.open(io.BytesIO(raw)) as header:
            if header.size!=(w,h) or header.format not in ['PNG','JPEG']:return fail('SUIT_INPUT_INVALID','图片尺寸不符')
        rgb=cv2.imdecode(np.frombuffer(raw,np.uint8),cv2.IMREAD_COLOR)
        if rgb is None or rgb.shape[:2]!=(h,w):return fail('SUIT_INPUT_INVALID','图片读取失败')
        rgba=np.dstack([rgb,np.frombuffer(alpha,np.uint8).reshape(h,w)])
    except Exception:return fail('SUIT_INPUT_INVALID','图片读取失败')
    try:
        import onnxruntime as ort
        import collar_engine as engine
        global _session
        if _session is None:
            if hashlib.sha256(MODEL_PATH.read_bytes()).hexdigest()!=MODEL_SHA:raise RuntimeError('MODEL_INTEGRITY')
            options=ort.SessionOptions();options.intra_op_num_threads=1;options.inter_op_num_threads=1
            _session=ort.InferenceSession(str(MODEL_PATH),options,providers=['CPUExecutionProvider'])
        inp=cv2.resize(cv2.cvtColor(rgb,cv2.COLOR_BGR2RGB),(256,256),interpolation=cv2.INTER_AREA).astype(np.float32)[None]/255
        logits=_session.run(None,{_session.get_inputs()[0].name:inp})[0][0]
        if logits.shape!=(256,256,6) or not np.isfinite(logits).all():raise RuntimeError('MODEL_OUTPUT')
        probs=np.exp(logits-logits.max(axis=2,keepdims=True));probs/=probs.sum(axis=2,keepdims=True);probs=cv2.resize(probs,(w,h),interpolation=cv2.INTER_LINEAR)
        f=np.array([face[k] for k in ['x','y','w','h']],np.float32)
        neck=engine._measure_neck_geometry(rgba,f,probs,face['chinY'])
        if neck['neck_left'] is None or neck['neck_length']<face['h']*.04 or neck['skin_bottom']-neck['chin_y']<face['h']*.12:return fail('SUIT_NECK_UNAVAILABLE','未检测到完整可见颈部，请使用无遮挡正面照片')
        head=engine._create_head_layer(rgba,f,probs,neck['chin_y']);neck['skin_mask']=engine._create_neck_mask(rgba,neck);neck['head_alpha']=head[:,:,3].astype(np.float32)/255
        neck['opening_support']=np.uint8((np.maximum(neck['skin_probability'],neck['hair_probability'])>neck['clothes_probability'])&(rgba[:,:,3]>240))
        asset=(ASSETS/(template+'.png')).read_bytes();manifest=json.loads((ASSETS/'manifest.json').read_text())
        if hashlib.sha256(asset).hexdigest()!=manifest[template]:raise RuntimeError('ASSET_INTEGRITY')
        garment=cv2.imdecode(np.frombuffer(asset,np.uint8),cv2.IMREAD_UNCHANGED);garment=engine._resize_bgra(garment,768,768)
        geometry=engine._analyze_clothes(garment)
        try:_,fit=engine._create_clothes_layer(rgba,garment,geometry,f,neck)
        except ValueError:return fail('SUIT_COLLAR_UNSUPPORTED','领口无法安全贴合，请更换模板或使用无遮挡正面照片')
        fields=['left','top','scale','protectY','templateWidth','templateHeight','worst_gap','seam_gap','feasible_candidates']
        result={k:fit[k] for k in fields}
        if not all(math.isfinite(v) for v in result.values()):raise RuntimeError('FIT_OUTPUT')
        return dict(ok=True,geometry=result,width=w,height=h,provider=PROVIDER,modelSha256=MODEL_SHA,templateId=template,templateSha256=manifest[template],traceId=trace)
    except Exception:return fail('SUIT_FIT_UNAVAILABLE','领口定位服务暂不可用，请稍后重试')
