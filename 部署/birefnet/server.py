"""
BiRefNet 上云增强推理服务（境内 GPU）
================================================
契约来源：idphoto-miniprogram/src/core/mattingCloud.js 的 cloudMatting()

入参（JSON POST）：
    {
      "region" : "CN",                  # 固定，服务端校验，非 CN 一律拒绝（数据不出境）
      "purpose": "matting_enhance",
      "retain" : false,                 # 处理完即销毁
      "train"  : false,                 # 不用于模型训练留存
      "consent": "faceCloudEnhance",    # 必须与前端授权项一致（PRD AC5）
      "width"  : int,                   # 图像宽（像素）
      "height" : int,                   # 图像高（像素）
      "image"  : "<base64>"             # RGBA 原始字节（w*h*4），仅裁剪后的人像区域
    }

出参（JSON）：
    { "alphaB64": "<base64>", "region": "CN" }
    # alphaB64 解码后为 w*h 字节的 uint8（每像素 1 字节，0=背景 255=前景）

错误码：
    403 缺少/不匹配的上云增强授权（consent != faceCloudEnhance）
    451 数据出境被拒绝（region != CN）
    400 请求体非法（字段缺失 / 尺寸不符 / base64 损坏）
    500 推理失败

合规设计（对应 PRD 条款）：
    - AC5   ：无单独授权 → 403 阻断，绝不静默处理
    - 不出境：region 强校验；且本服务应部署在**境内**机房
    - 不留存：图像只在内存里走一圈，不写磁盘、不打日志、不进任何持久层
    - AC8   ：日志只记元数据（尺寸/耗时/置信），**绝不打印像素或 base64**

为什么不用 CloudBase 云函数跑：
    微信 CloudBase 云函数是 CPU 运行环境、无 GPU，BiRefNet 在 1024×1024 推理
    约需 5.5GB 显存 —— 必须部署在自有境内 GPU 实例上。
    CloudBase 里的 cloudfunctions/matting 是**无 GPU 的影子实现**（多高斯+引导滤波），
    作为降级/离线验证路径保留。

启动：
    uvicorn server:app --host 0.0.0.0 --port 8000
    # 或 gunicorn -k uvicorn.workers.UvicornWorker -w 1 server:app
    # 注意：workers 必须为 1 以上时，每个 worker 都会载一份模型；显存有限时设 1
"""

from __future__ import annotations

import base64
import logging
import os
import time
from typing import Optional

import numpy as np
import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from PIL import Image

# ---------- 日志：只记元数据，绝不记像素（AC8） ----------
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
log = logging.getLogger("birefnet")

# ---------- 常量（与 core/mattingModel.js 的 birefnet-1024 规格保持一致） ----------
INPUT_SIZE = 1024
IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
EXPECTED_CONSENT = "faceCloudEnhance"
EXPECTED_REGION = "CN"

# 模型权重路径。默认用官方仓库 ZhengPeng7/BiRefNet（HuggingFace License: MIT，可商用）。
# ⚠️ 不要用 briaai/RMBG-2.0 —— 它虽基于 BiRefNet 架构，但**权重仅限非商业使用**。
MODEL_ID = os.getenv("BIRFNET_MODEL_ID", "ZhengPeng7/BiRefNet")
# 若已预下载权重到本地/挂载卷，指定本地路径可避免每次从 HF 拉取（境内建议预置）
MODEL_LOCAL_PATH = os.getenv("BIRFNET_LOCAL_PATH", "")

app = FastAPI(title="BiRefNet Matting Enhance (CN)", version="1.0.0")


class MattingRequest(BaseModel):
    region: str = Field(default="CN")
    purpose: str = Field(default="matting_enhance")
    retain: bool = Field(default=False)
    train: bool = Field(default=False)
    consent: str = Field(default="")
    width: int = Field(default=0)
    height: int = Field(default=0)
    image: str = Field(default="")


# ===================== 模型加载（进程内单例） =====================
_model: Optional[torch.nn.Module] = None
_device: Optional[str] = None


def get_model():
    """懒加载模型。首次请求时载入，之后复用。"""
    global _model, _device
    if _model is not None:
        return _model, _device

    _device = "cuda" if torch.cuda.is_available() else "cpu"
    if _device == "cpu":
        # CPU 能跑但极慢（1024×1024 前向可能数十秒），生产环境不应出现
        log.warning("未检测到 CUDA，将用 CPU 推理 —— 延迟会非常高，生产环境请部署在 GPU 实例")

    from transformers import AutoModelForImageSegmentation

    src = MODEL_LOCAL_PATH or MODEL_ID
    log.info("loading BiRefNet from %s (device=%s)", src, _device)
    _model = AutoModelForImageSegmentation.from_pretrained(src, trust_remote_code=True)
    _model.to(_device)
    _model.eval()
    # fp16 可显著降低显存与提升速度；CPU 下不支持则自动跳过
    if _device == "cuda":
        _model.half()
    log.info("BiRefNet loaded")
    return _model, _device


# ===================== 图像编解码 =====================
def decode_rgba(image_b64: str, width: int, height: int) -> np.ndarray:
    """base64 → RGB uint8 ndarray (H, W, 3)"""
    try:
        raw = base64.b64decode(image_b64)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"image base64 解码失败: {e}")

    expected = width * height * 4
    if len(raw) != expected:
        raise HTTPException(
            status_code=400,
            detail=f"image 字节数不符：期望 {expected}（{width}x{height}x4），实际 {len(raw)}",
        )
    arr = np.frombuffer(raw, dtype=np.uint8).reshape(height, width, 4)
    # 前端传的是 RGBA（canvas.getImageData 的输出顺序），这里丢弃 alpha 只取 RGB
    return arr[:, :, :3]


def encode_alpha(alpha01: np.ndarray) -> str:
    """float 0~1 (H, W) → uint8 → base64"""
    u8 = np.round(np.clip(alpha01, 0.0, 1.0) * 255.0).astype(np.uint8)
    return base64.b64encode(u8.tobytes()).decode("ascii")


def preprocess(rgb: np.ndarray) -> torch.Tensor:
    """RGB uint8 (H,W,3) → NCHW float tensor，ImageNet 归一化，尺寸 INPUT_SIZE"""
    img = Image.fromarray(rgb).convert("RGB").resize((INPUT_SIZE, INPUT_SIZE), Image.BILINEAR)
    f = np.asarray(img, dtype=np.float32) / 255.0
    f = (f - IMAGENET_MEAN) / IMAGENET_STD
    # HWC → CHW → NCHW
    t = torch.from_numpy(np.transpose(f, (2, 0, 1))).unsqueeze(0)
    return t


def postprocess(logits: torch.Tensor, width: int, height: int) -> np.ndarray:
    """模型输出 logits → sigmoid → resize 回原尺寸 → float 0~1 (H, W)

    注意：先以 float 插值、最后才量化到 uint8。若先量化再插值，
    会把 8bit 台阶带入插值结果，边缘过渡带出现可见的阶梯。
    """
    p = torch.sigmoid(logits).squeeze().detach().cpu().numpy().astype(np.float32)
    # p 形状应为 (INPUT_SIZE, INPUT_SIZE)；若模型返回多通道取第一路
    if p.ndim == 3:
        p = p[0]
    # numpy 无直接双线性，用 PIL 处理 float32 需先转成 PIL 支持的模式 → 用 'F'（32bit 浮点）
    img = Image.fromarray(p, mode="F").resize((width, height), Image.BILINEAR)
    return np.clip(np.asarray(img, dtype=np.float32), 0.0, 1.0)


# ===================== 路由 =====================
@app.get("/healthz")
def healthz():
    """健康检查。不加载模型，供负载均衡探活。"""
    return {
        "ok": True,
        "device": _device or ("cuda" if torch.cuda.is_available() else "cpu"),
        "modelLoaded": _model is not None,
        "modelId": MODEL_LOCAL_PATH or MODEL_ID,
        "inputSize": INPUT_SIZE,
    }


@app.post("/matting")
def matting(req: MattingRequest):
    t0 = time.time()

    # ---- 合规闸门 1：单独授权（PRD AC5） ----
    # 顺序重要：先校验授权再解码图像，未授权时连像素都不该被解析
    if req.consent != EXPECTED_CONSENT:
        log.warning("blocked_no_consent consent=%s", req.consent)
        raise HTTPException(status_code=403, detail="AC5: 缺少上云增强(faceCloudEnhance)单独授权")

    # ---- 合规闸门 2：数据不出境 ----
    if req.region != EXPECTED_REGION:
        log.warning("blocked_cross_border region=%s", req.region)
        raise HTTPException(status_code=451, detail="数据出境被拒绝：region 必须为 CN")

    # ---- 合规闸门 3：请求体合法 ----
    if req.width <= 0 or req.height <= 0:
        raise HTTPException(status_code=400, detail="width/height 必须为正整数")
    if req.width * req.height > 4096 * 4096:
        raise HTTPException(status_code=400, detail="图像尺寸过大")
    if not req.image:
        raise HTTPException(status_code=400, detail="image 为空")

    rgb = decode_rgba(req.image, req.width, req.height)

    try:
        model, device = get_model()
        x = preprocess(rgb).to(device)
        if device == "cuda":
            x = x.half()
        with torch.no_grad():
            # BiRefNet 返回多尺度输出（list），官方用法取最后一路作为最终分割结果。
            # ⚠️ 必须先接住返回值再取 [-1] —— 写成 model(x)[-1] if isinstance(model(x),...)
            # 会让前向跑两遍，延迟直接翻倍。
            outputs = model(x)
        out = outputs[-1] if isinstance(outputs, (list, tuple)) else outputs
        alpha = postprocess(out, req.width, req.height)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        # 只记错误类型，不记像素
        log.exception("inference_failed: %s", type(e).__name__)
        raise HTTPException(status_code=500, detail=f"推理失败: {type(e).__name__}")

    dt = int((time.time() - t0) * 1000)
    # AC8：审计只记元数据（尺寸/耗时），绝不记像素或 base64
    log.info("cloud_ok w=%d h=%d latencyMs=%d device=%s", req.width, req.height, dt, device)

    # 不留存：rgb / alpha 均为内存局部变量，函数返回后即释放，不写磁盘
    return {"alphaB64": encode_alpha(alpha), "region": EXPECTED_REGION}
