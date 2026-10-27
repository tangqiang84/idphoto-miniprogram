/**
 * 冒烟脚本共享工具包（2026-10-27 新增，任务 #50 的配套）
 *
 * 为什么要有这个文件：
 *   1) **判定不能靠整页文本关键词**。镜像自查的静态文案里含「会导致审核**失败**」，
 *      被 `pageText.includes('失败')` 判定为「处理失败」→ smoke_t5 误报（真实故障是好的）。
 *      同类问题已第 2 次发生（smoke_t3 找导出按钮时文案变体没同步），
 *      按纪律升级载体：把「处理状态」与「展示文案」**分离**——页面状态行统一带
 *      `className='status-line'`，冒烟只读这一行做判定。
 *   2) 页面文本要同时抓 `<text>` 与 `<button>`（Taro Button 编译成 button 标签），
 *      只抓 text 会漏按钮文案（已在 smoke_print 中踩过）。
 *
 * 用法：
 *   const { readStatus, readPageText, waitForStatus } = require('./smoke_kit');
 *   const st = await readStatus(page);            // 状态行文本（无则 ''）
 *   if (st.includes('完成')) { ... }
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 读整页文本（text + button），用于内容断言 */
async function readPageText(page) {
  const parts = [];
  for (const sel of ['text', 'button']) {
    try {
      const vs = await page.$$(sel);
      for (const v of vs) {
        try { parts.push((await v.text()) || ''); } catch (_) {}
      }
    } catch (e) { /* ignore */ }
  }
  return parts.join(' ');
}

/**
 * 读页面**状态行**（.status-line）——处理成功/失败的唯一判定来源。
 * 读不到返回 ''（页面未渲染状态行时，调用方自行回退到全页文本判定）。
 */
async function readStatus(page) {
  try {
    const el = await page.$('.status-line');
    if (!el) return '';
    return (await el.text()) || '';
  } catch (e) {
    return '';
  }
}

/**
 * 轮询直到状态行命中任一关键字。
 * @param {object} page
 * @param {string[]} keys 命中关键字（如 ['完成','失败']）
 * @param {number} timeoutSec 超时秒数
 * @param {object} [opts] { fallbackToPageText: boolean } 页面没有 .status-line 时回退整页文本
 * @returns {Promise<{hit: boolean, status: string, pageText: string}>}
 */
async function waitForStatus(page, keys, timeoutSec = 45, opts = {}) {
  const useFallback = opts.fallbackToPageText !== false;
  let status = '';
  let pageText = '';
  for (let i = 0; i < timeoutSec; i++) {
    await sleep(1000);
    status = await readStatus(page);
    pageText = await readPageText(page);
    const hay = status || (useFallback ? pageText : '');
    if (hay && keys.some((k) => hay.includes(k))) {
      return { hit: true, status, pageText };
    }
  }
  return { hit: false, status, pageText };
}

module.exports = { sleep, readPageText, readStatus, waitForStatus };
