import { printGeometry } from '../../core/printGeometry';
import { withTimeout, IMG_LOAD_TIMEOUT_MS, EXPORT_TIMEOUT_MS } from '../../core/asyncUtils';
import { inspectExportedFile } from '../../services/exportInspection';
import { View, Text, Button, Image, Switch } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useEffect, useRef, useState } from 'react';
import {
  listSpecs,
  getSpec,
  listPapers,
  getPaper,
  planLayout,
  mmToPx,
  DEFAULT_MARGIN_MM,
  DEFAULT_GAP_MM,
  decodeSrcParam,
  resolveHandoff,
} from '../../services';
import { useImagePicker, type PickedImage } from '../../hooks/useImagePicker';

// T6 冲印排版（PRD K 模块）：上传已制作好的证件照 → 选规格 → 选相纸 → 平铺拼版 → 导出可打印拼版图。
// 与 T1–T5 差异（PRD K1）：纯图像拼版，不涉及人脸处理，无需人脸授权（TOOL_CONSENTS.T6 = []）。
// 但沿用 AC1 镜像自查（导出前勾选，与 T5 一致），避免误存翻转照。
//
// 合成口径（与 paperLibrary.planLayout 严格一致）：
//   - 整张纸画布 = paperWidthMm × paperHeightMm × dpi（= layout.sheetPx）
//   - 可打印/成像区（print）居中于纸，四周留边；mini 成像区外的白边天然由白底承担
//   - 单张证件照 footprint = 规格 mm（按 photoRotated 取宽高）× 相纸 dpi
//   - tileable：在 print 区内按 cols×rows 网格平铺（含 margin/gap）；不可拼版（instax/方形贴纸）仅 1 张
//   - 裁剪参考线（默认开，Q6 已确认）：每张 footprint 周围画细虚线，便于用户自裁

interface T6Result {
  sheet: { width: number; height: number };
  dpi: number;
  count: number;
  tileable: boolean;
  note?: string;
  fileKb: number;
}

/**
 * 读取上游传来的成品图路径（?src=），**只负责取到原始字符串**，
 * 解码与承接结论交给 core/printHandoff（纯函数，有单测）。
 * 取参方式：用 getCurrentPages() 读页面实例 options（非 hook，避免 Taro.useRouter
 * 在部分运行时/自动化环境下不可用导致整页崩），再回退到 getCurrentInstance().router.params。
 */
function readSrcParam(): string {
  try {
    const pages: any = (Taro as any).getCurrentPages ? (Taro as any).getCurrentPages() : [];
    const cur: any = pages && pages[pages.length - 1];
    const opt = cur && (cur.options || (cur.__route__ && cur.__route__.query));
    if (opt && opt.src) return String(opt.src);
  } catch (e) {
    /* ignore */
  }
  try {
    const inst: any = (Taro as any).getCurrentInstance ? (Taro as any).getCurrentInstance() : null;
    const p = inst && inst.router && inst.router.params;
    if (p && p.src) return String(p.src);
  } catch (e) {
    /* ignore */
  }
  return '';
}

export default function ToolPrint() {
  const specs = listSpecs();
  const papers = listPapers();
  const regularPapers = papers.filter((p) => p.category === 'regular');
  const miniPapers = papers.filter((p) => p.category === 'mini');

  const [specId, setSpecId] = useState('one-inch');
  const [paperId, setPaperId] = useState('paper-6in');
  const [showGuide, setShowGuide] = useState(true);
  const [srcImg, setSrcImg] = useState<PickedImage | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [preview, setPreview] = useState('');
  const [result, setResult] = useState<T6Result | null>(null);
  const [incoming, setIncoming] = useState('');

  const selectedManually = useRef(false);
  const pick = useImagePicker((img: PickedImage) => { selectedManually.current = true; setSrcImg(img); });
  const paperLabel = getPaper(paperId);

  // 承接上一步成品图：读不到（路径失效/被清理）时静默降级为「手动从相册选择」，绝不阻断
  // 判定逻辑在 core/printHandoff（纯函数 + 单测），页面只做取参与调用。
  useEffect(() => {
    const raw = readSrcParam();
    if (!raw) return;
    let disposed = false;
    (async () => {
      let info: any = null;
      try {
        const decoded = decodeSrcParam(raw);
        if (decoded) info = await withTimeout(Taro.getImageInfo({ src: decoded }), IMG_LOAD_TIMEOUT_MS, 'print:handoff_timeout');
      } catch (e) {
        info = null;
      }
      if (disposed || selectedManually.current) return;
      const r = resolveHandoff(raw, info);
      if (r.ok && r.width && r.height) {
        setSrcImg({ path: r.src, width: r.width, height: r.height });
      }
      setIncoming(r.message);
    })();
    return () => { disposed = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 实时拼版：源图 / 规格 / 相纸 / 参考线任一变化即重算（带竞态保护）
  useEffect(() => {
    if (!srcImg) {
      setBusy(false);
      setPreview('');
      setResult(null);
      setMsg('');
      return;
    }
    let cancelled = false;
    const traceId = `print-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setBusy(true);
    setPreview('');
    setResult(null);
    (async () => {
      try {
        const out = await compose(srcImg, specId, paperId, showGuide, () => !cancelled);
        if (!cancelled) {
          setPreview(out.preview);
          setResult(out.result);
          setMsg(out.msg);
        }
      } catch (e: any) {
        if (!cancelled) {
          const code = e?.code === 'ASYNC_TIMEOUT' ? 'PRINT_TIMEOUT' : 'PRINT_EXPORT_FAILED';
          console.warn('[T6]', { code, traceId });
          setMsg(`${code === 'PRINT_TIMEOUT' ? '生成超时' : '生成失败'}，请重试（${code}，${traceId}）`);
        }
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // compose 为组件内函数，已通过参数传入最新 specId/paperId/showGuide，无需列入依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcImg?.path, specId, paperId, showGuide]);

  async function compose(
    img: PickedImage,
    sid: string,
    pid: string,
    guide: boolean,
    current: () => boolean,
  ): Promise<{ preview: string; result: T6Result; msg: string }> {
    const spec = getSpec(sid);
    const paper = getPaper(pid);
    if (!spec || !paper) throw new Error('规格或相纸不存在');
    const layout = printGeometry(pid, sid);
    if (!layout || !layout.valid) throw { code: 'PRINT_GEOMETRY', message: '排版几何校验失败' };

    if (layout.count === 0) {
      // 无法容纳（如 visa + instax-mini）：不出废图，提示换纸/换规格
      return {
        preview: '',
        result: {
          sheet: layout.sheetPx, dpi: layout.dpi, count: 0,
          tileable: layout.tileable, note: layout.note, fileKb: 0,
        },
        msg: layout.note || '该相纸无法容纳所选证件照',
      };
    }

    const anyTaro: any = Taro;
    if (typeof anyTaro.createOffscreenCanvas !== 'function') {
      throw new Error('当前基础库不支持离屏 canvas，请升级基础库到 2.16.1+');
    }

    const canvasW = layout.width, canvasH = layout.height;
    const cv: any = anyTaro.createOffscreenCanvas({ type: '2d', width: canvasW, height: canvasH });
    const ctx: any = cv.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvasW, canvasH);
    const fwp = layout.placements[0].width, fhp = layout.placements[0].height;

    const image = cv.createImage();
    await withTimeout(new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = (e: any) => reject(e || new Error('图片加载失败'));
      image.src = img.path;
    }), IMG_LOAD_TIMEOUT_MS, 'print:image_timeout');
    if (!current()) throw { code: 'PRINT_STALE' };

    const drawOne = (dx: number, dy: number) => {
      // cover 缩放：等比填满 footprint，居中裁剪，避免比例失真
      const tr = layout.photoRotated ? fhp / fwp : fwp / fhp;
      const sr = img.width / img.height;
      let sx = 0, sy = 0, sw = img.width, sh = img.height;
      if (sr > tr) {
        sw = img.height * tr;
        sx = (img.width - sw) / 2;
      } else {
        sh = img.width / tr;
        sy = (img.height - sh) / 2;
      }
      if (layout.photoRotated) {
        ctx.save();
        ctx.translate(dx + fwp, dy);
        ctx.rotate(Math.PI / 2);
        ctx.drawImage(image, sx, sy, sw, sh, 0, 0, fhp, fwp);
        ctx.restore();
      } else ctx.drawImage(image, sx, sy, sw, sh, dx, dy, fwp, fhp);
      if (guide) {
        ctx.save();
        ctx.strokeStyle = 'rgba(0,0,0,0.32)';
        ctx.lineWidth = Math.max(1, Math.min(fwp, fhp) * 0.006);
        ctx.setLineDash([Math.max(3, fwp * 0.02), Math.max(2, fwp * 0.015)]);
        ctx.strokeRect(dx + 0.5, dy + 0.5, fwp - 1, fhp - 1);
        ctx.restore();
      }
    };

    for (const placement of layout.placements) drawOne(placement.x, placement.y);

    const exported: any = await withTimeout(Taro.canvasToTempFilePath({
      canvas: cv,
      x: 0, y: 0, width: canvasW, height: canvasH,
      destWidth: canvasW, destHeight: canvasH,
      fileType: 'jpg', quality: 0.95,
    }), EXPORT_TIMEOUT_MS, 'print:export_timeout');
    if (!current()) throw { code: 'PRINT_STALE' };
    const artifact = await inspectExportedFile(exported.tempFilePath, { width: canvasW, height: canvasH }, 'jpg');
    const fileKb = Number(artifact.fileKb.toFixed(2));

    return {
      preview: exported.tempFilePath,
      result: {
        sheet: { width: canvasW, height: canvasH }, dpi: paper.dpi, count: layout.count,
        tileable: layout.tileable, note: layout.note, fileKb,
      },
      msg: '完成',
    };
  }

  async function save() {
    if (!preview || busy || !pick.mirrorConfirmed) return;
    try {
      await Taro.saveImageToPhotosAlbum({ filePath: preview });
      Taro.showToast({ title: '已保存到相册' });
    } catch (e) {
      Taro.showToast({ title: '保存失败，请检查相册权限', icon: 'none' });
    }
  }

  return (
    <View className='page'>
      <Text className='page__title'>冲印排版</Text>
      <Text className='page__hint'>上传已制作好的证件照，选规格与相纸，自动平铺成可打印拼版图。纯拼版，无需人脸授权。</Text>
      {incoming ? (
        <Text className={incoming.indexOf('未能') === 0 ? 'incoming incoming--bad' : 'incoming incoming--ok'}>
          {incoming}
        </Text>
      ) : null}

      {/* 上传 */}
      <Button className='btn-primary' loading={busy} onClick={pick.pickAlbum}>
        {busy ? '生成中…' : srcImg ? '重新选择照片' : '从相册选择'}
      </Button>
      <Button className='btn-camera' onClick={pick.openCamera}>
        📷 拍摄（引导框）
      </Button>

      {/* 选规格 */}
      <View className='section'>
        <Text className='field-label'>证件照规格：</Text>
        <View className='spec-chips'>
          {specs.map((s: any) => {
            const on = specId === s.id;
            return (
              <View
                key={s.id}
                className={on ? 'spec-chip spec-chip--sel' : 'spec-chip'}
                onClick={() => setSpecId(s.id)}
              >
                <Text>{s.name} {s.widthMm}×{s.heightMm}mm</Text>
              </View>
            );
          })}
        </View>
      </View>

      {/* 选相纸：常规 */}
      <View className='section'>
        <Text className='field-label'>相纸（常规冲印）：</Text>
        <View className='spec-chips'>
          {regularPapers.map((p: any) => {
            const on = paperId === p.id;
            return (
              <View
                key={p.id}
                className={on ? 'spec-chip spec-chip--sel' : 'spec-chip'}
                onClick={() => setPaperId(p.id)}
              >
                <Text>{p.name}</Text>
              </View>
            );
          })}
        </View>
      </View>

      {/* 选相纸：迷你 */}
      <View className='section'>
        <Text className='field-label'>相纸（迷你打印机）：</Text>
        <View className='spec-chips'>
          {miniPapers.map((p: any) => {
            const on = paperId === p.id;
            return (
              <View
                key={p.id}
                className={on ? 'spec-chip spec-chip--sel' : 'spec-chip'}
                onClick={() => setPaperId(p.id)}
              >
                <Text>{p.name}{p.tileable ? '' : '（每版1张）'}</Text>
              </View>
            );
          })}
        </View>
      </View>

      {/* 裁剪参考线开关（默认开，Q6 已确认） */}
      <View className='row-flex section'>
        <Switch checked={showGuide} onChange={(e: any) => setShowGuide(e.detail.value)} />
        <Text style={{ marginLeft: '6px' }}>显示裁剪参考线（便于自裁）</Text>
      </View>

      {/* 结果信息 */}
      {result && result.count > 0 ? (
        <Text className='out-info'>
          本版可排 {result.count} 张 · 输出 {result.sheet.width}×{result.sheet.height}px @
          {result.dpi}dpi 像素档 · {result.fileKb}KB
          {paperLabel && !paperLabel.tileable ? ' · 每版仅 1 张（白边不可拼版）' : ''}
        </Text>
      ) : null}
      {result && result.count === 0 ? (
        <Text className='out-info out-info--warn'>
          ⚠️ {result.note || '该相纸无法容纳所选证件照，请换更大相纸或更小规格'}
        </Text>
      ) : null}
      {msg && (!result || result.count > 0) && msg !== '完成' ? (
        <Text className='status-line'>{msg}</Text>
      ) : null}

      {/* 预览 */}
      {preview ? (
        <View className='section'>
          <Image src={preview} className='preview preview--tall' mode='aspectFit' />
          {/* AC1 镜像自查（导出前勾选，未勾选禁用保存，与 T5 一致） */}
          {pick.MirrorCheck}
          <Button className='btn-primary mt-sm' onClick={save} disabled={!pick.mirrorConfirmed}>
            保存到相册
          </Button>
        </View>
      ) : null}

      {/* 说明 */}
      <Text className='note-faint'>
        说明：dpi为相纸尺寸换算像素，不承诺文件dpi元数据。导出为拼版 JPG（白底、无水印、免费）。mini 相纸中 instax / 方形贴纸每版仅 1 张，四周白边不可裁掉用于拼版；开启时参考线会写入拼版图，仅供自裁定位。
      </Text>

      {pick.Guide}
      {pick.QualityTip}
    </View>
  );
}
