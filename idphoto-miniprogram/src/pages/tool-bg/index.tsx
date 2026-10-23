import { View, Text, Button, Image, Picker, Input } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useState } from 'react';
import {
  requiredConsents, buildConsentRecord,
  segment, composite, compositeTransparent,
  buildCloudFnAdapter,
  BG, getSpec, getPixelSize, listSpecs,
} from '../../services';

// T2 单独换底色：已有照片只换底（真实功能，非占位）
// 选图 → 端侧抠图 →（置信不足且已授权则走 CloudBase 云函数增强）→ 换底
// → 可选规格裁剪（不选保持原图尺寸）→ 导出（纯色 JPG / 透明底 PNG）→ 保存相册
//
// 与 T1 的差异（PRD J2）：不强制规格、不做合规预审。
// 功能范围（PRD C 章，2026-10-23 与 owner 确认）：四色底 + 自定义 HEX 色值 + 透明底 PNG；渐变底暂缓。
// 隐私合规：授权默认【不勾选】，未集齐授权不启动处理（对应 PRD AC5）。
const TOOL = 'T2';
const MAX_EDGE = 800; // 端侧逐像素抠图的性能保护：工作图长边上限
const DPI = 300;

type BgKey = 'white' | 'blue' | 'red' | 'gray';

// 校验自定义 HEX 色值（#RRGGBB / RRGGBB）
function normalizeHex(input: string): string | null {
  const s = input.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  return '#' + s.toUpperCase();
}

export default function ToolBg() {
  const consentItems = requiredConsents(TOOL);
  const [granted, setGranted] = useState<string[]>([]);
  const rec = buildConsentRecord(TOOL, granted);

  const specs = listSpecs();
  const [specIndex, setSpecIndex] = useState(-1); // -1 = 保持原图尺寸（不裁剪）
  const [bg, setBg] = useState<BgKey>('white');
  const [useTransparent, setUseTransparent] = useState(false);
  const [customHex, setCustomHex] = useState('');
  const [customApplied, setCustomApplied] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [preview, setPreview] = useState('');
  const [outInfo, setOutInfo] = useState('');

  const toggleConsent = (id: string) => {
    setGranted((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  // 当前生效底色：透明底优先，其次自定义色值，最后标准四色
  const activeBg = useTransparent ? null : customApplied || BG[bg];

  function applyCustom() {
    const hex = normalizeHex(customHex);
    if (!hex) {
      Taro.showToast({ title: '色值格式应为 #RRGGBB', icon: 'none' });
      return;
    }
    setCustomApplied(hex);
    setUseTransparent(false);
    Taro.showToast({ title: `已应用 ${hex}`, icon: 'none' });
  }

  async function process() {
    if (!rec.ready) {
      Taro.showToast({ title: '请先勾选所需授权', icon: 'none' });
      return;
    }
    if (!activeBg) {
      Taro.showToast({ title: '请先选择底色', icon: 'none' });
      return;
    }
    setBusy(true);
    setMsg('读取图片…');
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

      // 5. 换底合成（透明底保留 alpha 通道，纯色混合）
      setMsg(useTransparent ? '合成透明底…' : '合成底色…');
      const composed = useTransparent
        ? compositeTransparent(rgba, seg.alpha, w, h)
        : composite(rgba, seg.alpha, w, h, activeBg!);

      // 注：不使用 createImageData —— 微信部分基础库对它报
      // "Value is not of type 'long'"。改为复用第 3 步 getImageData 返回的
      // ImageData 直接写回工作 canvas（台账 #10）。
      imageData.data.set(composed);
      ctx.putImageData(imageData, 0, 0);

      // 6. 导出：默认保持原图尺寸；用户选了规格则居中裁剪到该规格
      const isTransparent = useTransparent;
      const fileType: 'jpg' | 'png' = isTransparent ? 'png' : 'jpg';
      let outW = w, outH = h;
      let outCanvas = canvas;
      if (specIndex >= 0) {
        const target = getPixelSize(getSpec(specs[specIndex].id)!, DPI)!;
        outCanvas = anyTaro.createOffscreenCanvas({ type: '2d', width: target.width, height: target.height });
        const octx = outCanvas.getContext('2d');
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
        outW = target.width;
        outH = target.height;
      }

      const exported: any = await Taro.canvasToTempFilePath({
        canvas: outCanvas,
        x: 0,
        y: 0,
        width: outW,
        height: outH,
        destWidth: outW,
        destHeight: outH,
        fileType,
        quality: 0.95,
      });
      setPreview(exported.tempFilePath);
      setOutInfo(
        `${outW}×${outH} · ${isTransparent ? '透明底 PNG' : `底色 ${activeBg} JPG`}` +
        (seg.degraded ? ' · 已降级端侧' : '') +
        (specIndex >= 0 ? ` · ${specs[specIndex].name}` : ' · 原图尺寸'),
      );
      setMsg(`完成（${seg.backend}）`);
    } catch (e: any) {
      const m = String((e && e.message) || e);
      if (m.startsWith('AC5')) {
        setMsg('该图端侧质量不足，需「上云增强」授权才能处理');
        Taro.showToast({ title: '请先勾选上云增强授权', icon: 'none' });
      } else {
        setMsg('处理失败：' + m);
      }
      console.error('[T2]', e);
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
    { key: 'blue', label: '蓝底', color: BG.blue },
    { key: 'red', label: '红底', color: BG.red },
    { key: 'gray', label: '灰底', color: BG.gray },
  ];

  return (
    <View className='page'>
      <Text className='page__title'>单独换底色</Text>
      <Text className='page__hint'>上传一张已有照片，仅替换背景色，不改动五官。不强制规格、不做预审。</Text>

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

      {/* 底色选择：标准四色 */}
      <View style={{ margin: '12px 0' }}>
        <Text>底色：</Text>
        <View style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', marginTop: '6px' }}>
          {bgOptions.map((o) => (
            <View
              key={o.key}
              onClick={() => { setBg(o.key); setUseTransparent(false); setCustomApplied(null); }}
              style={{
                padding: '8px 14px',
                marginRight: '8px',
                marginBottom: '8px',
                borderRadius: '6px',
                background: o.color,
                color: o.key === 'white' || o.key === 'gray' ? '#333' : '#fff',
                border: !useTransparent && !customApplied && bg === o.key ? '2px solid #333' : '1px solid #ccc',
              }}
            >
              <Text>{o.label}</Text>
            </View>
          ))}
          {/* 透明底（C3：PNG 保留 alpha 通道） */}
          <View
            onClick={() => setUseTransparent(true)}
            style={{
              padding: '8px 14px',
              borderRadius: '6px',
              border: useTransparent ? '2px solid #333' : '1px solid #ccc',
              backgroundImage:
                'linear-gradient(45deg, #ddd 25%, transparent 25%, transparent 75%, #ddd 75%), linear-gradient(45deg, #ddd 25%, #fff 25%, #fff 75%, #ddd 75%)',
              backgroundSize: '10px 10px',
              backgroundPosition: '0 0, 5px 5px',
            }}
          >
            <Text>透明底 PNG</Text>
          </View>
        </View>
      </View>

      {/* 自定义色值（C2：HEX 输入） */}
      <View style={{ margin: '12px 0', display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
        <Text>自定义色值：</Text>
        <Input
          value={customHex}
          onInput={(e: any) => setCustomHex(e.detail.value)}
          placeholder='#RRGGBB，如 1A2B3C'
          style={{
            flex: 1,
            border: '1px solid #ccc',
            borderRadius: '6px',
            padding: '6px 8px',
            marginLeft: '6px',
          }}
        />
        <Button size='mini' style={{ marginLeft: '8px' }} onClick={applyCustom}>
          应用
        </Button>
        {customApplied ? (
          <View style={{ marginLeft: '8px', width: '20px', height: '20px', background: customApplied, border: '1px solid #999' }} />
        ) : null}
      </View>

      {/* 可选规格裁剪（不选 = 保持原图尺寸） */}
      <View style={{ margin: '12px 0' }}>
        <Text>输出尺寸（可选）：</Text>
        <Picker
          mode='selector'
          range={['保持原图尺寸', ...specs.map((s: any) => `${s.name}（${s.note}）`)]}
          value={specIndex < 0 ? 0 : specIndex + 1}
          onChange={(e: any) => {
            const v = Number(e.detail.value);
            setSpecIndex(v === 0 ? -1 : v - 1);
          }}
        >
          <View style={{ color: '#438EDB', padding: '4px 0' }}>
            {specIndex < 0 ? '保持原图尺寸' : `${specs[specIndex].name} ▾`}
          </View>
        </Picker>
      </View>

      <Button className='btn-primary' loading={busy} onClick={process}>
        {busy ? '处理中…' : '选择照片并换底'}
      </Button>

      {msg ? <Text style={{ display: 'block', marginTop: '10px', color: '#666' }}>{msg}</Text> : null}

      {preview ? (
        <View style={{ marginTop: '14px' }}>
          <Image src={preview} style={{ width: '100%', height: '260px' }} mode='aspectFit' />
          {outInfo ? <Text style={{ display: 'block', fontSize: '12px', color: '#888', marginTop: '4px' }}>{outInfo}</Text> : null}
          <Button style={{ marginTop: '8px' }} onClick={save}>
            保存到相册
          </Button>
        </View>
      ) : null}
    </View>
  );
}
