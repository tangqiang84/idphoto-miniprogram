'use strict';
const MODEL_SHA = 'a93a8dac171b5c1fcc53632a8bfc180bfd9759ea69a3e207451bb07f76add54f';
const PROVIDER = 'segformer-b2-clothes-onnx-cpu';
function decodeSuitClasses(labels, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 2048 || height > 2048 || width * height > 1600000 || labels?.length !== width * height || !labels.every(v => Number.isInteger(v) && v >= 0 && v < 18)) {
    throw {code: 'SUIT_CLOTHING_INVALID', message: '服装识别结果无效'};
  }
  // 保护两个输出采样格内的头发边缘，保留原始高分辨率matte。
  const radius = Math.ceil(Math.max(width, height) / 128) * 2;
  const stride = width + 1, integral = new Uint32Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += labels[y * width + x] === 2 ? 1 : 0;
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + row;
    }
  }
  const clothing = new Uint8Array(labels.length), background = new Uint8Array(labels.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x, label = labels[i];
    clothing[i] = [4, 5, 6, 7, 8, 17].includes(label) ? 1 : 0;
    const left = Math.max(0, x - radius), top = Math.max(0, y - radius);
    const right = Math.min(width, x + radius + 1), bottom = Math.min(height, y + radius + 1);
    const hair = integral[bottom * stride + right] - integral[top * stride + right] - integral[bottom * stride + left] + integral[top * stride + left];
    background[i] = label === 0 && hair === 0 ? 1 : 0;
  }
  return {clothing, background, backgroundMode: 'face-exterior'};
}
module.exports = {MODEL_SHA, PROVIDER, decodeSuitClasses};
