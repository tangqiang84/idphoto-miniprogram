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
const { execSync } = require('child_process');

/**
 * 探测开发者工具当前正在监听的**自动化端口**（wechatweb 进程）。
 * 【2026-10-28 实测】IDE 重启/多次会话后，只有「当前正在监听的那个端口」能被 connect 复用；
 * 传一个全新端口 → launch 会把 IDE 的服务挪到新端口，旧端口失效。
 * 故：优先复用已监听的端口（launch 报 "Port in use" → 自动回退 connect → 可用）。
 * @returns {number|null}
 */
function detectIdeAutoPort() {
  try {
    const out = execSync("lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep wechatweb || true",
      { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      const m = line.match(/:(\d+)\s+\(LISTEN\)/);
      if (m) {
        const p = Number(m[1]);
        // 排除 IDE 自己的 HTTP 服务端口（通常 16780 段），只取 94xx 段的自动化端口
        if (p >= 9400 && p <= 9500) return p;
      }
    }
  } catch (e) { /* 探测失败不影响主流程 */ }
  return null;
}

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
  // 【2026-10-28 根因修复】automator 的 launch 内部跑 `cli auto --auto-port <p>`，
  // 而 `cli` 默认连 IDE 的 HTTP 服务端口 9420；本机 9420 被其它程序占用（返回 502），
  // 于是 IDE 永远连不回来 → 报 "Failed to launch … please make sure http port is open"。
  // 修法：给 cli 显式传 IDE 的真实 HTTP 端口（开发者工具 → 设置 → 安全设置 → 服务端口，
  // 本机实测 16780；可用环境变量 IDE_HTTP_PORT 覆盖）。
  const idePort = String(p.idePort || process.env.IDE_HTTP_PORT || 16780);
  const args = ['--port', idePort];

  // 端口被 IDE 占用 → 说明那就是活的自动化端口，直接复用（launch 会报错，随后 connect 成功）
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
      return await automator.launch({ projectPath, port, timeout, args });
    } catch (e1) {
      lastErr = e1;
      const m = String((e1 && e1.message) || e1);
      console.log(`  · launch 第 ${i + 1} 次失败（${m.slice(0, 60)}）`);
      // 【2026-10-28 实测】launch 超时时 IDE **其实已经把自动化服务开起来了**（会监听我们传的
      // port），只是 automator 侧没等到 IDE 回连 → 此时直接 connect 同端口即可用（页面已就绪）。
      await sleep(3000);
      try {
        return await automator.connect({ wsEndpoint: `ws://127.0.0.1:${port}` });
      } catch (e2) {
        lastErr = e2;
        console.log(`  · connect 复用也失败（${String((e2 && e2.message) || e2).slice(0, 50)}），重试 launch …`);
      }
      await sleep(3000);

      // 【2026-10-28 实测兜底】IDE 侧没有活会话时，用官方 CLI 手动开启自动化通道：
      //   cli auto --project <工程> --auto-port <port> --port <IDE HTTP 端口>
      // 成功后 IDE 会在 <port> 上监听 → 下一轮 connect 即可用（实测有效）。
      if (i === retries - 1) {
        try {
          const CLI = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli';
          execSync(
            `"${CLI}" auto --project "${projectPath}" --auto-port ${port} --port ${idePort}`,
            { encoding: 'utf8', stdio: 'ignore', timeout: 60000 },
          );
          console.log('  · 已用 cli auto 开启 IDE 自动化通道，重试 connect …');
          await sleep(6000);
          try {
            return await automator.connect({ wsEndpoint: `ws://127.0.0.1:${port}` });
          } catch (e3) {
            lastErr = e3;
          }
        } catch (e4) {
          lastErr = e4;
        }
      }
    }
  }

  throw new Error(
    '无法连接开发者工具自动化通道。请确认：① 工具已启动；② 已打开本项目窗口；' +
      '③ 「设置 → 安全设置 → 服务端口」已开启（IDE HTTP 端口需与 IDE_HTTP_PORT 一致，默认 16780）；④ 工具未处于编译忙碌状态。' +
      `原始错误：${String((lastErr && lastErr.message) || lastErr).slice(0, 200)}`
  );
}

module.exports = { connectAutomator, portFree, sleep, detectIdeAutoPort };
