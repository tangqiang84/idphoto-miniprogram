'use strict';

function fitShoulderAnchors(template, safety, face) {
  const anchors = template.shoulderAnchors;
  const bad = (reason, message) => ({ok: false, reason, message});
  if (!Array.isArray(anchors) || anchors.length !== 2 || !anchors.every(p => p &&
    Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x < template.width && p.y >= 0 && p.y < template.height))
    return bad('suit:template_metadata', '模板肩峰标注无效，不能安全换装');
  const [a, b] = anchors;
  const tx = b.x - a.x, ty = b.y - a.y;
  if (tx <= 0) return bad('suit:template_metadata', '模板肩峰顺序或间距无效');
  const {l, r} = safety.pair;
  const dx = r.x - l.x, dy = r.y - l.y;
  const scale = Math.hypot(dx, dy) / Math.hypot(tx, ty);
  const rad = Math.atan2(dy, dx) - Math.atan2(ty, tx);
  const cos = Math.cos(rad), sin = Math.sin(rad);
  // suitCompose 绕贴图中心旋转，平移必须以相同中心求解，不能先居中后旋转。
  const ax = ((a.x + b.x) / 2 - template.width / 2) * scale;
  const ay = ((a.y + b.y) / 2 - template.height / 2) * scale;
  const cx = (l.x + r.x) / 2 - ax * cos + ay * sin;
  const cy = (l.y + r.y) / 2 - ax * sin - ay * cos;
  const w = template.width * scale, h = template.height * scale;
  const collarY = cy + (template.collarTopY - template.height / 2) * scale * cos;
  if (collarY <= Math.max(face.chinY, safety.protectUntilY))
    return bad('suit:unsupported_composition', '实测肩线与模板领口不匹配，请更换模板或使用双肩完整的正面照片');
  return {ok: true, place: {x: cx - w / 2, y: cy - h / 2, w, h}, scale,
    rotateDeg: rad * 180 / Math.PI, garmentTop: collarY};
}

module.exports = {fitShoulderAnchors};
