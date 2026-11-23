'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { purgeWithWx } = require('../../../idphoto-miniprogram/src/core/localPurge');

async function main() {
  const dir = await fs.mkdtemp('/tmp/idphoto-purge-probe-');
  const ownedFile = dir + '/probe.png';
  const controlFile = dir + '/control.txt';
  const missingFile = dir + '/missing.png';
  await fs.writeFile(ownedFile, 'synthetic fixture', { flag: 'wx' });
  await fs.writeFile(controlFile, 'control', { flag: 'wx' });
  const calls = [];
  const result = await purgeWithWx([missingFile, ownedFile, controlFile, ownedFile], {
    getFileSystemManager: () => ({
      unlink({ filePath, success, fail }) {
        calls.push(filePath);
        assert.ok(filePath === missingFile || filePath === ownedFile);
        fs.unlink(filePath).then(success, fail);
      },
    }),
  });

  assert.deepEqual(calls, [missingFile, ownedFile]);
  assert.deepEqual(result.deleted, [ownedFile]);
  assert.deepEqual(result.failed, [{ path: missingFile, error: 'unlink_failed' }]);
  await assert.rejects(fs.stat(ownedFile), { code: 'ENOENT' });
  assert.equal(await fs.readFile(controlFile, 'utf8'), 'control');
  console.log(JSON.stringify({
    status: 'PASS',
    scope: '本机实际 unlink，微信接口桥接',
    observedAt: new Date().toISOString(),
    platform: process.platform,
    deletedPathAbsent: true,
    otherFilePreserved: true,
    missingFileReported: true,
    duplicateProcessedOnce: true,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.code || 'PURGE_PROBE_FAILED');
  process.exitCode = 1;
});
