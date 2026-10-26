import { View, Text, Button, Image, Switch } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useEffect, useState } from 'react';
import {
  listSpecs,
  getSpec,
  listPapers,
  getPaper,
  planLayout,
  mmToPx,
  DEFAULT_MARGIN_MM,
  DEFAULT_GAP_MM,
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

  const pick = useImagePicker((img: PickedImage) => setSrcImg(img));
  const paperLabel = getPaper(paperId);

  // 实时拼版：源图 / 规格 / 相纸 / 参考线任一变化即重算（带竞态保护）
  useEffect(() => {
    if (!srcImg) {
      setPreview('');
      setResult(null);
      setMsg('');
      return;
    }
    let cancelled = false;
    setBusy(true);
    (async () => {
      try {
        const out = await compose(srcImg, specId, paperId, showGuide);
        if (!cancelled) {
          setPreview(out.preview);
          setResult(out.result);
          setMsg(out.msg);
        }
      } catch (e: any) {
        if (!cancelled) setMsg('生成失败：' + String((e && e.message) || e));
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
  ): Promise<{ preview: string; result: T6Result; msg: string }> {
    const spec = getSpec(sid);
    const paper = getPaper(pid);
    if (!spec || !paper) throw new Error('规格或相纸不存在');
    const layout = planLayout(pid, sid);
    if (!layout) throw new Error('排版计算失败');

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

    const sheet = layout.sheetPx;
    // paperRotated（planLayout 已选最优朝向）：画布与 print 区同步旋转，
    // 否则网格 cols/rows 与算法坐标系错配 → 照片溢出 print 区、绘制数 ≠ count。
    const canvasW = layout.paperRotated ? sheet.height : sheet.width;
    const canvasH = layout.paperRotated ? sheet.width : sheet.height;
    const cv: any = anyTaro.createOffscreenCanvas({ type: '2d', width: canvasW, height: canvasH });
    const ctx: any = cv.getContext('2d');

    // 白底（instax 等成像区外的白边由白底天然承担）
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvasW, canvasH);

    // print 区域（可打印/成像区）居中于（已按朝向旋转的）画布
    const printWpx = mmToPx(layout.paperRotated ? paper.printHeightMm : paper.printWidthMm, paper.dpi);
    const printHpx = mmToPx(layout.paperRotated ? paper.printWidthMm : paper.printHeightMm, paper.dpi);
    const ox = (canvasW - printWpx) / 2;
    const oy = (canvasH - printHpx) / 2;

    // footprint（单张证件照在相纸上的像素尺寸）
    const fwpMm = layout.photoRotated ? spec.heightMm : spec.widthMm;
    const fhpMm = layout.photoRotated ? spec.widthMm : spec.heightMm;
    const fwp = mmToPx(fwpMm, paper.dpi);
    const fhp = mmToPx(fhpMm, paper.dpi);
    const gap = mmToPx(DEFAULT_GAP_MM, paper.dpi);
    const margin = mmToPx(DEFAULT_MARGIN_MM, paper.dpi);

    const image = cv.createImage();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = (e: any) => reject(e || new Error('图片加载失败'));
      image.src = img.path;
    });

    const drawOne = (dx: number, dy: number) => {
      // cover 缩放：等比填满 footprint，居中裁剪，避免比例失真
      const tr = fwp / fhp;
      const sr = img.width / img.height;
      let sx = 0, sy = 0, sw = img.width, sh = img.height;
      if (sr > tr) {
        sw = img.height * tr;
        sx = (img.width - sw) / 2;
      } else {
        sh = img.width / tr;
        sy = (img.height - sh) / 2;
      }
      ctx.drawImage(image, sx, sy, sw, sh, dx, dy, fwp, fhp);
      if (guide) {
        ctx.save();
        ctx.strokeStyle = 'rgba(0,0,0,0.32)';
        ctx.lineWidth = Math.max(1, Math.min(fwp, fhp) * 0.006);
        ctx.setLineDash([Math.max(3, fwp * 0.02), Math.max(2, fwp * 0.015)]);
        ctx.strokeRect(dx + 0.5, dy + 0.5, fwp - 1, fhp - 1);
        ctx.restore();
      }
    };

    if (!paper.tileable) {
      // 不可拼版（instax / 方形贴纸）：仅 1 张，居中于 print 区
      const dx = ox + (printWpx - fwp) / 2;
      const dy = oy + (printHpx - fhp) / 2;
      drawOne(dx, dy);
    } else {
      for (let r = 0; r < layout.rows; r++) {
        for (let c = 0; c < layout.cols; c++) {
          const dx = ox + margin + c * (fwp + gap);
          const dy = oy + margin + r * (fhp + gap);
          // 保护：理论上算法已保证不越界，越界则跳过（不出废图）
          if (dx + fwp > ox + printWpx + 1 || dy + fhp > oy + printHpx + 1) continue;
          drawOne(dx, dy);
        }
      }
    }

    const exported: any = await Taro.canvasToTempFilePath({
      canvas: cv,
      x: 0, y: 0, width: canvasW, height: canvasH,
      destWidth: canvasW, destHeight: canvasH,
      fileType: 'jpg', quality: 0.95,
    });
    const fs = Taro.getFileSystemManager();
    const fi: any = await new Promise((resolve, reject) => {
      fs.getFileInfo({ filePath: exported.tempFilePath, success: resolve, fail: reject });
    });
    const fileKb = Math.round(fi.size / 1024);

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
    if (!preview) return;
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

      {/* 上传 */}
      <Button className='btn-primary' loading={busy} onClick={pick.pickAlbum}>
        {busy ? '生成中…' : srcImg ? '重新选择照片' : '从相册选择'}
      </Button>
      <Button className='btn-camera' onClick={pick.openCamera}>
        📷 拍摄（引导框）
      </Button>

      {/* 选规格 */}
      <View style={{ margin: '14px 0' }}>
        <Text style={{ display: 'block', marginBottom: '6px' }}>证件照规格：</Text>
        <View className='spec-chips'>
          {specs.map((s: any) => {
            const on = specId === s.id;
            return (
              <View
                key={s.id}
                className='spec-chip'
                onClick={() => setSpecId(s.id)}
                style={{
                  padding: '5px 10px', marginRight: '6px', marginBottom: '6px', borderRadius: '20px',
                  border: on ? '1px solid #438EDB' : '1px solid #ddd',
                  background: on ? '#eef5fd' : '#fff',
                }}
              >
                <Text style={{ fontSize: '12px', color: on ? '#2b6cb0' : '#666' }}>
                  {s.name} {s.widthMm}×{s.heightMm}mm
                </Text>
              </View>
            );
          })}
        </View>
      </View>

      {/* 选相纸：常规 */}
      <View style={{ margin: '14px 0' }}>
        <Text style={{ display: 'block', marginBottom: '6px' }}>相纸（常规冲印）：</Text>
        <View className='spec-chips'>
          {regularPapers.map((p: any) => {
            const on = paperId === p.id;
            return (
              <View
                key={p.id}
                className='spec-chip'
                onClick={() => setPaperId(p.id)}
                style={{
                  padding: '5px 10px', marginRight: '6px', marginBottom: '6px', borderRadius: '20px',
                  border: on ? '1px solid #438EDB' : '1px solid #ddd',
                  background: on ? '#eef5fd' : '#fff',
                }}
              >
                <Text style={{ fontSize: '12px', color: on ? '#2b6cb0' : '#666' }}>{p.name}</Text>
              </View>
            );
          })}
        </View>
      </View>

      {/* 选相纸：迷你 */}
      <View style={{ margin: '14px 0' }}>
        <Text style={{ display: 'block', marginBottom: '6px' }}>相纸（迷你打印机）：</Text>
        <View className='spec-chips'>
          {miniPapers.map((p: any) => {
            const on = paperId === p.id;
            return (
              <View
                key={p.id}
                className='spec-chip'
                onClick={() => setPaperId(p.id)}
                style={{
                  padding: '5px 10px', marginRight: '6px', marginBottom: '6px', borderRadius: '20px',
                  border: on ? '1px solid #438EDB' : '1px solid #ddd',
                  background: on ? '#eef5fd' : '#fff',
                }}
              >
                <Text style={{ fontSize: '12px', color: on ? '#2b6cb0' : '#666' }}>
                  {p.name}{p.tileable ? '' : '（每版1张）'}
                </Text>
              </View>
            );
          })}
        </View>
      </View>

      {/* 裁剪参考线开关（默认开，Q6 已确认） */}
      <View style={{ margin: '12px 0', display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
        <Switch checked={showGuide} onChange={(e: any) => setShowGuide(e.detail.value)} />
        <Text style={{ marginLeft: '6px' }}>显示裁剪参考线（便于自裁）</Text>
      </View>

      {/* 结果信息 */}
      {result && result.count > 0 ? (
        <Text style={{ display: 'block', fontSize: '13px', color: '#333', marginTop: '6px' }}>
          本版可排 {result.count} 张 · 输出 {result.sheet.width}×{result.sheet.height}px @
          {result.dpi}dpi · {result.fileKb}KB
          {paperLabel && !paperLabel.tileable ? ' · 每版仅 1 张（白边不可拼版）' : ''}
        </Text>
      ) : null}
      {result && result.count === 0 ? (
        <Text style={{ display: 'block', fontSize: '13px', color: '#e53e3e', marginTop: '6px' }}>
          ⚠️ {result.note || '该相纸无法容纳所选证件照，请换更大相纸或更小规格'}
        </Text>
      ) : null}
      {msg && (!result || result.count > 0) && msg !== '完成' ? (
        <Text style={{ display: 'block', marginTop: '10px', color: '#666' }}>{msg}</Text>
      ) : null}

      {/* 预览 */}
      {preview ? (
        <View style={{ marginTop: '14px' }}>
          <Image src={preview} style={{ width: '100%', height: '300px', background: '#f0f0f0' }} mode='aspectFit' />
          {/* AC1 镜像自查（导出前勾选，未勾选禁用保存，与 T5 一致） */}
          {pick.MirrorCheck}
          <Button style={{ marginTop: '8px' }} onClick={save} disabled={!pick.mirrorConfirmed}>
            保存到相册
          </Button>
        </View>
      ) : null}

      {/* 说明 */}
      <Text style={{ display: 'block', fontSize: '11px', color: '#aaa', marginTop: '14px' }}>
        说明：导出为拼版 JPG（白底、无水印、免费）。mini 相纸中 instax / 方形贴纸每版仅 1 张，四周白边不可裁掉用于拼版；裁剪参考线仅供自裁定位，不会印到成品。
      </Text>

      {pick.Guide}
      {pick.QualityTip}
    </View>
  );
}
