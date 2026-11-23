import { researchTemplates as templates } from '../../services/suitAssets';
import MattingStatus from '../../components/MattingStatus';
import { View, Text, Button, Image, Picker } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useState } from 'react';
import { listSpecs, getPixelSize, requiredConsents, buildConsentRecord, BG } from '../../services';
import { useT1Workflow } from '../../hooks/useT1Workflow';
import { useImagePicker } from '../../hooks/useImagePicker';
import { useConsentGate } from '../../hooks/useConsentGate';
import StepFlow from '../../components/StepFlow';
import CropStep from '../../components/CropStep';
import BeautyStep from '../../components/BeautyStep';
import DpiStep from '../../components/DpiStep';
import MirrorCheck from '../../components/MirrorCheck';
import AlphaPatch from '../../components/AlphaPatch';
import './index.scss';

export const T1_STEPS = [
  { key: 'crop', label: '裁剪' }, { key: 'beauty', label: '美颜' }, { key: 'preview', label: '抠图换底' },
  { key: 'dress', label: '换装(可选)' }, { key: 'check', label: '预审' },
  { key: 'dpi', label: '输出档位' }, { key: 'export', label: '导出' },
];

export default function ToolIdPhoto() {
  const { flow, state, authorization } = useT1Workflow();
  const { session: snapshot, screen } = state;
  const p = snapshot.params;
  const busy = snapshot.status === 'processing';
  const specs = listSpecs(); const spec = specs.find((item: any) => item.id === p.specId)!;
  const consentItems = requiredConsents('T1');
  const gate = useConsentGate(() => buildConsentRecord('T1', flow.getState().session.params.consents).ready, '一键证件照');
  const [patch, setPatch] = useState<{ traceId: string } | null>(null);
  const picker = useImagePicker(async (img, quality) => {
    flow.selectImage({ ...img, forceCloud: !!quality?.tips?.some((tip: any) => tip.code === 'complexbg') });
    await flow.suggest();
  }, authorization);
  const consent = (id: string) => {
    const now = flow.getState().session.params.consents;
    flow.update({ consents: now.includes(id) ? now.filter((item: string) => item !== id) : [...now, id] });
  };
  const mirror = <MirrorCheck confirmed={state.mirrorConfirmed} onChange={(value) => flow.confirmMirror(value)} />;
  const report = screen === 'export' || state.pendingSelf && screen === 'dpi' ? state.finalResult : state.preview;
  const back = () => { setPatch(null); flow.back(); };
  async function consume(kind: 'save' | 'print', expectedTrace: string) {
    const allowed = flow.exportResult(expectedTrace);
    if (!allowed.ok) return;
    const output = allowed.output;
    try {
      if (kind === 'save') await Taro.saveImageToPhotosAlbum({ filePath: output.preview });
      else await Taro.navigateTo({ url: `/pages/tool-print/index?src=${encodeURIComponent(output.preview)}` });
      if (kind === 'save' && flow.exportResult(expectedTrace).ok) Taro.showToast({ title: '已保存到相册' });
    } catch {
      console.warn('[T1]', { code: kind === 'save' ? 'SAVE_FAILED' : 'PRINT_FAILED', traceId: expectedTrace });
      if (flow.exportResult(expectedTrace).ok) Taro.showToast({ title: '操作失败，请检查权限后重试', icon: 'none' });
    }
  }
  const suitAvailability = flow.suitAvailability();
  return (
    <View className='page t1-page' data-screen={screen}>
      <View className='t1-nav'>
        {screen !== 'upload' ? <Button className='flow-back' onClick={back}>‹ 上一步</Button> : null}
        <Text className='page__title'>一键证件照</Text>
      </View>
      <Text className='tag'>全部功能免费 · 无水印 · 300/600dpi均开放</Text>
      <StepFlow steps={T1_STEPS} current={T1_STEPS.findIndex((item) => item.key === screen)} />
        <View className={gate.hinted ? 'consent consent--hinted' : 'consent'}>
          <Text className='tag'>授权设置（可随时取消勾选撤回）；上云增强可选，不影响本地处理</Text>
          {consentItems.map((item: any) => <View key={item.id} className='consent__item' onClick={() => consent(item.id)}>
            <Text>{p.consents.includes(item.id) ? '☑ ' : '☐ '}{item.label}</Text>
            <Text className='consent__desc'>{item.desc}</Text>
          </View>)}
        </View>
        {screen !== 'dress' && p.consents.includes('suitSwap') ? <Button className='flow-revoke-suit' onClick={() => consent('suitSwap')}>撤回换装授权</Button> : null}
      {screen === 'upload' ? <View className='flow-screen screen-upload'>
        <Text className='t1-heading'>选择照片与目标规格</Text>
        <Picker mode='selector' value={specs.findIndex((item: any) => item.id === p.specId)} range={specs.map((item: any) => item.name)}
          onChange={(event: any) => flow.update({ specId: specs[Number(event.detail.value)].id })}>
          <View className='picker-value'>{spec.name} · {getPixelSize(p.specId, 300)!.width}×{getPixelSize(p.specId, 300)!.height}px ▾</View>
        </Picker>
        <Text className='tag'>{spec.source}</Text>
        <Button className='btn-primary' disabled={gate.blocked || busy} onClick={() => gate.gate(picker.pickAlbum)}>从相册选择</Button>
        <Button className='btn-camera' disabled={gate.blocked || busy} onClick={() => gate.gate(picker.openCamera)}>拍摄照片</Button>
        {p.source ? <Button className='flow-resume' onClick={() => flow.resumeCrop()}>继续编辑已选照片</Button> : null}
        {picker.Guide}
      </View> : null}

      {screen === 'crop' ? <View className='flow-screen screen-crop'>
        <Text className='t1-heading'>① 裁剪 · 选择范围</Text>
        <CropStep key={`${snapshot.sourceId}-${p.specId}`} confirmationRequired specName={spec.name}
          target={getPixelSize(p.specId, 300)!} imageSrc={p.source?.path} srcW={p.source?.width} srcH={p.source?.height}
          cropWindow={p.cropWindow} onCropWindowChange={(window) => flow.update({ cropWindow: window })}
          onApplyCrop={() => flow.confirmCrop()} />
        {picker.QualityTip}
      </View> : null}

      {screen === 'beauty' ? <View className='flow-screen screen-beauty'>
        <Text className='t1-heading'>② 美颜修图</Text>
        <BeautyStep standalone value={p.beauty} onChange={(value) => flow.update({ beauty: value })} onApply={() => flow.confirmBeauty()} />
        <Button className='flow-skip-beauty' disabled={busy} onClick={() => flow.confirmBeauty(true)}>跳过美颜并继续</Button>
      </View> : null}

      {screen === 'preview' ? <View className='flow-screen screen-preview'>
        <Text className='t1-heading'>③ 抠图换底 · 预览</Text>
        {state.preview ? <Image src={state.preview.preview} className='preview' mode='aspectFit' /> : null}
        <Text className='tag'>当前为处理预览，尚未生成最终成品</Text>
        <View className='bg-swatches'>{(['white', 'blue', 'blueLight', 'red'] as const).map((key) => <View key={key}
          className={`bg-swatch${p.bg === key ? ' bg-swatch--sel' : ''}`} style={{ background: BG[key] }} onClick={() => flow.background(key)}>
          <Text>{({ white: '白底', blue: '标准深蓝', blueLight: '浅蓝', red: '红底' })[key]}</Text>
        </View>)}</View>
        <MattingStatus evidence={state.preview?.mattingEvidence} />
        <Button className='flow-patch' disabled={busy || !state.preview} onClick={() => setPatch({ traceId: state.preview.traceId })}>手动修补边缘</Button>
        {patch && state.preview ? <AlphaPatch workPreviewPath={state.preview.preview} workW={state.preview.width} workH={state.preview.height}
          onApply={(strokes: any[]) => { setPatch(null); return flow.patch(strokes, patch.traceId); }} onCancel={() => setPatch(null)} /> : null}
        {mirror}
        <Button className='flow-next-dress' disabled={busy} onClick={() => flow.nextDress()}>下一步：换装（可选）</Button>
      </View> : null}

      {screen === 'dress' ? <View className='flow-screen screen-dress'>
        <Text className='t1-heading'>④ 换装（可选）</Text>
        {state.preview ? <Image src={state.preview.preview} className='preview' mode='aspectFit' /> : null}
        <Text className='tag'>研究用途；仅换装、不改五官；首次需下载约16MB解析模型，请核对领口与双肩</Text>
        {state.preview?.suitEvidence ? <Text className='suit-evidence'>信号来源：{state.preview.suitEvidence.source}；肩线{state.preview.suitEvidence.measuredShoulders ? `实测 ${state.preview.suitEvidence.shoulderAngleDeg}°` : '未可靠实测'}；脸部像素{state.preview.suitEvidence.pixelProtectionPassed ? '核验通过' : '未通过或未执行'}；视觉质量待人工验收</Text> : null}
        {!suitAvailability.ok ? <Text className='suit-unavailable'>{suitAvailability.message}（{suitAvailability.code}）</Text> : null}
        {suitAvailability.ok ? <View className='suit-consent' onClick={() => consent('suitSwap')}><Text>{p.consents.includes('suitSwap') ? '☑ ' : '☐ '}单独同意换装（可随时撤回）</Text></View> : null}
        <View className='suit-tpls'>{templates.map((tpl) => <View key={tpl.id} className={`suit-tpl${p.suit.templateId === tpl.id ? ' suit-tpl--sel' : ''}`}
          onClick={() => flow.update({ suit: { ...p.suit, templateId: tpl.id } })}>
          <Image src={tpl.src} className='suit-tpl__img' mode='aspectFit' /><Text>{tpl.name}</Text>
        </View>)}</View>
        <Button className='flow-apply-suit' disabled={busy || !suitAvailability.ok} onClick={() => flow.applySuit()}>应用换装并自检</Button>
        <Button className='flow-skip-suit' disabled={busy} onClick={() => flow.skipSuit()}>跳过换装，进入预审</Button>
      </View> : null}

      {screen === 'check' ? <View className='flow-screen screen-check'>
        <Text className='t1-heading'>⑤ 合规预审</Text>
        {state.preview ? <Image src={state.preview.preview} className='preview' mode='aspectFit' /> : null}
        <View className='precheck-results'>{state.preview?.result?.checks.map((item: any) => <View key={item.key} className='result-row'>
          <Text>{item.pass ? '✓ ' : '⚠ '}{item.label}</Text><Text>{item.detail}</Text>
        </View>)}</View>
        <Text className='tag'>预审仅供参考；头部占比缺失或构图不足须人工核对。文件大小在所选最终档位再次判定。</Text>
        <Button className='flow-next-dpi' disabled={busy} onClick={() => flow.goDpi()}>下一步：选择输出档位</Button>
      </View> : null}

      {screen === 'dpi' ? <View className='flow-screen screen-dpi'>
        <Text className='t1-heading'>⑥ 选择输出档位</Text>
        <DpiStep stepLabel='⑥ 输出档位' specId={p.specId} specName={spec.name} dpi={p.dpi} onChange={(dpi) => flow.setDpi(dpi)}
          srcW={p.source?.width} srcH={p.source?.height} effectiveW={p.cropWindow?.w} effectiveH={p.cropWindow?.h} processingW={state.preview?.pixelEvidence?.processingCrop?.width} processingH={state.preview?.pixelEvidence?.processingCrop?.height} />
        {mirror}
        <Button className='flow-confirm-dpi' disabled={busy || state.pendingSelf} onClick={() => flow.export()}>确认档位并生成最终成品</Button>
      </View> : null}

      {state.pendingSelf && report ? <View className='t1-modal-mask'><View className='t1-selfcheck' role='dialog'>
        <Text className='t1-heading'>请核对当前成品五官</Text>
        <Image src={report.preview} className='preview' mode='aspectFit' />
        <View className={`selfcheck${snapshot.selfChecked ? ' selfcheck--on' : ''}`} onClick={() => flow.confirmSelfCheck(!snapshot.selfChecked)}>
          <Text>{snapshot.selfChecked ? '☑ ' : '☐ '}我已核对五官未被改动</Text>
        </View>
        <Button className='flow-accept-selfcheck' disabled={!snapshot.selfChecked} onClick={() => flow.acceptSelfCheck()}>确认并继续</Button>
        <Button className='flow-self-back' onClick={back}>返回修改</Button>
      </View></View> : null}

      {screen === 'export' && state.finalResult ? <View className='flow-screen screen-export'>
        <Text className='t1-heading'>⑦ 成品已生成</Text>
        <Image src={state.finalResult.preview} className='preview' mode='aspectFit' />
        <MattingStatus evidence={state.finalResult.mattingEvidence} />
        <Text>{state.finalResult.width}×{state.finalResult.height}px · {state.finalResult.fileKb}KB · {p.dpi}档位 · JPG</Text>
        <Text className='tag'>免费 · 无水印；dpi表示输出像素档位，不承诺写入文件元数据。</Text>
        {state.finalResult.pixelEvidence?.sourceEnough === false || state.finalResult.pixelEvidence?.processingEnough === false ? <Text className='color-risk'>当前输出包含放大，增加像素不能补回原图或处理过程损失的细节。</Text> : null}
        <Button className='flow-save' onClick={() => consume('save', state.finalResult.traceId)}>保存到相册</Button>
        <Button className='flow-print' onClick={() => consume('print', state.finalResult.traceId)}>去冲印排版</Button>
      </View> : null}

      {busy ? <View className='t1-progress'><Text>处理中，请稍候…</Text><Button className='flow-cancel' onClick={() => flow.cancel()}>取消处理</Button></View> : null}
      {state.error ? <View className='flow-error'><Text className='status-line'>{state.error.message}（{state.error.code}{state.error.traceId ? `，${state.error.traceId}` : ''}）</Text>
        {state.error.retryable !== false ? <Button className='flow-retry' disabled={busy} onClick={() => flow.retry()}>重试当前步骤</Button> : null}</View> : null}
    </View>
  );
}
