'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fitSuitV2 } = require('../suitFitV2');
const { getSpec } = require('../specLibrary');
function input(k) {
  return { spec: getSpec('one-inch'), canvasW: 300*k, canvasH: 420*k,
    face: { source: 'landmarks', quality: 'good', faceCount: 1, headH: 273*k, crownY: 25*k,
      chinY: 298*k, faceCenterX: 150*k, rect: {x:100*k,y:25*k,w:100*k,h:273*k} },
    pose: { points: [{name:'left_shoulder',x:36*k,y:360*k,score:.9},{name:'right_shoulder',x:264*k,y:360*k,score:.9}] } };
}
test('同一构图像素变为四倍时模板位置和大小同比变化', () => {
  const a=fitSuitV2(input(1)),b=fitSuitV2(input(4));
  assert.ok(a.ok && b.ok);
  for(const key of ['x','y','w','h']) assert.ok(Math.abs(b.place[key]-a.place[key]*4)<1e-8, key+' 必须随画布同比缩放');
});
