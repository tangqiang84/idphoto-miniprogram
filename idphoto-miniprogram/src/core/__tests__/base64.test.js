/**
 * base64 纯 JS 实现单测（2026-10-27，任务 #52 续）
 * 关键断言：**与 Node Buffer 的结果逐字节一致** —— 保证小程序端（无 Buffer/btoa/atob）
 * 与 Node 单测/云函数侧解码出的是同一份数据。
 */
const test = require('node:test');
const assert = require('node:assert');
const { bytesToBase64, base64ToBytes } = require('../base64');

test('编码结果与 Buffer 一致（长度 0/1/2/3 及多字节组合）', () => {
  const cases = [[], [0], [0, 1], [0, 1, 2], [255], [0, 255, 128, 64, 32, 16]];
  for (const arr of cases) {
    const bytes = new Uint8Array(arr);
    const mine = bytesToBase64(bytes);
    const node = Buffer.from(bytes).toString('base64');
    assert.strictEqual(mine, node, `bytes=[${arr}] 编码不一致`);
  }
});

test('随机 1000 字节与 Buffer 完全一致', () => {
  const bytes = new Uint8Array(1000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 11) & 0xff;
  assert.strictEqual(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'));
});

test('解码结果与 Buffer 一致（含 padding 变体）', () => {
  for (const b64 of ['', 'AA==', 'AAE=', 'AAEC', Buffer.from('hello world').toString('base64')]) {
    const mine = base64ToBytes(b64);
    const node = new Uint8Array(Buffer.from(b64, 'base64'));
    assert.strictEqual(mine.length, node.length, `长度不一致 b64=${b64}`);
    for (let i = 0; i < node.length; i++) {
      assert.strictEqual(mine[i], node[i], `第 ${i} 字节不一致 b64=${b64}`);
    }
  }
});

test('往返一致（编码→解码→原字节）', () => {
  const bytes = new Uint8Array(256);
  for (let i = 0; i < 256; i++) bytes[i] = i;
  const back = base64ToBytes(bytesToBase64(bytes));
  assert.strictEqual(back.length, 256);
  for (let i = 0; i < 256; i++) assert.strictEqual(back[i], i);
});

test('解码能忽略换行/空白（云函数返回常带换行）', () => {
  const raw = Buffer.from([1, 2, 3, 4, 5, 6]).toString('base64');
  const withNl = raw.slice(0, 4) + '\n' + raw.slice(4);
  assert.strictEqual(base64ToBytes(withNl).length, 6);
});

test('不依赖 Buffer / btoa / atob（模拟小程序运行时）', () => {
  const saved = { Buffer: global.Buffer, btoa: global.btoa, atob: global.atob };
  try {
    delete global.Buffer;
    delete global.btoa;
    delete global.atob;
    const bytes = new Uint8Array([72, 101, 108, 108, 111]);
    assert.strictEqual(bytesToBase64(bytes), 'SGVsbG8=');
    assert.strictEqual(base64ToBytes('SGVsbG8=').length, 5);
  } finally {
    if (saved.Buffer) global.Buffer = saved.Buffer;
    if (saved.btoa) global.btoa = saved.btoa;
    if (saved.atob) global.atob = saved.atob;
  }
});
