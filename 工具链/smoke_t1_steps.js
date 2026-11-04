'use strict';
// 真实微信UI与本地图像算法；只接受已禁用云请求的独立验证工程。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function main(args = process.argv.slice(2)) {
  if (args.includes('--help')) { console.log('node 工具链/smoke_t1_steps.js --app 禁云验证工程 [--port 9457] [--out 新目录]'); return 0; }
  for (let i = 0; i < args.length; i += 2) if (!['--app', '--out', '--port', '--consents', '--withdraw'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('ARGUMENT_INVALID');
  const get = (key, fallback) => { const i = args.indexOf(key); return i < 0 ? fallback : args[i + 1]; };
  const app = path.resolve(get('--app', path.join(ROOT, 'idphoto-miniprogram')));
  const port = Number(get('--port', '9457'));
  const consentMode = get('--consents', 'all'); const withdraw = get('--withdraw', 'no');
  if (!['all','local'].includes(consentMode) || !['yes','no'].includes(withdraw)) throw new Error('ARGUMENT_INVALID');
  const out = path.resolve(get('--out', path.join(ROOT, 'docs/验证记录/t1-steps', crypto.randomUUID())));
  if (!Number.isInteger(port) || port < 1 || port > 65535 || out.startsWith(app + path.sep) || out.startsWith(path.join(ROOT, '工具链') + path.sep) || out.startsWith(path.join(ROOT, 'idphoto-miniprogram') + path.sep)) throw new Error('ARGUMENT_INVALID');
  if (fs.existsSync(out)) throw new Error('OUTPUT_EXISTS');
  fs.mkdirSync(out, { recursive: true });
  const checks = []; let mini; let page;
  const report = { status: 'BLOCKED', scope: '真实微信UI/本地图像算法，云端适配器禁用；非真实云模型/双平台真机验收', app, checks,
    sample: 'REAL-111', traceId: crypto.randomUUID(), timestamp: new Date().toISOString(), artifacts: [], runtimeErrors: 0 };
  const write = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  try {
    if (!fs.existsSync(path.join(app, 'rc05-local-only.json'))) { checks.push({ status: 'BLOCKED', code: 'LOCAL_BUILD_REQUIRED' }); write(); return 3; }
    for (const name of ['cloudFnAdapter.ts', 'poseService.ts']) {
      if (!fs.readFileSync(path.join(app, 'src/services', name), 'utf8').includes('RC05_NETWORK_BLOCKED')) throw new Error('NETWORK_GUARD_MISSING');
    }
    const automator = require('/Users/tq/.workbuddy/binaries/node/workspace/node_modules/miniprogram-automator');
    mini = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:' + port });
    mini.on('exception', () => { report.runtimeErrors++; });
    const reconnect = async () => { await mini.disconnect(); mini = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:' + port }); mini.on('exception', () => { report.runtimeErrors++; }); };
    const stack = await mini.pageStack();
    if (!stack.length) throw new Error('PAGE_NOT_READY');
    page = await mini.currentPage();
    if (page.path !== 'pages/home/index') { await mini.callWxMethod('navigateBack', { delta: 10 }); await delay(2000); await reconnect(); page = await mini.currentPage(); }
    const cards = await page.$$('.tool-card');
    if (!cards.length) throw new Error('HOME_CARDS_MISSING');
    try { await cards[0].tap(); } catch {
      await delay(500);
      if ((await mini.currentPage()).path !== 'pages/tool-idphoto/index') throw new Error('T1_ROUTE_FAILED');
    }
    await delay(2000); await reconnect(); page = await mini.currentPage();
    const shot = async (name) => { const artifact = name + '-' + (report.artifacts.length + 1) + '.png'; const file = path.join(out, artifact); if (fs.existsSync(file)) throw new Error('OUTPUT_EXISTS'); await mini.pageScrollTo(0); await delay(200); await mini.screenshot({ path: file }); report.artifacts.push(artifact); };
    const wait = async (selector, ms = 45000) => {
      const start = Date.now();
      while (Date.now() - start < ms) { page = await mini.currentPage(); const element = await page.$(selector); if (element) return element; await delay(300); }
      throw new Error('STEP_TIMEOUT_' + selector);
    };
    const tap = async (selector) => { const element = await wait(selector); await mini.pageScrollTo(0); const offset = await element.offset(); await mini.pageScrollTo(Math.max(0, offset.top - 160)); await delay(150); await element.tap(); await delay(300); };
    const step = async (name) => { await wait('.screen-' + name); checks.push({ status: 'PASS', step: name }); await shot(name); };
    await step('upload');
    const consentItems = await page.$$('.consent__item');
    for (const item of consentMode === 'local' ? consentItems.slice(0,1) : consentItems) await item.tap();
    report.consentMode = consentMode;
    const sample = fs.readFileSync(path.join(ROOT, '素材/真实头像/111.jpg'));
    report.sample_sha256 = crypto.createHash('sha256').update(sample).digest('hex');
    const sandbox = await mini.evaluate(() => wx.env.USER_DATA_PATH);
    const image = sandbox + '/rc05-' + crypto.randomUUID() + '.jpg';
    await mini.evaluate((data, target) => { wx.getFileSystemManager().writeFileSync(target, data, 'base64'); }, sample.toString('base64'), image);
    const pickerApi = await mini.evaluate(() => typeof wx.chooseMedia === 'function' ? 'chooseMedia' : 'chooseImage');
    report.pickerApi = pickerApi;
    await mini.mockWxMethod(pickerApi, pickerApi === 'chooseMedia' ? { type: 'image', tempFiles: [{ tempFilePath: image, size: sample.length, fileType: 'image' }] } : { tempFilePaths: [image], tempFiles: [{ path: image, size: sample.length }] });
    await tap('.btn-primary'); await step('crop');
    await wait('.crop-apply');
    const idleStart = Date.now();
    while (await page.$('.t1-progress')) { if (Date.now() - idleStart > 45000) throw new Error('CROP_NOT_READY'); await delay(300); }
    const slider = await wait('.crop-zoom__slider');
    await slider.slideTo(100); await slider.trigger('change', { value: 100 }); await delay(350);
    const full = await (await page.$('.crop-box')).size();
    await slider.slideTo(80); await slider.trigger('change', { value: 80 }); await delay(350);
    const smaller = await (await page.$('.crop-box')).size();
    await slider.slideTo(80); await slider.trigger('change', { value: 80 }); await delay(350);
    const repeated = await (await page.$('.crop-box')).size();
    if (Math.abs(smaller.width / full.width - 0.8) > 0.02 || Math.abs(repeated.width - smaller.width) > 1) throw new Error('CROP_SCALE_INVALID');
    checks.push({ status: 'PASS', step: 'crop-scale', interaction: 'SDK slider position + change event (not physical-device gesture)', full, smaller, repeated });
    await shot('crop-adjusted');
    await tap('.crop-apply'); await step('beauty');
    await tap('.flow-back'); await wait('.screen-crop');
    const restored = await (await page.$('.crop-box')).size();
    if (Math.abs(restored.width - smaller.width) > 1) throw new Error('CROP_RETURN_LOST');
    checks.push({ status: 'PASS', step: 'crop-return' });
    await tap('.crop-apply'); await wait('.screen-beauty'); await shot('beauty-return');
    if (await page.$('.preview')) throw new Error('EARLY_PREVIEW');
    await tap('.flow-skip-beauty'); await step('preview');
    if (await page.$('.flow-save')) throw new Error('EARLY_SAVE');
    await tap('.mirror-check__box');
    await tap('.flow-next-dress'); await step('dress');
    await tap('.flow-skip-suit'); await step('check');
    await tap('.flow-next-dpi'); await step('dpi');
    await tap('.flow-confirm-dpi'); await step('export');
    const result = await page.$('.screen-export .preview'); const src = await result.attribute('src');
    const file = await mini.evaluate((target) => {
      const bytes = wx.getFileSystemManager().readFileSync(target, 'base64');
      return { bytes };
    }, src);
    const bytes = Buffer.from(file.bytes, 'base64');
    fs.writeFileSync(path.join(out, 'result.jpg'), bytes, { flag: 'wx' }); report.artifacts.push('result.jpg');
    report.result = { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    report.system = await mini.systemInfo();
    if (withdraw === 'yes') {
      if (consentMode !== 'local') throw new Error('LOCAL_MODE_REQUIRED');
      await mini.pageScrollTo(0); await (await page.$$('.consent__item'))[1].tap();
      await wait('.screen-beauty');
      if (await page.$('.flow-save')) throw new Error('CLOUD_CHANGE_REUSED_RESULT');
      checks.push({ status: 'PASS', step: 'cloud-consent-invalidates-output' }); await shot('cloud-change');
      await mini.pageScrollTo(0); await (await page.$$('.consent__item'))[1].tap();
      await mini.pageScrollTo(0); await (await page.$$('.consent__item'))[0].tap();
      await wait('.screen-upload');
      if (await page.$('.flow-save') || await page.$('.flow-resume')) throw new Error('WITHDRAW_REUSED_SOURCE');
      checks.push({ status: 'PASS', step: 'local-withdraw-clears-source' }); await shot('withdraw');
      await mini.pageScrollTo(0); await (await page.$$('.consent__item'))[0].tap();
      if (await page.$('.flow-save') || await page.$('.flow-resume')) throw new Error('REGRANT_REUSED_SOURCE');
      checks.push({ status: 'PASS', step: 'regrant-no-old-result' }); await shot('regrant');
    }
    report.status = report.runtimeErrors ? 'FAIL' : 'PASS';
    write(); console.log(JSON.stringify({ status: report.status, report: path.join(out, 'report.json') }));
    return report.status === 'PASS' ? 0 : 1;
  } catch (error) {
    report.status = mini ? 'FAIL' : 'BLOCKED';
    report.diagnostic = String(error.message || '').slice(0, 180).replace(/[A-Za-z0-9+/=]{80,}/g, '[redacted]');
    checks.push({ status: report.status, code: /^[A-Z0-9_.#-]+$/.test(error.message) ? error.message : 'IDE_STEP_ERROR' });
    if (mini) { try { await mini.screenshot({ path: path.join(out, 'failure.png') }); } catch {} }
    write(); console.log(JSON.stringify({ status: report.status, report: path.join(out, 'report.json'), code: checks.at(-1).code }));
    return mini ? 1 : 3;
  } finally { if (mini) { try { if (report.pickerApi) await mini.restoreWxMethod(report.pickerApi); await mini.disconnect(); } catch {} } }
}
module.exports = { main };
if (require.main === module) main().then((code) => { process.exitCode = code; }).catch(() => { console.error(JSON.stringify({ code: 'T1_UI_SETUP', message: '参数/输出目录不可用，旧产物未覆盖', traceId: crypto.randomUUID() })); process.exitCode = 2; });
