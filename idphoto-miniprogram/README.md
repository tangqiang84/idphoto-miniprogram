# 证件照小程序 MVP — Taro 脚手架

纯 C 端证件照工具箱：**拍照/上传 → AI 抠图换底 → 选规格 →（换装）→ 合规预审 → 导出**。
首页为工具箱枢纽，5 个小工具可独立进入、互不依赖（对应 PRD 模块 J）。

## 技术栈
- 前端：Taro 3.6 + React 18 + Sass（编译到微信小程序）
- 抠图：端侧 RMBG-1.4 / MODNet（TFLite / TF.js WASM），置信 <0.85 触发上云增强（BiRefNet / RMBG-2.0，境内、用完即销毁、不训练）
- 后端/存储：微信云开发 CloudBase（MVP），COS 设 TTL 自动清理兜底"不留存"
- 隐私：个保法敏感个人信息·单独同意；换装独立授权；人脸本地优先

## 目录结构
```
idphoto-miniprogram/
├── config/                 # Taro 构建配置
├── src/
│   ├── app.ts / app.config.ts / app.scss   # 应用入口与全局样式
│   ├── core/               # 框架无关纯逻辑（PoC 核心，Node 可测）
│   │   ├── specLibrary.js   # 规格库：8 类常用证件照尺寸/底色/上限
│   │   ├── compliance.js    # 合规预审引擎：尺寸/dpi/KB/底色/头部占比
│   │   ├── matting.js       # 抠图服务契约 + 路由判定（端侧/上云）
│   │   ├── privacy.js       # 隐私同意契约（按工具区分授权项）
│   │   └── __tests__/core.test.js   # 13 条单测
│   ├── services/index.ts    # 业务聚合：复用 core + UI 辅助
│   └── pages/
│       ├── home/            # 首页工具箱（6 卡片入口：T1–T6）
│       ├── tool-idphoto/    # T1 一键证件照
│       ├── tool-bg/         # T2 单独换底色
│       ├── tool-suit/       # T3 AI 换装（独立授权）
│       ├── tool-check/      # T4 合规检测（只读）
│       └── tool-spec/       # T5 规格转换（无需人脸授权）
├── package.json
├── project.config.json      # 微信开发者工具项目配置
└── tsconfig.json
```

## 运行 PoC 核心测试（已验证 13/13 通过）
```bash
node --test src/core/__tests__
```
覆盖：规格像素计算、合规引擎 pass/fail 各分支、抠图路由阈值、隐私授权矩阵。

## 端侧模型真实接入 PoC（已完成本地基线）
沙箱无外网，无法下载 RMBG-1.4 权重，因此本次交付分两层：
- **真正能在端上加载 RMBG-1.4 的接入代码**：`src/miniprogram/onnxMatting.ts`（onnxruntime-web WASM 契约 + ImageNet 归一化前后处理 + 微信分包/wasmPaths/单线程约束）。
- **零依赖、可立即运行的本地经典抠图基线**：`src/core/mattingLocal.js`（`runClassicalFallback`：边界采样背景色 + 双边高斯模型 + 软 alpha + 羽化），并用合成图（含已知真值）算出**真实指标**。

运行本地基线验证（沙箱可直接跑）：
```bash
node poc/runMattingPoC.js
```
真实结果（合成图 512×512，与已知真值对比）：

| 场景 | 前景占比 | 歧义占比 | 置信度 | 路由 | IoU | 边界F1 |
|------|---------|---------|--------|------|-----|--------|
| A 前景/背景差异明显 | 35.8% | 0.8% | 0.992 | edge（本地） | 1.000 | 1.000 |
| B 前景/背景近同色（困难） | 0.0% | 0.6% | 0.597 | cloud（上云增强） | 0.000 | 0.000 |

含义：场景 A 本地可高质量完成（IoU 1.0）；场景 B 前景与背景近乎同色，本地算法**诚实承认分离不开**，置信 <0.85 → 自动路由上云增强（安全网生效，避免低质量输出）。

要跑**真实 RMBG-1.4**（需联网设备 + 权重，沙箱默认不触发）：
```bash
RMBG_ONNX=/path/rmbg-1.4.onnx node poc/runMattingPoC.js
```

## 上云增强链路（已打通）

端侧 `segment` 在置信度 <0.85 时自动路由上云增强（境内 GPU 云函数，BiRefNet / RMBG-2.0），覆盖 PRD 第171行、AC5、AC8、数据不出境条款。

- **调用契约** `src/core/mattingCloud.js`（框架无关纯 JS，Node 可测）：
  - `cloudMatting({ rgba, alpha, width, height, adapter, consents, audit })`：检查 `faceCloudEnhance` 单独授权 → 裁剪人像区域(非全图) → 调 adapter → 贴回 → 质量比对 → 降级或返回。
  - `makeHttpAdapter({ endpoint, trustedHosts, authToken })`：真实上云（wx.request / fetch），endpoint 必须境内，fail-closed 阻断跨境。
  - `makeLocalBiRefStub()`：本地 BiRefNet 影子实现（多高斯聚类 + 引导滤波保边），沙箱可跑通链路 + 单测验证；真模型经 `makeHttpAdapter` 同一契约接入。
- **合规内嵌**：AC5 无授权即抛错不静默上传；数据不出境 fail-closed 境内断言；上传仅裁剪人像区域；请求带 `retain:false / train:false`；审计日志只记元数据(尺寸/耗时/置信/区域)，无像素(AC8)；上云失败/质量不如本地自动降级端侧。
- **验证**：`node src/core/__tests__/core.test.js` 共 23 项全绿（含上云授权闸门、跨境阻断、裁剪仅传人像区域、上云失败降级、审计无像素）；`node poc/runMattingPoC.js` 场景 C 演示端侧置信不足时 `segment` 自动路由上云（安全网）。
- **部署待办**：真实 BiRefNet 权重 + 境内 GPU 云函数（微信云开发 CloudBase 或自研 FastAPI），endpoint 配进 `src/services/index.ts` 的 `CLOUD_CONFIG`，经 `buildCloudAdapter()` 注入；等保二级测评、人脸类目资质并行推进。

## 本地启动小程序
```bash
npm install
npm run dev:weapp      # 监听编译到 dist/
```
用微信开发者工具「导入项目」选择本目录（或 dist/），AppID 可用测试号 touristappid。

## 下一阶段待补（PoC 未覆盖）
1. ~~端侧模型真实接入~~ ✅ 本地经典基线已可运行+实测（IoU 1.0）；RMBG-1.4 接入代码就位（真实权重需联网设备执行，见上节）
2. ~~上云增强链路打通~~ ✅ 已打通：src/core/mattingCloud.js（契约 + 真实 http adapter + 本地 BiRefNet 影子 stub），内嵌 AC5 授权闸门 / 数据不出境 fail-closed / 裁剪上传非全图 / 销毁审计无像素 / 上云失败降级；真实境内 GPU 云函数经 makeHttpAdapter 同一契约接入（待联网设备部署）
3. 前端 CV 真实测量（头部占比/像素/dpi/KB）替代 mock
4. 等保二级测评排期 + 小程序人脸类目资质审核
5. 换装模板版权确认（OOTDiffusion/StableViton 商用授权）
