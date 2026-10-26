import { View, Text, Button, Image, Picker } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useState } from 'react';
import {
  requiredConsents, buildConsentRecord,
  segment, composite,
  buildCloudFnAdapter,
  alphaBBox, suitPlacement, suitCompose,
  measureHeadMetrics,
  planOutput,
  BG, getSpec, getPixelSize, listSpecs,
  DPI_STD, DPI_HD,
} from '../../services';
import { useImagePicker } from '../../hooks/useImagePicker';

// T3 单独 AI 换装：核心功能（PRD D 章），须三项独立授权（I1/J3：faceLocal+faceCloudEnhance+suitSwap）
// 技术路线（owner 2026-10-23 决策）：端侧贴图合成 MVP —— 自绘透明 PNG 西装模板 + 头肩几何贴合，
// 不依赖云端换装模型；贴合精度有限，换装效果以真机实测为准，正式商用版可替换设计师素材（接口不变）。
// 合规：PRD D2「仅换装不改五官」由端侧实现保证（只覆盖肩颈区域像素，不触碰脸部像素）+
//       D3/AC6 强制五官自检（页面层：未确认不得导出）。
//
// 【2026-10-23 owner 决策】MVP 不设付费档，300/600dpi 两档全部免费（T3 亦开放 600dpi）。
const TOOL = 'T3';

// 自绘模板（AI 自绘，自有版权，PRD Q3 合规）：透明 PNG，领口居中于顶部
const SUIT_TEMPLATES = [
  { id: 'black', name: '黑西装', src: require('../../assets/suits/suit_black.png') },
  { id: 'navy', name: '深蓝西装', src: require('../../assets/suits/suit_navy.png') },
  { id: 'gray', name: '灰西装', src: require('../../assets/suits/suit_gray.png') },
];

type BgKey = 'white' | 'blue' | 'blueLight' | 'red' | 'gray';

// 读模板 PNG → RGBA 像素（离屏 canvas）
async function loadTemplatePixels(src: string): Promise<{ data: Uint8ClampedArray; w: number; h: number }> {
  const anyTaro: any = Taro;
  const canvas = anyTaro.createOffscreenCanvas({ type: '2d', width: 400, height: 400 });
  const ctx = canvas.getContext('2d');
  const img = canvas.createImage();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = (e: any) => reject(e || new Error('模板加载失败'));
    img.src = src;
  });
  ctx.drawImage(img, 0, 0, 400, 400);
  const d = ctx.getImageData(0, 0, 400, 400);
  return { data: d.data, w: 400, h: 400 };
}

export default function ToolSuit() {
  const consentItems = requiredConsents(TOOL);
  const [granted, setGranted] = useState<string[]>([]);
  const rec = buildConsentRecord(TOOL, granted);
  const picker = useImagePicker((img) => run(img.path, img.width, img.height));

  const specs = listSpecs();
  const [tplIndex, setTplIndex] = useState(0);
  const [bg, setBg] = useState<BgKey>('blue');
  const [specIndex, setSpecIndex] = useState(-1); // -1 = 保持原图尺寸（不裁剪）
  const [dpi, setDpi] = useState(DPI_STD);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [preview, setPreview] = useState('');
  const [outInfo, setOutInfo] = useState('');
  const [planNote, setPlanNote] = useState('');
  const [selfChecked, setSelfChecked] = useState(false); // AC6/D3：五官自检确认

  const toggleConsent = (id: string) => {
    setGranted((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  async function run(path: string, srcW: number, srcH: number) {
    if (!rec.ready) {
      Taro.showToast({ title: '请先勾选所需授权（含换装单独授权）', icon: 'none' });
      return;
    }
    setBusy(true);
    setSelfChecked(false);
    setMsg('读取图片…');
    setPlanNote('');
    try {
      const anyTaro: any = Taro;
      if (typeof anyTaro.createOffscreenCanvas !== 'function') {
        throw new Error('当前基础库不支持离屏 canvas，请升级基础库到 2.16.1+');
      }

      // 2. 规划输出构图（选规格时按目标像素动态提升工作图，含 600dpi）
      //    取图已剥离到 useImagePicker（相册 picker.pickAlbum / 拍摄 CameraGuide，PRD A1 引导框）。
      let w: number, h: number;
      let plan: any = null;
      if (specIndex >= 0) {
        const target = getPixelSize(getSpec(specs[specIndex].id)!, dpi)!;
        plan = planOutput(srcW, srcH, target.width, target.height);
        if (!plan) throw new Error('图片尺寸读取失败，请换一张照片');
        w = plan.workW;
        h = plan.workH;
        setPlanNote(plan.reason || '');
      } else {
        const scale = Math.min(1, 800 / Math.max(srcW, srcH));
        w = Math.max(1, Math.round(srcW * scale));
        h = Math.max(1, Math.round(srcH * scale));
      }

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

      // 4. 抠图（复用共享链路，置信不足且已授权则上云增强）
      setMsg('抠图处理中…');
      const seg: any = await segment({
        rgba, width: w, height: h,
        cloud: { adapter: buildCloudFnAdapter() },
        consents: granted,
        audit: (meta: any) => console.log('[audit]', meta),
        tool: TOOL,
      });

      // 5. 头肩定位（统一走 services/faceService，任务 #4：与 T1/T4 同一套口径）
      setMsg('定位头肩区域…');
      const bbox = alphaBBox(seg.alpha, w, h);
      if (!bbox) throw new Error('未检测到人像，请换一张正面照片');
      const headRes = await measureHeadMetrics(rgba, w, h, bbox);
      if (!headRes.ok || !headRes.headLengthPx) {
        throw new Error('未检测到人脸，请换一张正面照片');
      }
      const headH = headRes.headLengthPx;
      // 用局部变量而非 state：setState 是异步的，同一函数内后续读取 state 拿到的是旧值
      // （原代码即有此隐患：setOutInfo 里的 headApprox 恒为初始值 null）
      const headIsEstimate = headRes.source === 'estimate';

      // 6. 换装贴图合成（仅覆盖肩颈前景区，不触碰脸部像素 → PRD D2）
      setMsg('合成职业装…');
      const tpl = await loadTemplatePixels(SUIT_TEMPLATES[tplIndex].src as any);
      const place = suitPlacement(bbox, headH);
      const suited = suitCompose(rgba, seg.alpha, w, h, tpl.data, tpl.w, tpl.h, place);

      // 7. 换底合成 + 写回工作 canvas
      setMsg('合成底色…');
      const composed = composite(suited, seg.alpha, w, h, BG[bg]);
      imageData.data.set(composed);
      ctx.putImageData(imageData, 0, 0);

      // 8. 导出（原图尺寸；选了规格则裁剪到该规格，含 600dpi）
      let outW = w, outH = h;
      let outCanvas = canvas;
      if (specIndex >= 0 && plan) {
        const target = getPixelSize(getSpec(specs[specIndex].id)!, dpi)!;
        outCanvas = anyTaro.createOffscreenCanvas({ type: '2d', width: target.width, height: target.height });
        const octx = outCanvas.getContext('2d');
        octx.drawImage(canvas, plan.sx, plan.sy, plan.sw, plan.sh, 0, 0, target.width, target.height);
        outW = target.width;
        outH = target.height;
      }
      const exported: any = await Taro.canvasToTempFilePath({
        canvas: outCanvas, x: 0, y: 0, width: outW, height: outH,
        destWidth: outW, destHeight: outH, fileType: 'jpg', quality: 0.95,
      });
      setPreview(exported.tempFilePath);
      setOutInfo(
        `${outW}×${outH} · ${SUIT_TEMPLATES[tplIndex].name} · 底色 ${BG[bg]}` +
        (seg.degraded ? ' · 已降级端侧' : '') +
        (specIndex >= 0 ? ` · ${specs[specIndex].name} @${dpi}dpi` : ' · 原图尺寸') +
        ` · ${headIsEstimate ? '比例估算定位' : '关键点定位'}`,
      );
      setMsg(`换装完成（${seg.backend}）——请核对五官后导出`);
    } catch (e: any) {
      const m = String((e && e.message) || e);
      if (m.startsWith('AC5')) {
        setMsg('该图端侧质量不足，需「上云增强」授权才能处理');
      } else {
        setMsg('处理失败：' + m);
      }
      console.error('[T3]', e);
    } finally {
      setBusy(false);
    }
  }

  // AC6/D3：未通过五官自检不得导出
  async function exportSave() {
    if (!preview || !selfChecked) {
      Taro.showToast({ title: '请先确认五官未被改动', icon: 'none' });
      return;
    }
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
    { key: 'gray', label: '灰底', color: BG.gray },
  ];

  return (
    <View className='page'>
      <Text className='page__title'>AI 换装</Text>
      <Text className='page__hint'>
        上传正面照片，合成职业装后换底导出。仅换装、不改五官；换装需单独授权。
      </Text>

      {/* 授权（默认不勾选，未集齐不启动处理；含换装单独授权 suitSwap） */}
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

      {/* 职业装模板（自绘素材，AI 自绘自有版权，PRD Q3 合规） */}
      <View style={{ margin: '12px 0' }}>
        <Text>职业装模板：</Text>
        <View style={{ display: 'flex', flexDirection: 'row', marginTop: '6px' }}>
          {SUIT_TEMPLATES.map((t, i) => (
            <View
              key={t.id}
              onClick={() => setTplIndex(i)}
              style={{
                flex: 1,
                marginRight: i < SUIT_TEMPLATES.length - 1 ? '8px' : 0,
                padding: '8px 4px',
                borderRadius: '6px',
                textAlign: 'center',
                border: tplIndex === i ? '2px solid #333' : '1px solid #ccc',
                background: tplIndex === i ? '#eef5fd' : '#fff',
              }}
            >
              <Image src={t.src as any} style={{ width: '48px', height: '48px' }} mode='aspectFit' />
              <Text style={{ display: 'block', fontSize: '12px', marginTop: '2px' }}>{t.name}</Text>
            </View>
          ))}
        </View>
      </View>

      {/* 底色 */}
      <View style={{ margin: '12px 0' }}>
        <Text>底色：</Text>
        <View style={{ display: 'flex', flexDirection: 'row', marginTop: '6px' }}>
          {bgOptions.map((o) => (
            <View
              key={o.key}
              onClick={() => setBg(o.key)}
              style={{
                padding: '8px 14px',
                marginRight: '8px',
                borderRadius: '6px',
                background: o.color,
                color: o.key === 'white' || o.key === 'gray' ? '#333' : '#fff',
                border: bg === o.key ? '2px solid #333' : '1px solid #ccc',
              }}
            >
              <Text>{o.label}</Text>
            </View>
          ))}
        </View>
      </View>

      {/* 输出尺寸（可选规格）+ 输出档位（dpi） */}
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
        {/* 输出档位（dpi）：300/600 两档全部免费（owner 2026-10-23 决策，不设付费档） */}
        {specIndex >= 0 ? (
          <View style={{ marginTop: '8px' }}>
            <Text>输出档位：</Text>
            <View style={{ display: 'flex', flexDirection: 'row', marginTop: '4px' }}>
              {[
                { dpi: DPI_STD, label: '标准 300dpi' },
                { dpi: DPI_HD, label: '印刷 600dpi' },
              ].map((o) => {
                const on = dpi === o.dpi;
                return (
                  <View
                    key={o.dpi}
                    className={on ? 'dpi-opt dpi-opt--on' : 'dpi-opt'}
                    onClick={() => setDpi(o.dpi)}
                    style={{
                      padding: '6px 12px',
                      marginRight: '8px',
                      borderRadius: '6px',
                      border: on ? '2px solid #438EDB' : '1px solid #ccc',
                      background: on ? '#eef5fd' : '#fff',
                    }}
                  >
                    <Text style={{ fontSize: '13px', color: on ? '#2b6cb0' : '#666' }}>{o.label}</Text>
                  </View>
                );
              })}
            </View>
            <Text style={{ display: 'block', fontSize: '11px', color: '#999', marginTop: '2px' }}>
              两档均免费无水印。600dpi 像素翻倍、体积约为 300dpi 的 2~4 倍，报名系统通常只收 300dpi。
            </Text>
          </View>
        ) : null}
      </View>

      <Button className='btn-primary' loading={busy} onClick={picker.pickAlbum}>
        {busy ? '处理中…' : '从相册选择'}
      </Button>
      <Button className='btn-camera' onClick={picker.openCamera}>
        📷 拍摄（引导框）
      </Button>

      {msg ? <Text style={{ display: 'block', marginTop: '10px', color: '#666' }}>{msg}</Text> : null}

      {/* 输出构图提示（分辨率不足 / 达到处理上限 → 如实告知） */}
      {planNote ? (
        <Text style={{ display: 'block', fontSize: '12px', color: '#e07b00', marginTop: '6px' }}>
          {planNote}
        </Text>
      ) : null}

      {preview ? (
        <View style={{ marginTop: '14px' }}>
          <Image src={preview} style={{ width: '100%', height: '260px' }} mode='aspectFit' />
          {outInfo ? <Text style={{ display: 'block', fontSize: '12px', color: '#888', marginTop: '4px' }}>{outInfo}</Text> : null}

          {/* D3/AC6 强制五官自检：未确认不得导出 */}
          <View
            className='selfcheck'
            onClick={() => setSelfChecked(!selfChecked)}
            style={{
              marginTop: '12px',
              padding: '10px',
              borderRadius: '6px',
              border: selfChecked ? '1px solid #438EDB' : '1px solid #ddd',
              background: selfChecked ? '#eef5fd' : '#fff',
            }}
          >
            <Text style={{ fontWeight: 'bold' }}>{selfChecked ? '☑ ' : '☐ '}五官自检（PRD D3 / AC6）</Text>
            <Text style={{ display: 'block', fontSize: '12px', color: '#666', marginTop: '4px' }}>
              请仔细核对：换装后的照片五官未被改动。端侧合成只覆盖肩颈区域，理论上不触碰脸部像素；如发现五官异常请勿导出，重新拍摄或换模板。未确认自检无法导出。
            </Text>
          </View>

          <Button
            style={{ marginTop: '10px' }}
            type={selfChecked ? 'primary' : 'default'}
            onClick={exportSave}
          >
            {selfChecked ? '导出并保存到相册' : '请先完成五官自检'}
          </Button>
        </View>
      ) : null}

      {/* A1 半透明人脸引导框：拍摄入口（相册走上方 .btn-primary） */}
      {picker.Guide}
    </View>
  );
}
