const test = require('node:test');
const assert = require('node:assert/strict');
const {cloudMatting, toBase64} = require('../mattingCloud');
for (const kind of ['short', 'long', 'invalid']) {
  test(`云alpha ${kind}响应必须拒绝并保留本地结果`, async () => {
    const alpha = new Float32Array(32 * 32).fill(0.5);
    let calls = 0;
    const audits = [];
    const result = await cloudMatting({rgba:new Uint8ClampedArray(32*32*4), alpha,
      width:32, height:32, consents:['faceCloudEnhance'], audit:r=>audits.push(r),
      adapter:{endpoint:'cloud://CN', kind:'cloudfn', async call(req) {
        calls++;
        const n=req.width*req.height;
        return {provider:'baidu', alphaB64:kind==='invalid'?'private!':toBase64(new Uint8Array(n+(kind==='short'?-1:1)).fill(128))};
      }}});
    assert.equal(result.backend,'cloud->edge');
    assert.equal(result.reasonCode,'CLOUD_RESPONSE_INVALID');
    assert.equal(result.alpha,alpha);
    assert.equal(calls,1);
    assert.equal(audits.at(-1).code,'CLOUD_RESPONSE_INVALID');
    assert.equal(JSON.stringify(audits).includes('private'),false);
  });
}
