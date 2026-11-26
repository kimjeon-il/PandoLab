import {referenceZoomPixelsPerDegree} from '../map/map-display-zoom.js';
import {globeVector} from './globe-camera.js';
import {territorialLabelPixelSize} from './label-layout.js';
import {renderCacheBudget,renderPacketBuffers} from './render-cache-budget.js';
import {createGlobePacketIndex} from './globe-picking.js';
import {createGlobeRangeCuller} from './globe-spatial-partition.js';
import {distanceMask} from './globe-label-sdf.js';
import {createGlobeLabelSdfTasks} from './globe-label-sdf-tasks.js';

export const COUNTRY_LABEL_MIN_ZOOM=3;
const fontSize=56, outlineRange=7, padding=outlineRange+2, atlasSize=2048;

export function placeGlobeLabels(candidates,camera,viewport,previous,onGrid=null,measureLabel=null,stats=null) {
  const placed=[],cells=new Map(),checked=new Uint32Array(candidates.length);
  let stamp=0;
  // Preserve greedy priority and hysteresis. Each pair is compared at most
  // once, even when both labels cross several screen cells.
  const cellSize=64,columns=Math.floor(viewport.width/cellSize)+1;
  function cellRange(left,top,right,bottom,visit){
    const x0=Math.max(0,Math.floor(left/cellSize)),y0=Math.max(0,Math.floor(top/cellSize));
    const x1=Math.min(columns-1,Math.floor(right/cellSize));
    const y1=Math.min(Math.floor(viewport.height/cellSize),Math.floor(bottom/cellSize));
    for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)if(visit(y*columns+x))return true;
    return false;
  }
  const scale=referenceZoomPixelsPerDegree(camera.view.zoom)*180/Math.PI;
  const eye=camera.frame.eye;
  for(const label of candidates){
    if(label.visible===false||camera.view.zoom<(label.minZoom??-Infinity)||camera.view.zoom>(label.maxZoom??Infinity))continue;
    const normal=label.vector??globeVector(label.coordinate);
    const point=camera.projectVisibleVector?camera.projectVisibleVector(normal):camera.projectVisibleCoordinate(label.coordinate);
    if(stats)stats.projectedCandidates++;
    if(!point)continue;
    const facing=(-1+normal[0]*eye[0]+normal[1]*eye[1]+normal[2]*eye[2])
      /Math.hypot(eye[0]-normal[0],eye[1]-normal[1],eye[2]-normal[2]);
    const retained=previous.has(label.key);
    if(facing<(retained ? .14 : .20))continue;
    const diameter=label.place?0:Math.sqrt(label.area)*scale;
    if(!label.place&&diameter<(retained?5:7))continue;
    const pixelSize=label.place?Math.min(20,12+Math.max(0,camera.view.zoom-4)*1.25)
      :territorialLabelPixelSize(label.shortSide,camera.view.zoom);
    const size=pixelSize/fontSize;
    // Font measurement is cheap and cached independently of SDF pixels.
    // Never rasterize a rejected, hidden or off-screen candidate.
    const measured=measureLabel?measureLabel(label):label;
    const [x,y]=point,left=x-(measured.anchorX??measured.width/2)*size,top=y-(measured.anchorY??measured.height/2)*size;
    const right=left+measured.width*size,bottom=top+measured.height*size;
    if(left<0||top<0||right>viewport.width||bottom>viewport.height)continue;
    const gap=retained?0:3;
    stamp++;
    if(cellRange(left-gap,top-gap,right+gap,bottom+gap,key=>{
      for(const row of cells.get(key)??[]){
        if(checked[row.collisionIndex]===stamp){if(stats)stats.duplicateCollisionSkips++;continue;}
        checked[row.collisionIndex]=stamp;if(stats)stats.collisionComparisons++;
        if(row.left<right+gap&&row.right>left-gap&&row.top<bottom+gap&&row.bottom>top-gap)return true;
      }
      return false;
    }))continue;
    const row={...label,...measured,left,right,top,bottom,collisionIndex:placed.length};
    placed.push(row);
    cellRange(left,top,right,bottom,key=>{
      let bucket=cells.get(key);
      if(!bucket){bucket=[];cells.set(key,bucket);}
      bucket.push(row);return false;
    });
  }
  onGrid?.(cells,columns,cellSize);
  return placed;
}

export function createGlobeLabelSpatialIndex(rows){
  const indexed=rows.filter(row=>row.visible!==false&&Array.isArray(row.coordinate)&&row.coordinate.length===2&&
    row.coordinate.every(Number.isFinite)&&Math.abs(row.coordinate[1])<=90).map(row=>{
      const vector=row.vector??globeVector(row.coordinate);
      return row.vector===vector&&row.bounds?row:{...row,vector,bounds:[...vector,...vector]};
    });
  const index=createGlobePacketIndex(indexed,row=>row.bounds);
  return {rows:indexed,query:index.query};
}

const vertexShader=`
  attribute float instanceRow;
  uniform sampler2D boxes;
  uniform vec2 viewport;
  uniform float capacity;
  varying vec2 texCoord;
  void main(){
    float row = (instanceRow + 0.5) / capacity;
    vec4 box = texture2D(boxes, vec2(0.25, row));
    vec4 uvRect = texture2D(boxes, vec2(0.75, row));
    vec2 pixel = mix(box.xy, box.zw, position.xy);
    texCoord = mix(uvRect.xy, uvRect.zw, position.xy);
    gl_Position = vec4(2.0 * pixel.x / viewport.x - 1.0, 1.0 - 2.0 * pixel.y / viewport.y, 0.0, 1.0);
  }
`;
const fragmentShader=`
  uniform sampler2D atlas;
  uniform vec3 textColor, haloColor;
  varying vec2 texCoord;
  void main(){
    float distance = texture2D(atlas,texCoord).r - 0.5;
    float width = max(fwidth(distance), 0.001);
    float ink = smoothstep(-0.5*width, 0.5*width, distance);
    float halo = smoothstep(-0.5*width, 0.5*width, distance + width);
    if (halo <= 0.0) discard;
    gl_FragColor = vec4(mix(haloColor,textColor,ink),halo);
    #include <colorspace_fragment>
  }
`;

export function orderGlobeLabels(rows){
  return [...rows].sort((a,b)=>Number(Boolean(a.place))-Number(Boolean(b.place))||
    (a.place?Number(Boolean(b.selected))-Number(Boolean(a.selected))||b.priority-a.priority:b.area-a.area)||a.key.localeCompare(b.key));
}

// Shelf-pack current cached runs without changing their SDF bitmap or metrics.
export function planGlobeAtlasPages(runs,size=atlasSize){
 const pages=[];
 for(const place of [false,true]){
  const ordered=runs.filter(run=>run.page.place===place).sort((a,b)=>b.height-a.height||b.width-a.width);
  let page=null;
  for(const run of ordered){
   if(run.width>size||run.height>size)return null;
   if(page&&page.x+run.width>size){page.y+=page.rowHeight;page.x=0;page.rowHeight=0;}
   if(!page||page.y+run.height>size){
    page={place,x:0,y:0,rowHeight:0,placements:[]};pages.push(page);
   }
   page.placements.push({run,x:page.x,y:page.y});
   page.x+=run.width;page.rowHeight=Math.max(page.rowHeight,run.height);
  }
 }
 return pages;
}

// Rectangles refer to texels, not RGBA components. The renderer's
// copyTextureToTexture CPU path supports both RedFormat and FloatType.
export function mergeLabelTextureRects(rects){
  const ordered=rects.map(row=>({...row})).sort((a,b)=>a.y-b.y||a.x-b.x);
  const merged=[];
  for(const rect of ordered){
    const previous=merged.at(-1);
    if(previous){
      const left=Math.min(previous.x,rect.x),top=Math.min(previous.y,rect.y);
      const right=Math.max(previous.x+previous.width,rect.x+rect.width),bottom=Math.max(previous.y+previous.height,rect.y+rect.height);
      const near=rect.y<=previous.y+previous.height+1&&rect.x<=previous.x+previous.width+1&&rect.x+rect.width>=previous.x-1;
      const area=(right-left)*(bottom-top);
      if(near&&area<=1.25*(previous.width*previous.height+rect.width*rect.height)){
        Object.assign(previous,{x:left,y:top,width:right-left,height:bottom-top});continue;
      }
    }
    merged.push(rect);
  }
  return merged;
}

export function labelInstanceCapacity(current,needed,limit){
  if(needed>limit)throw Error('Label batch exceeds texture capacity');
  if(!needed)return 0;
  if(current>=needed&&needed>current/4)return current;
  return Math.min(limit,Math.max(16,2**Math.ceil(Math.log2(needed))));
}
const labelFields=['key','area','shortSide','place','selected','priority','marker','minZoom','maxZoom','visible'];
const equalCoordinate=(a,b)=>a?.[0]===b?.[0]&&a?.[1]===b?.[1];
const sameLabel=(a,b)=>a&&b&&labelFields.every(key=>a[key]===b[key])&&a.ref?.key===b.ref?.key&&
  equalCoordinate(a.coordinate,b.coordinate)&&a.lines.length===b.lines.length&&a.lines.every((line,i)=>line===b.lines[i]);
const sumBuffers=buffers=>[...buffers].reduce((sum,buffer)=>sum+buffer.byteLength,0);

export function createThreeGlobeLabels(THREE,{scene,renderer,palette,capacity,viewport,maxTextureSize=2048,byteBudget=renderCacheBudget().labelAtlasBytes,onReady=()=>{},onError=()=>{},createSdfTasks=createGlobeLabelSdfTasks}){
  const raster=new OffscreenCanvas(1,1),context=raster.getContext('2d',{willReadFrequently:true});
  const size=Math.min(atlasSize,maxTextureSize),maxRows=Math.max(1,Math.min(maxTextureSize,capacity));
  const pages=[],cache=new Map(),metricsCache=new Map();
  const metricsLimit=4096;
  const textColor=new THREE.Color(palette.text),haloColor=new THREE.Color(0xffffff);
  // This source is never uploaded itself. It borrows the existing CPU data
  // for the rectangular copy and releases that reference immediately.
  const uploadSource=new THREE.DataTexture(null,1,1,THREE.RedFormat);
  const copyRegion=new THREE.Box2(new THREE.Vector2(),new THREE.Vector2()),copyPosition=new THREE.Vector2();
  const candidateGroups=[{source:null,rows:[],index:createGlobeLabelSpatialIndex([])},{source:null,rows:[],index:createGlobeLabelSpatialIndex([])}];
  const sdfTasks=createSdfTasks();
  let placed=[],previous=new Set(),lastCamera=null,cacheDirty=true,lastComplete=true,lastStrict=false,disposed=false;
  let layoutCache=null,candidateRevision=0;
  let pendingSdf=null,desiredKeys=new Set(),sdfFallback=false,pendingMaskBytes=0;
  let activePages=new Set(),hitSnapshot=()=>null,layoutStats={};
  const counters={rasterizedRuns:0,textMeasurements:0,fullUploadBytes:0,partialUploadBytes:0,partialUploads:0,fullUploads:0,evictedPages:0,compactedPages:0,shrunkBatches:0};

  function textureState(texture){
    const state={texture,uploaded:false,rects:[]};
    texture.onUpdate=()=>{
      state.uploaded=true;counters.fullUploads++;counters.fullUploadBytes+=texture.image.data.byteLength;
    };
    texture.needsUpdate=true;
    return state;
  }
  function restoreTexture(state){
    state.uploaded=false;state.rects.length=0;state.texture.clearUpdateRanges();state.texture.needsUpdate=true;
  }
  function dirty(state,x,y,width,height){
    if(state.uploaded&&width>0&&height>0)state.rects.push({x,y,width,height});
  }
  function flush(state){
    if(!state.rects.length)return;
    const texture=state.texture,{width,height,data}=texture.image;
    const rects=mergeLabelTextureRects(state.rects);state.rects.length=0;
    if(!state.uploaded)return;
    const area=rects.reduce((sum,row)=>sum+row.width*row.height,0);
    if(!renderer?.copyTextureToTexture||area>=width*height*.6||rects.length>64){
      restoreTexture(state);return;
    }
    const bytesPerTexel=data.byteLength/(width*height);
    uploadSource.image=texture.image;
    try{
      for(const {x,y,width:w,height:h} of rects){
        copyRegion.min.set(x,y);copyRegion.max.set(x+w,y+h);copyPosition.set(x,y);
        renderer.copyTextureToTexture(uploadSource,texture,copyRegion,copyPosition);
        counters.partialUploads++;counters.partialUploadBytes+=w*h*bytesPerTexel;
      }
    }finally{uploadSource.image=null;}
  }
  function addPage(place){
    const pixels=new Uint8Array(size*size);
    const atlas=new THREE.DataTexture(pixels,size,size,THREE.RedFormat);
    atlas.magFilter=atlas.minFilter=THREE.LinearFilter;
    const page={pixels,atlas,upload:textureState(atlas),batches:[],place,x:0,y:0,rowHeight:0,count:0,keys:new Set(),lastUsed:performance.now(),retired:false};
    pages.push(page);cacheDirty=true;return page;
  }
  function measureLabel(label){
    const key=label.atlasKey,run=cache.get(key);
    if(run&&!run.page.retired)return run.metrics;
    let measured=metricsCache.get(key);
    if(measured){metricsCache.delete(key);metricsCache.set(key,measured);return measured;}
    const place=Boolean(label.place),marker=label.marker??'';
    const font=`${place?600:800} ${fontSize}px "Pretendard Variable", sans-serif`;
    context.font=font;
    const markerWidth=marker?36:0;
    const width=Math.min(size,Math.ceil(Math.max(...label.lines.map(line=>context.measureText(line).width)))+padding*2+markerWidth);
    const lineHeight=Math.ceil(fontSize*1.26),height=lineHeight*label.lines.length+padding*2;
    if(height>size)throw Error('Label exceeds SDF atlas height');
    measured={width,height,font,lineHeight,markerWidth,textX:place?padding+markerWidth:width/2,
      anchorX:place?padding+markerWidth/3:width/2,anchorY:place?padding+lineHeight/2:height/2};
    metricsCache.set(key,measured);counters.textMeasurements++;
    while(metricsCache.size>metricsLimit)metricsCache.delete(metricsCache.keys().next().value);
    return measured;
  }
  function cachedRun(key){
    const run=cache.get(key);return run&&!run.page.retired?run:null;
  }
  function rasterMask(label){
    const {width,height,font,lineHeight,markerWidth,textX,anchorX,anchorY}=label;
    const place=Boolean(label.place),marker=label.marker??'';
    raster.width=width;raster.height=height;
    context.font=font;context.textAlign=place?'left':'center';context.textBaseline='middle';context.fillStyle='#fff';
    label.lines.forEach((line,index)=>context.fillText(line,textX,padding+lineHeight*(index+.5),width-padding*2-markerWidth));
    if(marker){context.beginPath();context.arc(anchorX,anchorY,marker==='capital'?13:10,0,Math.PI*2);context.fill();}
    const rgba=context.getImageData(0,0,width,height).data,mask=new Uint8Array(width*height);
    for(let i=0;i<mask.length;i++)mask[i]=rgba[i*4+3];
    return {key:label.atlasKey,width,height,mask,outlineRange};
  }
  function installText(label,field){
    const key=label.atlasKey,existing=cachedRun(key);
    if(existing)return existing;
    const {width,height,font,lineHeight,markerWidth,textX,anchorX,anchorY}=label;
    const metrics={width,height,font,lineHeight,markerWidth,textX,anchorX,anchorY};
    if(!(field instanceof Uint8Array)||field.length!==width*height)throw Error('Invalid SDF worker result');
    const place=Boolean(label.place);
    let page=pages.findLast(row=>row.place===place&&!row.retired)??addPage(place);
    if(page.x+width>size){page.y+=page.rowHeight;page.x=0;page.rowHeight=0;}
    if(page.y+height>size)page=addPage(place);
    for(let y=0;y<height;y++)page.pixels.set(field.subarray(y*width,(y+1)*width),(page.y+y)*size+page.x);
    const uv=[page.x/size,page.y/size,(page.x+width)/size,(page.y+height)/size];
    const run={page,width,height,uv,metrics,atlasKey:key};
    cache.set(key,run);page.keys.add(key);dirty(page.upload,page.x,page.y,width,height);
    page.x+=width;page.rowHeight=Math.max(page.rowHeight,height);
    counters.rasterizedRuns++;cacheDirty=true;
    return run;
  }
  function cancelSdf(){
    if(!pendingSdf)return;
    const old=pendingSdf;pendingSdf=null;pendingMaskBytes=0;
    old.controller.abort();cacheDirty=true;
  }
  function prepareMissing(layout){
    desiredKeys=new Set(layout.map(row=>row.atlasKey));
    if(pendingSdf&&![...pendingSdf.labels.keys()].some(key=>desiredKeys.has(key)))cancelSdf();
    const missing=new Map();
    for(const row of layout)if(!cachedRun(row.atlasKey))missing.set(row.atlasKey,row);
    if(!missing.size)return true;
    if(sdfFallback){
      for(const label of missing.values()){
        const row=rasterMask(label);
        installText(label,distanceMask(row.mask,row.width,row.height,row.outlineRange));
      }
      return true;
    }
    if(pendingSdf)return false;
    const rows=[],labels=new Map();
    let bytes=0;
    for(const label of missing.values()){
      const estimate=label.width*label.height;
      // Bound main-thread mask work and temporary worker input.
      if(rows.length&&(rows.length>=24||bytes+estimate>512*1024))break;
      const row=rasterMask(label);rows.push(row);labels.set(row.key,label);bytes+=estimate;
    }
    const controller=new AbortController(),job={controller,labels};
    pendingSdf=job;pendingMaskBytes=bytes;cacheDirty=true;
    sdfTasks.run(rows,controller.signal).then(result=>{
      if(disposed||pendingSdf!==job||controller.signal.aborted)return;
      if(!Array.isArray(result)||result.length!==labels.size||new Set(result.map(row=>row.key)).size!==labels.size)
        throw Error('Incomplete label SDF response');
      for(const row of result){
        const label=labels.get(row.key);
        if(!label||label.width!==row.width||label.height!==row.height)throw Error('Unexpected SDF response');
        if(desiredKeys.has(row.key))installText(label,row.pixels);
      }
    }).catch(error=>{
      if(disposed||pendingSdf!==job||controller.signal.aborted)return;
      // The exact same transform is available as a last-resort local
      // path if Worker creation or execution is unsupported.
      sdfFallback=true;onError(error);
    }).finally(()=>{
      if(disposed||pendingSdf!==job)return;
      pendingSdf=null;pendingMaskBytes=0;lastCamera=null;cacheDirty=true;onReady();
    });
    return false;
  }
  function disposeBatch(batch){
    scene.remove(batch.mesh);batch.mesh.geometry.dispose();batch.mesh.material.dispose();batch.boxes.dispose();
  }
  function createBatch(page,needed,old){
    const allocated=labelInstanceCapacity(old?.capacity??0,needed,maxRows);
    if(old&&allocated===old.capacity)return old;
    if(old){if(allocated<old.capacity)counters.shrunkBatches++;disposeBatch(old);}
    const values=new Float32Array(allocated*8),boxes=new THREE.DataTexture(values,2,allocated,THREE.RGBAFormat,THREE.FloatType);
    const geometry=new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position',new THREE.BufferAttribute(Float32Array.of(0,0,0,1,0,0,0,1,0,1,1,0),3));
    geometry.setAttribute('instanceRow',new THREE.InstancedBufferAttribute(Float32Array.from({length:allocated},(_,i)=>i),1));
    geometry.setIndex([0,2,1,2,3,1]);
    const material=new THREE.ShaderMaterial({vertexShader,fragmentShader,depthTest:false,depthWrite:false,transparent:true,
      uniforms:{atlas:{value:page.atlas},boxes:{value:boxes},capacity:{value:allocated},viewport,textColor:{value:textColor},haloColor:{value:haloColor}}});
    const mesh=new THREE.Mesh(geometry,material);
    mesh.frustumCulled=false;mesh.renderOrder=7;geometry.instanceCount=0;mesh.visible=false;scene.add(mesh);
    cacheDirty=true;return {values,boxes,upload:textureState(boxes),mesh,capacity:allocated,count:0};
  }
  function updateBatch(batch,rows,first,count){
    let dirtyStart=-1;
    for(let i=0;i<count;i++){
      const {uv,left,top,right,bottom}=rows[first+i];
      const offset=i*8,values=batch.values;
      let changed=false;
      for(let component=0;component<8;component++){
        const value=Math.fround(component===0?left:component===1?top:component===2?right:component===3?bottom:uv[component-4]);
        if(values[offset+component]!==value){values[offset+component]=value;changed=true;}
      }
      if(changed&&dirtyStart<0)dirtyStart=i;
      if(!changed&&dirtyStart>=0){dirty(batch.upload,0,dirtyStart,2,i-dirtyStart);dirtyStart=-1;}
    }
    if(dirtyStart>=0)dirty(batch.upload,0,dirtyStart,2,count-dirtyStart);
    if(batch.count!==count)cacheDirty=true;
    batch.count=count;batch.mesh.geometry.instanceCount=count;batch.mesh.visible=count>0;
    flush(batch.upload);
  }
  function hideBatches(page,first=0){
    for(let i=first;i<page.batches.length;i++){
      const batch=page.batches[i];
      if(batch.count){batch.count=0;batch.mesh.geometry.instanceCount=0;batch.mesh.visible=false;cacheDirty=true;}
    }
  }
  function pageFootprint(page){
    const buffers=renderPacketBuffers([page.pixels,...page.batches.flatMap(batch=>[batch.values,
      ...Object.values(batch.mesh.geometry.attributes).map(attribute=>attribute.array),batch.mesh.geometry.index.array])]);
    return {buffers,extraBytes:sumBuffers(buffers)};
  }
  function pageBytes(page){const row=pageFootprint(page);return sumBuffers(row.buffers)+row.extraBytes;}
  function disposePage(page){
    for(const batch of page.batches)disposeBatch(batch);
    page.batches.length=0;page.atlas.dispose();
    for(const key of page.keys)if(cache.get(key)?.page===page)cache.delete(key);
    page.keys.clear();page.upload.rects.length=0;
  }
  function evictPage(page){
    const i=pages.indexOf(page);
    if(i<0)return;
    disposePage(page);pages.splice(i,1);counters.evictedPages++;
  }
  function compactActivePages(renderRows){
    const current=new Set(renderRows.map(row=>row.page)),keys=new Set(renderRows.map(row=>row.atlasKey));
    if(current.size<2||current.size*size*size*2<=byteBudget)return renderRows;
    const runs=[...keys].map(key=>cache.get(key));
    const plan=planGlobeAtlasPages(runs,size);
    if(!plan||plan.length>=current.size)return renderRows;
    for(const page of current)page.retired=true;
    for(const layout of plan){
      const page=addPage(layout.place);
      for(const {run,x,y} of layout.placements){
        const sourceX=Math.round(run.uv[0]*size),sourceY=Math.round(run.uv[1]*size);
        for(let row=0;row<run.height;row++){
          const offset=(sourceY+row)*size+sourceX;
          page.pixels.set(run.page.pixels.subarray(offset,offset+run.width),(y+row)*size+x);
        }
        const uv=[x/size,y/size,(x+run.width)/size,(y+run.height)/size];
        cache.set(run.atlasKey,{...run,page,uv});page.keys.add(run.atlasKey);
      }
      page.x=layout.x;page.y=layout.y;page.rowHeight=layout.rowHeight;
    }
    counters.compactedPages+=current.size-plan.length;cacheDirty=true;
    return renderRows.map(row=>({...row,...cache.get(row.atlasKey)}));
  }
  function setGroup(group,rows){
    if(rows===group.source)return false;
    const ordered=orderGlobeLabels(rows);
    group.source=rows;
    if(ordered.length===group.rows.length&&ordered.every((row,index)=>sameLabel(row,group.rows[index])))return false;
    const prior=new Map(group.rows.map(row=>[row.key,row]));
    group.rows=ordered.map(row=>{
      const old=prior.get(row.key);
      if(sameLabel(row,old))return old;
      const vector=equalCoordinate(old?.coordinate,row.coordinate)?old?.vector:undefined;
      const valid=Array.isArray(row.coordinate)&&row.coordinate.length===2&&row.coordinate.every(Number.isFinite)&&Math.abs(row.coordinate[1])<=90;
      const point=valid?(vector??globeVector(row.coordinate)):null;
      return {...row,vector:point,bounds:point?[...point,...point]:null,atlasKey:JSON.stringify([Boolean(row.place),row.marker??'',row.lines])};
    });
    group.index=createGlobeLabelSpatialIndex(group.rows);candidateRevision++;layoutCache=null;lastCamera=null;cacheDirty=true;return true;
  }
  function setCandidateGroups(countries,places){
    const changedCountries=setGroup(candidateGroups[0],countries),changedPlaces=setGroup(candidateGroups[1],places);
    return changedCountries||changedPlaces;
  }
  function setCandidates(rows){return setCandidateGroups(rows.filter(row=>!row.place),rows.filter(row=>row.place));}
  function trim(){
    if(!cacheDirty)return false;
    cacheDirty=false;
    for(const page of pages)while(page.batches.length&&page.batches.at(-1).count===0)disposeBatch(page.batches.pop());
    let bytes=pages.reduce((sum,page)=>sum+pageBytes(page),0);
    const preparingPages=new Set([...desiredKeys].map(key=>cachedRun(key)?.page).filter(Boolean));
    const inactive=pages.filter(page=>!activePages.has(page)&&!preparingPages.has(page)).sort((a,b)=>Number(b.retired)-Number(a.retired)||a.lastUsed-b.lastUsed);
    for(const page of inactive){
      if(!page.retired&&bytes<=byteBudget)break;
      bytes-=pageBytes(page);evictPage(page);
    }
    return true;
  }
  function update(camera,width,height,cull=createGlobeRangeCuller(camera.frame,width,height),requireComplete=false){
    if(camera===lastCamera&&lastStrict===requireComplete)return lastComplete;
    lastCamera=camera;lastStrict=requireComplete;
    if(!layoutCache||layoutCache.camera!==camera||layoutCache.width!==width||layoutCache.height!==height||layoutCache.revision!==candidateRevision){
      const visible=camera.view.zoom>=COUNTRY_LABEL_MIN_ZOOM?candidateGroups.flatMap(group=>group.index.query(cull)):[];
      const stats={candidates:candidateGroups.reduce((sum,group)=>sum+group.rows.length,0),spatialCandidates:visible.length,projectedCandidates:0,collisionComparisons:0,duplicateCollisionSkips:0};
      let hitGrid=null;
      const layout=placeGlobeLabels(visible,camera,{width,height},previous,(cells,columns,cellSize)=>{hitGrid={cells,columns,cellSize};},measureLabel,stats);
      layoutCache={camera,width,height,revision:candidateRevision,layout,hitGrid,stats};
    }
    const {layout,hitGrid,stats}=layoutCache;layoutStats={...stats};
    lastComplete=prepareMissing(layout);
    layoutStats.pending=layout.filter(row=>!cachedRun(row.atlasKey)).length;
    // Initial/temporal frames retain the previous label buffers until the
    // entire exact placement has a ready SDF. Moving frames may display
    // only ready runs; missing rows are not exposed to picking.
    if(requireComplete&&!lastComplete)return false;
    placed=layout.filter(row=>cachedRun(row.atlasKey));
    previous=new Set(placed.map(row=>row.key));
    const readyKeys=new Set(placed.map(row=>row.key)),hitCells=new Map();
    if(hitGrid){
      const {cells,columns,cellSize}=hitGrid;
      for(const [key,rows] of cells){
        const hits=rows.filter(row=>readyKeys.has(row.key)).map(({ref,left,right,top,bottom})=>({ref,left,right,top,bottom}));
        if(hits.length)hitCells.set(key,hits);
      }
      hitSnapshot=([x,y])=>x<0||y<0||x>width||y>height?null:(hitCells.get(Math.floor(y/cellSize)*columns+Math.floor(x/cellSize))??[]).find(row=>x>=row.left&&x<=row.right&&y>=row.top&&y<=row.bottom)?.ref??null;
    }else hitSnapshot=()=>null;
    const renderRows=compactActivePages(placed.map(row=>({...row,...cachedRun(row.atlasKey)})));
    const byPage=new Map();
    for(const row of renderRows){
      let rows=byPage.get(row.page);if(!rows){rows=[];byPage.set(row.page,rows);}rows.push(row);
    }
    for(const page of activePages)if(!byPage.has(page)){page.count=0;hideBatches(page);cacheDirty=true;}
    for(const [page,rows] of byPage){
      if(!activePages.has(page))cacheDirty=true;
      page.count=rows.length;page.lastUsed=performance.now();
      let batchIndex=0;
      for(let first=0;first<rows.length;first+=maxRows){
        const count=Math.min(maxRows,rows.length-first);
        const batch=createBatch(page,count,page.batches[batchIndex]);
        page.batches[batchIndex++]=batch;updateBatch(batch,rows,first,count);
      }
      hideBatches(page,batchIndex);flush(page.upload);
    }
    activePages=new Set(byPage.keys());layoutStats.placed=placed.length;
    return lastComplete;
  }
  function cancelPending(){desiredKeys.clear();cancelSdf();layoutCache=null;lastCamera=null;cacheDirty=true;}
  function restoreTextures(){
    for(const page of pages){restoreTexture(page.upload);for(const batch of page.batches)restoreTexture(batch.upload);}
  }
  function memoryEntries(){
    const preparingPages=new Set([...desiredKeys].map(key=>cachedRun(key)?.page).filter(Boolean));
    const rows=pages.map(page=>({key:page,...pageFootprint(page),lastUsed:page.lastUsed,protected:activePages.has(page)||preparingPages.has(page),evict:()=>evictPage(page)}));
    rows.push({key:raster,protected:true,extraBytes:raster.width*raster.height*4+pendingMaskBytes*10+metricsCache.size*192+candidateGroups.reduce((sum,group)=>sum+group.rows.length*192+group.index.rows.length*160,0)+placed.length*128});
    return rows;
  }
  function dispose(){
    disposed=true;cancelSdf();sdfTasks.dispose();desiredKeys.clear();
    for(const page of pages)disposePage(page);
    uploadSource.dispose();pages.length=0;cache.clear();metricsCache.clear();
    for(const group of candidateGroups){group.source=null;group.rows=[];group.index=createGlobeLabelSpatialIndex([]);}
    placed=[];previous.clear();activePages.clear();lastCamera=null;layoutCache=null;hitSnapshot=()=>null;
    raster.width=1;raster.height=1;
  }
  function cacheStats(){
    return {pages:pages.length,visiblePages:activePages.size,residentBytes:pages.reduce((sum,page)=>sum+pageBytes(page),0),
      batchCapacity:pages.reduce((sum,page)=>sum+page.batches.reduce((n,batch)=>n+batch.capacity,0),0),
      measuredTexts:metricsCache.size,...counters,sdfWorker:{...sdfTasks.stats(),fallback:sdfFallback,pendingMaskBytes},layout:{...layoutStats}};
  }
  return Object.freeze({setCandidates,setCandidateGroups,update,trim,dispose,cancelPending,restoreTextures,memoryEntries,hitSnapshot:()=>hitSnapshot,cacheStats,
    visibleCount:place=>placed.filter(row=>Boolean(row.place)===place).length,atlasEntryCount:()=>cache.size,hitTest:point=>hitSnapshot(point)});
}
