'use strict';
// RC-09：模型默认关闭的静态/契约护栏与当前逐步流程SDK验证。旧工具另存legacy，不覆盖原截图。
const fs=require('fs'),path=require('path');const ROOT=path.resolve(__dirname,'..');
async function main(){const args=process.argv.slice(2);const model=require('../idphoto-miniprogram/src/core/mattingModel');const source=fs.readFileSync(path.join(ROOT,'idphoto-miniprogram/src/services/modelService.ts'),'utf8');const config=source.slice(source.indexOf('export const EDGE_MODEL_CONFIG'),source.indexOf('// 覆盖配置'));
 const checks=[['规格表不含禁止的RMBG',!Object.keys(model.MODEL_SPECS).some(x=>/rmbg/i.test(x))],['默认关闭不配置权重',/enabled:\s*false/.test(config)&&/weightUrl:\s*''/.test(config)],['运行时不静态引入',!/^\s*import.*from\s*['"]onnxruntime/m.test(source)],['MODNet与BiRefNet预处理参数不同',model.getModelSpec('modnet-q8').inputSize===512&&model.getModelSpec('birefnet-1024').inputSize===1024&&model.getModelSpec('modnet-q8').normalize.kind!==model.getModelSpec('birefnet-1024').normalize.kind],['默认计划为传统算法',model.resolveModelPlan({config:{enabled:false}}).action==='classical']];console.log(JSON.stringify({scope:'静态/契约，非权重/许可或真实模型质量验收',checks:checks.map(([name,pass])=>({name,status:pass?'PASS':'FAIL'}))}));if(checks.some(x=>!x[1]))return 1;
 if(args.length===1&&args[0]==='--checks-only')return 0;
 if(!args.includes('--app')||!args.includes('--out')){console.log('BLOCKED：真实SDK检查须提供--app禁云副本 --port端口 --out新目录；仅静态用--checks-only。');return 3;}
 return require('./smoke_rc07').main([...args,'--tool','T1','--consents','local','--matting','yes']);
}
if(require.main===module)main().then(c=>{process.exitCode=c;}).catch(()=>{console.error('MODEL_SMOKE_SETUP_FAILED：参数或验证资产不可用');process.exitCode=2;});
module.exports={main};
