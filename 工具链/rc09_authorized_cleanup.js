'use strict';
const TARGET=Object.freeze({filename:'rc09-compat-1793878646675-cadc9d5a528bd8-full-static.onnx',bytes:25898737,sha256:'e621672ff91c0d9729eb87ac11dcd78683b1fc7d36c681d2fb55acdbc506e12d'});
async function cleanupAuthorizedStaticCopy(fs,root,authorization,sha,check=()=>{},audit) {
 const error=code=>({code,message:'已授权诊断副本清理停止'});
 if(authorization?.authorized!==true||authorization.filename!==TARGET.filename||authorization.bytes!==TARGET.bytes||authorization.sha256!==TARGET.sha256)throw error('CLEANUP_NOT_AUTHORIZED');
 if(typeof audit!=='function')throw error('CLEANUP_AUDIT_REQUIRED');
 const persist=result=>{try{audit(result);}catch{throw {...error('CLEANUP_AUDIT_FAILED'),executed:result.executed};}};
 check();let names;
 try{names=fs.readdirSync(root);}catch{throw error('CLEANUP_INSPECTION_FAILED');}
 if(!names.includes(TARGET.filename)){const result={status:'ABSENT',executed:false,filename:TARGET.filename};persist(result);return result;}
 const path=root+'/'+TARGET.filename;let before,bytes;
 try{before=fs.statSync(path);if(!before.isFile()||before.size!==TARGET.bytes)throw error('CLEANUP_SIZE_MISMATCH');bytes=new Uint8Array(fs.readFileSync(path));}catch(e){throw error(e?.code==='CLEANUP_SIZE_MISMATCH'?e.code:'CLEANUP_INSPECTION_FAILED');}
 if(bytes.length!==TARGET.bytes)throw error('CLEANUP_SIZE_MISMATCH');
 const digest=await sha(bytes,{check});check();if(digest!==TARGET.sha256)throw error('CLEANUP_HASH_MISMATCH');
 let after;try{after=fs.statSync(path);}catch{throw error('CLEANUP_INSPECTION_FAILED');}
 if(after.size!==before.size||after.lastModifiedTime!==before.lastModifiedTime)throw error('CLEANUP_FILE_CHANGED');
 persist({status:'VERIFIED_BEFORE_DELETE',executed:false,filename:TARGET.filename,bytes:TARGET.bytes,sha256:digest});check();
 try{fs.unlinkSync(path);}catch{throw error('CLEANUP_DELETE_FAILED');}
 const result={status:'DELETED',executed:true,filename:TARGET.filename,bytes:TARGET.bytes,sha256:digest};persist(result);return result;
}
module.exports={TARGET,cleanupAuthorizedStaticCopy};
