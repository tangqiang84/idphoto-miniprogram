#!/usr/bin/env python3
"""提取MODNet静态前缀，生成可从固定原始缓存重建的增量计划。"""
import argparse
import base64
import copy
import hashlib
import json
from pathlib import Path
import numpy as np
import onnx
import onnxruntime as ort
from onnx import helper as h, TensorProto as T

BASE_SHA='07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9'


def varint(b, i):
    value=0; shift=0
    while True:
        c=b[i]; i+=1; value|=(c&127)<<shift
        if c<128:return value,i
        shift+=7
        if shift>70:raise ValueError('PROTOBUF_INVALID')


def fields(b, offset=0):
    i=0
    while i<len(b):
        start=i; key,i=varint(b,i); wire=key&7
        if wire==0: _,i=varint(b,i); payload=None
        elif wire in (1,5):payload=i;i+=8 if wire==1 else 4
        elif wire==2:size,i=varint(b,i);payload=i;i+=size
        else:raise ValueError('PROTOBUF_WIRE_INVALID')
        if i>len(b):raise ValueError('PROTOBUF_TRUNCATED')
        yield key>>3,offset+start,offset+i,None if payload is None else offset+payload


def pieces(b):
    result=[]
    for n,start,end,payload in fields(b):
        if n==7:
            result.append((start,payload))
            result.extend((a,z)for _,a,z,_ in fields(b[payload:end],payload))
        else:result.append((start,end))
    return result


def delta(base, derived):
    table={hashlib.sha256(base[a:z]).digest():(a,z) for a,z in pieces(base)}
    result=[]
    for a,z in pieces(derived):
        chunk=derived[a:z];match=table.get(hashlib.sha256(chunk).digest())
        if match and base[match[0]:match[1]]==chunk:
            part={'offset':match[0],'length':match[1]-match[0]}
            if result and 'offset' in result[-1] and result[-1]['offset']+result[-1]['length']==part['offset']:
                result[-1]['length']+=part['length'];continue
        else:part={'literal':base64.b64encode(chunk).decode()}
        result.append(part)
    reconstructed=b''.join(base[r['offset']:r['offset']+r['length']] if 'offset' in r else base64.b64decode(r['literal']) for r in result)
    assert reconstructed==derived
    return result


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--model',type=Path,required=True);parser.add_argument('--out',type=Path,required=True);args=parser.parse_args()
    base=args.model.read_bytes();assert hashlib.sha256(base).hexdigest()==BASE_SHA
    args.out.mkdir(exist_ok=False)
    source=onnx.load_model_from_string(base);static=copy.deepcopy(source)
    for d,n in zip(static.graph.input[0].type.tensor_type.shape.dim,[1,3,512,512]):d.ClearField('dim_param');d.dim_value=n
    static=onnx.shape_inference.infer_shapes(static)
    boundaries=[('stem',0,'1012'),('backbone',188,'686'),('resize-first',190,'691'),('norm-first',205,'706'),('norm-second',224,'728'),('full-static',486,'output')]
    observed=copy.deepcopy(static)
    for _,_,name in boundaries[:-1]:observed.graph.output.append(h.make_tensor_value_info(name,T.FLOAT,None))
    session=ort.InferenceSession(observed.SerializeToString(),providers=['CPUExecutionProvider'])
    names=[x[2]for x in boundaries];x=np.zeros((1,3,512,512),np.float32)
    references=session.run(names,{'input':x})
    original=ort.InferenceSession(base,providers=['CPUExecutionProvider'])
    original_zero=original.run(['output'],{'input':x})[0]
    original_ramp=None
    cases=[]
    extractor=onnx.utils.Extractor(static)
    for (name,index,output),reference in zip(boundaries,references):
        derived=extractor.extract_model(['input'],[output])
        # 真实运行形状作为图输出元数据，原始权重/节点属性保持不变。
        derived.graph.output[0].CopyFrom(h.make_tensor_value_info(output,T.FLOAT,list(reference.shape)))
        onnx.checker.check_model(derived,full_check=True)
        blob=derived.SerializeToString();path=args.out/(name+'.onnx');path.write_bytes(blob)
        run=ort.InferenceSession(blob,providers=['CPUExecutionProvider'])
        checks=[]
        for kind in ['zero','ramp']:
            data=x if kind=='zero' else np.linspace(-1,1,x.size,dtype=np.float32).reshape(x.shape)
            expected=reference if kind=='zero' else session.run([output],{'input':data})[0]
            actual=run.run([output],{'input':data})[0]
            error=float(np.max(np.abs(actual-expected)));assert np.isfinite(actual).all() and np.allclose(actual,expected,atol=1e-5,rtol=1e-5)
            if name=='full-static':
                original_reference=original_zero if kind=='zero' else original.run(['output'],{'input':data})[0]
                assert np.allclose(actual,original_reference,atol=1e-5,rtol=1e-5)
            checks.append({'input':kind,'maxAbsError':error,'status':'PASS'})
        indices=sorted(set(np.linspace(0,reference.size-1,32,dtype=int).tolist()))
        cases.append(dict(id=name,nodeIndex=index,inputName='input',outputName=output,inputShape=[1,3,512,512],outputShape=list(reference.shape),sha256=hashlib.sha256(blob).hexdigest(),byteLength=len(blob),segments=delta(base,blob),sampleIndices=indices,samples=reference.flatten()[indices].tolist(),atol=1e-3,rtol=1e-3,cpuChecks=checks))
    indices=np.linspace(0,original_zero.size-1,32,dtype=int).tolist()
    cases.append(dict(id='full-dynamic-control',nodeIndex=486,inputName='input',outputName='output',inputShape=[1,3,512,512],outputShape=list(original_zero.shape),sha256=BASE_SHA,byteLength=len(base),segments=[dict(offset=0,length=len(base))],sampleIndices=indices,samples=original_zero.flatten()[indices].tolist(),atol=1e-3,rtol=1e-3,cpuChecks=[dict(input='zero',status='PASS')]))
    report=dict(baseSha256=BASE_SHA,baseBytes=len(base),baseFilename='matting-modnet-fp32.onnx',inputKind='synthetic-zero',cases=cases,scope='有限值全量检查+32点抽样对照，非全量数值或照片验收',device='NOT_RUN',onnx=onnx.__version__,onnxruntime=ort.__version__)
    (args.out/'boundary-plan.json').write_text(json.dumps(report,indent=2))
    print(json.dumps({'cases':len(cases),'cpu':'PASS','deltaBytes':(args.out/'boundary-plan.json').stat().st_size,'device':'NOT_RUN'}))
if __name__=='__main__':main()
