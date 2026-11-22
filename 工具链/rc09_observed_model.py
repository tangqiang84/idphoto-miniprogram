#!/usr/bin/env python3
"""为完整动态图增加观察输出，四组对照复用单个派生模型。"""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import numpy as np
import onnx
import onnxruntime as ort
from onnx import helper as h,TensorProto as T,numpy_helper
from rc09_modnet_boundaries import BASE_SHA,delta


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--model',type=Path,required=True);parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--points',type=Path);parser.add_argument('--experiment-id',default='full-observed-v1');args=parser.parse_args()
    args.out.mkdir(exist_ok=False)
    base=args.model.read_bytes();assert hashlib.sha256(base).hexdigest()==BASE_SHA
    original=onnx.load_model_from_string(base);observed=copy.deepcopy(original)
    points=[(224,'728'),(298,'808'),(389,'905'),(442,'961'),(482,'1007'),(485,'1010')]
    if args.points:
        points=[(row['nodeIndex'],row['outputName'])for row in json.loads(args.points.read_text())]
    assert 0<len(points)<=20 and len(set(name for _,name in points))==len(points)
    for index,name in points:
        assert type(index)is int and 0<=index<len(original.graph.node)
        assert name in original.graph.node[index].output and name!='output'
    for _,name in points:observed.graph.output.append(h.make_tensor_value_info(name,T.FLOAT,None))
    session=ort.InferenceSession(observed.SerializeToString(),providers=['CPUExecutionProvider'])
    orig=ort.InferenceSession(base,providers=['CPUExecutionProvider'])
    names=[name for _,name in points]+['output'];references={};input_hashes={}
    for kind in ['zero','ramp']:
        n=3*512*512
        x=np.zeros(n,np.float32) if kind=='zero' else (-1+(2*np.arange(n,dtype=np.float64))/(n-1)).astype(np.float32)
        input_hashes[kind]=hashlib.sha256(x.tobytes()).hexdigest();x=x.reshape(1,3,512,512)
        values=session.run(names,{'input':x});final=orig.run(['output'],{'input':x})[0]
        assert all(np.isfinite(v).all()for v in values)
        difference=float(np.max(np.abs(values[-1]-final)));assert np.allclose(values[-1],final,atol=1e-5,rtol=1e-5)
        references[kind]={'values':values,'finalVsOriginalMaxAbsError':difference}
    shape_map={name:list(v.shape)for name,v in zip(names,references['zero']['values'])}
    for output in observed.graph.output:output.CopyFrom(h.make_tensor_value_info(output.name,T.FLOAT,shape_map[output.name]))
    onnx.checker.check_model(observed,full_check=True)
    blob=observed.SerializeToString();(args.out/'full-observed.onnx').write_bytes(blob)
    checked=ort.InferenceSession(blob,providers=['CPUExecutionProvider'])
    cases=[]
    constants={value.name:numpy_helper.to_array(value)for value in original.graph.initializer}
    for node in original.graph.node:
        if node.op_type=='Constant':
            for attr in node.attribute:
                if attr.name=='value':constants[node.output[0]]=numpy_helper.to_array(attr.t)
    pairs=[]
    for index,name in points:
        node=original.graph.node[index]
        if node.op_type=='InstanceNormalization' and node.input[0] in names:
            epsilon=next(float(h.get_attribute_value(a))for a in node.attribute if a.name=='epsilon')
            pairs.append(dict(nodeIndex=index,inputName=node.input[0],outputName=name,shape=shape_map[name],epsilon=epsilon,scale=constants[node.input[1]].flatten().tolist(),bias=constants[node.input[2]].flatten().tolist(),atol=1e-3,rtol=1e-3))
    for kind in ['zero','ramp']:
        n=3*512*512;x=np.zeros(n,np.float32) if kind=='zero' else (-1+(2*np.arange(n,dtype=np.float64))/(n-1)).astype(np.float32)
        actual=checked.run(names,{'input':x.reshape(1,3,512,512)})
        outputs=[]
        for name,index,ref,value in zip(names,[i for i,_ in points]+[486],references[kind]['values'],actual):
            assert np.array_equal(ref,value)
            indices=sorted(set(np.linspace(0,ref.size-1,32,dtype=int).tolist()))
            outputs.append(dict(outputName=name,nodeIndex=index,outputShape=list(ref.shape),sampleIndices=indices,samples=ref.flatten()[indices].tolist(),atol=1e-3,rtol=1e-3))
        cases.append(dict(id='observed-'+kind,model='observed',inputKind=kind,inputSha256=input_hashes[kind],outputs=outputs,normalizationChecks=pairs))
        cases.append(dict(id='original-'+kind,model='original',inputKind=kind,inputSha256=input_hashes[kind],outputs=[outputs[-1]]))
    plan=dict(baseFilename='matting-modnet-fp32.onnx',baseBytes=len(base),baseSha256=BASE_SHA,observed=dict(byteLength=len(blob),sha256=hashlib.sha256(blob).hexdigest(),segments=delta(base,blob)),cases=cases,cpu=dict(status='PASS',onnx=onnx.__version__,onnxruntime=ort.__version__,inputs={k:dict(sha256=input_hashes[k],finalVsOriginalMaxAbsError=v['finalVsOriginalMaxAbsError'])for k,v in references.items()}),diagnosticFileBudgetBytes=192*1024*1024,device='NOT_RUN',scope='完整图观察可能改变融合；全量有限值+32点抽样，非全量数值/照片验收')
    plan['experimentId']=args.experiment_id
    plan['observationPoints']=[dict(nodeIndex=i,outputName=name,operator=original.graph.node[i].op_type)for i,name in points]
    (args.out/'observed-plan.json').write_text(json.dumps(plan,indent=2))
    print(json.dumps(dict(cpu='PASS',cases=len(cases),observedBytes=len(blob),planBytes=(args.out/'observed-plan.json').stat().st_size,device='NOT_RUN')))
if __name__=='__main__':main()
