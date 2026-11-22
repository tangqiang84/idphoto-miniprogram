'use strict';
function createPhotoBuffer(samples){
 let active=null,version=0;
 const error=code=>({code,message:'授权照片诊断输入无效'});
 function check(ticket){if(!active||active.ticket!==ticket)throw error('PHOTO_TICKET_STALE');return active;}
 return {
  begin(id){const spec=samples.find(s=>s.id===id);if(!spec||!Number.isSafeInteger(spec.inputBytes)||spec.inputBytes<=0||spec.inputBytes>3*512*512*4)throw error('PHOTO_NOT_AUTHORIZED');active={ticket:++version,spec,data:new Uint8Array(spec.inputBytes),written:0,sealed:false};return{ticket:active.ticket,inputBytes:spec.inputBytes};},
  append(ticket,offset,bytes){const s=check(ticket);if(s.sealed||offset!==s.written||!(bytes instanceof Uint8Array)||bytes.length<=0||bytes.length>32768||offset+bytes.length>s.data.length)throw error('PHOTO_CHUNK_INVALID');s.data.set(bytes,offset);s.written+=bytes.length;return s.written;},
  seal(ticket){const s=check(ticket);if(s.written!==s.data.length||s.sealed)throw error('PHOTO_INPUT_INCOMPLETE');s.sealed=true;return{spec:s.spec,bytes:s.data};},
  check(ticket){check(ticket);},
  clear(){active=null;version++;},
 };
}
module.exports={createPhotoBuffer};
