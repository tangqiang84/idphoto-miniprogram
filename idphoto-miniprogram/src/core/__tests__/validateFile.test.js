const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ALLOWED_FORMATS,
  MAX_SIZE_BYTES,
  getExt,
  checkFormat,
  checkSize,
  validateUpload,
} = require('../validateFile');

const MB = 1024 * 1024;

test('常量：允许格式与上限', () => {
  assert.deepEqual(ALLOWED_FORMATS, ['jpg', 'jpeg', 'png', 'webp']);
  assert.equal(MAX_SIZE_BYTES, 10 * MB);
});

test('getExt：常规 / 大小写 / 无扩展名 / query / hash / 段内无点', () => {
  assert.equal(getExt('a.png'), 'png');
  assert.equal(getExt('A.JPG'), 'jpg');
  assert.equal(getExt('x.jpeg'), 'jpeg');
  assert.equal(getExt('dir/d.webp?x=1'), 'webp');
  assert.equal(getExt('http://x/y.z#h'), 'z');
  assert.equal(getExt('b'), '');
  assert.equal(getExt('c.'), '');
  assert.equal(getExt('/noext'), '');
  assert.equal(getExt('a.b/c'), ''); // 段 c 无点
  assert.equal(getExt('a.b/c.png'), 'png');
});

test('checkFormat：扩展名合法即通过', () => {
  for (const f of ALLOWED_FORMATS) {
    const r = checkFormat(`x.${f}`, undefined);
    assert.equal(r.ok, true, `ext ${f} 应通过`);
    assert.equal(r.source, 'ext');
  }
});

test('checkFormat：扩展名缺失时用 type 兜底', () => {
  const r = checkFormat('x', 'png');
  assert.equal(r.ok, true);
  assert.equal(r.source, 'type');
});

test('checkFormat：两者都非法 → 拦截', () => {
  const r = checkFormat('x.gif', undefined);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'format');
  assert.match(r.message, /JPG \/ PNG \/ WebP/);
  const r2 = checkFormat('x', 'gif');
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'format');
});

test('checkSize：边界与降级', () => {
  assert.equal(checkSize(-1).ok, true); // 无法取得 → 降级放行
  assert.equal(checkSize(-1).degraded, true);
  assert.equal(checkSize(NaN).ok, true);
  assert.equal(checkSize(0).ok, true);
  assert.equal(checkSize(5 * MB).ok, true);
  assert.equal(checkSize(10 * MB).ok, true); // 边界：等于上限（≤）放行
  const over = checkSize(10 * MB + 1);
  assert.equal(over.ok, false);
  assert.equal(over.reason, 'size');
  assert.match(over.message, /10MB/);
});

test('validateUpload：组合通过', () => {
  const r = validateUpload('x.png', 'png', 1000);
  assert.equal(r.ok, true);
});

test('validateUpload：格式不符优先拦截', () => {
  const r = validateUpload('x.gif', undefined, 1000);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'format');
});

test('validateUpload：大小超限拦截（即便格式合法）', () => {
  const r = validateUpload('x.png', undefined, 20 * MB);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'size');
});

test('validateUpload：格式与大小都缺失但字节无法取得 → 仍因格式拦截', () => {
  const r = validateUpload('x', undefined, -1);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'format'); // 格式先判，失败即返回
});
