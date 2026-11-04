"""派生RC-07微信串行逐步操作脚本，旧脚本保留。"""
from pathlib import Path
root=Path(__file__).resolve().parents[2]
s=(root/'工具链/smoke_t1_steps.js').read_text()
s=s.replace("'--withdraw'].includes", "'--withdraw', '--tool'].includes")
s=s.replace("  const port = Number", "  const tool = get('--tool', 'T1');\n  if (!['T1','T2','T5'].includes(tool)) throw new Error('TOOL_INVALID');\n  const port = Number")
s=s.replace('await cards[0].tap()', "await cards[({T1:0,T2:1,T5:4})[tool]].tap()")
s=s.replace("!== 'pages/tool-idphoto/index'", "!== ({T1:'pages/tool-idphoto/index',T2:'pages/tool-bg/index',T5:'pages/tool-spec/index'})[tool]")
start=s.index("    await tap('.crop-apply'); await step('beauty');")
end=s.index("    await tap('.flow-confirm-dpi'); await step('export');",start)
s=s[:start]+'''    await tap('.crop-apply');
    if (tool === 'T5') {
      await step('dpi'); await tap('.mirror-check__box');
    } else {
      await step('beauty');
      await tap('.flow-back'); await wait('.screen-crop');
      const restored = await (await page.$('.crop-box')).size();
      if (Math.abs(restored.width - smaller.width) > 1) throw new Error('CROP_RETURN_LOST');
      checks.push({ status: 'PASS', step: 'crop-return' });
      await tap('.crop-apply'); await wait('.screen-beauty'); await shot('beauty-return');
      if (await page.$('.preview')) throw new Error('EARLY_PREVIEW');
      await tap('.flow-skip-beauty'); await step('preview');
      if (await page.$('.flow-save')) throw new Error('EARLY_SAVE');
      if (tool === 'T2') { await tap('.color-transparent'); await wait('.screen-preview'); }
      await tap('.mirror-check__box');
      await tap('.flow-next-dress');
      if (tool === 'T1') { await step('dress'); await tap('.flow-skip-suit'); }
      await step('check'); await tap('.flow-next-dpi'); await step('dpi');
    }
''' +s[end:]
s=s.replace("path.join(out, 'result.jpg')", "path.join(out, tool === 'T2' ? 'result.png' : 'result.jpg')").replace("report.artifacts.push('result.jpg')", "report.artifacts.push(tool === 'T2' ? 'result.png' : 'result.jpg')")
s=s.replace("sample: 'REAL-111'", "tool, sample: 'REAL-111'")
with (root/'工具链/smoke_rc07.js').open('x') as f:f.write(s)
