'use strict';
// 保持同步基线的运算顺序，仅在固定批次间让出事件循环。
async function runCooperative(rgba,w,h,opts={}) {
 const {collectEdgeSamples,gaussianFromSamples,mat3Inv,mahalanobis,sigmoid}=require('./mattingLocal');
 const check=opts.check||(()=>{});let budget=0,last=Date.now();
 const pause=async()=>{check();await new Promise(resolve=>setTimeout(resolve,0));check();last=Date.now();};
 const checkpoint=()=>++budget%2048===0&&Date.now()-last>=8;
 check();await pause();
 const n=w*h,alpha=new Float32Array(n);
 const samples=Array.isArray(opts.bgSamples)&&opts.bgSamples.length>=3?opts.bgSamples:collectEdgeSamples(rgba,w,h,2);
 const bg=gaussianFromSamples(samples),fgSamples=[];
 for(let i=0;i<n;i++){const r=rgba[i*4],g=rgba[i*4+1],b=rgba[i*4+2];const d=mahalanobis(r,g,b,bg.mean,bg.covInv);const a=sigmoid((d-2.0)*1.2);alpha[i]=a;if(a>0.7)fgSamples.push([r,g,b]);if(checkpoint())await pause();}
 if(fgSamples.length){
  const k=fgSamples.length,mean=[0,0,0],cov=new Array(9).fill(0);
  for(const s of fgSamples){mean[0]+=s[0];mean[1]+=s[1];mean[2]+=s[2];if(checkpoint())await pause();}
  mean[0]/=k;mean[1]/=k;mean[2]/=k;
  for(const s of fgSamples){const dx=s[0]-mean[0],dy=s[1]-mean[1],dz=s[2]-mean[2];cov[0]+=dx*dx;cov[1]+=dx*dy;cov[2]+=dx*dz;cov[3]+=dy*dx;cov[4]+=dy*dy;cov[5]+=dy*dz;cov[6]+=dz*dx;cov[7]+=dz*dy;cov[8]+=dz*dz;if(checkpoint())await pause();}
  for(let i=0;i<9;i++)cov[i]/=k;const inv=mat3Inv(cov);
  for(let i=0;i<n;i++){const r=rgba[i*4],g=rgba[i*4+1],b=rgba[i*4+2];const df=mahalanobis(r,g,b,mean,inv),db=mahalanobis(r,g,b,bg.mean,bg.covInv);alpha[i]=sigmoid((db-df)*0.8+0.2);if(checkpoint())await pause();}
 }
 const out=new Float32Array(n);
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){let acc=0,cnt=0;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const xx=x+dx,yy=y+dy;if(xx<0||yy<0||xx>=w||yy>=h)continue;acc+=alpha[yy*w+xx];cnt++;}out[y*w+x]=cnt?acc/cnt:0;if(checkpoint())await pause();}
 check();alpha.set(out);return alpha;
}
module.exports={runCooperative};
