import {referenceZoomPixelsPerDegree} from '../map/map-display-zoom.js';
import {globeVector} from './globe-camera.js';
import {territorialLabelPixelSize} from './label-layout.js';
import {renderCacheBudget} from './render-cache-budget.js';

export const COUNTRY_LABEL_MIN_ZOOM=3;
const fontSize=56, outlineRange=7, padding=outlineRange+2, atlasSize=2048;

export function placeGlobeLabels(candidates,camera,viewport,previous) {
  const placed=[],cells=new Map();
  // Retain greedy priority and hysteresis. Inspect only occupied screen
  // cells touched by the candidate (including its existing gap).
  const cellSize=64,columns=Math.floor(viewport.width/cellSize)+1;
  function cellRange(left,top,right,bottom,visit){
    const x0=Math.max(0,Math.floor(left/cellSize)),y0=Math.max(0,Math.floor(top/cellSize));
    const x1=Math.min(columns-1,Math.floor(right/cellSize));
    const y1=Math.min(Math.floor(viewport.height/cellSize),Math.floor(bottom/cellSize));
    for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)if(visit(y*columns+x))return true;
    return false;
  }
  const scale=referenceZoomPixelsPerDegree(camera.view.zoom)*180/Math.PI;
  for(const label of candidates){
    if(label.visible===false||camera.view.zoom<(label.minZoom??-Infinity)||camera.view.zoom>(label.maxZoom??Infinity))continue;
    const point=camera.projectVisibleCoordinate(label.coordinate);
    if(!point)continue;
    const normal=globeVector(label.coordinate), eye=camera.frame.eye;
    const facing=normal.reduce((sum,value,axis)=>sum+value*eye[axis],-1)
      /Math.hypot(...eye.map((value,axis)=>value-normal[axis]));
    const retained=previous.has(label.key);
    if(facing<(retained ? .14 : .20))continue;
    const diameter=label.place?0:Math.sqrt(label.area)*scale;
    if(!label.place&&diameter<(retained?5:7))continue;
    const pixelSize=label.place?Math.min(20,12+Math.max(0,camera.view.zoom-4)*1.25)
      :territorialLabelPixelSize(label.shortSide,camera.view.zoom);
    const size=pixelSize/fontSize;
    const [x,y]=point, left=x-(label.anchorX??label.width/2)*size, top=y-(label.anchorY??label.height/2)*size;
    const right=left+label.width*size,bottom=top+label.height*size;
    if(left<0||top<0||right>viewport.width||bottom>viewport.height)continue;
    const gap=retained?0:3;
    if(cellRange(left-gap,top-gap,right+gap,bottom+gap,key=>
      (cells.get(key)??[]).some(row=>row.left<right+gap&&row.right>left-gap&&row.top<bottom+gap&&row.bottom>top-gap)))continue;
    const row={...label,left,right,top,bottom};
    placed.push(row);
    cellRange(left,top,right,bottom,key=>{
      let bucket=cells.get(key);
      if(!bucket){bucket=[];cells.set(key,bucket);}
      bucket.push(row);return false;
    });
  }
  return placed;
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

// Two raster passes approximate the signed Euclidean distance on the glyph mask.
function distanceMask(alpha,width,height){
  const distanceTo=(foreground)=>{
    const values=new Float32Array(width*height);
    for(let i=0;i<values.length;i++)values[i]=(alpha[i*4+3]>=128)===foreground?0:outlineRange+1;
    const pass=(direction)=>{
      for(let step=0;step<values.length;step++){
        const i=direction===1?step:values.length-1-step;
        const x=i%width, row=i-direction*width, side=i-direction;
        let distance=values[i];
        if(x-direction>=0&&x-direction<width)distance=Math.min(distance,values[side]+1);
        if(row<0||row>=values.length){values[i]=distance;continue;}
        distance=Math.min(distance,values[row]+1);
        if(x>0)distance=Math.min(distance,values[row-1]+Math.SQRT2);
        if(x<width-1)distance=Math.min(distance,values[row+1]+Math.SQRT2);
        values[i]=distance;
      }
    };
    pass(1);pass(-1);return values;
  };
  const inside=distanceTo(true),outside=distanceTo(false);
  return Uint8Array.from(inside,(distance,i)=>{
    const signed=outside[i]-distance;
    return Math.round(127.5+127.5*Math.max(-1,Math.min(1,signed/outlineRange)));
  });
}

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

export function createThreeGlobeLabels(THREE,{scene,palette,capacity,viewport,byteBudget=renderCacheBudget().labelAtlasBytes}){
  const raster=new OffscreenCanvas(1,1);
  const context=raster.getContext('2d',{willReadFrequently:true});
  const pages=[],cache=new Map();
  const textColor=new THREE.Color(palette.text),haloColor=new THREE.Color(0xffffff);
  let candidates=[],placed=[],previous=new Set(),lastCamera=null,clock=0,cacheDirty=true;

  function addPage(place){
    const pixels=new Uint8Array(atlasSize*atlasSize), values=new Float32Array(capacity*8);
    const atlas=new THREE.DataTexture(pixels,atlasSize,atlasSize,THREE.RedFormat);
    atlas.magFilter=atlas.minFilter=THREE.LinearFilter;
    const boxes=new THREE.DataTexture(values,2,capacity,THREE.RGBAFormat,THREE.FloatType);
    boxes.needsUpdate=true;
    const geometry=new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position',new THREE.BufferAttribute(Float32Array.of(0,0,0,1,0,0,0,1,0,1,1,0),3));
    geometry.setAttribute('instanceRow',new THREE.InstancedBufferAttribute(Float32Array.from({length:capacity},(_,i)=>i),1));
    geometry.setIndex([0,2,1,2,3,1]);
    const material=new THREE.ShaderMaterial({vertexShader,fragmentShader,depthTest:false,depthWrite:false,transparent:true,
      uniforms:{atlas:{value:atlas},boxes:{value:boxes},capacity:{value:capacity},viewport,
        textColor:{value:textColor},haloColor:{value:haloColor}}});
    const mesh=new THREE.Mesh(geometry,material);
    mesh.frustumCulled=false;mesh.renderOrder=7;geometry.instanceCount=0;scene.add(mesh);
    const page={pixels,values,atlas,boxes,mesh,place,x:0,y:0,rowHeight:0,count:0,keys:new Set(),lastUsed:++clock,retired:false};
    pages.push(page);cacheDirty=true;return page;
  }

  function prepareText(lines,place,marker){
    const key=JSON.stringify([place,marker,lines]);
    const cached=cache.get(key);
    if(cached&&!cached.page.retired)return cached;
    if(cached)cache.delete(key);
    const font=`${place?600:800} ${fontSize}px "Pretendard Variable", sans-serif`;
    context.font=font;
    const markerWidth=marker?36:0;
    const width=Math.min(atlasSize,Math.ceil(Math.max(...lines.map(line=>context.measureText(line).width)))+padding*2+markerWidth);
    const lineHeight=Math.ceil(fontSize*1.26),height=lineHeight*lines.length+padding*2;
    let page=pages.findLast(row=>row.place===place&&!row.retired)??addPage(place);
    if(page.x+width>atlasSize){page.y+=page.rowHeight;page.x=0;page.rowHeight=0;}
    if(page.y+height>atlasSize)page=addPage(place);
    raster.width=width;raster.height=height;
    context.font=font;context.textAlign=place?'left':'center';context.textBaseline='middle';context.fillStyle='#fff';
    const textX=place?padding+markerWidth:width/2,anchorX=place?padding+markerWidth/3:width/2;
    const anchorY=place?padding+lineHeight/2:height/2;
    lines.forEach((line,index)=>context.fillText(line,textX,padding+lineHeight*(index+.5),width-padding*2-markerWidth));
    if(marker){context.beginPath();context.arc(anchorX,anchorY,marker==='capital'?13:10,0,Math.PI*2);context.fill();}
    const field=distanceMask(context.getImageData(0,0,width,height).data,width,height);
    for(let y=0;y<height;y++)page.pixels.set(field.subarray(y*width,(y+1)*width),(page.y+y)*atlasSize+page.x);
    const uv=[page.x/atlasSize,page.y/atlasSize,(page.x+width)/atlasSize,(page.y+height)/atlasSize];
    const run={page,width,height,uv,anchorX,anchorY,atlasKey:key};
    cache.set(key,run);page.keys.add(key);page.x+=width;page.rowHeight=Math.max(page.rowHeight,height);page.atlas.needsUpdate=true;
    return run;
  }

  // Account for atlas pixels, per-page boxes and instance rows on both CPU
  // and GPU. The budget never limits the currently required labels.
  const pageBytes=2*(atlasSize*atlasSize+capacity*8*4+capacity*4+12*4+6*2);
  function compactActivePages(current){
    const keys=new Set(candidates.map(row=>row.atlasKey));
    const runs=[...keys].map(key=>cache.get(key));
    const plan=planGlobeAtlasPages(runs);
    if(!plan||plan.length>=current.size)return;
    for(const page of current)page.retired=true;
    for(const layout of plan){
      const page=addPage(layout.place);
      for(const {run,x,y} of layout.placements){
        const sourceX=Math.round(run.uv[0]*atlasSize),sourceY=Math.round(run.uv[1]*atlasSize);
        for(let row=0;row<run.height;row++){
          const offset=(sourceY+row)*atlasSize+sourceX;
          page.pixels.set(run.page.pixels.subarray(offset,offset+run.width),(y+row)*atlasSize+x);
        }
        const uv=[x/atlasSize,y/atlasSize,(x+run.width)/atlasSize,(y+run.height)/atlasSize];
        cache.set(run.atlasKey,{...run,page,uv});page.keys.add(run.atlasKey);
      }
      page.x=layout.x;page.y=layout.y;page.rowHeight=layout.rowHeight;page.atlas.needsUpdate=true;
    }
    candidates=candidates.map(row=>({...row,...cache.get(row.atlasKey)}));
  }
  function setCandidates(rows){
    candidates=orderGlobeLabels(rows).map(({lines,...label})=>({...label,...prepareText(lines,Boolean(label.place),label.marker??'')}));
    const current=new Set(candidates.map(row=>row.page));
    if(current.size*pageBytes>byteBudget&&current.size>1)compactActivePages(current);
    for(const page of new Set(candidates.map(row=>row.page)))page.lastUsed=++clock;
    cacheDirty=true;lastCamera=null;
  }
  function trim(){
    if(!cacheDirty)return;
    cacheDirty=false;
    const current=new Set(candidates.map(row=>row.page));
    const inactive=pages.filter(page=>!current.has(page)).sort((a,b)=>Number(b.retired)-Number(a.retired)||a.lastUsed-b.lastUsed);
    for(const page of inactive){
      if(!page.retired&&pages.length*pageBytes<=byteBudget)break;
      disposePage(page);pages.splice(pages.indexOf(page),1);
    }
  }
  function update(camera,width,height){
    if(camera===lastCamera)return;
    lastCamera=camera;
    placed=camera.view.zoom>=COUNTRY_LABEL_MIN_ZOOM?placeGlobeLabels(candidates,camera,{width,height},previous):[];
    previous=new Set(placed.map(row=>row.key));
    for(const page of pages)page.count=0;
    for(const {page,uv,left,top,right,bottom} of placed){
      const offset=page.count++*8;
      page.values.set([left,top,right,bottom,...uv],offset);
    }
    for(const page of pages){
      page.mesh.geometry.instanceCount=page.count;
      page.mesh.visible=page.count>0;
      if(page.count)page.boxes.needsUpdate=true;
    }
  }
  function disposePage(page){
    scene.remove(page.mesh);page.mesh.geometry.dispose();page.mesh.material.dispose();page.atlas.dispose();page.boxes.dispose();
    for(const key of page.keys)if(cache.get(key)?.page===page)cache.delete(key);
  }
  function dispose(){
    for(const page of pages)disposePage(page);
    pages.length=0;cache.clear();candidates=[];placed=[];previous.clear();lastCamera=null;
  }
  return Object.freeze({setCandidates,update,trim,dispose,cacheStats:()=>({pages:pages.length,residentBytes:pages.length*pageBytes}),
    visibleCount:place=>placed.filter(row=>Boolean(row.place)===place).length,atlasEntryCount:()=>cache.size,
    hitTest:([x,y])=>placed.find(row=>x>=row.left&&x<=row.right&&y>=row.top&&y<=row.bottom)?.ref??null,
  });
}
