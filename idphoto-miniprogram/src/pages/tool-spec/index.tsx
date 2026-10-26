import { View, Text, Button, Image, Picker, Input, Switch } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useState } from 'react';
import { getSpec, getPixelSize, listSpecs, DPI_STD, DPI_HD, specLabel } from '../../services';
import { useImagePicker } from '../../hooks/useImagePicker';

// T5 规格转换：已有照片按所选规格「裁剪 / 改 dpi / 压 KB」后导出（真实功能，非占位）
// 选图 → 目标像素计算（内置规格×dpi 或 自定义宽高）→ 居中裁剪缩放 → KB 上限压缩（quality 逐步降）→ 保存相册
//
// 与 T1/T2 的差异（PRD J2/J3）：**纯图像变换，不涉及人脸处理，无需任何人脸授权**（TOOL_CONSENTS.T5 = []）。
// 功能范围（PRD F2，2026-10-23 与 owner 确认）：内置 8 规格 + 300/600dpi 切换 + KB 上限压缩 + 自定义像素宽高兜底。
//
// dpi 技术现实（owner 已确认）：微信 canvas 导出的 JPG 无法写入 dpi 元数据；
// 做到「选 300/600 dpi → 输出对应像素数」，文件内不含 dpi 标记（报名系统按像素校验，页面已诚实标注）。
const DPI = 300;

// KB 压缩：从高 quality 起步，超限则逐步降低，最多 8 轮
const KB_QUALITY_STEPS = [0.95, 0.9, 0.85, 0.8, 0.7, 0.6, 0.5, 0.4];

export default function ToolSpec() {
  const specs = listSpecs();
  const [mode, setMode] = useState<'spec' | 'custom'>('spec'); // spec=内置规格 / custom=自定义像素
  const [specIndex, setSpecIndex] = useState(0);
  const [dpi, setDpi] = useState(DPI_STD);
  const [customW, setCustomW] = useState('');
  const [customH, setCustomH] = useState('');
  // KB 上限：关闭开关 = 不压缩（最高质量导出）；默认 200KB（多数报名系统上限，PRD 8.1）
  const [kbLimit, setKbLimit] = useState('200');
  const [kbLimitOn, setKbLimitOn] = useState(true);

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [preview, setPreview] = useState('');
  const [outInfo, setOutInfo] = useState('');
  const picker = useImagePicker((img) => run(img.path, img.width, img.height));

  const spec = mode === 'spec' ? getSpec(specs[specIndex].id) : null;
  const targetPx = mode === 'spec'
    ? getPixelSize(spec!, dpi)!
    : {
      width: Math.max(1, Math.min(5000, parseInt(customW, 10) || 0)),
      height: Math.max(1, Math.min(5000, parseInt(customH, 10) || 0)),
      dpi,
    };
  const limitKb = kbLimitOn ? Math.max(0, parseInt(kbLimit, 10) || 0) : 0;

  function validate(): string | null {
    if (mode === 'custom' && (!targetPx.width || !targetPx.height)) {
      return '请输入有效的自定义像素（1–5000）';
    }
    if (kbLimitOn && !limitKb) return '请输入 KB 上限，或关闭压缩开关';
    return null;
  }

  async function run(path: string, srcW: number, srcH: number) {
    const err = validate();
    if (err) {
      Taro.showToast({ title: err, icon: 'none' });
      return;
    }
    setBusy(true);
    setMsg('读取图片…');
    try {
      const anyTaro: any = Taro;
      if (typeof anyTaro.createOffscreenCanvas !== 'function') {
        throw new Error('当前基础库不支持离屏 canvas，请升级基础库到 2.16.1+');
      }

      // 取图已剥离到 useImagePicker（相册 picker.pickAlbum / 拍摄 CameraGuide，PRD A1 引导框）。
      const w = srcW;
      const h = srcH;

      // 2. 目标画布：居中裁剪到目标宽高比，再缩放到目标像素
      setMsg('裁剪缩放中…');
      const tw = targetPx.width;
      const th = targetPx.height;
      const outCanvas = anyTaro.createOffscreenCanvas({ type: '2d', width: tw, height: th });
      const octx = outCanvas.getContext('2d');
      const img = outCanvas.createImage();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = (e: any) => reject(e || new Error('图片加载失败'));
        img.src = path;
      });
      const targetRatio = tw / th;
      const srcRatio = w / h;
      let sw = w, sh = h, sx = 0, sy = 0;
      if (srcRatio > targetRatio) {
        sw = h * targetRatio;
        sx = (w - sw) / 2;
      } else {
        sh = w / targetRatio;
        sy = (h - sh) / 2;
      }
      octx.drawImage(img, sx, sy, sw, sh, 0, 0, tw, th);

      // 3. 导出 + KB 上限压缩（JPG quality 逐步降）
      setMsg('导出中…');
      const fs = Taro.getFileSystemManager();
      const getFileKb = async (p: string): Promise<number> => {
        const fi: any = await new Promise((resolve, reject) => {
          fs.getFileInfo({ filePath: p, success: resolve, fail: reject });
        });
        return Math.round(fi.size / 1024);
      };

      let fileKb = 0;
      let exported: any = null;
      let usedQuality = KB_QUALITY_STEPS[0];
      let kbWarn = false;
      for (const q of KB_QUALITY_STEPS) {
        usedQuality = q;
        exported = await Taro.canvasToTempFilePath({
          canvas: outCanvas,
          x: 0, y: 0, width: tw, height: th,
          destWidth: tw, destHeight: th,
          fileType: 'jpg',
          quality: q,
        });
        fileKb = await getFileKb(exported.tempFilePath);
        if (!limitKb || fileKb <= limitKb) break;
      }
      if (limitKb && fileKb > limitKb) {
        kbWarn = true;
      }

      setPreview(exported!.tempFilePath);
      setOutInfo(
        `${tw}×${th}px` +
        (mode === 'spec' ? ` · ${specs[specIndex].name} @${dpi}dpi` : ' · 自定义尺寸') +
        ` · ${fileKb}KB` +
        (limitKb && fileKb <= limitKb ? `（≤${limitKb}KB）` : '') +
        ` · 质量 ${Math.round(usedQuality * 100)}%`,
      );
      setMsg(
        kbWarn
          ? `注意：已压到最低质量仍 ${fileKb}KB > 上限 ${limitKb}KB（可提高上限或缩小目标像素）`
          : '完成',
      );
    } catch (e: any) {
      setMsg('处理失败：' + String((e && e.message) || e));
      console.error('[T5]', e);
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

  return (
    <View className='page'>
      <Text className='page__title'>规格转换</Text>
      <Text className='page__hint'>按目标规格裁剪 / 改 dpi / 压 KB 后导出。纯图像变换，不涉及人脸处理，无需人脸授权。</Text>

      {/* 模式切换 */}
      <View style={{ display: 'flex', flexDirection: 'row', margin: '12px 0' }}>
        <View
          onClick={() => setMode('spec')}
          style={{
            padding: '8px 14px', marginRight: '8px', borderRadius: '6px',
            border: mode === 'spec' ? '2px solid #438EDB' : '1px solid #ccc',
            background: mode === 'spec' ? '#eef5fd' : '#fff',
          }}
        >
          <Text>内置规格</Text>
        </View>
        <View
          onClick={() => setMode('custom')}
          style={{
            padding: '8px 14px', borderRadius: '6px',
            border: mode === 'custom' ? '2px solid #438EDB' : '1px solid #ccc',
            background: mode === 'custom' ? '#eef5fd' : '#fff',
          }}
        >
          <Text>自定义像素</Text>
        </View>
      </View>

      {/* 内置规格 + dpi */}
      {mode === 'spec' ? (
        <View style={{ margin: '12px 0' }}>
          <Text>目标规格：</Text>
          <Picker
            mode='selector'
            range={specs.map((s: any) => specLabel(s.id, dpi))}
            value={specIndex}
            onChange={(e: any) => setSpecIndex(Number(e.detail.value))}
          >
            <View style={{ color: '#438EDB', padding: '4px 0' }}>{specs[specIndex].name} ▾</View>
          </Picker>
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
          {spec ? (
            <Text style={{ display: 'block', fontSize: '11px', color: '#999' }}>
              {spec.source}
            </Text>
          ) : null}
          <Text>输出 dpi：</Text>
          <Picker
            mode='selector'
            range={['300dpi（标准 · 像素少）', '600dpi（高清 · 像素翻倍）']}
            value={dpi === DPI_STD ? 0 : 1}
            onChange={(e: any) => setDpi(Number(e.detail.value) === 0 ? DPI_STD : DPI_HD)}
          >
            <View style={{ color: '#438EDB', padding: '4px 0' }}>
              {dpi}dpi ▾
            </View>
          </Picker>
        </View>
      ) : (
        <View style={{ margin: '12px 0', display: 'flex', flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' }}>
          <Text>宽(px)：</Text>
          <Input
            type='number'
            value={customW}
            onInput={(e: any) => setCustomW(e.detail.value)}
            placeholder='如 295'
            style={{ width: '80px', border: '1px solid #ccc', borderRadius: '6px', padding: '6px 8px', marginLeft: '6px' }}
          />
          <Text style={{ marginLeft: '10px' }}>高(px)：</Text>
          <Input
            type='number'
            value={customH}
            onInput={(e: any) => setCustomH(e.detail.value)}
            placeholder='如 413'
            style={{ width: '80px', border: '1px solid #ccc', borderRadius: '6px', padding: '6px 8px', marginLeft: '6px' }}
          />
        </View>
      )}

      {/* 目标像素预览 */}
      <Text style={{ display: 'block', fontSize: '12px', color: '#888' }}>
        输出像素：{targetPx.width}×{targetPx.height}
        {mode === 'spec' ? `（${spec!.widthMm}×${spec!.heightMm}mm @${dpi}dpi 换算）` : ''}
      </Text>

      {/* KB 上限 */}
      <View style={{ margin: '12px 0', display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
        <Switch checked={kbLimitOn} onChange={(e: any) => setKbLimitOn(e.detail.value)} />
        <Text style={{ marginLeft: '6px' }}>KB 上限：</Text>
        <Input
          type='number'
          value={kbLimit}
          onInput={(e: any) => setKbLimit(e.detail.value)}
          placeholder={mode === 'spec' ? `规格默认 ${spec!.maxKb}` : '如 200'}
          style={{ width: '80px', border: '1px solid #ccc', borderRadius: '6px', padding: '6px 8px', marginLeft: '6px' }}
        />
      </View>

      <Button className='btn-primary' loading={busy} onClick={picker.pickAlbum}>
        {busy ? '处理中…' : '从相册选择'}
      </Button>
      <Button className='btn-camera' onClick={picker.openCamera}>
        📷 拍摄（引导框）
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

      {/* dpi 元数据诚实标注（owner 2026-10-23 确认口径） */}
      <Text style={{ display: 'block', fontSize: '11px', color: '#aaa', marginTop: '14px' }}>
        说明：dpi 决定输出像素数量（同一规格 600dpi 像素翻倍）；文件本身不含 dpi 元数据，报名/办证系统按像素校验。
      </Text>

      {/* A1 半透明人脸引导框：拍摄入口（相册走上方 .btn-primary） */}
      {picker.Guide}
    </View>
  );
}
