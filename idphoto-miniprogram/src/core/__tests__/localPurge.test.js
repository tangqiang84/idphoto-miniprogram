'use strict';
// localPurge 单测（PRD I2：处理完成后本地销毁）
const { test } = require('node:test');
const assert = require('node:assert');
const {
  collectTempPaths,
  purgeTempFiles,
  purgeWithWx,
  extOf,
} = require('../localPurge');

// ---------- collectTempPaths ----------

test('collectTempPaths：只挑出临时目录 + 图片扩展名的路径', () => {
  const r = collectTempPaths([
    'wxfile://tmp_abc123.jpg',
    'http://tmp/def456.png',
    '/tmp/ghi789.jpeg',
  ]);
  assert.deepStrictEqual(r, [
    'wxfile://tmp_abc123.jpg',
    'http://tmp/def456.png',
    '/tmp/ghi789.jpeg',
  ]);
});

test('collectTempPaths：相册原图（非临时路径）不进待删清单', () => {
  const r = collectTempPaths([
    'wxfile://usr/keep_me.jpg', // 用户目录 → 不属于「本次处理产生的临时文件」
    'wxfile://tmp_tmp.jpg',
    'https://example.com/remote.jpg',
  ]);
  assert.deepStrictEqual(r, ['wxfile://tmp_tmp.jpg']);
});

test('collectTempPaths：非图片扩展名被排除', () => {
  const r = collectTempPaths(['wxfile://tmp_a.json', 'wxfile://tmp_b.dat']);
  assert.deepStrictEqual(r, []);
});

test('collectTempPaths：去重 + 保持原顺序 + 跳过非法输入', () => {
  const r = collectTempPaths([
    'wxfile://tmp_a.jpg',
    'wxfile://tmp_a.jpg',
    null,
    undefined,
    123,
    '',
    '   ',
    'wxfile://tmp_b.png',
  ]);
  assert.deepStrictEqual(r, ['wxfile://tmp_a.jpg', 'wxfile://tmp_b.png']);
});

test('collectTempPaths：非数组输入返回空数组（不抛）', () => {
  assert.deepStrictEqual(collectTempPaths(null), []);
  assert.deepStrictEqual(collectTempPaths(undefined), []);
  assert.deepStrictEqual(collectTempPaths('not-an-array'), []);
});

test('extOf：取小写扩展名，正确处理 query 与无扩展名', () => {
  assert.strictEqual(extOf('wxfile://tmp_a.JPG'), '.jpg');
  assert.strictEqual(extOf('http://tmp/b.png?x=1'), '.png');
  assert.strictEqual(extOf('wxfile://tmp_c'), '');
});

// ---------- purgeTempFiles ----------

test('purgeTempFiles：全部成功 → deleted 全收，failed 为空', async () => {
  const seen = [];
  const adapter = {
    unlink: async (p) => {
      seen.push(p);
    },
  };
  const r = await purgeTempFiles(['wxfile://tmp_a.jpg', 'wxfile://tmp_b.png'], adapter);
  assert.deepStrictEqual(r.deleted, ['wxfile://tmp_a.jpg', 'wxfile://tmp_b.png']);
  assert.deepStrictEqual(r.failed, []);
  assert.deepStrictEqual(seen, ['wxfile://tmp_a.jpg', 'wxfile://tmp_b.png']);
});

test('purgeTempFiles：部分失败 → 成功的仍记录，失败的带原因，且不阻断后续', async () => {
  const adapter = {
    unlink: async (p) => {
      if (p === 'wxfile://tmp_bad.jpg') throw new Error('EBUSY: file in use');
    },
  };
  const r = await purgeTempFiles(
    ['wxfile://tmp_a.jpg', 'wxfile://tmp_bad.jpg', 'wxfile://tmp_c.jpg'],
    adapter,
  );
  assert.deepStrictEqual(r.deleted, ['wxfile://tmp_a.jpg', 'wxfile://tmp_c.jpg']);
  assert.strictEqual(r.failed.length, 1);
  assert.strictEqual(r.failed[0].path, 'wxfile://tmp_bad.jpg');
  assert.strictEqual(r.failed[0].error, 'unlink_failed');
});

test('purgeTempFiles：适配器抛错不中断后续文件（同步 throw 也一样）', async () => {
  const adapter = {
    unlink: (p) => {
      if (p === 'wxfile://tmp_x.jpg') throw new Error('boom');
      return Promise.resolve();
    },
  };
  const r = await purgeTempFiles(['wxfile://tmp_x.jpg', 'wxfile://tmp_y.jpg'], adapter);
  assert.deepStrictEqual(r.deleted, ['wxfile://tmp_y.jpg']);
  assert.strictEqual(r.failed.length, 1);
  assert.strictEqual(r.failed[0].error, 'unlink_failed');
});

test('purgeTempFiles：空输入 → 空结果，不调适配器', async () => {
  let called = 0;
  const adapter = {
    unlink: async () => {
      called++;
    },
  };
  const r = await purgeTempFiles([], adapter);
  assert.deepStrictEqual(r, { deleted: [], failed: [] });
  assert.strictEqual(called, 0);
  const r2 = await purgeTempFiles(null, adapter);
  assert.deepStrictEqual(r2, { deleted: [], failed: [] });
  assert.strictEqual(called, 0);
});

test('purgeTempFiles：无适配器 → 如实报告全部失败，不假装成功', async () => {
  const r = await purgeTempFiles(['wxfile://tmp_a.jpg'], null);
  assert.deepStrictEqual(r.deleted, []);
  assert.strictEqual(r.failed.length, 1);
  assert.strictEqual(r.failed[0].error, 'no_fs_adapter');
});

// ---------- purgeWithWx ----------

test('purgeWithWx：注入 wx 适配器 → 走 unlink 并汇总结果', async () => {
  const calls = [];
  const wxApi = {
    getFileSystemManager: () => ({
      unlink: ({ filePath, success, fail }) => {
        calls.push(filePath);
        if (filePath === 'wxfile://tmp_bad.jpg') fail({ errMsg: 'unlink:fail' });
        else success();
      },
    }),
  };
  const r = await purgeWithWx(
    ['wxfile://tmp_a.jpg', 'wxfile://tmp_bad.jpg', 'wxfile://tmp_c.jpg'],
    wxApi,
  );
  assert.deepStrictEqual(calls, [
    'wxfile://tmp_a.jpg',
    'wxfile://tmp_bad.jpg',
    'wxfile://tmp_c.jpg',
  ]);
  assert.deepStrictEqual(r.deleted, ['wxfile://tmp_a.jpg', 'wxfile://tmp_c.jpg']);
  assert.strictEqual(r.failed.length, 1);
  assert.strictEqual(r.failed[0].error, 'unlink_failed');
});

test('purgeWithWx：环境没有 wx → 如实报告失败，不抛异常', async () => {
  const r = await purgeWithWx(['wxfile://tmp_a.jpg'], {});
  assert.deepStrictEqual(r.deleted, []);
  assert.strictEqual(r.failed[0].error, 'no_wx_api');
});

test('端到端：collectTempPaths → purgeTempFiles 只删临时图', async () => {
  const paths = [
    'wxfile://tmp_work.jpg',
    'wxfile://tmp_export.png',
    'wxfile://usr/saved_album.jpg', // 用户相册 → 不删
    'wxfile://tmp_meta.json', // 非图片 → 不删
  ];
  const target = collectTempPaths(paths);
  const deleted = [];
  const adapter = { unlink: async (p) => { deleted.push(p); } };
  const r = await purgeTempFiles(target, adapter);
  assert.deepStrictEqual(r.deleted, ['wxfile://tmp_work.jpg', 'wxfile://tmp_export.png']);
  assert.deepStrictEqual(deleted, r.deleted);
});

test('RC-11 直接调用清理接口也拒绝持久目录、路径穿越和带查询的文件', async () => {
  const calls = [];
  const result = await purgeWithWx([
    'wxfile://usr/keep.jpg', '/tmp/../private.jpg', 'http://tmp/%2e%2e/private.jpg',
    'http://tmp/work.jpg?private_token=x', 'http://tmp/work.jpg', 'http://tmp/work.jpg',
  ], { getFileSystemManager: () => ({ unlink: ({filePath, success}) => { calls.push(filePath); success(); } }) });
  assert.deepStrictEqual(calls, ['http://tmp/work.jpg']);
  assert.deepStrictEqual(result.deleted, calls);
});

test('RC-11 文件系统初始化失败不会泄露平台异常', async () => {
  const result = await purgeWithWx(['http://tmp/work.jpg'], { getFileSystemManager() { throw new Error('private_token'); } });
  assert.deepStrictEqual(result, { deleted: [], failed: [{ path: 'http://tmp/work.jpg', error: 'no_fs_adapter' }] });
});
