#!/usr/bin/env python3
"""生成只含合成数据的微信算子诊断材料；不修改生产模型或工程。"""
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
import onnx
import onnxruntime as ort
from onnx import TensorProto as T, helper as h, numpy_helper as nh


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_cases(out):
    out.mkdir(exist_ok=False)
    cases = []

    def add(name, nodes, initializers, x, expected, dynamic=False):
        shape = ['N', 'C', 'H', 'W'] if dynamic else list(x.shape)
        graph = h.make_graph(nodes, name, [h.make_tensor_value_info('input', T.FLOAT, shape)],
                             [h.make_tensor_value_info('output', T.FLOAT, list(expected.shape))], initializers)
        model = h.make_model(graph, opset_imports=[h.make_opsetid('', 11)], ir_version=7)
        onnx.checker.check_model(model, full_check=True)
        path = out / (name + '.onnx')
        onnx.save(model, path)
        session = ort.InferenceSession(str(path), providers=['CPUExecutionProvider'])
        actual = session.run(['output'], {'input': x})[0]
        error = float(np.max(np.abs(actual - expected)))
        # 期望来自显式数学公式/固定表，不用ORT输出作为小图预期。
        assert np.isfinite(actual).all() and np.allclose(actual, expected, rtol=1e-5, atol=1e-5), name
        cases.append(dict(id=name, file=path.name, sha256=digest(path), inputName='input', outputName='output',
                          inputShape=list(x.shape), outputShape=list(expected.shape), input=x.flatten().tolist(),
                          expected=expected.flatten().tolist(), atol=1e-4, rtol=1e-4, cpuMaxAbsError=error,
                          expectedBasis='explicit mathematical oracle', status='PASS'))

    init = lambda name, value: nh.from_array(np.asarray(value), name)
    for dynamic in [False, True]:
        for constant in [True, False]:
            x = np.zeros((1, 2, 2, 2), np.float32) if constant else np.arange(8, dtype=np.float32).reshape(1, 2, 2, 2)
            scale = np.array([1, 2], np.float32); bias = np.array([0, .25], np.float32)
            mean = x.astype(np.float64).mean(axis=(2, 3), keepdims=True)
            var = ((x - mean) ** 2).mean(axis=(2, 3), keepdims=True)
            expected = ((x - mean) / np.sqrt(var + 1e-5) * scale.reshape(1, 2, 1, 1) + bias.reshape(1, 2, 1, 1)).astype(np.float32)
            add('instance-' + ('dynamic-' if dynamic else 'static-') + ('zero' if constant else 'ramp'),
                [h.make_node('InstanceNormalization', ['input', 'scale', 'bias'], ['output'], epsilon=1e-5)],
                [init('scale', scale), init('bias', bias)], x, expected, dynamic)
    x = np.array([[[[0, 1], [2, 3]]]], np.float32)
    # pytorch_half_pixel、linear、2倍缩放：边界夹紧，采样坐标为0,.25,.75,1。
    expected = np.array([[[[0, .25, .75, 1], [.5, .75, 1.25, 1.5],
                            [1.5, 1.75, 2.25, 2.5], [2, 2.25, 2.75, 3]]]], np.float32)
    attrs = dict(mode='linear', coordinate_transformation_mode='pytorch_half_pixel', nearest_mode='floor', cubic_coeff_a=-.75)
    add('resize-static', [h.make_node('Resize', ['input', 'roi', 'scales'], ['output'], **attrs)],
        [init('roi', np.array([], np.float32)), init('scales', np.array([1, 1, 2, 2], np.float32))], x, expected)
    add('resize-dynamic-shape', [h.make_node('Shape', ['input'], ['shape']),
        h.make_node('Gather', ['shape', 'indices'], ['hw'], axis=0), h.make_node('Mul', ['hw', 'two'], ['large']),
        h.make_node('Concat', ['nc', 'large'], ['sizes'], axis=0),
        h.make_node('Resize', ['input', 'roi', 'empty', 'sizes'], ['output'], **attrs)],
        [init('roi', np.array([], np.float32)), init('empty', np.array([], np.float32)),
         init('indices', np.array([2, 3], np.int64)), init('two', np.array([2, 2], np.int64)),
         init('nc', np.array([1, 1], np.int64))], x, expected, True)
    add('dynamic-expand', [h.make_node('Shape', ['input'], ['shape']), h.make_node('Expand', ['value', 'shape'], ['output'])],
        [init('value', np.array([2], np.float32))], x, np.full_like(x, 2), True)
    add('conv-3x3', [h.make_node('Conv', ['input', 'kernel'], ['output'], kernel_shape=[3, 3], pads=[1, 1, 1, 1])],
        [init('kernel', np.ones((1, 1, 3, 3), np.float32))], np.ones((1, 1, 3, 3), np.float32),
        np.array([[[[4, 6, 4], [6, 9, 6], [4, 6, 4]]]], np.float32))
    (out / 'cases.json').write_text(json.dumps(cases, ensure_ascii=False, indent=2))
    return cases


def mobilenet_reference(model, out):
    expected_hash = 'c0c3f76d93fa3fd6580652a45618618a220fced18babf65774ed169de0432ad5'
    assert digest(model) == expected_hash, '官方仓库LFS摘要不符'
    m = onnx.load(model); onnx.checker.check_model(m, full_check=True)
    session = ort.InferenceSession(str(model), providers=['CPUExecutionProvider'])
    inp = session.get_inputs()[0]; output = session.get_outputs()[0]
    assert len(inp.shape) == 4 and inp.shape[1:] == [3, 224, 224]
    shape = [1, 3, 224, 224]
    x = np.zeros(shape, np.float32)
    result = session.run([output.name], {inp.name: x})[0]
    assert np.isfinite(result).all()
    report = dict(id='official-mobilenetv2-12', sha256=digest(model), inputName=inp.name, outputName=output.name,
                  inputShape=shape, outputShape=list(result.shape), inputKind='synthetic-zero',
                  expected=result.flatten().tolist(), expectedBasis='ONNX Runtime CPU numerical reference, not classification accuracy',
                  atol=1e-3, rtol=1e-3, provider=session.get_providers(), status='PASS')
    (out / 'mobilenet-reference.json').write_text(json.dumps(report, indent=2))


def mnist_reference(model, out):
    assert digest(model) == '2f06e72de813a8635c9bc0397ac447a601bdbfa7df4bebc278723b958831c9bf'
    onnx.checker.check_model(onnx.load(model), full_check=True)
    session = ort.InferenceSession(str(model), providers=['CPUExecutionProvider'])
    inp = session.get_inputs()[0]; output = session.get_outputs()[0]
    assert inp.shape == [1, 1, 28, 28]
    target = out / 'mnist-8.onnx'; target.write_bytes(model.read_bytes())
    cases = []
    for kind in ['zero', 'ramp']:
        x = np.zeros(inp.shape, np.float32) if kind == 'zero' else np.linspace(0, 1, 784, dtype=np.float32).reshape(inp.shape)
        result = session.run([output.name], {inp.name: x})[0]
        assert np.isfinite(result).all()
        cases.append(dict(id='official-mnist-' + kind, file=target.name, sha256=digest(target),
                          inputName=inp.name, outputName=output.name, inputShape=inp.shape,
                          outputShape=list(result.shape), input=x.flatten().tolist(), expected=result.flatten().tolist(),
                          expectedBasis='ONNX model zoo model, ONNX Runtime CPU numerical reference; not classification accuracy',
                          atol=1e-3, rtol=1e-3, status='PASS'))
    return cases


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--mobilenet', type=Path, required=True)
    parser.add_argument('--mnist', type=Path); args = parser.parse_args()
    cases = build_cases(args.out)
    mobilenet_reference(args.mobilenet, args.out)
    if args.mnist:
        cases = mnist_reference(args.mnist, args.out) + cases
        (args.out / 'device-cases.json').write_text(json.dumps(cases, ensure_ascii=False, indent=2))
    (args.out / 'runtime.json').write_text(json.dumps(dict(onnx=onnx.__version__, onnxruntime=ort.__version__, numpy=np.__version__)))
    print(json.dumps(dict(minimalCases=len(cases), cpu='PASS', device='NOT_RUN', out=str(args.out))))


if __name__ == '__main__':
    main()
