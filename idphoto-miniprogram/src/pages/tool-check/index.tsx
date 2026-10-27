import { View, Text, Button, Image, Picker } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useState } from 'react';
import { requiredConsents, buildConsentRecord, BG, listSpecs, getSpec, check, specLabel, measureHeadRatio } from '../../services';
import { useImagePicker } from '../../hooks/useImagePicker';
import { useConsentGate } from '../../hooks/useConsentGate';

// T4 合规检测：只读检测，不生成、不改动原图（PRD J2 / AC10）——无保存相册入口。
// 检测项与口径（2026-10-23 与 owner 确认）：
//   1. 尺寸：真实测量（getImageInfo）
//   2. KB：真实测量（getFileInfo）
//   3. 底色：边缘环形采样 → 最近标准色（BG 常量）匹配
//   4. dpi：文件内 dpi 元数据微信端无法读取（同 T5 #24 口径）→
//      等效 dpi = min(像素宽/规格英寸宽, 像素高/规格英寸高)（最坏情况），报告标注口径
//   5. 头部占比：统一走 services/faceService（任务 #4：VisionKit 优先 → faceDetect 降级 → 几何估算），
//      与 T1/T3 同一套口径；完全不可用时降级为「未检测」，其余 4 项照常出报告
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

export default function ToolCheck() {
  const consentItems = requiredConsents(TOOL);
  const [granted, setGranted] = useState<string[]>([]);
  const rec = buildConsentRecord(TOOL, granted);
  // 【P1 #77 / RC-7】T4 补人脸处理协议闸门：未勾选时上传区不可点
  const gate = useConsentGate(rec.ready, '合规检测');
  const picker = useImagePicker((img) => run(img.path, img.width, img.height));

  const specs = listSpecs();
  const [specIndex, setSpecIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [preview, setPreview] = useState('');
  const [result, setResult] = useState<CheckResult | null>(null);
  const [headApprox, setHeadApprox] = useState(false);
  const [headSkipped, setHeadSkipped] = useState(false);
  const [headNotes, setHeadNotes] = useState<string[]>([]);

  const spec = specs[specIndex];

  const toggleConsent = (id: string) => {
    setGranted((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  async function run(path: string, srcW: number, srcH: number) {
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

      // 2. 真实尺寸 + 真实 KB（取图已剥离到 useImagePicker，PRD A1 引导框在拍摄路径叠加）
      let fileKb = 0;
      try {
        const fi: any = await Taro.getFileInfo({ filePath: path });
        fileKb = Math.max(1, Math.round((fi.size || 0) / 1024));
      } catch (_) { fileKb = 0; }

      // 3. 工作图（长边 ≤ MAX_EDGE）用于底色采样与人脸检测
      const scale = Math.min(1, MAX_EDGE / Math.max(srcW, srcH));
      const w = Math.max(1, Math.round(srcW * scale));
      const h = Math.max(1, Math.round(srcH * scale));
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
      const dpiW = srcW / (full.widthMm / 25.4);
      const dpiH = srcH / (full.heightMm / 25.4);
      const eqDpi = Math.round(Math.min(dpiW, dpiH));

      // 6. 头部占比（统一走 services/faceService：VisionKit 优先 → faceDetect 降级 → 几何估算）
      //    T4 是只读检测，不做抠图，故无 alpha 包围盒可作几何估算兜底 → 完全不可用时为「未检测」
      setMsg('检测人脸区域…');
      const head = await measureHeadRatio(rgba, w, h, null);
      const ratio = head.ok ? head.ratio : null;
      setHeadApprox(head.source === 'estimate' || head.quality === 'low');
      setHeadSkipped(ratio == null);
      setHeadNotes(head.notes || []);

      // 7. 出报告（core/compliance 引擎；只读，无任何写文件动作 → AC10）
      const measured: any = {
        widthPx: srcW,
        heightPx: srcH,
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
      <View
        className='consent'
        style={gate.hinted
          ? { border: '2px solid #e07b00', borderRadius: '8px', padding: '10px', background: '#fff8ec' }
          : undefined}
      >
        <Text className='consent__h'>需授权（{granted.length}/{consentItems.length}）</Text>
        {gate.hinted ? (
          <Text style={{ display: 'block', fontSize: '12px', color: '#e07b00', margin: '4px 0 6px' }}>
            请先勾选下方授权，才能选择照片或拍照（先同意、后收集）
          </Text>
        ) : null}
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
          说明：文件内 dpi 元数据微信端无法读取，按「像素 ÷ 目标规格英寸」换算等效 dpi（同 T5 #24 口径）；头部占比由端侧人脸检测测得（关键点估算头顶，含误差）
        </Text>
      </View>

      <Button className='btn-primary' loading={busy}
        disabled={gate.blocked}
        onClick={() => gate.gate(picker.pickAlbum)}>
        {busy ? '检测中…' : '从相册选择'}
      </Button>
      <Button className='btn-camera' disabled={gate.blocked}
        onClick={() => gate.gate(picker.openCamera)}>
        📷 拍摄（引导框）
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
              <Text className={c.level === 'advisory' ? 'result__warn' : (c.pass ? 'result__ok' : 'result__bad')}>
                {c.level === 'advisory' ? '提示' : (c.pass ? '通过' : '未通过')}
              </Text>
            </View>
          ))}
          {headSkipped ? (
            <View className='result__row'>
              <Text style={{ color: '#999' }}>头部占比</Text>
              <Text style={{ color: '#999' }}>未检测（当前环境不支持人脸检测）</Text>
            </View>
          ) : null}
          {headNotes.length ? (
            <Text style={{ display: 'block', fontSize: '11px', color: '#999', marginTop: '2px' }}>
              {headNotes.join('；')}
            </Text>
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
          {/* AC1 镜像提示（检测工具无导出，仅做引导文案提示） */}
          <Text style={{ display: 'block', marginTop: '6px', fontSize: '12px', color: '#ad6800' }}>
            ⚠️ 若照片为镜像自拍（左右颠倒），请关闭镜像/翻转后重拍，否则将导致审核失败。
          </Text>
        </View>
      ) : null}

      {/* A1 半透明人脸引导框：拍摄入口（相册走上方 .btn-primary） */}
      {picker.Guide}
      {/* A3 原图质量提示（非阻断，建议性） */}
      {picker.QualityTip}
    </View>
  );
}
