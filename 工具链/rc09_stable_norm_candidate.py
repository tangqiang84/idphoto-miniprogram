#!/usr/bin/env python3
"""生成显式中心化方差的独立实验模型；不改原图或生产配置。"""
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
import onnx
import onnxruntime as ort
from onnx import helper as h,numpy_helper as nh
from rc09_modnet_boundaries import BASE_SHA


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--model',type=Path,required=True);parser.add_argument('--out',type=Path,required=True);parser.add_argument('--photo-inputs',type=Path,required=True);parser.add_argument('--axis-wise-reduction',action='store_true');args=parser.parse_args()
    base=args.model.read_bytes();assert hashlib.sha256(base).hexdigest()==BASE_SHA;args.out.mkdir(exist_ok=False)
    m=onnx.load_model_from_string(base);nodes=[];replacements=[]
    shape_name='rc09_norm_nchw_shape';m.graph.initializer.append(nh.from_array(np.array([1,-1,1,1],np.int64),shape_name))
    for index,node in enumerate(m.graph.node):
        if node.op_type!='InstanceNormalization':nodes.append(node);continue
        prefix='rc09_stable_'+str(index)+'_';eps=next(float(h.get_attribute_value(a))for a in node.attribute if a.name=='epsilon');inp,scale,bias=node.input
        m.graph.initializer.append(nh.from_array(np.array(eps,np.float32),prefix+'epsilon'))
        specs=[('ReduceMean',[inp],[prefix+'mean'],dict(axes=[2,3],keepdims=1)),('Sub',[inp,prefix+'mean'],[prefix+'center'],{}),('Mul',[prefix+'center',prefix+'center'],[prefix+'square'],{}),('ReduceMean',[prefix+'square'],[prefix+'variance'],dict(axes=[2,3],keepdims=1)),('Add',[prefix+'variance',prefix+'epsilon'],[prefix+'variance_eps'],{}),('Sqrt',[prefix+'variance_eps'],[prefix+'std'],{}),('Div',[prefix+'center',prefix+'std'],[prefix+'unit'],{}),('Reshape',[scale,shape_name],[prefix+'scale'],{}),('Reshape',[bias,shape_name],[prefix+'bias'],{}),('Mul',[prefix+'unit',prefix+'scale'],[prefix+'scaled'],{}),('Add',[prefix+'scaled',prefix+'bias'],list(node.output),{})]
        if args.axis_wise_reduction:
            expanded=[]
            for op,inputs,outputs,attrs in specs:
                if op=='ReduceMean':
                    row=outputs[0]+'_row'
                    expanded.extend([('ReduceMean',inputs,[row],dict(axes=[3],keepdims=1)),('ReduceMean',[row],outputs,dict(axes=[2],keepdims=1))])
                else:expanded.append((op,inputs,outputs,attrs))
            specs=expanded
        nodes.extend(h.make_node(op,inputs,outputs,name=prefix+str(i),**attrs)for i,(op,inputs,outputs,attrs)in enumerate(specs))
        replacements.append(dict(originalNodeIndex=index,epsilon=eps,inputName=inp,outputName=node.output[0],scaleName=scale,biasName=bias))
    del m.graph.node[:];m.graph.node.extend(nodes);onnx.checker.check_model(m,full_check=True);blob=m.SerializeToString();(args.out/'stable-norm.onnx').write_bytes(blob)
    original=ort.InferenceSession(base,providers=['CPUExecutionProvider']);candidate=ort.InferenceSession(blob,providers=['CPUExecutionProvider']);records=[]
    cases=[];n=3*512*512
    cases.append(('synthetic-zero',np.zeros(n,np.float32)));cases.append(('synthetic-ramp',(-1+2*np.arange(n,dtype=np.float64)/(n-1)).astype(np.float32)))
    for file in sorted(args.photo_inputs.glob('RC09-USER-*/input.float32')):cases.append((file.parent.name,np.fromfile(file,np.float32)))
    assert len(cases)==13
    for name,data in cases:
        x=data.reshape(1,3,512,512);before=original.run(['output'],{'input':x})[0];after=candidate.run(['output'],{'input':x})[0]
        assert np.isfinite(before).all() and np.isfinite(after).all() and after.shape==(1,1,512,512)
        error=np.abs(after.astype(np.float64)-before);mismatch=(error>1e-3+1e-3*np.abs(before))
        records.append(dict(id=name,finite=True,min=float(after.min()),max=float(after.max()),maxAbsDifference=float(error.max()),meanAbsDifference=float(error.mean()),mismatchCount=int(mismatch.sum()),numericalComparison='FAIL'if mismatch.any()else'PASS',quality='NOT_REVIEWED'))
    report=dict(sourceSha256=BASE_SHA,candidateSha256=hashlib.sha256(blob).hexdigest(),candidateBytes=len(blob),axisWiseReduction=args.axis_wise_reduction,replacedNodes=replacements,records=records,numericalCounts={state:sum(r['numericalComparison']==state for r in records)for state in ['PASS','FAIL']},scope='独立实验候选，保持原epsilon/scale/bias；有限与数值差异不等于视觉质量或微信验收',device='NOT_RUN',runtime=ort.__version__)
    (args.out/'candidate-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps(dict(candidateSha256=report['candidateSha256'],records=len(records),numericalCounts=report['numericalCounts'],device='NOT_RUN')))
if __name__=='__main__':main()
