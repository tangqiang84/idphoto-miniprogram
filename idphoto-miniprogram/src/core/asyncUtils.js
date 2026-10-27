// 异步边界超时硬闸门（问题台账 #70，2026-10-27 真机「一直在处理中」复盘）
//
// 【事故】owner 真机验证 T3 换装：上传图片后永远转圈，无错误、无恢复路径。
// 根因不是某个具体调用失败，而是**跨设备异步边界没有超时兜底**：
//   · cloudFnAdapter 的 Taro.cloud.callFunction 无超时——真机上网络 stall /
//     云函数冷启动挂起 / 云环境未就绪，Promise 永不 resolve，页面 busy 永不复位；
//   · 模拟器上这些调用都是「秒回或秒错」，同样代码在沙箱验证 100% 通过——
//     与 #69 同根：**验证环境替生产环境回答了它回答不了的问题**。
//   · 图片加载 onload/onerror 在部分真机上也可能双不触发（#70 观察项）。
//
// 【纪律】每个跨设备异步边界必须同时满足：① 有超时上限 ② 超时错误带**原因码**
// （#67 纪律 6：UI 失败提示必须带原因码，否则现场无法区分，等于没有观测）。
// 上游 segment() 已能捕获云错误并降级出图——超时抛错后用户拿到的是
// 「带原因码的降级结果」，而不是永久转圈。

'use strict';

/** 云端抠图调用超时（百度链路实测 0.3–4.5s，留 3 倍以上余量） */
const CLOUD_CALL_TIMEOUT_MS = 15000;
/** 图片加载超时（相册大图 / 模板图） */
const IMG_LOAD_TIMEOUT_MS = 15000;
/** canvas 导出 + 文件信息读取超时 */
const EXPORT_TIMEOUT_MS = 20000;

/**
 * 给 Promise 竞速一个超时定时器：超时即 reject，错误消息带原因码。
 * 纯粹函数，无平台依赖，Node 可单测。
 *
 * @param {Promise<T>} p     原 Promise（不得为 null）
 * @param {number} ms        超时毫秒数（必须 > 0）
 * @param {string} code      原因码（会拼进错误消息，如 'cloudfn: 云端响应超时'）
 * @returns {Promise<T>}
 */
function withTimeout(p, ms, code) {
  if (!p || typeof p.then !== 'function') {
    return Promise.reject(new Error(String(code) + '（入参不是 Promise）'));
  }
  if (!(ms > 0)) {
    return Promise.reject(new Error(String(code) + '（超时参数非法：' + ms + '）'));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(String(code) + '（超时 ' + Math.round(ms / 1000) + 's）'));
    }, ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

module.exports = {
  withTimeout,
  CLOUD_CALL_TIMEOUT_MS,
  IMG_LOAD_TIMEOUT_MS,
  EXPORT_TIMEOUT_MS,
};
