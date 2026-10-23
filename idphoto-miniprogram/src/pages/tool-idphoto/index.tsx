import { View, Text, Button, Image, Picker } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useState } from 'react';
import {
  requiredConsents, buildConsentRecord,
  segment, composite, check,
  buildCloudFnAdapter,
  measureHeadRatio,
  planOutput,
  BG, getSpec, getPixelSize, listSpecs, specLabel,
  DPI_STD, DPI_HD,
} from '../../services';

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
    setHeadInfo(null);
    setPlanNote('');
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

      // 2. 规划输出构图（工作图尺寸 + 裁剪窗口）
      //    600dpi 目标最大 1252px，超过原固定 800px 工作图上限 → 必须动态提升，
      //    否则输出的是「从 800px 放大来的假印刷级」。规划逻辑见 core/compose.js。
      const spec = getSpec(specs[specIndex].id);
      const target = getPixelSize(spec!, dpi)!;
      const plan = planOutput(info.width, info.height, target.width, target.height);
      if (!plan) throw new Error('图片尺寸读取失败，请换一张照片');
      const w = plan.workW;
      const h = plan.workH;
      setPlanNote(plan.reason || '');

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
      imageData.data.set(composed);
      ctx.putImageData(imageData, 0, 0);

      const outCanvas = anyTaro.createOffscreenCanvas({
        type: '2d',
        width: target.width,
        height: target.height,
      });
      const octx = outCanvas.getContext('2d');
      // 居中裁剪，保持目标宽高比（窗口由 core/compose.js 统一计算，三端口径一致）
      const sx = plan.sx, sy = plan.sy, sw = plan.sw, sh = plan.sh;
      octx.drawImage(canvas, sx, sy, sw, sh, 0, 0, target.width, target.height);

      // 6.1 头部占比（PRD B3 / 功能清单 T1-16，任务 #4）
      // 口径：在【裁剪窗口】坐标系中测量 —— 头长 ÷ 成品图高，与审核员在成品图上量的口径一致。
      // 在工作图（按目标分辨率动态规划）上检测，而非在 295×413 的成品小图上检测：
      // 小图人脸像素过少，106 点关键点检测不可靠。缩放为等比变换，头长占比在换算前后不变。
      // 检测不到时降级为「未检测」，其余 4 项照常预审（不因一项缺失而阻断整张图）。
      setMsg('测量头部占比…');
      const head = await measureHeadRatio(rgba, w, h, null, { x: sx, y: sy, width: sw, height: sh });
      const headRatio = head.ok ? head.ratio : null;
      setHeadInfo(head.ok
        ? { ratio: headRatio, source: head.source, quality: head.quality, notes: head.notes || [] }
        : null);

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

      <Button className='btn-primary' loading={busy} onClick={process}>
        {busy ? '处理中…' : '选择照片并制作'}
      </Button>

      {msg ? <Text style={{ display: 'block', marginTop: '10px', color: '#666' }}>{msg}</Text> : null}

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
    </View>
  );
}
