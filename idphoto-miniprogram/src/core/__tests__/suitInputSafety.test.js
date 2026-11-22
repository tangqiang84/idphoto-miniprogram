const test=require('node:test'),assert=require('node:assert/strict');
const {getSuitTemplate,evaluateSuitTemplate}=require('../suitTemplates');
const {measuredShoulders}=require('../suitSafety');
function template(){return {...getSuitTemplate('black'),approval:'approved',licenseEvidence:'fixture-license',qualityEvidence:'fixture-review',sha256:'a'.repeat(64),specs:['one-inch'],native:{width:3000,height:3000}};}
for(const patch of [{shoulderY:-1},{shoulderY:401},{shoulderWidthPx:401},{collarVy:NaN},{collarVy:401}])test('异常模板几何拒绝 '+JSON.stringify(patch),()=>{
 const t=template();t.geometry={...t.geometry,...patch};assert.equal(evaluateSuitTemplate(t,'one-inch').ok,false);
});
test('参考几何与原生像素可以不同，合法元数据仍通过结构检查',()=>assert.equal(evaluateSuitTemplate(template(),'one-inch').ok,true));
test('超过概率范围的肩点置信度不得算可靠',()=>assert.equal(measuredShoulders([{name:'left_shoulder',x:10,y:60,score:2},{name:'right_shoulder',x:90,y:60,score:2}],100,140),null));
