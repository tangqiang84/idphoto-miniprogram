'use strict';
const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');
const manifest = require('./suit-assets/manifest.json');
const parsingModel = require('./suit-parsing-model/manifest.json');
const CHUNK_BYTES = 512 * 1024;
function handleSuitAsset(event) {
  const traceId = 'suit-asset-' + randomBytes(8).toString('hex');
  const fail = (code, message) => ({ ok: false, error: code, code, message, traceId });
  if (event.consent !== 'suitSwap') return fail('SUIT_CONSENT_REQUIRED', '请先同意换装');
  const isModel = event.action === 'suit-parsing-model';
  const item = isModel ? (event.templateId === parsingModel.id ? parsingModel : null) : manifest.find(t => t.id === event.templateId);
  if (!item || !Number.isInteger(event.chunk) || event.chunk < 0 || event.chunk >= Math.ceil(item.bytes / CHUNK_BYTES))
    return fail('SUIT_ASSET_REQUEST_INVALID', '模板或分片参数无效');
  let fd;
  try {
    fd = fs.openSync(path.join(__dirname, isModel ? 'suit-parsing-model' : 'suit-assets', item.asset), 'r');
    const offset = event.chunk * CHUNK_BYTES, buffer = Buffer.alloc(Math.min(CHUNK_BYTES, item.bytes - offset));
    const count = fs.readSync(fd, buffer, 0, buffer.length, offset);
    if (count !== buffer.length) throw new Error('ASSET_TRUNCATED');
    return { ok: true, templateId: item.id, chunk: event.chunk, chunks: Math.ceil(item.bytes / CHUNK_BYTES),
      sha256: item.sha256, bytes: item.bytes, dataB64: buffer.toString('base64'), traceId };
  } catch {
    console.warn('[suit-assets]', { traceId, code: 'SUIT_ASSET_UNAVAILABLE' });
    return fail('SUIT_ASSET_UNAVAILABLE', '模板暂不可用，请稍后重试');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
module.exports = { handleSuitAsset, CHUNK_BYTES };
