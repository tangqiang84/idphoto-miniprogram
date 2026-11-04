'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { selectAlbum } = require('../../idphoto-miniprogram/src/services/imageSelection');
test('新基础库chooseMedia与旧chooseImage都规范为同一照片/字节契约', async () => {
  let media = 0; let legacy = 0;
  const newer = await selectAlbum({ chooseMedia: async (input) => { media++; assert.deepEqual(input.mediaType, ['image']); return { tempFiles: [{ tempFilePath: 'fixture://media.jpg', size: 100 }] }; }, chooseImage: async () => { legacy++; } });
  assert.equal(newer.image.path, 'fixture://media.jpg'); assert.equal(media, 1); assert.equal(legacy, 0);
  const older = await selectAlbum({ chooseImage: async () => ({ tempFilePaths: ['fixture://old.png'], tempFiles: [{ size: 200 }] }) });
  assert.equal(older.image.size, 200);
});
test('取消、缺失接口、空结果与读取失败均结构化，原异常不向外暴露', async () => {
  assert.equal((await selectAlbum({ chooseMedia: async () => { throw { errMsg: 'chooseMedia:fail cancel' }; } })).error.cancelled, true);
  assert.equal((await selectAlbum({})).error.code, 'PICK_UNAVAILABLE');
  assert.equal((await selectAlbum({ chooseMedia: async () => ({ tempFiles: [] }) })).error.code, 'PICK_EMPTY');
  const failed = await selectAlbum({ chooseMedia: async () => { throw new Error('private-payload'); } });
  assert.equal(failed.error.code, 'PICK_FAILED'); assert.equal(JSON.stringify(failed).includes('private-payload'), false);
});
