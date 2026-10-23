import { View, Text, Button, Image, Picker } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useState } from 'react';
import { requiredConsents, buildConsentRecord, BG, listSpecs, getSpec, check, specLabel } from '../../services';

// T4 合规检测：只读检测，不生成、不改动原图（PRD J2 / AC10）——无保存相册入口。
// 检测项与口径（2026-10-23 与 owner 确认）：
//   1. 尺寸：真实测量（getImageInfo）
//   2. KB：真实测量（getFileInfo）
//   3. 底色：边缘环形采样 → 最近标准色（BG 常量）匹配
//   4. dpi：文件内 dpi 元数据微信端无法读取（同 T5 #24 口径）→
//      等效 dpi = min(像素宽/规格英寸宽, 像素高/规格英寸高)（最坏情况），报告标注口径
//   5. 头部占比：微信端侧人脸检测 wx.faceDetect（106 点 landmarks）估算；
//      不支持的环境（开发者工具等）自动降级为「未检测」，其余 4 项照常出报告
// 隐私合规：授权矩阵 T4=['faceLocal']（端侧分析人脸区域，无上云），默认【不勾选】（AC5）。
const TOOL = 'T4';
const MAX_EDGE = 800; // 分析用工作图长边上限（采样/人脸检测性能保护）

type CheckResult = ReturnType<typeof check>;

// 边缘环形采样求平均色，再匹配最近的标准底色
function detectBgKey(rgba: Uint8ClampedArray, w: number, h: number): string | null {
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.04));
  let r = 0, g = 0, b = 0, n = 0;
  const sample = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; n += 1;
  };
  for (let x = 0; x < w; x += 2) {
    for (let y = 0; y < band; y += 2) { sample(x, y); sample(x, h - 1 - y); }
  }
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < band; x += 2) { sample(x, y); sample(w - 1 - x, y); }
  }
  if (!n) return null;
  const ar = r / n, ag = g / n, ab = b / n;
  let bestKey = '', bestDist = Infinity;
  for (const [key, hex] of Object.entries(BG)) {
    const v = parseInt(String(hex).slice(1), 16);
    const br = (v >> 16) & 255, bgc = (v >> 8) & 255, bb = v & 255;
    const d = (ar - br) ** 2 + (ag - bgc) ** 2 + (ab - bb) ** 2;
    if (d < bestDist) { bestDist = d; bestKey = key; }
  }
  return bestKey || null;
}

// 微信端侧人脸检测估算头部占比；失败返回 null（降级，报告跳过该项）
async function detectHeadRatio(canvas: any, ctx: any, w: number, h: number): Promise<number | null> {
  const anyWx: any = wx;
  if (typeof anyWx.initFaceDetect !== 'function' || typeof anyWx.faceDetect !== 'function') return null;
  try {
    const imageData = ctx.getImageData(0, 0, w, h);
    await new Promise<void>((resolve, reject) => {
      anyWx.initFaceDetect({
        success: () => resolve(),
        fail: (e: any) => reject(e || new Error('initFaceDetect fail')),
      });
    });
    const res: any = await new Promise<void>((resolve, reject) => {
      anyWx.faceDetect({
        frameBuffer: imageData.data.buffer,
        width: w,
        height: h,
        enablePoint: true,
        enableConf: true,
        success: (r: any) => resolve(r),
        fail: (e: any) => reject(e || new Error('faceDetect fail')),
      });
    });
    anyWx.stopFaceDetect();
    const pts: any[] = res.pointArray || [];
    if (!pts.length) return null;
    const ys = pts.map((p) => p.y);
    const browY = Math.min(...ys);   // landmarks 最高点 ≈ 眉/眼区
    const chinY = Math.max(...ys);   // 最低点 ≈ 下巴
    const faceH = chinY - browY;
    if (faceH <= 0) return null;
    // 头顶 ≈ 眉线上方 0.35×脸高（含额头与发型，经验系数，估算口径）
    const headTopY = browY - 0.35 * faceH;
    return (chinY - headTopY) / h;
  } catch (e) {
    return null; // 开发者工具/部分真机不支持 → 降级
  }
}

export default function ToolCheck() {
  const consentItems = requiredConsents(TOOL);
  const [granted, setGranted] = useState<string[]>([]);
  const rec = buildConsentRecord(TOOL, granted);

  const specs = listSpecs();
  const [specIndex, setSpecIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [preview, setPreview] = useState('');
  const [result, setResult] = useState<CheckResult | null>(null);
  const [headApprox, setHeadApprox] = useState(false);
  const [headSkipped, setHeadSkipped] = useState(false);

  const spec = specs[specIndex];

  const toggleConsent = (id: string) => {
    setGranted((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  async function run() {
    if (!rec.ready) {
      Taro.showToast({ title: '请先勾选所需授权', icon: 'none' });
      return;
    }
    setBusy(true);
    setResult(null);
    setMsg('读取图片…');
    try {
      const anyTaro: any = Taro;
      if (typeof anyTaro.createOffscreenCanvas !== 'function') {
        throw new Error('当前基础库不支持离屏 canvas，请升级基础库到 2.16.1+');
      }

      // 1. 选图（original 保证实测 KB 真实）
      const pick: any = await Taro.chooseImage({
        count: 1,
        sizeType: ['original'],
        sourceType: ['album', 'camera'],
      });
      const path = pick.tempFilePaths[0];

      // 2. 真实尺寸 + 真实 KB
      const info: any = await Taro.getImageInfo({ src: path });
      let fileKb = 0;
      try {
        const fi: any = await Taro.getFileInfo({ filePath: path });
        fileKb = Math.max(1, Math.round((fi.size || 0) / 1024));
      } catch (_) { fileKb = Math.round((pick.tempFiles?.[0]?.size || 0) / 1024); }

      // 3. 工作图（长边 ≤ MAX_EDGE）用于底色采样与人脸检测
      const scale = Math.min(1, MAX_EDGE / Math.max(info.width, info.height));
      const w = Math.max(1, Math.round(info.width * scale));
      const h = Math.max(1, Math.round(info.height * scale));
      const canvas = anyTaro.createOffscreenCanvas({ type: '2d', width: w, height: h });
      const ctx = canvas.getContext('2d');
      const img = canvas.createImage();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = (e: any) => reject(e || new Error('图片加载失败'));
        img.src = path;
      });
      ctx.drawImage(img, 0, 0, w, h);
      const rgba = ctx.getImageData(0, 0, w, h).data;

      // 4. 底色（边缘采样 → 最近标准色）
      setMsg('分析底色…');
      const bgKey = detectBgKey(rgba, w, h);

      // 5. 等效 dpi（#24 口径：像素 ÷ 目标规格英寸，取宽高较劣者）
      // 注意：listSpecs() 只含 {id,name,note}，完整字段（widthMm 等）须经 getSpec 取
      const full = getSpec(spec.id)!;
      const dpiW = info.width / (full.widthMm / 25.4);
      const dpiH = info.height / (full.heightMm / 25.4);
      const eqDpi = Math.round(Math.min(dpiW, dpiH));

      // 6. 头部占比（faceDetect，失败降级为未检测）
      setMsg('检测人脸区域…');
      const ratio = await detectHeadRatio(canvas, ctx, w, h);
      setHeadApprox(ratio != null);
      setHeadSkipped(ratio == null);

      // 7. 出报告（core/compliance 引擎；只读，无任何写文件动作 → AC10）
      const measured: any = {
        widthPx: info.width,
        heightPx: info.height,
        dpi: eqDpi,
        fileKb,
        bg: bgKey || 'unknown',
      };
      if (ratio != null) measured.headHeightRatio = ratio;
      setResult(check(spec.id, measured));
      setPreview(path);
      setMsg(
        '检测完成' +
        (ratio == null ? '（头部占比：当前环境不支持人脸检测，已跳过）' : '') +
        '（等效 dpi 口径：像素 ÷ 目标规格英寸）',
      );
    } catch (e: any) {
      setMsg('检测失败：' + String((e && e.message) || e));
      console.error('[T4]', e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View className='page'>
      <Text className='page__title'>合规检测</Text>
      <Text className='page__hint'>上传已有证件照，出检测报告。仅读取分析，不生成、不改动原图。</Text>

      {/* 授权（默认不勾选，未集齐不启动） */}
      <View className='consent'>
        <Text className='consent__h'>需授权（{granted.length}/{consentItems.length}）</Text>
        {consentItems.map((c: any) => {
          const on = granted.includes(c.id);
          return (
            <View
              key={c.id}
              className='consent__item'
              onClick={() => toggleConsent(c.id)}
              style={{
                border: on ? '1px solid #438EDB' : '1px solid #ddd',
                background: on ? '#eef5fd' : '#fff',
                padding: '8px',
                marginBottom: '6px',
                borderRadius: '6px',
              }}
            >
              <Text style={{ fontWeight: on ? 'bold' : 'normal' }}>
                {on ? '☑ ' : '☐ '}
                {c.label}
              </Text>
              <Text className='consent__desc'>{c.desc}</Text>
            </View>
          );
        })}
      </View>

      {/* 目标规格 */}
      <View style={{ margin: '12px 0' }}>
        <Text>目标规格：</Text>
        <Picker
          mode='selector'
          range={specs.map((s: any) => specLabel(s.id, 300))}
          value={specIndex}
          onChange={(e: any) => { setSpecIndex(Number(e.detail.value)); setResult(null); }}
        >
          <View style={{ color: '#438EDB', padding: '4px 0' }}>{spec.name} ▾</View>
        </Picker>
        <Text style={{ display: 'block', fontSize: '11px', color: '#999', marginTop: '2px' }}>
          {spec.source}
        </Text>
        <Text style={{ display: 'block', fontSize: '11px', color: '#999', marginTop: '4px' }}>
          说明：文件内 dpi 元数据微信端无法读取，按「像素 ÷ 目标规格英寸」换算等效 dpi（同 T5 #24 口径）；头部占比为端侧人脸检测估算值
        </Text>
      </View>

      <Button className='btn-primary' loading={busy} onClick={run}>
        {busy ? '检测中…' : '选择照片并检测'}
      </Button>

      {msg ? <Text style={{ display: 'block', marginTop: '10px', color: '#666' }}>{msg}</Text> : null}

      {result ? (
        <View className='result'>
          <View className='result__row'>
            <Text>综合结论（目标：{spec.name}）</Text>
            <Text className={result.pass ? 'result__ok' : 'result__bad'}>
              {result.pass ? '合规 ✓' : '不合规 ✗'}
            </Text>
          </View>
          {result.checks.map((c) => (
            <View className='result__row' key={c.key}>
              <View style={{ flex: 1, paddingRight: '8px' }}>
                <Text>{c.label}{c.key === 'head' && headApprox ? '（估算）' : ''}</Text>
                <Text style={{ display: 'block', fontSize: '11px', color: '#888' }}>{c.detail}</Text>
              </View>
              <Text className={c.pass ? 'result__ok' : 'result__bad'}>
                {c.pass ? '通过' : '未通过'}
              </Text>
            </View>
          ))}
          {headSkipped ? (
            <View className='result__row'>
              <Text style={{ color: '#999' }}>头部占比</Text>
              <Text style={{ color: '#999' }}>未检测（当前环境不支持人脸检测）</Text>
            </View>
          ) : null}
          {!result.pass && result.suggestions.length ? (
            <Text style={{ display: 'block', marginTop: '8px', fontSize: '12px', color: '#b26a00' }}>
              建议：用「一键证件照 / 规格转换」重新生成 → {result.suggestions.join('、')}
            </Text>
          ) : null}
        </View>
      ) : null}

      {preview ? (
        <View style={{ marginTop: '14px' }}>
          <Image src={preview} style={{ width: '100%', height: '220px' }} mode='aspectFit' />
          <Text style={{ display: 'block', fontSize: '11px', color: '#999', marginTop: '6px' }}>
            仅检测，不生成、不改动原图（AC10）
          </Text>
        </View>
      ) : null}
    </View>
  );
}
