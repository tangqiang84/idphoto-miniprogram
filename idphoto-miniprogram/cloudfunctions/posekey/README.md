# posekey 云函数 · 部署说明（P1 / 台账 #72）

> 用途：给 T3 换装的 `suitFitV2` 几何引擎提供 **L1 实测双肩点**，替代 v1 的猜测信号
> （行宽突变 / bbox 投影 / 0.3 系数 —— 四轮失败的结构性根因，见《T3换装重新选型与重构方案》第 1 章）。
>
> **未部署不影响其他功能**：云函数缺失/未部署时，前端按原因码 `posekey:not_deployed`
> 降级到 L2（faceDetect 实测）+ 物理标尺通道（R1 规格头身比推导），T1/T2/T5/T6 完全不受影响。

## 1. 契约

| 项 | 内容 |
|---|---|
| 入参 | `{ image(base64), width, height, region:'CN', purpose:'pose_keypoints', retain:false, train:false }` |
| 出参（成功） | `{ keypoints:[{name,x,y,score}] ×17, model:'movenet-lightning-int8', latencyMs }`，坐标归一化 0~1（相对上传区域） |
| 出参（失败） | `{ error: 'not_deployed' \| 'model_missing' \| 'decode_failed' \| 'no_person' \| 'infer_failed' }` |
| 前端解析 | `src/core/poseContract.js`（`parsePoseResult` / `mapPoseToCanvas`，8 条单测） |

## 2. 部署步骤（微信开发者工具）

1. **下载模型**（只需一次）：
   ```bash
   python3 cloudfunctions/posekey/fetch_model.py
   # 产物：cloudfunctions/posekey/model/movenet_singlepose_lightning_int8_4.tflite（约 3.6MB）
   # License：MoveNet Apache-2.0（模型卡 + tfjs-models LICENSE 双确认）
   ```
2. **确认云函数 Python 运行时版本**（云开发控制台 → 云函数 → 运行环境）。
   `requirements.txt` 里的 `tflite-runtime` 与 Python 版本强绑定（cp36/cp37/cp38…），
   版本不匹配会 import 失败 → 云函数返回 `not_deployed`（不会崩，前端降级）。
3. **上传并部署**：开发者工具里右键 `cloudfunctions/posekey` → 「上传并部署：云端安装依赖」。
   ⚠️ 模型文件必须一起上传（放在 `model/` 子目录，不要放进 `.gitignore`）。
4. **验证**：云开发控制台 → 云函数 → posekey → 「测试」，payload 用
   `工具链/make_cloudfn_payload.js` 生成的 base64（沿用 #53 口径：控制台载荷远小于 1MB，
   用默认的 128KB 预算生成），期望 `keypoints.length === 17`。

## 3. 合规要点（不要改）

- 入参只传**人像区域**（F1 后上传的就是规格裁剪窗），不传原图；`retain=false` / `train=false` / `region=CN`。
- 用途是**姿态关键点识别**（识别类，非生成式）——个人主体下保持该形态是合规前提（方案 2.1）。
- 政策页「第三方信息共享说明」如后续列云端能力，需补一行「姿态关键点识别（CloudBase 云函数，境内处理，不留存）」。

## 4. 自测

```bash
python3 cloudfunctions/posekey/selftest.py   # 5/5（不依赖 tflite/Pillow/numpy，注入假依赖）
```

## 5. 故障速查

| 现象 | 含义 | 动作 |
|---|---|---|
| `posekey:not_deployed` | 云函数未部署 / tflite 运行时 import 失败 | 检查部署与 Python 版本（第 2 步） |
| `posekey:model_missing` | `model/*.tflite` 没上传上去 | 重跑 fetch_model.py 并重新部署 |
| `posekey:no_person` | 模型没检出人（非证件照构图） | 走契约 7：前端提示换标准证件照 |
| `posekey:timeout` | 15s 未返回（冷启动/网络） | 前端自动降级 L2，状态行带原因码（#70 纪律） |
