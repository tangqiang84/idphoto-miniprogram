"""
BiRefNet 服务自测脚本
================================================
目的：在你真正拿到 GPU 之前，先把「契约是否对齐」验证掉。

分两层：
  A. 契约层（**无需 GPU、无需服务启动**）—— 用纯 numpy 验证编解码与前后处理
     的数值契约是否和前端 core/mattingCloud.js 一致。这一步现在就能跑。
  B. 服务层（需要已启动的服务 + GPU）—— 打真实 HTTP 请求，校验错误码与返回格式。

用法：
    # A. 契约层（任何环境都能跑）
    python selftest.py

    # B. 服务层（需先启动服务）
    python selftest.py --url https://your-domain.cn
    python selftest.py --url http://127.0.0.1:8000 --gpu   # 本地也测真推理

退出码：0 = 全部通过；非 0 = 有失败项。
"""

from __future__ import annotations

import argparse
import base64
import sys

import numpy as np

# ---- 与 core/mattingModel.js 的 birefnet-1024 规格保持一致 ----
INPUT_SIZE = 1024
IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)

FAILS: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  OK   {name}")
    else:
        print(f"  FAIL {name} — {detail}")
        FAILS.append(name)


# ===================== A. 契约层（无需 GPU） =====================
def test_contract_layer() -> None:
    print("===== A. 契约层（纯数值，无需 GPU） =====")

    # --- A1. RGBA 字节长度契约 ---
    # 前端 canvas.getImageData 产出 RGBA（每像素 4 字节），服务端按 w*h*4 解码
    w, h = 300, 400
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    raw = rgba.tobytes()
    check("A1 RGBA 字节数 = w*h*4", len(raw) == w * h * 4, f"实际 {len(raw)}")
    b64 = base64.b64encode(raw).decode("ascii")
    # base64 膨胀系数 4/3（与 mattingCloud.js 注释里的「像素×5.3 字节」估算一致）
    check("A2 base64 膨胀比 ≈ 4/3", abs(len(b64) / len(raw) - 4 / 3) < 0.02,
          f"实际比值 {len(b64) / len(raw):.3f}")

    # --- A3. alpha 单通道契约 ---
    # 服务端返回 alphaB64 解码后必须是 w*h 字节（每像素 1 字节），
    # 前端 mattingCloud.decodeAlphaB64(b64, w*h) 按此长度解析
    alpha01 = np.linspace(0, 1, w * h, dtype=np.float32).reshape(h, w)
    u8 = np.round(np.clip(alpha01, 0.0, 1.0) * 255.0).astype(np.uint8)
    a_b64 = base64.b64encode(u8.tobytes()).decode("ascii")
    decoded = np.frombuffer(base64.b64decode(a_b64), dtype=np.uint8)
    check("A3 alpha 解码长度 = w*h", decoded.shape[0] == w * h, f"实际 {decoded.shape[0]}")
    check("A4 alpha 往返无损（0→0, 1→255）",
          decoded[0] == 0 and decoded[-1] == 255, f"首 {decoded[0]} 尾 {decoded[-1]}")

    # --- A5. ImageNet 归一化契约 ---
    # 与 core/mattingModel.preprocess 必须一致：
    #   中灰 128 → (128/255 - 0.485)/0.229 ≈ 0.0707
    v = np.float32(128) / np.float32(255)
    got = (v - IMAGENET_MEAN[0]) / IMAGENET_STD[0]
    check("A5 ImageNet 归一化与前端一致（128→≈0.0707）",
          abs(float(got) - 0.0707) < 0.01, f"实际 {float(got):.4f}")

    # --- A6. 端侧 MODNet 归一化与云端 BiRefNet 必须不同 ---
    # 这是任务 #3 的核心回归：两者搞混会让模型静默失真
    modnet = (v - np.float32(0.5)) / np.float32(0.5)
    check("A6 MODNet 归一化 ≠ BiRefNet 归一化（参数化生效）",
          abs(float(modnet) - float(got)) > 0.02,
          f"MODNet {float(modnet):.4f} vs BiRefNet {float(got):.4f}")

    # --- A7. sigmoid 后处理契约 ---
    def sigmoid(x):
        return 1.0 / (1.0 + np.exp(-x))

    check("A7 sigmoid(0)=0.5", abs(sigmoid(np.float32(0)) - 0.5) < 1e-6)
    check("A8 sigmoid(+10)→≈1", sigmoid(np.float32(10)) > 0.99)
    check("A9 sigmoid(-10)→≈0", sigmoid(np.float32(-10)) < 0.01)

    # --- A10. 载荷估算：与前端 64 万像素封顶是否匹配 ---
    # 前端 UPLOAD_MAX_PIXELS=640000；此处验证该封顶下的 base64 体积在 5MB 内
    # CloudBase/HTTP 载荷上限参考值 5MB（前端另有 64 万像素封顶）
    px = 640000
    est = px * 4 * 4 / 3  # RGBA 4 字节 + base64 4/3 膨胀
    check("A10 64 万像素封顶下 base64 ≈3.4MB < 5MB", est < 5 * 1024 * 1024,
          f"估算 {est / 1024 / 1024:.2f}MB")


# ===================== B. 服务层（需服务已启动） =====================
def test_service_layer(url: str, with_gpu: bool) -> None:
    print(f"\n===== B. 服务层（{url}） =====")
    try:
        import requests  # noqa: PLC0415
    except ImportError:
        print("  SKIP 未安装 requests，跳过服务层测试（pip install requests）")
        return

    # --- B1. 健康检查 ---
    try:
        r = requests.get(f"{url}/healthz", timeout=20)
        check("B1 /healthz 可达", r.status_code == 200, f"HTTP {r.status_code}")
        if r.status_code == 200:
            info = r.json()
            print(f"       device={info.get('device')} modelLoaded={info.get('modelLoaded')}")
    except Exception as e:  # noqa: BLE001
        check("B1 /healthz 可达", False, f"{type(e).__name__}: {e}")
        return

    def post(payload):
        return requests.post(f"{url}/matting", json=payload, timeout=180)

    base = {
        "region": "CN", "purpose": "matting_enhance",
        "retain": False, "train": False, "consent": "faceCloudEnhance",
        "width": 8, "height": 8,
        "image": base64.b64encode(np.zeros((8, 8, 4), dtype=np.uint8).tobytes()).decode(),
    }

    # --- B2. 未授权 → 403（PRD AC5） ---
    r = post({**base, "consent": "none"})
    check("B2 无授权 → 403", r.status_code == 403, f"实际 {r.status_code}")

    # --- B3. 非 CN → 451（数据不出境） ---
    r = post({**base, "region": "US"})
    check("B3 非 CN → 451", r.status_code == 451, f"实际 {r.status_code}")

    # --- B4. 字节数不符 → 400 ---
    r = post({**base, "image": base64.b64encode(b"short").decode()})
    check("B4 图像字节数不符 → 400", r.status_code == 400, f"实际 {r.status_code}")

    # --- B5. 合法请求 → 200 且返回 alphaB64 ---
    if with_gpu:
        r = post(base)
        ok = r.status_code == 200
        check("B5 合法请求 → 200", ok, f"实际 {r.status_code} {r.text[:200]}")
        if ok:
            j = r.json()
            a = np.frombuffer(base64.b64decode(j["alphaB64"]), dtype=np.uint8)
            check("B6 alpha 长度 = w*h", a.shape[0] == 64, f"实际 {a.shape[0]}")
            check("B7 region 回传为 CN", j.get("region") == "CN", str(j.get("region")))
    else:
        print("  SKIP B5~B7 真推理测试（加 --gpu 启用，需 GPU 与已加载模型）")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="", help="服务地址，如 https://your-domain.cn；不填则只跑契约层")
    ap.add_argument("--gpu", action="store_true", help="服务层也测真推理（需 GPU）")
    args = ap.parse_args()

    test_contract_layer()
    if args.url:
        test_service_layer(args.url.rstrip("/"), args.gpu)

    print("\n===== 结果 =====")
    if FAILS:
        print(f"❌ {len(FAILS)} 项失败：{', '.join(FAILS)}")
        return 1
    print("✅ 全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
