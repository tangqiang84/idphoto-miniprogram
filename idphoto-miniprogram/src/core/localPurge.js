'use strict';
const { withTimeout } = require('./asyncUtils');
// 处理完成后本地临时文件销毁（PRD I2「处理完成后本地销毁」）
//
// 【为什么需要它】小程序里每一步图像处理都会落临时文件：
//   选图（wx.chooseMedia → tempFilePath）→ 抠图工作图 → 抠图结果 → 合成结果 → 导出预览 → 排版图。
//   这些文件默认留在 wx 的临时目录里，**用户不主动清理就一直占着存储**，
//   也与「处理完即销毁、不留副本」的隐私承诺不符（PRD I2）。
//
// 【设计取舍】
//   · 核心逻辑是**纯函数**（collectTempPaths / purgeTempFiles），文件系统通过适配器注入 →
//     Node 可直接单测，不依赖 wx API；
//   · 提供一个 wx 包装（purgeWithWx）把 wx.getFileSystemManager().unlink 适配成同样的接口；
//   · **单个文件删除失败不阻断其它文件** —— 清理是「尽力而为」，
//     一个文件被占用/不存在不该导致其它临时文件全部残留；
//   · 只删「本次处理产生的临时文件」：按路径前缀/扩展名规则筛选，
//     绝不误删用户相册里的原图（相册路径不以临时目录前缀开头）。
//
// 【不做的事】不做递归目录清理（小程序临时目录不产生子目录），不做「配额管理」。

// 临时文件路径特征（微信小程序）：
//   · wxfile://tmp_xxxxxxxx  —— chooseMedia / saveFile 的临时文件
//   · http://tmp/xxxxxxxx   —— canvasToTempFilePath 等产生的临时文件
//   · /tmp/xxxxxxxx        —— 部分平台的沙盒路径
//
// ⚠️ **不含** wxfile://usr/（用户持久化目录）：那里的文件是用户主动保存的成果
//    （saveFile / 相册），不属于「本次处理产生的临时文件」，删了就是数据丢失。
const TEMP_PATH_PREFIXES = [
  'wxfile://tmp_',
  'http://tmp/',
  'https://tmp/',
  '/tmp/',
];

/** 临时文件的扩展名白名单（图片类产物） */
const TEMP_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.heic'];

/** 取文件扩展名（小写，含点）；无扩展名返回 '' */
function extOf(p) {
  const s = String(p);
  const q = s.split(/[?#]/)[0]; // 去掉 query/fragment
  const i = q.lastIndexOf('.');
  if (i < 0) return '';
  const slash = q.lastIndexOf('/');
  if (i < slash) return '';
  return q.slice(i).toLowerCase();
}

/**
 * 从一组路径里筛出「本次处理产生的临时文件」。
 *
 * 规则（两条都满足才算）：
 *   1) 路径前缀命中临时目录特征（TEMP_PATH_PREFIXES）；
 *   2) 扩展名在图片白名单里（TEMP_EXTS）。
 * 去重且保持原顺序；非法输入（非字符串/空串）跳过。
 *
 * @param {string[]} paths 候选路径（可以包含用户相册原图、可以包含非临时文件）
 * @param {{prefixes?:string[], exts?:string[]}} [opts] 可覆盖默认规则
 * @returns {string[]} 待删清单
 */
function collectTempPaths(paths, opts = {}) {
  if (!Array.isArray(paths)) return [];
  const prefixes = Array.isArray(opts.prefixes) ? opts.prefixes : TEMP_PATH_PREFIXES;
  const exts = Array.isArray(opts.exts) ? opts.exts : TEMP_EXTS;
  const out = [];
  const seen = new Set();
  for (const p of paths) {
    if (typeof p !== 'string') continue;
    const s = p.trim();
    if (!s) continue;
    if (/[\\%?#\x00-\x20]/.test(s) || s.split('/').some(part => part === '..' || part === '.')) continue;
    if (seen.has(s)) continue;
    const hitPrefix = prefixes.some((pre) => s.startsWith(pre));
    if (!hitPrefix) continue;
    const ext = extOf(s);
    if (!ext || exts.indexOf(ext) < 0) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * 逐个删除临时文件。
 *
 * @param {string[]} paths 待删路径（建议先过 collectTempPaths）
 * @param {{unlink:(path:string)=>Promise<void>|void}} fsAdapter 文件系统适配器（注入，便于单测）
 * @returns {Promise<{deleted:string[], failed:Array<{path:string,error:string}>}>}
 *          单个失败不阻断其它文件；失败原因用字符串记录（不抛异常给调用方）
 */
async function purgeTempFiles(paths, fsAdapter) {
  const deleted = [];
  const failed = [];
  paths = collectTempPaths(paths);
  if (!paths.length) return { deleted, failed };
  if (!fsAdapter || typeof fsAdapter.unlink !== 'function') {
    // 没有适配器 → 一个都删不掉，但**如实报告**，不假装成功
    for (const p of paths) failed.push({ path: p, error: 'no_fs_adapter' });
    return { deleted, failed };
  }
  for (const p of paths) {
    if (typeof p !== 'string' || !p) continue;
    try {
      await fsAdapter.unlink(p);
      deleted.push(p);
    } catch (e) {
      // 单个失败不阻断：记录后继续删下一个
      failed.push({ path: p, error: e?.code === 'ASYNC_TIMEOUT' ? 'unlink_timeout' : 'unlink_failed' });
    }
  }
  return { deleted, failed };
}

/**
 * wx 包装：把 wx.getFileSystemManager() 适配成 purgeTempFiles 需要的 unlink 接口。
 *
 * 注意：这里**不 require('wx')**，而是从全局取（小程序运行时 wx 是全局对象），
 * 以保持本模块在 Node 单测环境里可安全 require（Node 里没有 wx，会走降级分支）。
 *
 * @param {string[]} paths 待删路径
 * @param {{getFileSystemManager?:Function}} [wxApi] 注入 wx 对象（默认取全局 wx）
 * @returns {Promise<{deleted:string[], failed:Array<{path:string,error:string}>}>}
 */
async function purgeWithWx(paths, wxApi) {
  paths = collectTempPaths(paths);
  if (!paths.length) return { deleted: [], failed: [] };
  const api =
    wxApi ||
    (typeof globalThis !== 'undefined' && globalThis.wx ? globalThis.wx : null);
  if (!api || typeof api.getFileSystemManager !== 'function') {
    const list = Array.isArray(paths) ? paths : [];
    const failed = [];
    for (const p of list) failed.push({ path: p, error: 'no_wx_api' });
    return { deleted: [], failed };
  }
  let fs;
  try { fs = api.getFileSystemManager(); } catch { return purgeTempFiles(paths, null); }
  if (typeof fs?.unlink !== 'function') return purgeTempFiles(paths, null);
  const adapter = {
    unlink(filePath) {
      return withTimeout(new Promise((resolve, reject) => {
        fs.unlink({
          filePath,
          success: () => resolve(),
          fail: reject,
        });
      }), 3000, 'unlink:timeout');
    },
  };
  return purgeTempFiles(paths, adapter);
}

module.exports = {
  collectTempPaths,
  purgeTempFiles,
  purgeWithWx,
  TEMP_PATH_PREFIXES,
  TEMP_EXTS,
  extOf,
};
