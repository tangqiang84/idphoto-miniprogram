'use strict';
// automator 连接助手（P1 沉淀，2026-10-28）
//
// 【为什么要有这个模块】三个冒烟脚本各自写了一遍「连 IDE」逻辑，遇到同一类环境坑：
//   · 端口被 IDE 自身占用 → `Port 9420 is in use`（automator 需要 bind 一个**空闲**端口起 ws server，
//     IDE 再连回来；所以不能传 IDE 正在监听的端口）
//   · IDE 窗口未打开/未开启自动化 → `Failed connecting … check if target project window is opened
//     with automation enabled`
//   · IDE 正忙（编译中）→ `timeout waiting for automator response`
// 本助手统一处理：候选端口探测 → launch → 失败回退 connect → 有限重试，失败抛出可操作提示。
//
// 用法：
//   const { connectAutomator } = require('./automator_connect');
//   const mp = await connectAutomator({ projectPath: APP, port: 9431 });

const net = require('net');

const MOD = '/Users/tq/.workbuddy/binaries/node/workspace/node_modules/miniprogram-automator';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 端口是否空闲（automator 需要 bind 它）
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

/**
 * 连接（或拉起）微信开发者工具的自动化通道。
 *
 * @param {object} p
 * @param {string} p.projectPath 小程序工程绝对路径
 * @param {number} p.port        automator ws 端口（必须空闲）
 * @param {number} [p.timeout]   单次 launch/connect 超时（默认 60s）
 * @param {number} [p.retries]   失败重试次数（默认 2）
 * @returns {Promise<any>} miniProgram 实例
 */
async function connectAutomator(p = {}) {
  const projectPath = p.projectPath;
  const port = Number(p.port || 9420);
  const timeout = Number(p.timeout || 60000);
  const retries = Number(p.retries != null ? p.retries : 2);
  const automator = require(MOD);

  const free = await portFree(port);
  if (!free) {
    throw new Error(
      `端口 ${port} 已被占用（通常是开发者工具自身在监听）。automator 需要 bind 一个**空闲**端口，` +
      `请换端口后重跑，例如：--port ${port + 10}`
    );
  }

  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    try {
      return await automator.launch({ projectPath, port, timeout });
    } catch (e1) {
      lastErr = e1;
      const m = String((e1 && e1.message) || e1);
      console.log(`  · launch 第 ${i + 1} 次失败（${m.slice(0, 60)}），尝试 connect 复用 …`);
      try {
        return await automator.connect({ wsEndpoint: `ws://127.0.0.1:${port}` });
      } catch (e2) {
        lastErr = e2;
      }
      await sleep(5000);
    }
  }

  throw new Error(
    '无法连接开发者工具自动化通道。请确认：① 工具已启动；② 已打开本项目窗口；' +
      '③ 「设置 → 安全设置 → 服务端口」已开启；④ 工具未处于编译忙碌状态。' +
      `原始错误：${String((lastErr && lastErr.message) || lastErr).slice(0, 200)}`
  );
}

module.exports = { connectAutomator, portFree, sleep };
