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

## T6 冲印排版模块（2026-10-26 落地骨架）
- 独立工具 T6「冲印排版」：上传已做好的证件照 → 选规格 → 选相纸 → 自动平铺多张 → 导出可打印拼版图；**无需人脸授权**（纯拼版，不处理人脸）。只做"导出拼版图"，不做实际打印/邮寄/相纸售卖（延续非目标）。
- 代码骨架 `idphoto-miniprogram/src/core/paperLibrary.js`（CommonJS，纯数据+`planLayout`，Node 可单测）：16 种纸（7 常规 R 系列 5/6/7/8/10/12 寸 + 9 迷你 instax/SELPHY/ZINK），每条带 `source`（富士/佳能/惠普官方 + 冲印店出货）；字段 `paperMm/printMm(可打印区或成像区)/dpi/tileable`；`planLayout(paperId,specId)` 复用 `specLibrary.getSpec` 取证件照 mm，4 朝向组合取最多平铺，instax/方贴纸强制 count≤1 并带白边提示。导出自 `NODE_OPTIONS=` 下 `node -e require` 验过 8 API。
- 原型 `prototype.html` 已含 P12 交互屏（内联 `t6plan`，与 paperLibrary 同套数据/算法，已 Node 复跑一致：6寸+1寸=10、12寸+1寸=72、instax-mini+1寸=1 带提示、selphy-postcard+1寸=10、zink-2x3+1寸=2、visa-us+instax-mini=0 触发无法容纳）。
- 尺寸 SSOT 三处同步：paperLibrary.js ↔ 《相纸尺寸口径对照表.md》↔ 《产品功能清单》T6 章节（改尺寸须三处齐改）。
- 提交：`5acecd5 feat(T6)`（paperLibrary.js + prototype.html）+ `a839130 docs(T6)`（PRD大纲/正文/页面原型设计/相纸对照表），已 push，**未打 tag**（待 T6 页面落地）。
- 待办：pages/tool-print/index + canvas 合成导出（把 planLayout 接真实 canvas 绘制与保存相册）；prototype.html 已是 P12 交互屏。

## 智能裁切（#24）/ 600dpi（#33）/ 人脸定位（#4）
- 裁切：sh=头长÷占比、占比取区间中值；留白 0.13/0.16（0.16 仅校验）；裁剪窗必须全在原图内（否则纯色图 #37）；背景采样注入 `segment({bgSamples})`；无人脸→居中裁剪降级不阻断。数值字段用 `getSpec(id)`，`listSpecs()` 是摘要（#25）。
- 600dpi：构图统一 `planOutput`（够用即止/下限800px/上限1600px）；filesize 降 advisory；上云64万像素封顶；suit.js 双线性。
- 人脸：faceService.ts+core/face.js 双层；VisionKit→faceDetect→几何兜底；头长=脸长÷0.74；不硬编码关键点；离群点只剔孤立飞点。

## 商业化（owner 2026-10-23 决策，勿翻案）
个人主体无微信支付→**全功能免费无水印**，600dpi 全开放；代码禁出现支付实现（冒烟断言兜底）；未来企业主体再新增付费档。

## 提审合规口径（2026-10-25 已落地）
- 后台隐私指引**勾 5 项**：选中的照片或视频 / 摄像头 / 相册（仅写入）/ 设备信息 / 操作日志。**摄像头必须勾**——五工具页 chooseImage 均 `sourceType:['album','camera']`（漏报=硬拒，#56）。
- 模板「信息对外提供」文案不可编辑（写着"不共享第三方"），与接百度冲突 → 第三方披露走「补充文档」；**后台实测只收 .txt ≤100KB，不是 PDF**（#57）。产物：`提审材料/第三方信息共享说明.txt`（2.4KB）。
- 纪律：涉及后台/控制台界面的结论，**必须以用户实测截图为准**，检索到的文档口径只作参考（#55/#57 同根）。

## 当前状态（2026-10-25 23:1x 收工）
任务 #13 已收口：隐私指引含第三方条目**已重提**（23:05），审核 1–3 工作日（预计 10-28~10-30）。
任务 #34 全环节收口：换 Key + 重部署后控制台复验**通过**（`provider=baidu`、331ms、personNum=1、downscaled=false），#54 的 512² 封顶被实测双向锁定（23541 像素时不降）。
**提审唯一硬阻塞 = ICP 备案号**（10-22 提交，7–15 工作日 → 最早 10-31）。
待办优先级：①查备案状态；②**微信认证重提（#15，deadline 2026-11-21，剩 2 次机会，30 元不退风险，不阻塞提审）**；③真机冒烟 S1–S7（不阻塞提审）；④#54 像素封顶 A/B（纯优化）；⑤模型点亮待外部资源。
