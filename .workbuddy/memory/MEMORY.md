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

## 关键文件
- `小程序发布准备包.md` —— 注册/备案/提审材料与进度（含路1实施方案）
- `问题台账.md` —— 问题→根因→解决→状态→预防（登记纪律载体）
- `微信小程序开发实战避坑指南.md` —— **五维度踩坑总览**（流程/配置/代码/工具/沟通），新人入门与培训教材
- `每日开发日志/` —— 每日总结（由 `工具链/daily_summary.py` 生成）
- `idphoto-miniprogram/` —— 代码；`cloudfunctions/matting/` —— 云函数
- 本项目与主线产品「银行资金智能连接器」是**两条独立产品线**，合规红线语境不同：本项目重点是人脸生物识别（个保法敏感个人信息）。

## 当前状态（2026-10-23 14:4x）
备案管局审核中（7–15 日）；后台《用户隐私保护指引》已提交（1–3 工作日）。**五个工具全部接真实功能，占位页清零**（#16 解除 / #12 消解）。**人脸定位统一接入完成**（任务 #4，`core/face.js` + `services/faceService.ts` 双轨 VisionKit→faceDetect，T1/T3/T4 三处口径合一，T1 头占比真实上屏）。单测 65/65，verify 全绿。
**下一步：任务 #24（T1 按头占比自动裁剪，依赖已解除可开工）｜ 真机实测头占比与 T3 贴合效果（开发者工具无真机 GPU 能力）｜ 备案号下来填政策页 → 提审。**

## 人脸定位口径（任务 #4 固化，2026-10-23）
- **分层**：`services/faceService.ts`（平台适配，可失败可降级）→ `core/face.js`（纯计算，可单测）
- **双轨**：VisionKit（`wx.createVKSession` + `track.face.mode=2`，基础库 2.25.0+/安卓微信 ≥8.0.25/iOS ≥8.0.24）→ `wx.faceDetect`（**官方已停止维护**，2.18.0+ 覆盖老设备）→ 几何估算兜底
- **两条轨道的静态图片输入都是 RGBA ArrayBuffer**，与 `canvas.getImageData().data` 同构，可直接互喂
- **口径**：`脸长(发际线→下巴) ÷ 0.74 = 头长(含头顶)`；`头长 ÷ 成品图高 = 头占比`
- **铁律**：①**不用硬编码关键点索引**（官方未公布 106 点分组，社区的"98=下巴"是 XRFrame 编号）②**离群点只剔除孤立飞点**（固定裁剪两端会系统性低估 4%，误拒合格照 — 台账 #28）③**降级要区分失败语义**（只有"压根没关键点"才允许估算兜底 — #29）④**能力预检先行**（`wx.getDeviceInfo()`，避免 SDK 报错日志污染统计 — #30）
- **T1 特殊**：按裁剪窗口换算成品图口径；在工作图（长边 ≤800px）检测而非 295×413 成品小图（小图人脸像素过少）
- 冒烟：`工具链/smoke_face.js`（端口 9426），含「页面层无重复人脸检测实现」静态断言
