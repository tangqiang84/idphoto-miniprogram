# BiRefNet 上云增强服务 · 容器镜像
# 构建：docker build -t idphoto-birefnet:1.0 .
# 运行：docker run --gpus all -p 8000:8000 -e BIRFNET_LOCAL_PATH=/models/BiRefNet idphoto-birefnet:1.0

# CUDA 12.1 + Python 3.10（与 requirements.txt 的 cu121 组合对应）
FROM pytorch/pytorch:2.4.1-cuda12.1-cudnn9-runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    LOG_LEVEL=INFO

WORKDIR /app

# 系统依赖（Pillow 需要 libgl 时可加 libgl1；此处保持最小）
RUN apt-get update && apt-get install -y --no-install-recommends \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py selftest.py ./

# 权重：默认从 HuggingFace 拉取（ZhengPeng7/BiRefNet，MIT）。
# 境内部署建议预先下载权重并挂载到 /models/BiRefNet，再用 BIRFNET_LOCAL_PATH 指定，
# 避免每次启动访问 HF（境内网络不稳定）。
ENV BIRFNET_MODEL_ID=ZhengPeng7/BiRefNet
ENV BIRFNET_LOCAL_PATH=

EXPOSE 8000

# workers=1：每个 worker 都会载一份模型，显存有限时保持 1
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
