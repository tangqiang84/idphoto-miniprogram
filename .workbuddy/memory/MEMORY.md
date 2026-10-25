# 证件照小程序 · 项目长期记忆

## 项目定位
微信小程序「标准照裁剪」，**个人主体**，AppID `wxd7ff2aaa541a62e4`。Taro 3.6.23+React+TS+Sass，核心逻辑在 `src/core/`（纯 JS 可 Node 单测）。上云走路1 CloudBase：环境 `baochengtang-d7g6ki1ch79dc2faa`（已写入 src/app.ts），云函数 `cloudfunctions/matting/index.js`，前端封装 `services/cloudFnAdapter.ts`。与「银行资金智能连接器」是两条独立产品线（本项目红线=人脸生物识别/个保法）。

## 工作流硬约定（必须遵守）
1. 代码修改/问题/解决 → 登记《问题台账.md》+同步任务状态。
2. 改完必实跑编译/单测（verify.sh），禁静态阅读下结论。
3. 同类问题第2次=预防失效，升级载体（提醒→清单→脚本硬闸门）。
4. 用户质疑"找不到/不对"→**全量重查磁盘**再答，不凭记忆。
5. 文档随任务回写：架构→《技术架构说明》｜UI→《页面原型设计》｜功能→《产品功能清单》｜环境→《小程序开发指南》｜工具→《项目资产与工具手册》｜问题→《问题台账》｜任务→《开发任务台账》。文档冲突以磁盘现状为准。
6. 每日收工跑 `工具链/daily_summary.py` 生成日志（每日开发日志/YYYY-MM-DD.md），通用教训进《避坑指南》。

## 资产纪律
只增不删（工具/脚本/素材/模块不得删，dist/ 除外）；新工具必须登记手册；先查手册再动手禁重复造轮子。

## 环境避坑（高频）
- 写盘命令一律前置 `NODE_OPTIONS=`（沙箱 fs shim 的 mkdir 不幂等），build/npm install 同理。
- 验证：`NODE_OPTIONS= bash 工具链/verify.sh`；冒烟 smoke_auto/model/headcrop/dpi/face（端口 9426–9436）。改页面 className 必须先编译再冒烟（跑 dist/）。
- **禁止项目内 npm install 新包**（webpack 重排风险）；webpack 锁 5.89.0（EntryDependency）。
- bash heredoc 写文件被静默杀（exit 137）→ 用 Python/Write 写文件；macOS 无 timeout。
- automator 0.13：禁 reLaunch()；Page 无 screenshot/path()；mock 图先 evaluate 注入；mock wx 底层 API 只能在 evaluate 内直接赋值（#38）。
- project.config.json 须有 cloudfunctionRoot；git 详见《项目资产与工具手册》第四节（远程 GitHub 私有库，tag 需单独 push，#22）。

## 云端抠图口径（#34 固化 + 2026-10-24 控制台全链路验证通过）
- 路由：baidu（默认，配 Key 即生效）→失败降 shadow（永不失败）；另有 birefnet 待 GPU。契约：入 RGBA→出 alphaB64。
- 密钥只走云函数环境变量，禁进包体/文件/git；有静态断言。
- 取 scoremap 软 alpha（发丝最好），foreground 兜底；判优劣用 `shouldAcceptCloudAlpha`（前景占比退化+偏移>0.25），不用 1−ambiguousRatio（#45）。
- **#54**：生效封顶是像素 `DEFAULT_MAX_PIXELS=512²`，960×1280 实际降到 443×591；「无需降采样」旧结论已废。提封顶需 A/B 实跑。
- **#53**：控制台「云端测试」旧签名限制远低于 1MB：156KB✅/864KB❌；载荷一律用 `工具链/make_cloudfn_payload.js`（默认128KB预算）。控制台只验路由；质量验证走小程序 callFunction(5MB) 或本地 `baidu_live.js`（全分辨率）。
- **2026-10-24 控制台闭环**：provider=baidu，personNum=1，前景占比39.3%（本地39.4%一致），软边缘1.0%，唯一值245，421ms；三联图 `素材/测试截图/cloudfn-result-1792814268979.png`；结果存档 `工具链/cf-result-console-baidu.json`；解码器 `decode_cloudfn_result.js`（手册3q/3r）。
- #49：卡通图百度检不出人（person_num=0），测试素材必须含真人照（素材/测试图/test_real.png）；线上兜底 `cloud_foreground_degenerate`（<0.5%拦下）。
- #50/51/52 已修：rgba 长度校验、影子方向反、真 mat3Inv。
- 合规：个保法23条，政策页/授权弹窗/后台指引/原型文档**四处点名百度智能云**。

## 真模型接入口径（#3）
许可红线：查 HF 模型卡 License（非 GitHub）；BiRefNet 官方 MIT 可商用，briaai/RMBG-2.0 非商用已禁用（#40）。三层：core/mattingModel.js（规格驱动）→ services/modelService.ts（下载/退避）→ miniprogram/onnxMatting.ts（注入式 ort）。端侧默认关闭零回归；点亮三步见《小程序开发指南》6.1。云端 BiRefNet 需境内 GPU≥8GB（部署/birefnet/）。

## 智能裁切（#24）/ 600dpi（#33）/ 人脸定位（#4）
- 裁切：sh=头长÷占比、占比取区间中值；留白 0.13/0.16（0.16 仅校验）；裁剪窗必须全在原图内（否则纯色图 #37）；背景采样注入 `segment({bgSamples})`；无人脸→居中裁剪降级不阻断。数值字段用 `getSpec(id)`，`listSpecs()` 是摘要（#25）。
- 600dpi：构图统一 `planOutput`（够用即止/下限800px/上限1600px）；filesize 降 advisory；上云64万像素封顶；suit.js 双线性。
- 人脸：faceService.ts+core/face.js 双层；VisionKit→faceDetect→几何兜底；头长=脸长÷0.74；不硬编码关键点；离群点只剔孤立飞点。

## 商业化（owner 2026-10-23 决策，勿翻案）
个人主体无微信支付→**全功能免费无水印**，600dpi 全开放；代码禁出现支付实现（冒烟断言兜底）；未来企业主体再新增付费档。

## 当前状态（2026-10-24）
备案管局审核中；隐私指引已提交（需补百度条目重提）。单测 142/142、tsc 0告警、verify 全绿。云端百度链路**本地+控制台双验证通过**。
下一步：owner 轮换百度 Secret Key（终端明文暴露过）+重部署云函数+后台指引补百度重提（提审前必须）；真机实测（#24遗留）；模型点亮待外部资源；备案号下来填政策页→提审（GPU未就绪则提审版关闭上云）。
