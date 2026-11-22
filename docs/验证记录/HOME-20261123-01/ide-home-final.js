const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const automator = require('/Users/tq/.workbuddy/binaries/node/workspace/node_modules/miniprogram-automator');
async function main() {
 const app = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9498' });
 try {
  const page = await app.reLaunch('/pages/home/index');
  await page.waitFor('.tool-card');
  const title = await (await page.$('.home__hero-title')).text();
  const cards = await page.$$('.tool-card');
  const sizes = await Promise.all(cards.map(card => card.size()));
  const windowWidth = await app.evaluate(() => wx.getWindowInfo().windowWidth);
  assert.equal(title,'老唐标准照裁剪');
  assert.equal(cards.length,6);
  assert.ok(sizes.every(card => card.height >= Math.floor(windowWidth * 240 / 750)));
  assert.ok((await page.size()).width <= windowWidth);
  const routes = [];
  for (let index = 0; index < cards.length; index++) {
   const home = await app.reLaunch('/pages/home/index');
   await home.waitFor('.tool-card');
   await (await home.$$('.tool-card'))[index].tap();
   let current = await app.currentPage();
   for (let attempt=0; current.path==='pages/home/index' && attempt<20; attempt++) {
    await new Promise(resolve=>setTimeout(resolve,150));
    current = await app.currentPage();
   }
   routes.push(current.path);
  }
  assert.deepEqual(routes,['tool-idphoto','tool-bg','tool-suit','tool-check','tool-spec','tool-print'].map(tool=>`pages/${tool}/index`));
  fs.writeFileSync(path.join(__dirname,'ide-report.json'),JSON.stringify({title,windowWidth,sizes,routes},null,2),{flag:'wx'});
 } finally { await app.disconnect(); }
}
main().catch(e => {console.error(e.message);process.exitCode=1;});
