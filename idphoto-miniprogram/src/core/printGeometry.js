'use strict';
const {getPaper,planLayout,mmToPx,DEFAULT_MARGIN_MM,DEFAULT_GAP_MM}=require('./paperLibrary');
const {getSpec}=require('./specLibrary');
function printGeometry(paperId,specId){
 const paper=getPaper(paperId),spec=getSpec(specId),layout=planLayout(paperId,specId);if(!paper||!spec||!layout)return null;
 const width=layout.paperRotated?layout.sheetPx.height:layout.sheetPx.width;
 const height=layout.paperRotated?layout.sheetPx.width:layout.sheetPx.height;
 const printW=mmToPx(layout.paperRotated?paper.printHeightMm:paper.printWidthMm,paper.dpi);
 const printH=mmToPx(layout.paperRotated?paper.printWidthMm:paper.printHeightMm,paper.dpi);
 const ox=(width-printW)/2,oy=(height-printH)/2;
 const pw=layout.photoRotated?spec.heightMm:spec.widthMm,ph=layout.photoRotated?spec.widthMm:spec.heightMm;
 const w=mmToPx(pw,paper.dpi),h=mmToPx(ph,paper.dpi),placements=[];
 if(!paper.tileable&&layout.count)placements.push({x:ox+(printW-w)/2,y:oy+(printH-h)/2,width:w,height:h});
 else for(let row=0;row<layout.rows;row++)for(let col=0;col<layout.cols;col++){
  // 在毫米坐标计算后一次舍入，避免大纸多列累计整数像素误差。
  placements.push({x:ox+mmToPx(DEFAULT_MARGIN_MM+col*(pw+DEFAULT_GAP_MM),paper.dpi),y:oy+mmToPx(DEFAULT_MARGIN_MM+row*(ph+DEFAULT_GAP_MM),paper.dpi),width:w,height:h});
 }
 const valid=placements.length===layout.count&&placements.every(p=>p.x>=ox-1&&p.y>=oy-1&&p.x+p.width<=ox+printW+1&&p.y+p.height<=oy+printH+1);
 return {...layout,width,height,print:{x:ox,y:oy,width:printW,height:printH},placements,valid};
}
module.exports={printGeometry};
