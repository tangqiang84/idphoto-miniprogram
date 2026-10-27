import { View, Text, Button, Image, Picker } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useRef, useState } from 'react';
import {
  requiredConsents, buildConsentRecord,
  segment, composeAndExportImage,
  buildCloudFnAdapter,
  alphaBBox, tightBBox, estimateHeadByShoulder, suitPlacement, suitCompose,
  fitSuitV2, checkComposition, SUIT_REASON,
  measureHeadMetrics,
  planOutput,
  BG, getSpec, getPixelSize, listSpecs,
  DPI_STD, DPI_HD,
  backendLabel,
  withTimeout, IMG_LOAD_TIMEOUT_MS,
} from '../../services';
import { requestPoseKeypoints, encodeCanvasToJpegB64 } from '../../services/poseService';
import { prepareWorkCanvas } from '../../services/pipeline';
import { useImagePicker } from '../../hooks/useImagePicker';
import StepFlow from '../../components/StepFlow';
import CropStep from '../../components/CropStep';
import BeautyStep from '../../components/BeautyStep';
import DpiStep from '../../components/DpiStep';
import { applyBeauty } from '../../core/beauty';
import type { BeautyState } from '../../components/BeautyControl';
import { useConsentGate } from '../../hooks/useConsentGate';

// T3 单独 AI 换装：核心功能（PRD D 章），须三项独立授权（I1/J3：faceLocal+faceCloudEnhance+suitSwap）
// 技术路线（owner 2026-10-23 决策）：端侧贴图合成 MVP —— 自绘透明 PNG 西装模板 + 头肩几何贴合，
// 不依赖云端换装模型；贴合精度有限，换装效果以真机实测为准，正式商用版可替换设计师素材（接口不变）。
// 合规：PRD D2「仅换装不改五官」由端侧实现保证（只覆盖肩颈区域像素，不触碰脸部像素）+
//       D3/AC6 强制五官自检（页面层：未确认不得导出）。
//
// 【2026-10-23 owner 决策】MVP 不设付费档，300/600dpi 两档全部免费（T3 亦开放 600dpi）。
const TOOL = 'T3';

// 【P1 #77】管线步骤定义（与 T1 同序，T3 换装为必选步骤；RC-6/RC-9）
const T3_STEPS = [
  { key: 'crop', label: '裁剪' },
  { key: 'beauty', label: '美颜' },
  { key: 'matting', label: '抠图换底' },
  { key: 'suit', label: '换装' },
  { key: 'precheck', label: '合规预审' },
  { key: 'dpi', label: '输出档位' },
  { key: 'export', label: '导出' },
];

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
  // #70：图片加载加超时硬闸门（真机上 onload/onerror 可能双不触发 → 永久转圈）
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = (e: any) => reject(e || new Error('模板加载失败'));
      img.src = src;
    }),
    IMG_LOAD_TIMEOUT_MS,
    '模板加载超时',
  );
  ctx.drawImage(img, 0, 0, 400, 400);
  const d = ctx.getImageData(0, 0, 400, 400);
  return { data: d.data, w: 400, h: 400 };
}

export default function ToolSuit() {
  const consentItems = requiredConsents(TOOL);
  const [granted, setGranted] = useState<string[]>([]);
  const rec = buildConsentRecord(TOOL, granted);
  // F3（P1）：协议闸门前移到选图入口（run() 内的 rec.ready 保留为兜底第二道）
  const gate = useConsentGate(rec.ready, 'AI 换装');
  const picker = useImagePicker((img, q) =>
    run(img.path, img.width, img.height, { forceCloud: shouldForceCloud(q) }),
  );

  // 背景复杂 + 已授权上云 → 强制走云端真模型（任务 #51：端侧置信高 ≠ 质量好）
  function shouldForceCloud(q: any): boolean {
    if (!q || !Array.isArray(q.tips)) return false;
    const complex = q.tips.some((t: any) => t.code === 'complexbg');
    return complex && granted.includes('faceCloudEnhance');
  }

  const specs = listSpecs();
  const [tplIndex, setTplIndex] = useState(0);
  const [bg, setBg] = useState<BgKey>('blue');
  // R1：换装只针对 specLibrary 现有 9 个标准规格画布 → 规格【必选】，默认一寸。
  // （"保持原图尺寸"选项废止：未定规格就没有物理标尺，西装尺寸只能靠猜，正是四轮失败的病根。）
  const [specIndex, setSpecIndex] = useState(0);
  const [dpi, setDpi] = useState(DPI_STD);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [preview, setPreview] = useState('');
  const [outInfo, setOutInfo] = useState('');
  const [planNote, setPlanNote] = useState('');
  // 【P1 #77】美颜状态（P2.6 步骤，裁剪后、抠图换底前）
  const [beauty, setBeauty] = useState<BeautyState>({ enabled: false, smooth: 0.3, whiten: 0.2, brighten: 0.15 });
  // 【P1 #77】当前管线步骤 / 智能裁切结果
  const [stepIndex, setStepIndex] = useState(-1);
  const [cropInfo, setCropInfo] = useState<any>(null);
  const [selfChecked, setSelfChecked] = useState(false); // AC6/D3：五官自检确认
  // 已处理结果缓存（任务 #50）：换底色时据此**只重跑合成**
  const lastProc = useRef<{
    suited: Uint8ClampedArray; alpha: any; w: number; h: number;
    plan: any; target: any; specIndex: number; dpi: number;
    tplIndex: number; headIsEstimate: boolean;
  } | null>(null);
  // 源图信息：换规格/dpi 时据此自动重跑（用户不必重新选图）
  const lastSrc = useRef<{ path: string; w: number; h: number } | null>(null);

  const toggleConsent = (id: string) => {
    setGranted((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  async function run(
    path: string,
    srcW: number,
    srcH: number,
    opts?: { bgHex?: string | null; specIndex?: number; dpi?: number; forceCloud?: boolean },
  ) {
    // 参数覆盖（任务 #50）：state 异步，链式操作必须显式传值（问题台账 #31 同根）
    const specIdx = opts?.specIndex ?? specIndex;
    const dpiVal = opts?.dpi ?? dpi;
    const bgHex = opts?.bgHex !== undefined ? opts.bgHex : BG[bg];
    if (!rec.ready) {
      Taro.showToast({ title: '请先勾选所需授权（含换装单独授权）', icon: 'none' });
      return;
    }
    setBusy(true);
    setSelfChecked(false);
    setMsg('读取图片…');
    setStepIndex(0); // ① 裁剪
    setPlanNote('');
    // P1：换装被跳过的原因（R1 未选规格 / 非目标构图 / 引擎拒绝）——如实上状态行，不静默
    let suitSkippedReason = '';
    try {
      const anyTaro: any = Taro;
      if (typeof anyTaro.createOffscreenCanvas !== 'function') {
        throw new Error('当前基础库不支持离屏 canvas，请升级基础库到 2.16.1+');
      }

      // 2. 规划输出构图 + 取工作画布像素
      //    【F1（P1 / 台账 #75）】选了规格 → 走共享管线**先裁剪到规格再抠图**
      //    （matting 在最终构图内运行，alpha 噪声不外溢；与 R1「换装锚定规格画布」同向）。
      //    取图已剥离到 useImagePicker（相册 picker.pickAlbum / 拍摄 CameraGuide，PRD A1 引导框）。
      let w: number, h: number;
      let plan: any = null;
      let canvas: any;
      let rgba: Uint8ClampedArray;
      let bgSamples: any = undefined;
      if (specIdx >= 0) {
        const specObj = getSpec(specs[specIdx].id)!;
        const target = getPixelSize(specObj, dpiVal)!;
        const prep = await prepareWorkCanvas({
          path, srcW, srcH, spec: specObj, dpi: dpiVal, target, onMsg: setMsg,
        });
        w = prep.w; h = prep.h; plan = prep.plan; canvas = prep.canvas; rgba = prep.rgba;
        bgSamples = prep.bgSamples;
        setPlanNote(prep.reason || '');
        setCropInfo(prep.crop
          ? {
            auto: true,
            ratioTarget: prep.crop.ratioTarget,
            ratioAchieved: prep.crop.ratioAchieved,
            degraded: prep.crop.degraded,
            degradeReason: prep.crop.degradeReason,
            notes: prep.crop.notes || [],
          }
          : { auto: false, notes: ['未检出人脸，已按画面居中裁剪；建议正对镜头、面部清晰的照片'] });
      } else {
        // 未选规格：沿用旧路径（整图等比缩放，输出保持原图尺寸）
        // —— 是否强制规格仍待 owner 拍板（台账 #81），本版不擅自改变默认值
        const scale = Math.min(1, 800 / Math.max(srcW, srcH));
        w = Math.max(1, Math.round(srcW * scale));
        h = Math.max(1, Math.round(srcH * scale));
        canvas = anyTaro.createOffscreenCanvas({ type: '2d', width: w, height: h });
        const ctx = canvas.getContext('2d');
        const img = canvas.createImage();
        // #70：主图加载加超时硬闸门（同 loadTemplatePixels，真机双不触发 → 永久转圈）
        await withTimeout(
          new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = (e: any) => reject(e || new Error('图片加载失败'));
            img.src = path;
          }),
          IMG_LOAD_TIMEOUT_MS,
          '图片加载超时',
        );
        ctx.drawImage(img, 0, 0, w, h);
        rgba = ctx.getImageData(0, 0, w, h).data;
      }

      // 3.5 【P1 #77 / P2.6】受限美颜：裁剪之后、抠图换底之前（RC-1）
      if (beauty.enabled) {
        setStepIndex(1); // ② 美颜
        try {
          applyBeauty(rgba, w, h, {
            smooth: beauty.smooth,
            whiten: beauty.whiten,
            brighten: beauty.brighten,
          });
        } catch (e) {
          console.warn('[T3] 美颜跳过（合规拦截或异常）:', (e && e.message) || e);
        }
      }

      // 4. 抠图（复用共享链路，置信不足且已授权则上云增强）
      setStepIndex(2); // ③ 抠图换底
      setMsg('抠图处理中…');
      const seg: any = await segment({
        rgba, width: w, height: h,
        bgSamples,
        cloud: { adapter: buildCloudFnAdapter() },
        consents: granted,
        audit: (meta: any) => console.log('[audit]', meta),
        tool: TOOL,
        forceCloud: !!opts?.forceCloud, // 任务 #51：复杂背景强制云端精修
      });

      // 5. 头肩定位（统一走 services/faceService，任务 #4：与 T1/T4 同一套口径）
      setMsg('定位头肩区域…');
      // #69：用 tightBBox 收紧版包围盒——alphaBBox 的 min/max 会被云端 alpha 的零星
      // 噪声前景撑爆（实测 111.jpg 左右两侧背景被判前景 → bbox 满宽），撑爆的 bbox
      // 直接把下游定位全带偏（盖脸/变形/盖不住原衣）
      const bbox = tightBBox(seg.alpha, w, h) || alphaBBox(seg.alpha, w, h);
      if (!bbox) throw new Error('未检测到人像，请换一张正面照片');
      const headRes = await measureHeadMetrics(rgba, w, h, bbox);
      const headIsEstimate = headRes.source === 'estimate';

      // ---- 5.1 L1 姿态信号（P1：posekey 云函数实测双肩点）----
      // 未部署/超时/无人 → 只记原因码，降级到 L2（face）+ 物理标尺，绝不静默造点（#74）。
      setMsg('识别肩线…');
      const faceSig = headRes.ok && headRes.metrics ? {
        chinY: headRes.metrics.chinY,
        crownY: headRes.metrics.crownY,
        headH: headRes.headLengthPx,
        faceCenterX: headRes.metrics.faceCenterX,
        source: headRes.source === 'landmarks' ? 'landmarks' : 'estimate',
      } : null;
      let poseSig: any = null;
      let poseReason: string | null = null;
      const jpegB64 = encodeCanvasToJpegB64(canvas);
      if (jpegB64) {
        const pr = await requestPoseKeypoints({
          imageB64: jpegB64, width: w, height: h,
          region: { x: 0, y: 0, w, h }, canvasW: w, canvasH: h,
        });
        if (pr.ok && pr.pose) poseSig = pr.pose;
        else poseReason = pr.reason;
      } else {
        poseReason = 'posekey:encode_failed';
      }
      console.log('[audit]', {
        stage: 'pose_signal', ok: !!poseSig, reason: poseReason,
        model: poseSig ? poseSig.model : null, latencyMs: poseSig ? poseSig.latencyMs : null,
      });

      // ---- 5.2 非目标构图拒绝（契约 7：全身/多人/横图明确拒绝，不猜着摆）----
      if (!headRes.ok && !poseSig) {
        throw new Error('未检测到人脸，请换一张正面标准证件照');
      }
      const comp = checkComposition({ face: faceSig, pose: poseSig, bbox });
      if (!comp.ok) {
        throw new Error(comp.message + '（' + SUIT_REASON.UNSUPPORTED + '）');
      }

      // 几何审计（#69 + P1）：换装定位三要素落 audit，供批量验收脚本抓取
      console.log('[audit]', {
        stage: 'suit_geometry', source: headRes.source,
        bbox: { x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h },
        headH: headRes.headLengthPx, chinY: headRes.metrics ? headRes.metrics.chinY : null,
        w, h,
      });

      // 6. 换装贴图合成（仅覆盖肩颈前景区，不触碰脸部像素 → PRD D2）
      //    P1：几何改由 suitFitV2 求解（实测信号 + 规格物理标尺）；spec 缺失（未选规格）
      //    时按 R1 不做换装——明确提示，不猜系数、不静默出图。
      setMsg('合成职业装…');
      const tpl = await loadTemplatePixels(SUIT_TEMPLATES[tplIndex].src as any);
      let suited = new Uint8ClampedArray(rgba);
      let fitInfo: any = null;
      const specForFit = specIdx >= 0 ? getSpec(specs[specIdx].id) : null;
      const fit = fitSuitV2({
        spec: specForFit as any,
        canvasW: w,
        canvasH: h,
        face: faceSig,
        pose: poseSig,
        bbox,
      });
      if (!fit.ok) {
        // 未选规格 → R1 范围约束：不换装，如实提示（不阻断出图，用户可选规格后重跑）
        suitSkippedReason = fit.reason === SUIT_REASON.NO_SPEC
          ? '换装需要选择输出规格（R1：换装只针对标准证件照规格）——本次未换装'
          : (fit.message + '（' + fit.reason + '）');
        console.log('[audit]', { stage: 'suit_fit_v2', ok: false, reason: fit.reason, audit: fit.audit });
      } else {
        fitInfo = fit;
        suited = suitCompose(rgba, seg.alpha, w, h, tpl.data, tpl.w, tpl.h, fit.place, fit.rotateDeg);
        console.log('[audit]', Object.assign({ stage: 'suit_fit_v2', ok: true }, fit.audit));
      }

      // 7. 换底合成 + 导出（共享渲染服务，任务 #50）
      setMsg('合成底色…');
      let target: any = null;
      if (specIdx >= 0) target = getPixelSize(getSpec(specs[specIdx].id)!, dpiVal)!;
      const r = await composeAndExportImage({
        rgba: suited,
        alpha: seg.alpha,
        w,
        h,
        bgHex,
        plan: specIdx >= 0 ? plan : null,
        target,
      });

      // 缓存处理结果：换底色时据此**只重跑合成**（不重跑抠图/换装）
      lastProc.current = {
        suited, alpha: seg.alpha, w, h, plan, target,
        specIndex: specIdx, dpi: dpiVal, tplIndex, headIsEstimate,
      };
      lastSrc.current = { path, w: srcW, h: srcH };

      setPreview(r.preview);
      setOutInfo(
        `${r.outW}×${r.outH} · ${SUIT_TEMPLATES[tplIndex].name} · 底色 ${bgHex}` +
        (seg.degraded ? ' · 已降级端侧' : '') +
        (specIdx >= 0 ? ` · ${specs[specIdx].name} @${dpiVal}dpi` : ' · 原图尺寸') +
        ` · ${fitInfo ? `定位 ${fitInfo.source}${fitInfo.basis.shoulder === 'pose' ? '（肩线实测）' : '（物理标尺）'}` : '未换装'}`,
      );
      setMsg(
        (suitSkippedReason ? `${suitSkippedReason}——` : `换装完成（${backendLabel(seg.backend)}`) +
        (!suitSkippedReason && seg.degraded ? `，云端不可用已降级${seg.cloudError ? '：' + String(seg.cloudError).slice(0, 60) : ''}` : '') +
        (suitSkippedReason ? '' : '）——请核对五官后导出') +
        (poseReason && !poseSig ? `（姿态信号：${poseReason}）` : ''),
      );
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

  // AC6/D3：未通过五官自检不得导出；AC1：未确认非镜像照不得导出
  // 换底色 → 只重跑「合成 + 导出」，不重跑抠图/换装（任务 #50）
  async function recompose(nextBgHex: string) {
    const p = lastProc.current;
    if (!p) {
      Taro.showToast({ title: '请先选择照片并处理', icon: 'none' });
      return;
    }
    setBusy(true);
    setMsg('重新合成…');
    try {
      const r = await composeAndExportImage({
        rgba: p.suited,
        alpha: p.alpha,
        w: p.w,
        h: p.h,
        bgHex: nextBgHex,
        plan: p.specIndex >= 0 ? p.plan : null,
        target: p.specIndex >= 0 ? p.target : null,
      });
      setPreview(r.preview);
      setOutInfo(
        `${r.outW}×${r.outH} · ${SUIT_TEMPLATES[p.tplIndex].name} · 底色 ${nextBgHex}` +
        (p.specIndex >= 0 ? ` · ${specs[p.specIndex].name} @${p.dpi}dpi` : ' · 原图尺寸') +
        ` · ${p.headIsEstimate ? '比例估算定位' : '关键点定位'}`,
      );
      setMsg('换装完成（底色已更新）——请核对五官后导出');
    } catch (e: any) {
      setMsg('换底色失败：' + String((e && e.message) || e));
    } finally {
      setBusy(false);
    }
  }

  // 换规格 / 换 dpi → 工作画布与裁剪窗都变，必须整条链路重跑
  function reprocess(opts: { specIndex?: number; dpi?: number }) {
    const src = lastSrc.current;
    if (!src) {
      Taro.showToast({ title: '请先选择照片', icon: 'none' });
      return;
    }
    run(src.path, src.w, src.h, opts);
  }

  async function exportSave() {
    if (!preview) return;
    if (!selfChecked) {
      Taro.showToast({ title: '请先确认五官未被改动', icon: 'none' });
      return;
    }
    if (!picker.mirrorConfirmed) {
      Taro.showToast({ title: '请先确认照片非镜像照', icon: 'none' });
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

      {/* 【P1 #77】管线步骤指示器（RC-6/RC-9：与 T1 同序） */}
      <StepFlow steps={T3_STEPS} current={stepIndex} />
      <Text className='page__hint'>
        上传正面照片，合成职业装后换底导出。仅换装、不改五官；换装需单独授权。
      </Text>

      {/* 授权（默认不勾选，未集齐不启动处理；含换装单独授权 suitSwap；F3：未勾选则选图入口不可点） */}
      <View
        className='consent'
        style={gate.hinted
          ? { border: '2px solid #e07b00', borderRadius: '8px', padding: '10px', background: '#fff8ec' }
          : undefined}
      >
        <Text className='consent__h'>需授权（{granted.length}/{consentItems.length}）</Text>
        {gate.hinted ? (
          <Text style={{ display: 'block', fontSize: '12px', color: '#e07b00', margin: '4px 0 6px' }}>
            请先勾选下列全部授权（含换装单独授权），才能选择照片或拍照（先同意、后收集）
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
                border: on ? '1px solid #438EDB' : (gate.hinted ? '1px solid #e07b00' : '1px solid #ddd'),
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
              onClick={() => {
                setBg(o.key);
                recompose(BG[o.key]); // 任务 #50：换底色即刻重新合成
              }}
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

      {/* 输出尺寸（R1：换装必须锚定标准规格画布，默认一寸）+ 输出档位（dpi） */}
      <View style={{ margin: '12px 0' }}>
        <Text>输出尺寸：</Text>
        <Picker
          mode='selector'
          range={specs.map((s: any) => `${s.name}（${s.note}）`)}
          value={specIndex < 0 ? 0 : specIndex}
          onChange={(e: any) => {
            const nextIdx = Number(e.detail.value);
            setSpecIndex(nextIdx);
            reprocess({ specIndex: nextIdx }); // 任务 #50：换规格自动重跑
          }}
        >
          <View style={{ color: '#438EDB', padding: '4px 0' }}>
            {specIndex < 0 ? '一寸' : `${specs[specIndex].name} ▾`}
          </View>
        </Picker>
        {/* 【P1 #77 / P2.7】输出档位提升为独立步骤屏（含像素不足提示；RC-3/RC-4） */}
        <DpiStep
          specId={specs[specIndex].id}
          specName={specs[specIndex].name}
          dpi={dpi}
          onChange={(d) => {
            setDpi(d);
            reprocess({ dpi: d }); // 任务 #50：换 dpi 自动重跑
          }}
          srcW={lastSrc.current ? lastSrc.current.w : undefined}
          srcH={lastSrc.current ? lastSrc.current.h : undefined}
          workW={lastProc.current ? lastProc.current.w : undefined}
          workH={lastProc.current ? lastProc.current.h : undefined}
        />
      </View>

      {/* 【P1 #77 / P2.5】裁剪步骤屏（比例锁定 + 智能构图结果） */}
      <CropStep
        specName={specs[specIndex].name}
        target={getPixelSize(specs[specIndex].id, dpi)!}
        crop={cropInfo && cropInfo.auto ? cropInfo : null}
      />

      {/* 【P1 #77 / P2.6】美颜步骤屏（裁剪后、抠图换底前；RC-1） */}
      <BeautyStep
        value={beauty}
        onChange={setBeauty}
        onApply={() => {
          const src = lastSrc.current;
          if (src) run(src.path, src.w, src.h);
        }}
      />

      {/* F3（P1 / 台账 #76）：选图前协议闸门 —— 未集齐授权，选图/拍摄入口不可达 */}
      <Button
        className='btn-primary'
        loading={busy}
        disabled={gate.blocked}
        onClick={() => gate.gate(picker.pickAlbum)}
      >
        {busy ? '处理中…' : (gate.blocked ? '请先勾选授权（含换装单独授权）' : '从相册选择')}
      </Button>
      <Button
        className='btn-camera'
        disabled={gate.blocked}
        onClick={() => gate.gate(picker.openCamera)}
      >
        📷 拍摄（引导框）
      </Button>

      {msg ? <Text className='status-line' style={{ display: 'block', marginTop: '10px', color: '#666' }}>{msg}</Text> : null}

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

          {/* AC1 镜像自查（与 T3 五官自检并列，导出前双闸门） */}
          {picker.MirrorCheck}
          <Button
            style={{ marginTop: '10px' }}
            type={selfChecked && picker.mirrorConfirmed ? 'primary' : 'default'}
            onClick={exportSave}
            disabled={!selfChecked || !picker.mirrorConfirmed}
          >
            {!selfChecked ? '请先完成五官自检' : (!picker.mirrorConfirmed ? '请先确认照片非镜像照' : '导出并保存到相册')}
          </Button>
        </View>
      ) : null}

      {/* A1 半透明人脸引导框：拍摄入口（相册走上方 .btn-primary） */}
      {picker.Guide}
      {/* A3 原图质量提示（非阻断，建议性） */}
      {picker.QualityTip}
    </View>
  );
}
