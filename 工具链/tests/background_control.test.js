'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('fs');const vm=require('vm');const ts=require('../../idphoto-miniprogram/node_modules/typescript');
test('RC-07真实颜色控件：HEX/RGB等价、越界不调用处理、渐变和透明可明确切换',()=>{
 const states=[];let cursor=0;let value='#FFFFFF';const applied=[];
 const jsx=(type,props)=>({type,props});const exports={};
 const code=ts.transpileModule(fs.readFileSync('idphoto-miniprogram/src/components/BackgroundControl/index.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const context=vm.createContext({exports,require(name){
  if(name==='react')return {useState(initial){const id=cursor++;if(!(id in states))states[id]=initial;return [states[id],v=>{states[id]=v;}];}};
  if(name==='react/jsx-runtime')return {jsx,jsxs:jsx};
  if(name==='@tarojs/components')return new Proxy({},{get:(_,key)=>key});
  if(name.endsWith('/core/color'))return require('../../idphoto-miniprogram/src/core/color');
  if(name.endsWith('/core/specLibrary'))return require('../../idphoto-miniprogram/src/core/specLibrary');throw new Error(name);
 }});new vm.Script(code).runInContext(context,{timeout:2000});
 function flatten(n,list=[]){if(Array.isArray(n))n.forEach(x=>flatten(x,list));else if(n?.props){list.push(n);flatten(n.props.children,list);}return list;}
 function find(cls){cursor=0;return flatten(exports.default({value,onChange:v=>{value=v;applied.push(v);}})).find(n=>n.props.className===cls);}
 find('color-input').props.onInput({detail:{value:'300,0,0'}});find('color-solid').props.onClick();assert.equal(applied.length,0);assert.ok(find('color-error'));
 find('color-input').props.onInput({detail:{value:'#438EDB'}});find('color-solid').props.onClick();
 find('color-input').props.onInput({detail:{value:'67,142,219'}});find('color-solid').props.onClick();assert.equal(applied[0],applied[1]);
 find('color-end').props.onInput({detail:{value:'#FFFFFF'}});
 find('color-gradient').props.onClick();assert.equal(value.type,'gradient');assert.equal(value.angle,90);
 assert.equal(find('color-sample').props.style.background,'linear-gradient(180deg, #438EDB, #FFFFFF)','90°向下映射到CSS180°');
 find('color-transparent').props.onClick();assert.equal(value,null);
 find('color-solid').props.onClick();assert.equal(value,'#438EDB');assert.equal(find('color-sample').props.style.background,'#438EDB');
});
