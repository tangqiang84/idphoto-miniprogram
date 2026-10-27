import { View, Text, Button, Image, Picker, Input } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useRef, useState } from 'react';
import {
  requiredConsents, buildConsentRecord,
  segment, composeAndExportImage,
  buildCloudFnAdapter,
  planOutput,
  BG, getSpec, getPixelSize, listSpecs,
  DPI_STD, DPI_HD, backendLabel,
} from '../../services';
import { useImagePicker } from '../../hooks/useImagePicker';
import StepFlow from '../../components/StepFlow';
import CropStep from '../../components/CropStep';
import BeautyStep from '../../components/BeautyStep';
import DpiStep from '../../components/DpiStep';
import { applyBeauty } from '../../core/beauty';
import type { BeautyState } from '../../components/BeautyControl';
import { useConsentGate } from '../../hooks/useConsentGate';
import { prepareWorkCanvas } from '../../services/pipeline';

// T2 单独换底色：已有照片只换底（真实功能，非占位）
// 选图 → 端侧抠图 →（置信不足且已授权则走 CloudBase 云函数增强）→ 换底
// → 可选规格裁剪（不选保持原图尺寸）→ 导出（纯色 JPG / 透明底 PNG）→ 保存相册
//
// 与 T1 的差异（PRD J2）：不强制规格、不做合规预审。
// 功能范围（PRD C 章，2026-10-23 与 owner 确认）：四色底 + 自定义 HEX 色值 + 透明底 PNG；渐变底暂缓。
// 隐私合规：授权默认【不勾选】，未集齐授权不启动处理（对应 PRD AC5）。
//
// 【2026-10-23 owner 决策】MVP 不设付费档，300/600dpi 两档全部免费（T2 亦开放 600dpi）。
//
// 【任务 #50，2026-10-27 真机反馈修正】此前「底色/规格/dpi」只改 state，**成品不跟着变**：
//   选完照片再点「标准深蓝」，导出的仍是白底（#FFFFFF），用户必须重新选一次图才生效。
// 现在：换底色 → 只重跑「合成 + 导出」（秒级，不重跑抠图）；换规格/dpi → 自动重跑整条链路。
const TOOL = 'T2';

// 【P1 #77】管线步骤定义（与 T1 同序，T2 无换装步骤；RC-5/RC-9）
const T2_STEPS = [
  { key: 'crop', label: '裁剪' },
  { key: 'beauty', label: '美颜' },
  { key: 'matting', label: '抠图换底' },
  { key: 'precheck', label: '合规预审' },
  { key: 'dpi', label: '输出档位' },
  { key: 'export', label: '导出' },
];

type BgKey = 'white' | 'blue' | 'blueLight' | 'red' | 'gray';

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
  // F3（P1）：协议闸门前移到选图入口（run() 内的 rec.ready 保留为兜底第二道）
  const gate = useConsentGate(rec.ready, '换底色');
  const picker = useImagePicker((img, q) =>
    run(img.path, img.width, img.height, { forceCloud: shouldForceCloud(q) }),
  );

  const specs = listSpecs();
  const [specIndex, setSpecIndex] = useState(-1); // -1 = 保持原图尺寸（不裁剪）
  const [dpi, setDpi] = useState(DPI_STD);
  const [bg, setBg] = useState<BgKey>('white');
  const [useTransparent, setUseTransparent] = useState(false);
  const [customHex, setCustomHex] = useState('');
  const [customApplied, setCustomApplied] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [preview, setPreview] = useState('');
  const [outInfo, setOutInfo] = useState('');
  const [planNote, setPlanNote] = useState('');
  // 【P1 #77】美颜状态（P2.6 步骤，裁剪后、抠图换底前）
  const [beauty, setBeauty] = useState<BeautyState>({ enabled: false, smooth: 0.3, whiten: 0.2, brighten: 0.15 });
  // 【P1 #77】当前管线步骤
  const [stepIndex, setStepIndex] = useState(-1);
  // 【P1 #77】智能裁切结果（供 P2.5 裁剪步骤屏展示）
  const [cropInfo, setCropInfo] = useState<any>(null);
  // 【P2.5 交互式裁剪】用户手动选取的裁剪窗（原图像素坐标）
  const [cropWindow, setCropWindow] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  // 已处理结果缓存（任务 #50）：换底色时据此**只重跑合成**，不重跑抠图
  const lastProc = useRef<{
    rgba: Uint8ClampedArray; alpha: any; w: number; h: number;
    srcW: number; srcH: number; specIndex: number; dpi: number;
  } | null>(null);
  // 源图信息：换规格/dpi 时据此自动重跑整条链路（用户不必重新选图）
  const lastSrc = useRef<{ path: string; w: number; h: number } | null>(null);

  // 背景复杂 + 已授权上云 → 强制走云端真模型（任务 #51：端侧置信高 ≠ 质量好）
  function shouldForceCloud(q: any): boolean {
    if (!q || !Array.isArray(q.tips)) return false;
    const complex = q.tips.some((t: any) => t.code === 'complexbg');
    return complex && granted.includes('faceCloudEnhance');
  }

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
    recompose(hex, false); // 任务 #50：应用即刻重新合成，不需重新选图
  }

  async function run(
    path: string,
    srcW: number,
    srcH: number,
    opts?: { bgHex?: string | null; transparent?: boolean; specIndex?: number; dpi?: number; forceCloud?: boolean;
          cropWindow?: { x: number; y: number; w: number; h: number } | null },
  ) {
    if (!rec.ready) {
      Taro.showToast({ title: '请先勾选所需授权', icon: 'none' });
      return;
    }
    // 参数覆盖：state 更新是异步的，链式操作（改底色/规格后自动重跑）必须显式传值，
    // 否则会用到旧值（问题台账 #31 同根）
    const specIdx = opts?.specIndex ?? specIndex;
    const dpiVal = opts?.dpi ?? dpi;
    const transparent = opts?.transparent ?? useTransparent;
    const bgHex = opts?.bgHex !== undefined
      ? opts.bgHex
      : (transparent ? null : (customApplied || BG[bg]));
    if (!transparent && !bgHex) {
      Taro.showToast({ title: '请先选择底色', icon: 'none' });
      return;
    }
    setBusy(true);
    setMsg('读取图片…');
    setStepIndex(0); // ① 裁剪
    setPlanNote('');
    try {
      const anyTaro: any = Taro;
      if (typeof anyTaro.createOffscreenCanvas !== 'function') {
        throw new Error('当前基础库不支持离屏 canvas，请升级基础库到 2.16.1+');
      }

      // 2. 规划输出构图
      //    选了规格 → 按目标像素（含 600dpi）动态规划工作图与裁剪窗口；
      //    未选规格（保持原图尺寸）→ 工作图长边上限 800px（端侧抠图性能保护）。
      //    取图已剥离到 useImagePicker：相册 picker.pickAlbum / 拍摄 CameraGuide，
      //    本函数只接收 path + 尺寸（PRD A1 引导框在拍摄路径叠加）。
      let w: number, h: number;
      let plan: any = null;
      let target: any = null;
      let canvas: any;
      let rgba: Uint8ClampedArray;
      let bgSamples: any = undefined;
      if (specIdx >= 0) {
        // 【F1（P1 / 台账 #75）】选了规格 → 共享管线**先裁剪到规格再抠图**（与 T1/T3 同一份实现）
        const specObj = getSpec(specs[specIdx].id)!;
        target = getPixelSize(specObj, dpiVal)!;
        const prep = await prepareWorkCanvas({
          path, srcW, srcH, spec: specObj, dpi: dpiVal, target, onMsg: setMsg,
          cropWindow: opts?.cropWindow ?? null,
        });
        w = prep.w; h = prep.h; plan = prep.plan; canvas = prep.canvas; rgba = prep.rgba;
        bgSamples = prep.bgSamples;
        setPlanNote(prep.reason || '');
        setCropInfo(prep.crop
          ? {
            auto: true,
            // 【P2.5】带上裁剪窗坐标：交互裁剪屏要拿它当**系统建议的初始框**
            sx: prep.crop.sx, sy: prep.crop.sy, sw: prep.crop.sw, sh: prep.crop.sh,
            ratioTarget: prep.crop.ratioTarget,
            ratioAchieved: prep.crop.ratioAchieved,
            degraded: prep.crop.degraded,
            degradeReason: prep.crop.degradeReason,
            notes: prep.crop.notes || [],
          }
          : { auto: false, notes: ['未检出人脸，已按画面居中裁剪；建议正对镜头、面部清晰的照片'] });
      } else {
        // 未选规格（保持原图尺寸）→ 工作图长边上限 800px（端侧抠图性能保护）
        // —— 是否强制规格仍待 owner 拍板（台账 #81），本版保留该选项
        const scale = Math.min(1, 800 / Math.max(srcW, srcH));
        w = Math.max(1, Math.round(srcW * scale));
        h = Math.max(1, Math.round(srcH * scale));
        canvas = anyTaro.createOffscreenCanvas({ type: '2d', width: w, height: h });
        const ctx = canvas.getContext('2d');
        const img = canvas.createImage();
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = (e: any) => reject(e || new Error('图片加载失败'));
          img.src = path;
        });
        ctx.drawImage(img, 0, 0, w, h);
        rgba = ctx.getImageData(0, 0, w, h).data;
      }

      // 3.5 【P1 #77 / P2.6】受限美颜：裁剪之后、抠图换底之前（RC-1）
      //     合规模式由 core/beauty.js 的 assertCompliance 硬拦截（禁改五官），异常静默跳过不阻断主流程。
      if (beauty.enabled) {
        setStepIndex(1); // ② 美颜
        try {
          applyBeauty(rgba, w, h, {
            smooth: beauty.smooth,
            whiten: beauty.whiten,
            brighten: beauty.brighten,
          });
        } catch (e) {
          console.warn('[T2] 美颜跳过（合规拦截或异常）:', (e && e.message) || e);
        }
      }

      // 4. 抠图：端侧优先，置信不足自动走 CloudBase 云函数增强（需 faceCloudEnhance 授权）
      setStepIndex(2); // ③ 抠图换底
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
        forceCloud: !!opts?.forceCloud, // 任务 #51：复杂背景强制云端精修
      });

      // 5. 换底合成 + 导出（共享渲染服务，任务 #50）
      setMsg(transparent ? '合成透明底…' : '合成底色…');
      const r = await composeAndExportImage({
        rgba,
        alpha: seg.alpha,
        w,
        h,
        bgHex: transparent ? null : bgHex,
        plan: specIdx >= 0 ? plan : null,
        target: specIdx >= 0 ? target : null,
      });

      // 缓存处理结果：换底色时据此**只重跑合成**（不重跑抠图）
      lastProc.current = {
        rgba, alpha: seg.alpha, w, h, plan, target,
        specIndex: specIdx, dpi: dpiVal, srcW, srcH,
      };
      lastSrc.current = { path, w: srcW, h: srcH };

      setPreview(r.preview);
      setOutInfo(
        `${r.outW}×${r.outH} · ${transparent ? '透明底 PNG' : `底色 ${bgHex} JPG`}` +
        (seg.degraded ? ' · 已降级端侧' : '') +
        (specIdx >= 0 ? ` · ${specs[specIdx].name} @${dpiVal}dpi` : ' · 原图尺寸'),
      );
      setMsg(`完成（${backendLabel(seg.backend)}${seg.degraded ? `，云端不可用已降级${seg.cloudError ? '：' + String(seg.cloudError).slice(0, 60) : ''}` : ''}）`);
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

  // 换底色 → 只重跑「合成 + 导出」，不重跑抠图（任务 #50）
  // 规格/dpi 变更 → 工作画布尺寸会变（alpha 坐标系随之改变），必须整条链路重跑
  async function recompose(nextBgHex: string | null, nextTransparent: boolean) {
    const p = lastProc.current;
    if (!p) {
      Taro.showToast({ title: '请先选择照片', icon: 'none' });
      return;
    }
    setBusy(true);
    setMsg('重新合成…');
    try {
      const r = await composeAndExportImage({
        rgba: p.rgba,
        alpha: p.alpha,
        w: p.w,
        h: p.h,
        bgHex: nextTransparent ? null : nextBgHex,
        plan: p.specIndex >= 0 ? p.plan : null,
        target: p.specIndex >= 0 ? p.target : null,
      });
      setPreview(r.preview);
      setOutInfo(
        `${r.outW}×${r.outH} · ${nextTransparent ? '透明底 PNG' : `底色 ${nextBgHex} JPG`}` +
        (p.specIndex >= 0 ? ` · ${specs[p.specIndex].name} @${p.dpi}dpi` : ' · 原图尺寸'),
      );
      setMsg('完成（底色已更新）');
    } catch (e: any) {
      setMsg('换底色失败：' + String((e && e.message) || e));
    } finally {
      setBusy(false);
    }
  }

  // 换规格 / 换 dpi → 自动重跑整条链路（用户不必重新选图）
  function reprocess(opts: { specIndex?: number; dpi?: number }) {
    const src = lastSrc.current;
    if (!src) {
      Taro.showToast({ title: '请先选择照片', icon: 'none' });
      return;
    }
    run(src.path, src.w, src.h, opts);
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
    { key: 'gray', label: '灰底', color: BG.gray },
  ];

  return (
    <View className='page'>
      <Text className='page__title'>单独换底色</Text>

      {/* 【P1 #77】管线步骤指示器（RC-5/RC-9：与 T1 同序） */}
      <StepFlow steps={T2_STEPS} current={stepIndex} />
      <Text className='page__hint'>上传一张已有照片，仅替换背景色，不改动五官。不强制规格、不做预审；**只换底不裁剪构图**，要出证件照请用「一键证件照」。</Text>

      {/* 授权（默认不勾选，未集齐不启动处理；F3：未勾选则选图入口不可点） */}
      <View
        className='consent'
        style={gate.hinted
          ? { border: '2px solid #e07b00', borderRadius: '8px', padding: '10px', background: '#fff8ec' }
          : undefined}
      >
        <Text className='consent__h'>需授权（{granted.length}/{consentItems.length}）</Text>
        {gate.hinted ? (
          <Text style={{ display: 'block', fontSize: '12px', color: '#e07b00', margin: '4px 0 6px' }}>
            请先勾选下列全部授权，才能选择照片或拍照（先同意、后收集）
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

      {/* 底色选择：标准四色 */}
      <View style={{ margin: '12px 0' }}>
          {specIndex >= 0 ? (
          <CropStep
            specName={specs[specIndex].name}
            target={getPixelSize(specs[specIndex].id, dpi)!}
            crop={cropInfo && cropInfo.auto ? cropInfo : null}
            imageSrc={lastSrc.current ? lastSrc.current.path : null}
            srcW={lastSrc.current ? lastSrc.current.w : undefined}
            srcH={lastSrc.current ? lastSrc.current.h : undefined}
            cropWindow={cropWindow}
            onCropWindowChange={setCropWindow}
            onApplyCrop={() => {
              const src = lastSrc.current;
              if (src) run(src.path, src.w, src.h, { cropWindow });
            }}
          />
          ) : null}

        {/* 【P1 #77 / P2.6】美颜步骤屏（裁剪后、抠图换底前；RC-1） */}
        <BeautyStep
          value={beauty}
          onChange={setBeauty}
          onApply={() => {
            const src = lastSrc.current;
            if (src) run(src.path, src.w, src.h);
          }}
        />

        <DpiStep
          specId={specIndex >= 0 ? specs[specIndex].id : 'one-inch'}
          specName={specIndex >= 0 ? specs[specIndex].name : '未选择规格'}
          dpi={dpi}
          noSpec={specIndex < 0}
          onChange={(d) => {
            setDpi(d);
            reprocess({ dpi: d }); // 任务 #50：换 dpi 自动重跑
          }}
          srcW={lastSrc.current ? lastSrc.current.w : undefined}
          srcH={lastSrc.current ? lastSrc.current.h : undefined}
          workW={lastProc.current ? lastProc.current.w : undefined}
          workH={lastProc.current ? lastProc.current.h : undefined}
        />

        <Text>底色：</Text>
        <View style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', marginTop: '6px' }}>
          {bgOptions.map((o) => (
            <View
              key={o.key}
              onClick={() => {
                setBg(o.key);
                setUseTransparent(false);
                setCustomApplied(null);
                recompose(BG[o.key], false); // 任务 #50：换底色即刻重新合成
              }}
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
            onClick={() => {
              setUseTransparent(true);
              setCustomApplied(null);
              recompose(null, true); // 任务 #50：透明底即刻重新合成
            }}
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
            const nextIdx = v === 0 ? -1 : v - 1;
            setSpecIndex(nextIdx);
            reprocess({ specIndex: nextIdx }); // 任务 #50：换规格自动重跑（不需重新选图）
          }}
        >
          <View style={{ color: '#438EDB', padding: '4px 0' }}>
            {specIndex < 0 ? '保持原图尺寸' : `${specs[specIndex].name} ▾`}
          </View>
        </Picker>
      </View>

      {/* F3（P1 / 台账 #76）：选图前协议闸门 —— 未集齐授权，选图/拍摄入口不可达 */}
      <Button
        className='btn-primary'
        loading={busy}
        disabled={gate.blocked}
        onClick={() => gate.gate(picker.pickAlbum)}
      >
        {busy ? '处理中…' : (gate.blocked ? '请先勾选授权' : '从相册选择')}
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
          {/* AC1 镜像自查（导出前勾选，未勾选禁用保存） */}
          {picker.MirrorCheck}
          <Button style={{ marginTop: '8px' }} onClick={save} disabled={!picker.mirrorConfirmed}>
            保存到相册
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
