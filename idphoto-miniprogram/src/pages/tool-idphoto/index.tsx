import { View, Text, Button, Image, Picker } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useState } from 'react';
import {
  requiredConsents, buildConsentRecord,
  segment, composite, check,
  buildCloudFnAdapter,
  measureHeadMetrics, ratioWithinWindow,
  planOutput, planWindowOutput, planDetectImage,
  planHeadCrop, targetHeadRatio,
  collectEdgeSamples,
  BG, getSpec, getPixelSize, listSpecs, specLabel,
  DPI_STD, DPI_HD,
} from '../../services';
import { useImagePicker } from '../../hooks/useImagePicker';

// T1 一键证件照：完整链路（真实功能，非占位）
// 选图 → 端侧抠图 →（置信不足且已授权则走 CloudBase 云函数增强）→ 换底
// → 裁剪到规格尺寸 → 导出 → 合规预审 → 保存相册
//
// 隐私合规：授权默认【不勾选】，未集齐授权不启动处理（对应 PRD AC5）。
//
// 【2026-10-23 owner 决策】MVP 不设付费档，300/600dpi 两档全部免费：
//   - 个人主体无法开通微信支付（问题台账 #14）→ 付费档无落地路径 → 暂不上付费档
//   - 600dpi 印刷级同样免费开放，不再作为「付费才给」的能力
//   - 官方报名系统只校验像素+KB+格式，从不校验 dpi 元数据；600dpi 的用途是印刷/冲印
const TOOL = 'T1';

type BgKey = 'white' | 'blue' | 'blueLight' | 'red';

export default function ToolIdPhoto() {
  const consentItems = requiredConsents(TOOL);
  const [granted, setGranted] = useState<string[]>([]);
  const rec = buildConsentRecord(TOOL, granted);
  const picker = useImagePicker((img) => run(img.path, img.width, img.height));

  const specs = listSpecs();
  const [specIndex, setSpecIndex] = useState(0);
  const [dpi, setDpi] = useState(DPI_STD);
  const [bg, setBg] = useState<BgKey>('white');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [preview, setPreview] = useState('');
  const [result, setResult] = useState<any>(null);
  // 头部占比测量结果（PRD B3 / T1-16，任务 #4）：null = 未检测到人脸
  const [headInfo, setHeadInfo] = useState<any>(null);
  // 输出构图提示（如「原图分辨率不足」/「已达处理分辨率上限」）
  const [planNote, setPlanNote] = useState('');
  // 智能裁切信息（任务 #24 / PRD B2）：
  //   auto=false → 未检出人脸，已降级为「按宽高比居中裁剪」（与 #24 前行为一致）
  //   degraded     → 已按占比反解裁剪，但原片构图不足，如实提示（owner 决策：不阻断导出）
  const [cropInfo, setCropInfo] = useState<any>(null);

  const toggleConsent = (id: string) => {
    setGranted((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  async function run(path: string, srcW: number, srcH: number) {
    if (!rec.ready) {
      Taro.showToast({ title: '请先勾选所需授权', icon: 'none' });
      return;
    }
    setBusy(true);
    setMsg('读取图片…');
    setResult(null);
    setHeadInfo(null);
    setPlanNote('');
    setCropInfo(null);
    try {
      const anyTaro: any = Taro;
      if (typeof anyTaro.createOffscreenCanvas !== 'function') {
        throw new Error('当前基础库不支持离屏 canvas，请升级基础库到 2.16.1+');
      }

      // 取图已剥离到 useImagePicker（相册 picker.pickAlbum / 拍摄 CameraGuide，PRD A1 引导框）。
      const spec = getSpec(specs[specIndex].id);
      const target = getPixelSize(spec!, dpi)!;

      // 把一张图片画进离屏 canvas 并取回 RGBA 像素（微信 canvas 通用取像素姿势）
      const loadRgba = async (cw: number, ch: number, draw: (ctx: any, img: any) => void) => {
        const cv = anyTaro.createOffscreenCanvas({ type: '2d', width: cw, height: ch });
        const cx = cv.getContext('2d');
        const im = cv.createImage();
        await new Promise<void>((resolve, reject) => {
          im.onload = () => resolve();
          im.onerror = (e: any) => reject(e || new Error('图片加载失败'));
          im.src = path;
        });
        draw(cx, im);
        const id = cx.getImageData(0, 0, cw, ch);
        return { canvas: cv, ctx: cx, imageData: id, rgba: id.data };
      };

      // 2. 人脸检测（任务 #24 / PRD B2 智能裁切的前置）
      //    检测在【检测用图】上做（长边 ≤ DETECT_EDGE=1200）：人脸关键点需要足够像素细节，
      //    同时避免为检测而绘制全尺寸大图（RGBA 内存 = 长边²×4）。
      //    此处拿到的头顶/下巴/面部中心都是检测用图坐标，需按 1/scale 换算回原图坐标。
      setMsg('识别人脸…');
      const det = planDetectImage(srcW, srcH);
      if (!det) throw new Error('图片尺寸读取失败，请换一张照片');
      const detImg = await loadRgba(det.width, det.height, (cx, im) => {
        cx.drawImage(im, 0, 0, det.width, det.height);
      });
      const fm = await measureHeadMetrics(detImg.rgba, det.width, det.height, null);
      // 换算回原图坐标（检测用图是原图的等比缩放，比例不变）
      const srcMetrics = fm.ok && fm.metrics
        ? {
          ...fm.metrics,
          crownY: fm.metrics.crownY / det.scale,
          chinY: fm.metrics.chinY / det.scale,
          faceCenterX: typeof fm.metrics.faceCenterX === 'number'
            ? fm.metrics.faceCenterX / det.scale
            : undefined,
        }
        : null;

      // 3. 反解裁剪框（按规格头占比区间中值，core/headCrop.js）
      //    检测不可用时 srcMetrics 为 null → 降级为「居中裁剪」，并在页面提示。
      let crop: any = null;
      let plan: any;
      if (srcMetrics) {
        crop = planHeadCrop({
          workW: srcW,
          workH: srcH,
          targetW: target.width,
          targetH: target.height,
          crownY: srcMetrics.crownY,
          chinY: srcMetrics.chinY,
          faceCenterX: srcMetrics.faceCenterX,
          ratioMin: spec!.headHeightRatioMin,
          ratioMax: spec!.headHeightRatioMax,
        });
      }

      if (crop) {
        // 3.1 区域化工作画布：只把「要用到的那块」放大到足够像素，避免成品是放大糊图
        plan = planWindowOutput(srcW, srcH, target.width, target.height, {
          sx: crop.sx, sy: crop.sy, sw: crop.sw, sh: crop.sh,
        });
      }
      if (!plan) {
        // 降级路径：未检出人脸 / 反解失败 → 沿用「按目标宽高比居中裁剪」
        plan = planOutput(srcW, srcH, target.width, target.height);
      }
      if (!plan) throw new Error('图片尺寸读取失败，请换一张照片');

      const w = plan.workW;
      const h = plan.workH;
      setPlanNote(plan.reason || '');
      setCropInfo(crop
        ? {
          auto: true,
          ratioTarget: crop.ratioTarget,
          ratioAchieved: crop.ratioAchieved,
          degraded: crop.degraded,
          degradeReason: crop.degradeReason,
          notes: crop.notes || [],
        }
        : { auto: false, notes: ['未检出人脸，已按画面居中裁剪；建议正对镜头、面部清晰的照片'] });

      // 4. 取工作画布像素
      //    自动裁剪路径：画「裁剪窗 + 余量」这一块（planWindowOutput 已算好源图区域）
      //    降级路径：画整图（planOutput 的工作画布 = 整图等比缩放）
      const work = await loadRgba(w, h, (cx, im) => {
        if (plan.regionX != null) {
          cx.drawImage(im, plan.regionX, plan.regionY, plan.regionW, plan.regionH, 0, 0, w, h);
        } else {
          cx.drawImage(im, 0, 0, w, h);
        }
      });
      const canvas = work.canvas;
      const ctx = work.ctx;
      const imageData = work.imageData;
      const rgba = work.rgba;

      // 4.1 背景色采样集（任务 #24）
      // 经典抠图基线的背景色由「画布四边环带」估计。自动裁剪时工作画布只含
      // 「裁剪窗 + 余量」，四边可能压在头发/肩膀上 → 背景色估计失准。
      // 故在【检测用图】（覆盖整张原图）上采一次注入，行为与整图抠图一致。
      const bgSamples = crop ? collectEdgeSamples(detImg.rgba, det.width, det.height, 2) : undefined;

      // 5. 抠图：端侧优先，置信不足自动走 CloudBase 云函数增强（需 faceCloudEnhance 授权）
      setMsg('抠图处理中…');
      const seg: any = await segment({
        rgba,
        width: w,
        height: h,
        bgSamples,
        cloud: { adapter: buildCloudFnAdapter() },
        consents: granted,
        audit: (meta: any) => console.log('[audit]', meta),
        tool: TOOL,
      });

      // 6. 换底合成
      setMsg('合成底色…');
      const composed = composite(rgba, seg.alpha, w, h, BG[bg]);

      // 7. 裁剪缩放到目标规格尺寸并导出
      // 注：不使用 createImageData —— 微信部分基础库对它报
      // "Value is not of type 'long'"。改为复用第 4 步 getImageData 返回的
      // ImageData 直接写回工作 canvas，再经 drawImage 裁剪缩放到目标尺寸。
      imageData.data.set(composed);
      ctx.putImageData(imageData, 0, 0);

      const outCanvas = anyTaro.createOffscreenCanvas({
        type: '2d',
        width: target.width,
        height: target.height,
      });
      const octx = outCanvas.getContext('2d');
      // 裁剪窗口：自动裁剪 = 按头占比反解的窗口；降级 = 居中窗口（三端口径一致，均由 core/compose.js 产出）
      const sx = plan.sx, sy = plan.sy, sw = plan.sw, sh = plan.sh;
      octx.drawImage(canvas, sx, sy, sw, sh, 0, 0, target.width, target.height);

      // 7.1 头部占比（PRD B3 / 功能清单 T1-16，任务 #4；任务 #24 后口径由「反解目标」+「实测复核」双报）
      // 口径：在【裁剪窗口】坐标系中测量 —— 头长 ÷ 成品图高，与审核员在成品图上量的口径一致。
      // 复用第 2 步已测得的人脸度量按窗口换算，【不重复调用平台检测】：
      // 真机上每次人脸检测是百毫秒级开销，且二次调用可能失败 → 占比忽有忽无。
      // 坐标换算：检测用图坐标 → 原图坐标（÷det.scale）→ 工作图坐标（×plan.scale）。
      setMsg('测量头部占比…');
      let headRatio: number | null = null;
      let headExtra: any = null;
      if (srcMetrics) {
        const wm = {
          ...srcMetrics,
          crownY: srcMetrics.crownY * plan.scale,
          chinY: srcMetrics.chinY * plan.scale,
        };
        const r = ratioWithinWindow(wm, { x: sx, y: sy, width: sw, height: sh });
        if (r) {
          headRatio = r.ratio;
          headExtra = { source: srcMetrics.source, quality: srcMetrics.quality, notes: srcMetrics.notes || [] };
          if (r.clamped) headExtra.notes = [...headExtra.notes, '头顶或下巴被裁切，占比按成品图可见部分计算'];
        }
      }
      // 未检出人脸时降级为「未检测」，其余 4 项照常预审（不因一项缺失而阻断整张图）
      setHeadInfo(headRatio != null ? { ratio: headRatio, ...headExtra } : null);

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

      // 8. 合规预审
      const fs = Taro.getFileSystemManager();
      const fileInfo: any = await new Promise((resolve, reject) => {
        fs.getFileInfo({ filePath: exported.tempFilePath, success: resolve, fail: reject });
      });
      const fileKb = Math.round(fileInfo.size / 1024);
      const cr = check(specs[specIndex].id, {
        widthPx: target.width,
        heightPx: target.height,
        dpi,
        fileKb,
        bg,
        // 头部占比：仅在成功测量时传入（未检测则跳过该项，其余 4 项照常判定）
        headHeightRatio: headRatio != null ? headRatio : undefined,
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
          range={specs.map((s: any) => specLabel(s.id, dpi))}
          value={specIndex}
          onChange={(e: any) => setSpecIndex(Number(e.detail.value))}
        >
          <View style={{ color: '#438EDB', padding: '4px 0' }}>{specs[specIndex].name} ▾</View>
        </Picker>
        <Text style={{ display: 'block', fontSize: '11px', color: '#999', marginTop: '2px' }}>
          {specs[specIndex].source}
        </Text>
        {/* 输出档位（dpi）：300/600 两档全部免费（owner 2026-10-23 决策，不设付费档） */}
        <Text style={{ display: 'block', marginTop: '8px' }}>输出档位：</Text>
        <View style={{ display: 'flex', flexDirection: 'row', marginTop: '4px' }}>
          {[
            { dpi: DPI_STD, label: '标准 300dpi', hint: '网上报名通用' },
            { dpi: DPI_HD, label: '印刷 600dpi', hint: '冲印/大幅面' },
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
        {/* 规格速览芯片：直接点选 + 展示官方像素（2026-10-23 规格数值裁决后新增） */}
        <View className='spec-chips'>
          {specs.map((s: any, i: number) => {
            const px = getPixelSize(s.id, dpi)!;
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

      <Button className='btn-primary' loading={busy} onClick={picker.pickAlbum}>
        {busy ? '处理中…' : '从相册选择'}
      </Button>
      <Button className='btn-camera' onClick={picker.openCamera}>
        📷 拍摄（引导框）
      </Button>

      {msg ? <Text style={{ display: 'block', marginTop: '10px', color: '#666' }}>{msg}</Text> : null}

      {/* 智能裁切状态（任务 #24 / PRD B2）：按规格头占比自动定位裁剪框 */}
      {cropInfo ? (
        <View className='crop-info'>
          <Text style={{ fontSize: '12px', color: cropInfo.auto ? '#2b6cb0' : '#999' }}>
            {cropInfo.auto
              ? `智能裁切：已按目标头部占比 ${(cropInfo.ratioTarget * 100).toFixed(0)}% 自动构图`
              : '智能裁切：未检出人脸，已按画面居中裁剪'}
          </Text>
          {cropInfo.notes && cropInfo.notes.length ? (
            <Text
              className='crop-info__warn'
              style={{ display: 'block', fontSize: '12px', color: cropInfo.degraded ? '#c62828' : '#e07b00', marginTop: '4px' }}
            >
              {cropInfo.degraded ? '⚠ ' : ''}
              {cropInfo.notes.join('；')}
            </Text>
          ) : null}
        </View>
      ) : null}

      {/* 输出构图提示（分辨率不足 / 达到处理上限 → 如实告知，不静默输出糊图） */}
      {planNote ? (
        <Text style={{ display: 'block', fontSize: '12px', color: '#e07b00', marginTop: '6px' }}>
          {planNote}
        </Text>
      ) : null}

      {preview ? (
        <View style={{ marginTop: '14px' }}>
          <Image src={preview} style={{ width: '100%', height: '260px' }} mode='aspectFit' />
          {/* 头部占比（PRD B3）：实测值 + 来源标注；未检测时说明原因 */}
          {headInfo ? (
            <View style={{ padding: '8px 0' }}>
              <Text style={{ fontSize: '13px', color: '#333' }}>
                头部占比{' '}
                {headInfo.ratio != null
                  ? `${(headInfo.ratio * 100).toFixed(0)}%`
                  : '未检测到'}
                {headInfo.source === 'estimate' ? '（估算）' : ''}
                {headInfo.quality === 'low' ? '（可信度低）' : ''}
              </Text>
              {headInfo.notes && headInfo.notes.length ? (
                <Text style={{ display: 'block', fontSize: '11px', color: '#999', marginTop: '2px' }}>
                  {headInfo.notes.join('；')}
                </Text>
              ) : null}
            </View>
          ) : (
            <Text style={{ display: 'block', fontSize: '12px', color: '#999', marginTop: '6px' }}>
              头部占比：未检测到人脸，当前环境不支持人脸检测
            </Text>
          )}
          {/* AC1 镜像自查（导出前勾选，未勾选禁用保存） */}
          {picker.MirrorCheck}
          <Button style={{ marginTop: '8px' }} onClick={save} disabled={!picker.mirrorConfirmed}>
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
              <Text
                className={c.level === 'advisory' ? 'result__warn' : (c.pass ? 'result__ok' : 'result__bad')}
                style={{ color: c.level === 'advisory' ? '#e07b00' : (c.pass ? '#2e7d32' : '#c62828') }}
              >
                {c.level === 'advisory' ? 'ⓘ' : (c.pass ? '✓' : '✗')} {c.label}
                {c.level === 'advisory' ? '（提示项）' : ''}
              </Text>
              <Text style={{ display: 'block', fontSize: '12px', color: '#888' }}>{c.detail}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {/* A1 半透明人脸引导框：拍摄入口（相册走上方 .btn-primary） */}
      {picker.Guide}
      {/* A3 原图质量提示（非阻断，建议性） */}
      {picker.QualityTip}
    </View>
  );
}
