# 证件照小程序 · 项目长期记忆

## 项目定位
- 微信小程序「标准照裁剪」，**个人主体**，AppID `wxd7ff2aaa541a62e4`，证件照工具 MVP。
- 技术栈：Taro 3.6.23 + React + TypeScript + Sass。核心逻辑在 `src/core/`（纯 JS、框架无关，Node 单测与小程序共用同一份）。
- 上云路线：**路1 CloudBase 原生**（`wx.cloud.callFunction` 调云函数 `matting`）→ 后台合法域名**零配置**。
  - CloudBase 环境 ID：`baochengtang-d7g6ki1ch79dc2faa`（已写入 `src/app.ts`）
  - 云函数：`cloudfunctions/matting/index.js`；前端封装 `src/services/cloudFnAdapter.ts`（`buildCloudFnAdapter`）

## 工作流约定（用户 2026-10-22 固化，必须遵守）
1. **登记纪律**：每次代码修改、发现问题、解决问题，都要登记到《问题台账.md》并同步任务列表状态。
2. **改完必验证**：改动 TS/JS 导出结构或 core 逻辑后，**必须实跑编译/单测**，禁止只靠静态阅读（重复导出、Node 包静态 require 只在编译时暴露）。
3. **同类问题第 2 次发生 = 预防机制失效**，必须升级载体：口头提醒 → 清单 → 配置/脚本硬闸门。
4. 用户质疑或反馈"找不到/不对"时，**全量重查磁盘**后再答，不凭记忆或上一轮结论。

## 项目硬约束（资产与工具 · 用户 2026-10-22 要求）
1. **只增不删**：任务过程产生的工具、脚本、代码模块、素材必须保存在项目内，**不得删除**（含 `工具链/`、`poc/`、core 各模块、生成图片素材）。清理前先确认是否在册。
2. **必须有使用文档**：新增任何工具/脚本都要登记到《项目资产与工具手册.md》——用途 + 使用命令/调用方式 + 注意事项。没登记的视为临时物。
3. **优先复用，禁止重复造轮子**：遇到类似需求**先查手册**再用；已有能力（规格库 / 合规引擎 / 抠图链路 / 隐私矩阵 / 云函数封装）一律复用，不重写。
4. 构建产物（如 `dist/`）可重建，不受"不得删除"限制；但工具/代码/素材受限制。
5. **文档随任务同步更新（用户 2026-10-22 追加）**：每个任务结束时，必须按任务内容回写对应文档，**不允许只改代码不更文档**。映射：
   | 本次动了什么 | 必须回写 |
   |---|---|
   | 代码结构 / 目录 / 接口 / 云函数 | 《技术架构说明.md》（含目录结构、API） |
   | 页面 UI / 交互 / 弹窗 / 路由 | 《页面原型设计.md》（含路由映射、差距清单） |
   | 功能增删改 / 规格值 / 授权项 | 《产品功能清单.md》 |
   | 环境 / 依赖 / 命令 / 部署方式 | 《小程序开发指南.md》 |
   | 新增工具脚本素材 | 《项目资产与工具手册.md》 |
   | 任何问题 / 修复 / 决策 | 《问题台账.md》 |
   | 任务状态变化 | 《开发任务台账.md》 |
   收尾自检：本次改了哪些文件 → 逐条对照上表 → 未回写的当场补。文档之间出现冲突时，以**磁盘现状**为准并登记问题。
6. **每日必须总结（用户 2026-10-23 要求）**：收工时跑 `工具链/daily_summary.py` 生成当日日志骨架并人工补完七段（做了什么/改了哪些文件/问题与解决/验证结果/明天要做/待决策/经验沉淀），日志存 `每日开发日志/YYYY-MM-DD.md`。通用教训同步沉淀进《微信小程序开发实战避坑指南.md》。跨零点开工用日期参数明确归属日。

## 环境事实（避坑）
- ~~沙箱内无法完成 Taro 完整 build~~ → **2026-10-22 23:47 推翻：可以**。**根因**：沙箱经 `NODE_OPTIONS` 向 node 子进程注入 fs shim，mkdir 对已存在路径不幂等。**解法：任何写盘类命令前置 `NODE_OPTIONS=`**（`NODE_OPTIONS= npm run build:weapp`，实测 5s 成功）。同理适用于 npm install、生成文件、截图写盘。
- **AI 自跑验证已打通**：`NODE_OPTIONS= bash 工具链/verify.sh` = 类型检查 + core 单测 + 编译；`NODE_OPTIONS= node 工具链/smoke_auto.js` = 模拟器内 T1 全链路冒烟（2026-10-23 已跑通，含 `--skip-consent` AC5 反向）。**每次任务收尾自己跑，不必用户代跑。**
- **automator 0.13 三坑**（详见 `工具链/smoke_auto.js` 头注释）：禁用 reLaunch()；Page 无 screenshot/path()；mock 图片必须先 evaluate 注入 USER_DATA_PATH。
- **禁止在项目内 `npm install` 新包**：会触发 npm 重排 `node_modules/webpack`（ENOTEMPTY），有把 webpack 升到 5.112 破坏 #7 的风险。第三方工具包装到隔离工作区 `/Users/tq/.workbuddy/binaries/node/workspace`。
- **webpack 必须 5.89.0**：Taro 3.6.23 的 webpack5-runner 依赖 `EntryDependency`，webpack 5.112+ 已移除该文件。
- **云函数上传菜单**：`project.config.json` 必须有 `cloudfunctionRoot`，否则微信开发者工具不显示"上传并部署"。
- **微信 canvas**：避免 `createImageData`（报 `Value is not of type 'long'`），优先复用 `getImageData` 返回的 ImageData。

- **Windows 无关 / macOS 无 `timeout` 命令**：脚本里别用 `timeout`，用后台任务 + TaskOutput。
- **bash 脚本写文件会被静默杀**：`cat > file <<EOF` 在本环境触发安全层拦截（exit **137 / SIGTERM**，沙箱内外都无报错）。**生成文件优先用 Python + Write 工具**（台账 #21）。
- **版本控制已建立（2026-10-23）**：根目录为唯一 git 仓库，分支 `master`，提交 `02c6e6d`（基线）+ `124f497`，标签 `v0.1-t1-verified`。忽略：node_modules/ dist/ .swc/ project.private.config.json/ `.git.scaffold-backup/`。**远程 = GitHub 私有库 `git@github.com:tangqiang84/idphoto-miniprogram.git`**（master 已跟踪 origin/master，标签已同步，远程克隆回验 75 文件一致）。依赖本机 `~/.ssh/id_ed25519`；非交互首次连接需 `GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new"`。**坑：普通 `git push` 不带 annotated tag，要单独 `git push origin --tags`（台账 #22）**。提交规范与日常命令见《项目资产与工具手册》第四节。
- **脚手架嵌套 .git 坑**：Taro 脚手架自带 `.git`（1 次 Initial Commit），会导致 `git add` 只收 38 个文件、源码被当 submodule 拒收。已改名为 `idphoto-miniprogram/.git.scaffold-backup` 保留（勿删），由根仓库统一接管。

## 云端抠图 provider 口径（任务 #34 固化，2026-10-23）
- **三条并存、契约一致**（入 RGBA 像素 → 出 alphaB64），云函数 `index.js` 按配置路由：
  `baidu`（百度智能云人像分割，**默认**，配 Key 即生效）→ 失败/未配置 → `shadow`（CPU 影子，永不失败）；
  另有 `birefnet`（自部署 GPU，`部署/birefnet/`，待实例）。
- **密钥铁律**：`BAIDU_API_KEY` / `BAIDU_SECRET_KEY` 只走云函数环境变量，**禁止进小程序包体/文件/git**；单测有静态断言。
- **取 scoremap 不取 foreground**：scoremap 灰度 = 置信度×255 → 软 alpha，发丝边缘最好；foreground 只兜底。
- **三个限制**：base64 **再 urlencode 后 ≤4MB**（最坏 ×3）；最短边≥15 / 最长边≤4096；个人免费 1 万次、QPS 2（企业 5 万/5）。
- **触发时机**：沿用端侧置信 <0.85 且已授权 `faceCloudEnhance` 才上云 —— 省额度，断网/失败自动降级。
- **PNG 编解码手写**：CloudBase 无 sharp/canvas → `cloudfunctions/matting/png.js`（纯 zlib），已用 PIL 双向交叉验证。
- **判据铁律（#45）**：真模型软 alpha 的 `confidence` 天然更低，**不得**用 `1−ambiguousRatio` 判优劣 →
  用 `shouldAcceptCloudAlpha`（前景占比退化检测 + 与本地偏移 >0.25）。
- **合规**：第三方 = 个保法第 23 条，政策页/授权弹窗/后台指引/原型文档**四处同步点名接收方**；
  owner 待办：后台指引补第三方条目并重提（已提交版本不含）。

## 关键文件
- `小程序发布准备包.md` —— 注册/备案/提审材料与进度（含路1实施方案）
- `问题台账.md` —— 问题→根因→解决→状态→预防（登记纪律载体）
- `微信小程序开发实战避坑指南.md` —— **五维度踩坑总览**（流程/配置/代码/工具/沟通），新人入门与培训教材
- `每日开发日志/` —— 每日总结（由 `工具链/daily_summary.py` 生成）
- `idphoto-miniprogram/` —— 代码；`cloudfunctions/matting/` —— 云函数
- 本项目与主线产品「银行资金智能连接器」是**两条独立产品线**，合规红线语境不同：本项目重点是人脸生物识别（个保法敏感个人信息）。

## 当前状态（2026-10-23 22:4x）
备案管局审核中（7–15 日）；后台《用户隐私保护指引》已提交（1–3 工作日）。**五个工具全部接真实功能**。**人脸定位统一接入完成**（#4）。**600dpi 全工具免费开放**（#9/#33）。**T1 智能裁切落地**（#24）。**真 AI 抠图模型接入骨架 + 云端部署包交付**（任务 #3）：端侧 MODNet（Apache-2.0）可插拔加载器**默认关闭零回归**，云端 `部署/birefnet/` 真 BiRefNet（MIT）待境内 GPU；**RMBG-1.4/2.0 权重非商业许可已禁用（#40 红线）**。单测 **139/139**，**tsc 基线 0 告警（#12 已关闭，verify 已升级为硬闸门）**，verify 全绿，smoke_model 18/18，四项回归全绿。**商用抠图 API 已接入**（任务 #34）：百度智能云人像分割走云函数代理，失败降级影子实现仍出图。
**下一步：真机实测（#24 遗留）｜ 模型点亮待外部资源（端侧权重 CDN + 境内 GPU ≥8GB）｜ 备案号下来填政策页 → 提审（提审前决策：GPU 未就绪则提审版关闭上云）。**

## 百度人像分割口径（任务 #34 固化 + 2026-10-24 真实联调闭环）
- **真实联调已通过（2026-10-24 03:29）**：真人照（960×1280）抠图质量优秀（发丝/眼镜/西装边缘干净），
  回执 `素材/测试截图/baidu-live-1792783769593.png`；素材库新增真人照 `素材/测试图/test_real.png`（只增不删）。
- **测试素材教训（#49）**：卡通合成图百度检不出人（person_num=0 → alpha 全 0）——卡通能验证链路，
  验证不了检出质量；测试素材库必须含真人照。线上兜底 = `shouldAcceptCloudAlpha` 的
  `cloud_foreground_degenerate`（前景占比 <0.5% 拦下 → 降级本地）。
- **体积实测**：urlencode 对 base64 膨胀仅 **约 4.5%**（非最坏 3 倍，3 倍只适用原始二进制）；
  960×1280 真人照 body 1.89MB < 4MB，无需降采样。
- **owner 部署两步**：①微信开发者工具上传部署云函数 `matting`，环境变量配 `BAIDU_API_KEY`/`BAIDU_SECRET_KEY`；
  ②后台《用户隐私保护指引》补「百度智能云」第三方条目并重提（**提审前必须**）。

## 真模型接入口径（任务 #3 固化，2026-10-23）
- **许可红线**：接模型先查 **HF 模型卡 License 字段**（不是 GitHub LICENSE）。「开源」≠「可商用」；**同架构不同权重许可可能不同**——BiRefNet 官方权重 MIT 可商用，`briaai/RMBG-2.0` 同架构但仅限非商用。规格表含 `commercialOk/license/source`，单测断言「不含 RMBG」。
- **三层代码分工**：`core/mattingModel.js`（规格表+预处理/后处理+权重校验/下载决策，纯 JS 可单测）→ `services/modelService.ts`（CDN 下载/缓存/校验/session/失败退避/显式降级）→ `miniprogram/onnxMatting.ts`（注入式 ort 封装，**无编译期依赖**——项目禁 npm install，ort 由调用方注入）。
- **规格驱动**：模型参数（输入尺寸/归一化/输出后处理/输入名）由规格表声明，代码只读规格。MODNet=512+`[-1,1]`+matte；BiRefNet=1024+ImageNet+sigmoid；硬编码某模型参数换模型会**静默失真**（#41）。
- **端侧决策**（`resolveModelPlan`）：未启用/未注入 ort/未配 URL/未知规格/云端专用规格 → classical。默认 `{enabled:false, weightUrl:''}` 零回归。点亮三步：CDN 权重 → 填 `EDGE_MODEL_CONFIG` → `enabled:true`（见《小程序开发指南》6.1）。
- **失败退避**：下载失败冷却 30min、会话内最多 3 次；校验失败删坏文件重下；**降级必须显式可观测**，不许静默吞错。
- **云端部署**（`部署/birefnet/README.md`）：自有境内 GPU ≥8GB（CloudBase 云函数无 GPU，跑不动 BiRefNet 1024 的 5.5GB 显存，影子实现只是降级路径——#43）。合规闸门顺序：consent(403)→region(451)→尺寸(400)→**才解码图像**。自测 `python3 selftest.py` 契约层 10 项无需 GPU。
- **冒烟**：`工具链/smoke_model.js`（端口 9436）——改了 mattingModel/modelService/onnxMatting 后必跑；端口被占多为崩溃残留，换端口重跑即可。
- **手册/台账编号纪律重演**：3l 撞号再次发生（#39 同款错误）→ 自检脚本化：手册用 `matchAll(/^### 3([a-z])\. /gm)` 扫重，台账用 `max(|\d+|)+1`。

## 智能裁切口径（任务 #24 固化，2026-10-23）
- **反解数学**（`core/headCrop.js` 的 `planHeadCrop`）：`sh = 头长 ÷ 目标占比`、`sw = sh × 目标宽高比`；垂直 `sy = 头顶 − 0.13×头长`；水平 `sx = 面部中心 − sw/2`。
- **目标占比 = 区间中值**（owner 拍板）：测量有误差（头顶由脸长 ÷ 0.74 外推），取中值双向各留约 5% 余量；瞄区间沿会把合规照推出区间。
- **留白系数 0.13 / 0.16** 出自官方口径（护照「头顶留白 3~5mm / 头长 28~33mm」「下巴至下边 ≥7mm / 图高 48mm」）。**0.16 只作可行性校验、不是硬性目标值** —— 窗高已由占比唯一决定，下巴留白是派生量（写单测时别拿它当等式断言，本轮已踩）。
- **区域化工作画布**（`compose.js` 的 `planWindowOutput`）：只把「裁剪窗 + 15% 余量」放大到够像素。远景照裁剪窗可能只占原片 ~1/9 面积，沿用整图 1600px 会输出放大糊图。
- **抠图背景采样必须注入**：经典基线背景色取自**画布四边 2px 环带**，区域化后四边会压在头发/肩膀上 → 失准。解法：`collectEdgeSamples` + `segment({bgSamples})`，T1 在检测用图（覆盖整图）上采一次注入；**缺省不变** → T2/T3/T4 零回归。
- **铁律**：裁剪窗必须完全落在原图内（`sy∈[0,workH−sh]`、`sx∈[0,workW−sw]`），否则 `drawImage` 取空白 → 输出纯色图（台账 #37）。夹取要在「保主体」修正**之后**夹两次。
- **降级**：未检出人脸 → 退回 `planOutput` 居中裁剪 + 页面明示；构图不足 → 出图 + 红色 ⚠ 提示，**不阻断导出**（owner 决策）。
- 冒烟：`工具链/smoke_headcrop.js`（端口 9432，几何层为纯 Node 可单独快跑）。**注入假人脸检测只能在 `evaluate` 内直接赋值 `wx.*`**（台账 #38：`mockWxMethod` 函数形态在 wx 底层 API 上不执行）。
- `listSpecs()` 返回**摘要**（无 headHeightRatioMin/Max 等），凡要用规格数值字段一律 `getSpec(id)`（台账 #25 同源）。

## 商业化形态（owner 2026-10-23 决策，勿再翻案）
- **MVP 暂不上付费档**：个人主体不能开微信支付（#14）→ 付费档无落地路径 → 全部功能免费。
- **600dpi 不再是"付费才给"**，而是「印刷/冲印输出分辨率档位」，**T1/T2/T3 全工具免费开放**（`.dpi-opt` 开关）。
- **首页显式标注**「全部功能免费 · 无水印 · 300/600dpi 均开放」（`.home__free-badge`）——透明定价是相对竞品的差异化信任信号。
- **代码中不得出现任何支付实现**（`requestPayment`/`mch_id`/`prepay_id` 等），已有冒烟静态断言兜底。
- 未来开通企业主体 + 支付能力后，以「**新增付费档**」迭代，不影响现有免费承诺。

## 600dpi 口径（任务 #33 固化，2026-10-23）
- **构图规划统一走 `core/compose.js` 的 `planOutput(srcW,srcH,targetW,targetH)`**（T1/T2/T3 共用；返回 `{workW,workH,sx,sy,sw,sh,scale,needScale,upscale,srcTooSmall,cappedBy,reason}`）。
  原则：**A 够用即止**（裁剪窗口像素 ≥ 目标像素，绝不放大）/ **B 质量下限 800px** / **C 性能上限 1600px + 220 万像素** / **D 源图不足如实标记**（页面提示"原图分辨率不足，放大不会更清晰"）。
- **预审分档**：600dpi 时 `filesize` 项 `level='advisory'`（只提示、不阻断、不计入 suggestions）；其余 required 项（尺寸/dpi/底色/头占比）照常严格判定。依据：官方报名系统只校验像素+KB+格式，从不校验 dpi 元数据；KB 上限是为 300dpi 像素量设定的。
- **上云载荷**：CloudBase `callFunction` 上限 5MB，base64(RGBA)≈像素×5.3B → `mattingCloud.js` 已加 64 万像素封顶 + 面积平均降采样 + 双线性 alpha 回贴，**不要绕过直接传大图**。
- **贴图采样**：`suit.js` 已由最近邻改**双线性**（模板源固定 400×400，600dpi 放置框可达 1400px+；RGB/A 分离插值 + 按 A 加权混合防黑边）。
- 冒烟：`工具链/smoke_dpi.js`（端口 9431）。**改了页面 className 必须先编译再跑冒烟**（冒烟跑 `dist/`）。

## 人脸定位口径（任务 #4 固化，2026-10-23）
- **分层**：`services/faceService.ts`（平台适配，可失败可降级）→ `core/face.js`（纯计算，可单测）
- **双轨**：VisionKit（`wx.createVKSession` + `track.face.mode=2`，基础库 2.25.0+/安卓微信 ≥8.0.25/iOS ≥8.0.24）→ `wx.faceDetect`（**官方已停止维护**，2.18.0+ 覆盖老设备）→ 几何估算兜底
- **两条轨道的静态图片输入都是 RGBA ArrayBuffer**，与 `canvas.getImageData().data` 同构，可直接互喂
- **口径**：`脸长(发际线→下巴) ÷ 0.74 = 头长(含头顶)`；`头长 ÷ 成品图高 = 头占比`
- **铁律**：①**不用硬编码关键点索引**（官方未公布 106 点分组，社区的"98=下巴"是 XRFrame 编号）②**离群点只剔除孤立飞点**（固定裁剪两端会系统性低估 4%，误拒合格照 — 台账 #28）③**降级要区分失败语义**（只有"压根没关键点"才允许估算兜底 — #29）④**能力预检先行**（`wx.getDeviceInfo()`，避免 SDK 报错日志污染统计 — #30）
- **T1 特殊**：按裁剪窗口换算成品图口径；在工作图（长边 ≤800px，600dpi 时按 `planOutput` 动态）检测而非 295×413 成品小图（小图人脸像素过少）
- 冒烟：`工具链/smoke_face.js`（端口 9426），含「页面层无重复人脸检测实现」静态断言
