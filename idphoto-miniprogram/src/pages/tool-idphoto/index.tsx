import { View, Text, Button, Image, Picker } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useState } from 'react';
import {
  requiredConsents, buildConsentRecord,
  segment, composite, check,
  buildCloudFnAdapter,
  BG, getSpec, getPixelSize, listSpecs, specLabel,
} from '../../services';

// T1 一键证件照：完整链路（真实功能，非占位）
// 选图 → 端侧抠图 →（置信不足且已授权则走 CloudBase 云函数增强）→ 换底
// → 裁剪到规格尺寸 → 导出 → 合规预审 → 保存相册
//
// 隐私合规：授权默认【不勾选】，未集齐授权不启动处理（对应 PRD AC5）。
const TOOL = 'T1';
const MAX_EDGE = 800; // 端侧逐像素抠图的性能保护：工作图长边上限
const DPI = 300;

type BgKey = 'white' | 'blue' | 'blueLight' | 'red';

export default function ToolIdPhoto() {
  const consentItems = requiredConsents(TOOL);
  const [granted, setGranted] = useState<string[]>([]);
  const rec = buildConsentRecord(TOOL, granted);

  const specs = listSpecs();
  const [specIndex, setSpecIndex] = useState(0);
  const [bg, setBg] = useState<BgKey>('white');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [preview, setPreview] = useState('');
  const [result, setResult] = useState<any>(null);

  const toggleConsent = (id: string) => {
    setGranted((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  async function process() {
    if (!rec.ready) {
      Taro.showToast({ title: '请先勾选所需授权', icon: 'none' });
      return;
    }
    setBusy(true);
    setMsg('读取图片…');
    setResult(null);
    try {
      const anyTaro: any = Taro;
      if (typeof anyTaro.createOffscreenCanvas !== 'function') {
        throw new Error('当前基础库不支持离屏 canvas，请升级基础库到 2.16.1+');
      }

      // 1. 选图
      const pick: any = await Taro.chooseImage({
        count: 1,
        sizeType: ['original'],
        sourceType: ['album', 'camera'],
      });
      const path = pick.tempFilePaths[0];
      const info: any = await Taro.getImageInfo({ src: path });

      // 2. 缩放到工作尺寸（长边 <= MAX_EDGE）
      const scale = Math.min(1, MAX_EDGE / Math.max(info.width, info.height));
      const w = Math.max(1, Math.round(info.width * scale));
      const h = Math.max(1, Math.round(info.height * scale));

      // 3. 离屏 canvas 取像素
      const canvas = anyTaro.createOffscreenCanvas({ type: '2d', width: w, height: h });
      const ctx = canvas.getContext('2d');
      const img = canvas.createImage();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = (e: any) => reject(e || new Error('图片加载失败'));
        img.src = path;
      });
      ctx.drawImage(img, 0, 0, w, h);
      const imageData = ctx.getImageData(0, 0, w, h);
      const rgba = imageData.data;

      // 4. 抠图：端侧优先，置信不足自动走 CloudBase 云函数增强（需 faceCloudEnhance 授权）
      setMsg('抠图处理中…');
      const seg: any = await segment({
        rgba,
        width: w,
        height: h,
        cloud: { adapter: buildCloudFnAdapter() },
        consents: granted,
        audit: (meta: any) => console.log('[audit]', meta),
        tool: TOOL,
      });

      // 5. 换底合成
      setMsg('合成底色…');
      const composed = composite(rgba, seg.alpha, w, h, BG[bg]);

      // 6. 裁剪缩放到目标规格尺寸并导出
      // 注：不使用 createImageData —— 微信部分基础库对它报
      // "Value is not of type 'long'"。改为复用第 3 步 getImageData 返回的
      // ImageData 直接写回工作 canvas，再经 drawImage 裁剪缩放到目标尺寸。
      const spec = getSpec(specs[specIndex].id);
      const target = getPixelSize(spec!, DPI)!;
      imageData.data.set(composed);
      ctx.putImageData(imageData, 0, 0);

      const outCanvas = anyTaro.createOffscreenCanvas({
        type: '2d',
        width: target.width,
        height: target.height,
      });
      const octx = outCanvas.getContext('2d');
      // 居中裁剪，保持目标宽高比
      const targetRatio = target.width / target.height;
      const srcRatio = w / h;
      let sw = w, sh = h, sx = 0, sy = 0;
      if (srcRatio > targetRatio) {
        sw = h * targetRatio;
        sx = (w - sw) / 2;
      } else {
        sh = w / targetRatio;
        sy = (h - sh) / 2;
      }
      octx.drawImage(canvas, sx, sy, sw, sh, 0, 0, target.width, target.height);

      const exported: any = await Taro.canvasToTempFilePath({
        canvas: outCanvas,
        x: 0,
        y: 0,
        width: target.width,
        height: target.height,
        destWidth: target.width,
        destHeight: target.height,
        fileType: 'jpg',
        quality: 0.95,
      });
      setPreview(exported.tempFilePath);

      // 7. 合规预审
      const fs = Taro.getFileSystemManager();
      const fileInfo: any = await new Promise((resolve, reject) => {
        fs.getFileInfo({ filePath: exported.tempFilePath, success: resolve, fail: reject });
      });
      const fileKb = Math.round(fileInfo.size / 1024);
      const cr = check(specs[specIndex].id, {
        widthPx: target.width,
        heightPx: target.height,
        dpi: DPI,
        fileKb,
        bg,
      });
      setResult(cr);
      setMsg(`完成（${seg.backend}${seg.degraded ? '，已降级端侧' : ''}）`);
    } catch (e: any) {
      const m = String((e && e.message) || e);
      if (m.startsWith('AC5')) {
        setMsg('该图端侧质量不足，需「上云增强」授权才能处理');
        Taro.showToast({ title: '请先勾选上云增强授权', icon: 'none' });
      } else {
        setMsg('处理失败：' + m);
      }
      console.error('[T1]', e);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!preview) return;
    try {
      await Taro.saveImageToPhotosAlbum({ filePath: preview });
      Taro.showToast({ title: '已保存到相册' });
    } catch (e) {
      Taro.showToast({ title: '保存失败，请检查相册权限', icon: 'none' });
    }
  }

  const bgOptions: { key: BgKey; label: string; color: string }[] = [
    { key: 'white', label: '白底', color: BG.white },
    { key: 'blue', label: '标准深蓝', color: BG.blue },
    { key: 'blueLight', label: '浅蓝', color: BG.blueLight },
    { key: 'red', label: '红底', color: BG.red },
  ];

  return (
    <View className='page'>
      <Text className='page__title'>一键证件照</Text>

      {/* 授权（默认不勾选，未集齐不启动处理） */}
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

      {/* 规格与底色 */}
      <View style={{ margin: '12px 0' }}>
        <Text>规格：</Text>
        <Picker
          mode='selector'
          range={specs.map((s: any) => specLabel(s.id, DPI))}
          value={specIndex}
          onChange={(e: any) => setSpecIndex(Number(e.detail.value))}
        >
          <View style={{ color: '#438EDB', padding: '4px 0' }}>{specs[specIndex].name} ▾</View>
        </Picker>
        <Text style={{ display: 'block', fontSize: '11px', color: '#999', marginTop: '2px' }}>
          {specs[specIndex].source}
        </Text>
        {/* 规格速览芯片：直接点选 + 展示官方像素（2026-10-23 规格数值裁决后新增） */}
        <View className='spec-chips'>
          {specs.map((s: any, i: number) => {
            const px = getPixelSize(s.id, DPI)!;
            const on = specIndex === i;
            return (
              <View
                key={s.id}
                className='spec-chip'
                onClick={() => setSpecIndex(i)}
                style={{
                  padding: '5px 10px',
                  marginRight: '6px',
                  marginBottom: '6px',
                  borderRadius: '20px',
                  border: on ? '1px solid #438EDB' : '1px solid #ddd',
                  background: on ? '#eef5fd' : '#fff',
                }}
              >
                <Text style={{ fontSize: '12px', color: on ? '#2b6cb0' : '#666' }}>
                  {s.name} {px.width}×{px.height}
                </Text>
              </View>
            );
          })}
        </View>
      </View>

      <View style={{ display: 'flex', flexDirection: 'row', margin: '12px 0' }}>
        {bgOptions.map((o) => (
          <View
            key={o.key}
            onClick={() => setBg(o.key)}
            style={{
              padding: '8px 14px',
              marginRight: '8px',
              borderRadius: '6px',
              background: o.color,
              color: o.key === 'white' ? '#333' : '#fff',
              border: bg === o.key ? '2px solid #333' : '1px solid #ccc',
            }}
          >
            <Text>{o.label}</Text>
          </View>
        ))}
      </View>

      <Button className='btn-primary' loading={busy} onClick={process}>
        {busy ? '处理中…' : '选择照片并制作'}
      </Button>

      {msg ? <Text style={{ display: 'block', marginTop: '10px', color: '#666' }}>{msg}</Text> : null}

      {preview ? (
        <View style={{ marginTop: '14px' }}>
          <Image src={preview} style={{ width: '100%', height: '260px' }} mode='aspectFit' />
          <Button style={{ marginTop: '8px' }} onClick={save}>
            保存到相册
          </Button>
        </View>
      ) : null}

      {/* 合规预审结果 */}
      {result ? (
        <View style={{ marginTop: '14px' }}>
          <Text style={{ fontWeight: 'bold' }}>
            合规预审：{result.pass ? '全部通过' : '有不通过项'}
          </Text>
          {result.checks.map((c: any) => (
            <View key={c.key} style={{ padding: '6px 0' }}>
              <Text style={{ color: c.pass ? '#2e7d32' : '#c62828' }}>
                {c.pass ? '✓' : '✗'} {c.label}
              </Text>
              <Text style={{ display: 'block', fontSize: '12px', color: '#888' }}>{c.detail}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
