'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {printGeometry}=require('../printGeometry');const {PAPERS}=require('../paperLibrary');const {SPECS}=require('../specLibrary');
// 相纸SSOT整纸毫米及原生档位的独立固定期望（不是调用产品换算函数生成）。
const expected={'paper-5in':[1500,1051],'paper-6in':[1795,1205],'paper-6in-plus':[1795,1346],'paper-7in':[2102,1500],'paper-8in':[2398,1795],'paper-10in':[3000,2398],'paper-12in':[3602,3000],'instax-mini':[1016,638],'instax-square':[1016,850],'instax-wide':[1276,1016],'selphy-card':[638,1016],'selphy-l':[1051,1406],'selphy-postcard':[1181,1748],'selphy-sticker-square':[591,591],'zink-2x3':[937,628],'zink-2.3x3.4':[1072,715]};
test('RC-08全部16相纸×9规格几何及整纸独立像素误差≤1，单张限制不被绕过',()=>{
 assert.equal(PAPERS.length,16);for(const p of PAPERS)for(const s of SPECS){const g=printGeometry(p.id,s.id);assert.equal(g.valid,true,p.id+'/'+s.id);assert.equal(g.placements.length,g.count);if(!p.tileable)assert.ok(g.count<=1);
 const [w,h]=g.paperRotated?[g.height,g.width]:[g.width,g.height];assert.ok(Math.abs(w-expected[p.id][0])<=1);assert.ok(Math.abs(h-expected[p.id][1])<=1);
 }
});
test('RC-08固定排版：6寸一寸10张；instax小区无法容纳美签；12寸无累积溢出',()=>{
 // 可打印148×98mm，边距各3mm、间距2mm：floor((142+2)/27)=5列，floor((92+2)/37)=2行。
 const six=printGeometry('paper-6in','one-inch');assert.equal(six.count,10);assert.equal(six.placements[0].width,295);assert.equal(six.placements[0].height,413);
 assert.equal(printGeometry('instax-mini','visa-us').count,0);
 assert.equal(printGeometry('instax-mini','one-inch').count,1);
 assert.equal(printGeometry('paper-12in','one-inch').valid,true);
});
