"""生成共享照片工具页并用薄路由接入；原页面已归档。"""
from pathlib import Path
root=Path(__file__).resolve().parents[2]
original=(root/'idphoto-miniprogram/src/pages/tool-idphoto/index.tsx').read_text()
s=original.replace('Button, Image, Picker','Button, Image, Picker, Input, Switch')
s=s.replace("import './index.scss';", "import '../../pages/tool-idphoto/index.scss';\nimport BackgroundControl from '../BackgroundControl';")
s=s.replace("from '../../services'", "from '../../services'")
s=s.replace("export default function ToolIdPhoto() {", "export default function PhotoTool({ tool = 'T1' }: { tool?: string }) {")
s=s.replace('useT1Workflow();','useT1Workflow(tool);')
s=s.replace("  const consentItems = requiredConsents('T1');", "  const consentItems = requiredConsents(tool).filter((item: any) => item.id !== 'suitSwap');\n  const steps = T1_STEPS.filter(item => tool === 'T5' ? ['crop','dpi','export'].includes(item.key) : tool !== 'T2' || item.key !== 'dress');\n  const title = ({ T1: '一键证件照', T2: '单独换底色', T3: 'AI换装', T5: '规格转换' })[tool];\n  const target = p.customTarget || getPixelSize(p.specId, p.dpi)!;\n  const [customW, setCustomW] = useState('600'); const [customH, setCustomH] = useState('600');\n  const [limit, setLimit] = useState('200'); const [inputError, setInputError] = useState('');")
s=s.replace("buildConsentRecord('T1',", 'buildConsentRecord(tool,')
s=s.replace('    await flow.suggest();', "    if (tool !== 'T5') await flow.suggest();")
s=s.replace('一键证件照</Text>', '{title}</Text>')
s=s.replace('steps={T1_STEPS} current={T1_STEPS.findIndex','steps={steps} current={steps.findIndex')
s=s.replace("{ key: 'dress', label: '换装(可选)' }", "{ key: 'dress', label: '换装' }")
s=s.replace("        <View className={gate.hinted", "        {tool !== 'T5' ? <View className={gate.hinted",1)
s=s.replace("        {screen !== 'dress'", "        : null}\n        {screen !== 'dress'",1)
s=s.replace("        <Text className='tag'>{spec.source}</Text>", """        <Text className='tag'>{spec.source}</Text>
        {tool === 'T5' ? <View>
          <Text>自定义像素（1–5000），不随dpi翻倍；也可选上方标准规格</Text>
          <Input className='custom-width' value={customW} onInput={(e) => setCustomW(e.detail.value)} />
          <Input className='custom-height' value={customH} onInput={(e) => setCustomH(e.detail.value)} />
          <Button className='custom-apply' onClick={() => { const w = Number(customW); const h = Number(customH); if (!/^\\d+$/.test(customW) || !/^\\d+$/.test(customH) || !Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 5000 || h > 5000) { setInputError('自定义宽高须为1–5000整数'); return; } setInputError(''); flow.update({ customTarget: { width: w, height: h } }); }}>应用自定义像素</Button>
          <Text>{p.customTarget ? `当前自定义：${target.width}×${target.height}px` : '当前使用标准规格'}</Text>
        </View> : null}
        {inputError ? <Text className='input-error'>{inputError}</Text> : null}""")
s=s.replace("flow.update({ specId: specs[Number(event.detail.value)].id })", "flow.update({ specId: specs[Number(event.detail.value)].id, customTarget: null })")
s=s.replace('target={getPixelSize(p.specId, 300)!}', 'target={p.customTarget || getPixelSize(p.specId, 300)!}')
s=s.replace("specName={spec.name}", "specName={p.customTarget ? '自定义像素' : spec.name}")
s=s.replace("        <Text className='tag'>处理来源：", "        {tool === 'T2' ? <BackgroundControl value={p.bg} onChange={(value) => flow.background(value)} /> : null}\n        <Text className='tag'>处理来源：")
s=s.replace('下一步：换装（可选）</Button>', "{tool === 'T2' ? '下一步：合规预审' : tool === 'T3' ? '下一步：换装（必选）' : '下一步：换装（可选）'}</Button>")
s=s.replace('④ 换装（可选）</Text>', "④ 换装{tool === 'T3' ? '（必选）' : '（可选）'}</Text>")
s=s.replace("        <Button className='flow-skip-suit'", "        {tool === 'T1' ? <Button className='flow-skip-suit'")
s=s.replace('跳过换装，进入预审</Button>', '跳过换装，进入预审</Button> : null}')
s=s.replace("        <DpiStep stepLabel=", "        {tool === 'T5' ? <View><Text>KB上限（0表示不设压缩上限；无法满足时禁止保存）</Text><Input className='kb-input' value={limit} onInput={(e) => setLimit(e.detail.value)} /><Button className='kb-apply' onClick={() => { const kb = Number(limit); if (!limit.trim() || !Number.isFinite(kb) || kb < 0 || kb > 20000) { setInputError('KB上限须为0–20000'); return; } setInputError(''); flow.update({ kbLimit: kb }); }}>应用KB上限</Button>{inputError ? <Text>{inputError}</Text> : null}</View> : null}\n        <DpiStep noSpec={!!p.customTarget} stepLabel=")
s=s.replace("        <Text>{state.finalResult.width}", "        {state.finalResult.colorRisk ? <Text className='color-risk'>仅作为图像素材，不符合该证件底色要求；不能据此认定证件合规</Text> : null}\n        <Text>{state.finalResult.width}")
s=s.replace('档位 · JPG</Text>', "档位 · {state.finalResult.fileType === 'png' ? 'PNG' : 'JPG'}</Text>")
s=s.replace('import { useState }', 'import { useState }')
# 放在components下仍保持原有两级相对引用。
p=root/'idphoto-miniprogram/src/components/PhotoTool/index.tsx';p.parent.mkdir();p.write_text(s)
for page,tool in [('tool-bg','T2'),('tool-suit','T3'),('tool-spec','T5')]:
 (root/f'idphoto-miniprogram/src/pages/{page}/index.tsx').write_text(f"import PhotoTool from '../../components/PhotoTool';\nexport default function ToolPage() {{ return <PhotoTool tool='{tool}' />; }}\n")
