# BiRefNet 上云增强服务 · 部署手册

> 对应任务 #3（接入真 AI 抠图模型 · 云端 BiRefNet）。
> **当前状态：代码与手册已就绪，等待 GPU 资源部署。** 本文是一份「拿到 GPU 后照着做就能跑通」的操作手册。

---

## 0. 先回答：为什么不能直接用现有的 CloudBase 云函数？

项目已选「路 1 · CloudBase 原生」（`wx.cloud.callFunction` → 云函数 `matting`），这条链路**已经打通**，但它是 **CPU 运行环境、无 GPU**：

- BiRefNet 在 1024×1024 推理约需 **5.5GB 显存**（官方 README），CPU 上单次前向可能数十秒，生产不可用。
- 因此 `idphoto-miniprogram/cloudfunctions/matting/index.js` 目前是**影子实现**（多高斯 + 引导滤波保边），作用是「链路可跑通、质量可对比」，**不是真 BiRefNet**。

结论：**真 BiRefNet 必须部署在自有境内 GPU 实例**（即《小程序发布准备包》第八节的「形态 B · 自有服务器」），CloudBase 云函数保留为无 GPU 时的降级路径。

---

## 1. 前置条件核对（部署前逐项打勾）

| # | 条件 | 为什么 | 怎么确认 |
|---|---|---|---|
| 1 | **境内** GPU 实例 | 数据不出境（PRD 硬约束）；`region != 'CN'` 服务端直接 451 | 云厂商控制台看地域，必须是中国大陆节点 |
| 2 | GPU 显存 **≥ 8GB** | 1024 推理约 5.5GB，加上 PyTorch 自身开销留余量 | `nvidia-smi` |
| 3 | 域名已 **ICP 备案** | 微信小程序合法域名必须备案 | 本项目主体备案已通过（2026-10-27，苏ICP备2026082326号-1X）；自有域名需另办备案 |
| 4 | **HTTPS**、443 端口 | 小程序不允许 http / IP / 非 443 端口 | 浏览器访问 `https://域名/healthz` |
| 5 | 安全组放行 443 | 否则小程序请求超时 | 云厂商安全组 |

> ⚠️ 第 1 条是**合规红线**不是技术选项。若服务在境外，即便功能正常也违反「数据不出境」，应在提审前纠正。
> 前端 `mattingCloud.js` 的 `assertDomestic()` 会做 fail-closed 校验：非白名单域名直接阻断上传（`.cn` 等境内后缀，或显式加入 `trustedHosts`）。

---

## 2. 部署步骤

### 步骤 1 · 准备权重（建议预先下载，别让容器启动时访问 HuggingFace）

```bash
# 官方权重 ZhengPeng7/BiRefNet —— HuggingFace License 字段为 mit（可商用）
pip install -U "huggingface_hub[cli]"
huggingface-cli download ZhengPeng7/BiRefNet --local-dir ./models/BiRefNet
```

> 🔴 **不要用 `briaai/RMBG-2.0`**：它虽采用 BiRefNet 架构，但权重由 BRIA 私有数据训练，
> **仅限非商业使用**（BiRefNet 官方 README 明确标注）。本项目属商业使用，只能用 `ZhengPeng7/BiRefNet`。
> 「架构 MIT」≠「所有该架构的权重都能商用」——接任何模型前都要单独核权重许可。

### 步骤 2 · 构建并启动

```bash
cd 部署/birefnet
docker build -t idphoto-birefnet:1.0 .

docker run -d --gpus all \
  -p 8000:8000 \
  -v "$(pwd)/models/BiRefNet:/models/BiRefNet" \
  -e BIRFNET_LOCAL_PATH=/models/BiRefNet \
  --name idphoto-birefnet \
  idphoto-birefnet:1.0
```

> 不挂载权重也能跑（会走 `BIRFNET_MODEL_ID=ZhengPeng7/BiRefNet` 从 HF 拉取），但境内部署每次启动都访问 HF 不稳定，**强烈建议预置**。

### 步骤 3 · 验证服务活着

```bash
curl https://你的域名/healthz
# 期望：{"ok":true,"device":"cuda","modelLoaded":false,"modelId":"...","inputSize":1024}
# 首次推理时 modelLoaded 才变 true（懒加载）
```

### 步骤 4 · 跑自测

```bash
# 契约层（不需要 GPU，本机就能跑）
python selftest.py

# 服务层（需要服务已启动；加 --gpu 才会打真推理请求）
python selftest.py --url https://你的域名 --gpu
```

| 断言 | 期望 |
|---|---|
| B2 无授权 | **403**（PRD AC5：未授权绝不处理，连像素都不解析） |
| B3 region 非 CN | **451**（数据出境被拒） |
| B4 字节数不符 | **400** |
| B5/B6/B7 合法请求 | 200，且 `alphaB64` 解码后长度 = `width*height` |

### 步骤 5 · 前端切到形态 B

改 `idphoto-miniprogram/src/services/index.ts`：

```ts
export const CLOUD_CONFIG = {
  endpoint: 'https://你的域名/matting',   // ← 换成真实境内 HTTPS 地址
  trustedHosts: ['你的域名'],              // ← 必须与 endpoint 的 host 一致
  region: 'CN',
};
```

然后把 T1/T2 页面里的 `buildCloudFnAdapter()`（路 1）换成 `buildCloudAdapter()`（路 2）。

### 步骤 6 · 微信后台配合法域名

`mp.weixin.qq.com` → 开发 → 开发设置 → 服务器域名 → request 合法域名，填 `https://你的域名`。

> 上线前确认 `project.config.json` 的 `urlCheck` 为 `true`，否则正式版请求会被拦。

---

## 3. 接口契约（与前端 `core/mattingCloud.js` 严格对应）

### 请求 `POST /matting`

| 字段 | 类型 | 说明 |
|---|---|---|
| `region` | string | 固定 `"CN"`，服务端强校验 |
| `purpose` | string | `"matting_enhance"` |
| `retain` | bool | `false` —— 处理完即销毁 |
| `train` | bool | `false` —— 不做训练留存 |
| `consent` | string | 必须 `"faceCloudEnhance"`（PRD AC5 单独授权项） |
| `width` / `height` | int | 图像像素尺寸 |
| `image` | string | **RGBA** 原始字节的 base64（`w*h*4`），仅裁剪后的人像区域，非全图 |

### 响应

```json
{ "alphaB64": "<base64>", "region": "CN" }
```

`alphaB64` 解码后为 `width*height` 字节的 uint8（每像素 1 字节，0=背景、255=前景）。

### 错误码

| 码 | 含义 |
|---|---|
| 403 | 缺少/不匹配 `faceCloudEnhance` 授权（AC5） |
| 451 | `region != CN`，数据出境被拒 |
| 400 | 请求体非法（字段缺失 / 尺寸不符 / base64 损坏 / 图像过大） |
| 500 | 推理失败 |

---

## 4. 合规检查清单（提审前逐项确认）

- [ ] 机房在**中国境内**
- [ ] 服务**不写磁盘**：图像只在内存走一圈（`server.py` 中 `rgb`/`alpha` 均为局部变量）
- [ ] 日志**不含像素**：只记 `w/h/latencyMs/device`（AC8），`selftest.py` 的 A 层已覆盖
- [ ] 未授权请求返回 403，且**在解码图像之前**拦截（`server.py` 中闸门顺序：consent → region → 尺寸 → 解码）
- [ ] 前端 `trustedHosts` 与 `endpoint` 域名一致（否则 `assertDomestic` fail-closed 阻断）
- [ ] 权重来自 `ZhengPeng7/BiRefNet`（MIT），**不是** `briaai/RMBG-2.0`

---

## 5. 成本与运维提示

- **按需启停**：证件照制作有明显峰谷，GPU 实例建议按量付费或闲时释放（权重预置在对象存储，重建时拉取）。
- **workers 保持 1**：每个 uvicorn worker 会各载一份模型，显存有限时多开会 OOM。
- **冷启动**：首次请求会触发模型加载（数十秒），建议启动后主动打一次 `/matting` 预热。
- **降级**：服务不可用时，前端 `cloudMatting` 会捕获异常并降级端侧结果，同时 `audit` 记录 `cloud_fail`——**不会中断用户流程**。

---

## 6. 已知限制

1. 本服务**尚未在真实 GPU 上跑过**（沙箱无网无 GPU）。已验证的是：语法、契约数值、错误码分支；未验证的是：真实推理精度与延迟。
2. 首次真实部署后，建议用「发丝/复杂背景」两类样本各 5 张做人工目检，再决定是否调整 `CONF_THRESHOLD`（当前 0.85）。
3. 若精度不足，优先换 BiRefNet 的更高分辨率变体（`BiRefNet_HR` 2048×2048），代价是显存与时延翻倍。
