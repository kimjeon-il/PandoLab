// Hand over before Mercator's 85.051129-degree tile edge: a line ending on
// that edge can still acquire a stretched polar segment during tile clipping.
export const POLAR_LATITUDE = 85;
const SOUTH_CAP = 1, NORTH_CAP = 2, BOTH_CAPS = SOUTH_CAP | NORTH_CAP;
const latitudeBands = [[-90, -POLAR_LATITUDE, SOUTH_CAP], [POLAR_LATITUDE, 90, NORTH_CAP]];

function cutLatitude(a, b, south, north) {
 const dy=b[1]-a[1];
 if(!dy)return a[1]>=south&&a[1]<=north?[a,b]:null;
 const t0=(south-a[1])/dy,t1=(north-a[1])/dy;
 const start=Math.max(0,Math.min(t0,t1)),end=Math.min(1,Math.max(t0,t1));
 if(start>=end)return null;
 const point=t=>t===0?a:t===1?b:[a[0]+(b[0]-a[0])*t,t===t0?south:north];
 return [point(start),point(end)];
}

export function clipMercatorLines(geometry){
 const lines=geometry?.type==='LineString'?[geometry.coordinates]:geometry?.type==='MultiLineString'?geometry.coordinates:null;
 if(!lines||lines.every(line=>line.every(p=>Math.abs(p[1])<=POLAR_LATITUDE)))return geometry;
 const result=[];let part=[];
 const flush=()=>{if(part.length>1)result.push(part);part=[];};
 for(const line of lines){
  for(let i=1;i<line.length;i++){
   const a=line[i-1],b=line[i],section=cutLatitude(a,b,-POLAR_LATITUDE,POLAR_LATITUDE);
   if(!section){flush();continue;}
   const [first,last]=section,previous=part.at(-1);
   if(previous&&(Math.abs(previous[0]-first[0])>1e-9||Math.abs(previous[1]-first[1])>1e-9))flush();
   if(!part.length)part.push(first);part.push(last);if(last!==b)flush();
  }
  flush();
 }
 return {type:'MultiLineString',coordinates:result};
}
const polarShapes=new WeakMap();
export function polarGeometry(geometry){
 if(!geometry)return null;if(polarShapes.has(geometry))return polarShapes.get(geometry);
 const polygons=geometry?.type==='Polygon'?[geometry.coordinates]:geometry?.type==='MultiPolygon'?geometry.coordinates:[];
 const selected=polygons.filter(poly=>poly.some(ring=>ring.some(point=>Math.abs(point[1])>=POLAR_LATITUDE)));
 const result=selected.length?{type:'MultiPolygon',coordinates:selected}:null;polarShapes.set(geometry,result);return result;
}
export function polarLinePacket(lines,{fullExtent=false}={}){
 const values=[],indices=[],ranges=[];
 const bands=fullExtent?[[-90,90,BOTH_CAPS]]:latitudeBands;
 for(const [south,north,cap] of bands){
  const offset=indices.length;
  for(const line of lines)for(let i=1;i<line.length;i++){
   const a=line[i-1],b=line[i];
   if(!fullExtent&&(cap===SOUTH_CAP?Math.min(a[1],b[1])>=north:Math.max(a[1],b[1])<=south))continue;
   const section=fullExtent?[a,b]:cutLatitude(a,b,south,north);
   if(!section)continue;
   const [first,last]=section,n=values.length/5;
   const [x,y]=first,[nextX,nextY]=last;
   if(x===nextX&&y===nextY)continue;
   values.push(x,y,nextX,nextY,1,x,y,nextX,nextY,-1,nextX,nextY,x,y,-1,nextX,nextY,x,y,1);
   indices.push(n,n+1,n+2,n+2,n+1,n+3);
  }
  if(indices.length>offset)ranges.push({cap,offset,count:indices.length-offset});
 }
 return {values:new Float32Array(values),indices:new Uint32Array(indices),ranges};
}
export function polarGridPacket(){const lines=[];for(const sign of [-1,1])for(let lon=-180;lon<180;lon+=10){const line=[];for(let i=0;i<=40;i++)line.push([lon,sign*(POLAR_LATITUDE+(90-POLAR_LATITUDE)*i/40)]);lines.push(line);}return polarLinePacket(lines);}
function capMesh(){
 const positions=[],indices=[],ranges=[];
 for(const sign of [-1,1]){const offset=positions.length/2,start=indices.length;
  for(let j=0;j<=20;j++)for(let i=0;i<=360;i++)positions.push(i-180,sign*(POLAR_LATITUDE+(90-POLAR_LATITUDE)*j/20));
  for(let j=0;j<20;j++)for(let i=0;i<360;i++){const a=offset+j*361+i,b=a+361;indices.push(a,a+1,b,a+1,b+1,b);}
  ranges.push({cap:sign===-1?SOUTH_CAP:NORTH_CAP,offset:start,count:indices.length-start});
 }
 return {positions:new Float32Array(positions),indices:new Uint32Array(indices),ranges};
}
export function compactPolarPacket(packet){
 const {positions,indices,maxEdgeDegrees:margin}=packet;
 if(!Number.isFinite(margin))return packet;
 const groups=[[],[],[]];
 for(let i=0;i<indices.length;i+=3){
  const a=indices[i],b=indices[i+1],c=indices[i+2];
  const y0=positions[a*2+1],y1=positions[b*2+1],y2=positions[c*2+1];
  const cap=(Math.min(y0,y1,y2)-margin<=-POLAR_LATITUDE?SOUTH_CAP:0)|(Math.max(y0,y1,y2)+margin>=POLAR_LATITUDE?NORTH_CAP:0);
  if(cap)groups[cap-1].push(a,b,c);
 }
 const remapped=new Int32Array(positions.length/2).fill(-1),compactPositions=[],compactIndices=[],ranges=[];
 for(const [index,group] of groups.entries()){
  if(!group.length)continue;
  ranges.push({cap:index+1,offset:compactIndices.length,count:group.length});
  for(const vertex of group){
   if(remapped[vertex]===-1){remapped[vertex]=compactPositions.length/2;compactPositions.push(positions[vertex*2],positions[vertex*2+1]);}
   compactIndices.push(remapped[vertex]);
  }
 }
 return {positions:new Float32Array(compactPositions),indices:new Uint32Array(compactIndices),ranges};
}
function visiblePolarCaps(data){
 if(data?.projectionTransition<.999||data?.mainMatrix?.length!==16||!data.clippingPlane)return BOTH_CAPS;
 const m=data.mainMatrix,planes=[data.clippingPlane];
 for(const axis of [0,1])for(const sign of [-1,1])planes.push([m[3]+sign*m[axis],m[7]+sign*m[4+axis],m[11]+sign*m[8+axis],m[15]+sign*m[12+axis]]);
 const s=Math.sin(POLAR_LATITUDE*Math.PI/180),c=Math.cos(POLAR_LATITUDE*Math.PI/180);
 let visible=0;
 for(const sign of [-1,1])if(planes.every(([x,y,z,w])=>{const v=y*sign,h=Math.hypot(x,z),length=Math.hypot(h,v);return (length&&v/length>=s?length:v*s+h*c)+w>=0;}))visible|=sign===-1?SOUTH_CAP:NORTH_CAP;
 return visible;
}
export const polarCapsVisible=data=>visiblePolarCaps(data)!==0;
export function createPolarLayer({map,prepare,onChange,onError}){
 const id='pando-polar-caps',capCache=new WeakMap(),fullCache=new WeakMap();
 let key='',pending=false,sequence=0,disposed=false,gl,program,vao,bindings;
 const emptyBatch={rows:[],packets:new Set(),fullExtent:false};
 let staticBatch=emptyBatch,gridBatch=emptyBatch,overlayBatch=emptyBatch,highlightBatch=emptyBatch,stagedHighlights=emptyBatch,highlightSequence=0,contextGeneration=0;
 let loadingSurface=null;
 let culledFrames=0,drawCalls=0,submittedTriangles=0,uploadedBytes=0;
 const buffers=new Map();
 const shader=(type,source)=>{const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){const message=gl.getShaderInfoLog(s);gl.deleteShader(s);throw Error(message);}return s;};
 let variant='',preparations=0,failed=false;
 function compile(options){
  if(program&&variant===options.shaderData.variantName)return;
  if(program)gl.deleteProgram(program);variant=options.shaderData.variantName;
  const vs=shader(gl.VERTEX_SHADER,`#version 300 es
   ${options.shaderData.vertexShaderPrelude}
   ${options.shaderData.define}
   in vec4 a_geo;in float a_side;uniform vec2 u_viewport;uniform float u_width;out vec3 v_sphere;
   vec3 sphere(vec2 p){vec2 r=radians(p);return vec3(sin(r.x)*cos(r.y),sin(r.y),cos(r.x)*cos(r.y));}
   vec4 project(vec2 p){vec2 fallback=vec2((p.x+180.)/360.,(1.-log(tan(0.7853981633974483+radians(clamp(p.y,-89.999,89.999))*.5))/3.141592653589793)*.5);
    #ifdef GLOBE
     return interpolateProjection(fallback,sphere(p),0.);
    #else
     return projectTile(fallback);
    #endif
   }
   void main(){v_sphere=sphere(a_geo.xy);gl_Position=project(a_geo.xy);if(a_side!=0.){vec4 other=project(a_geo.zw);vec2 d=(other.xy/other.w-gl_Position.xy/gl_Position.w)*u_viewport;float n=length(d);if(n>0.)gl_Position.xy+=vec2(-d.y,d.x)/n*a_side*u_width/u_viewport*gl_Position.w;}}
  `);
  const fs=shader(gl.FRAGMENT_SHADER,`#version 300 es
   precision highp float;in vec3 v_sphere;uniform vec4 u_color;uniform vec4 u_clip;uniform bool u_cap_only;out vec4 fragColor;
   void main(){vec3 p=normalize(v_sphere);if((u_cap_only&&abs(p.y)<${Math.sin(POLAR_LATITUDE*Math.PI/180)})||dot(p,u_clip.xyz)+u_clip.w<0.)discard;fragColor=vec4(u_color.rgb*u_color.a,u_color.a);}
  `);
  program=gl.createProgram();gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);gl.deleteShader(vs);gl.deleteShader(fs);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));
  bindings=Object.fromEntries(['u_projection_matrix','u_projection_fallback_matrix','u_projection_clipping_plane','u_projection_tile_mercator_coords','u_projection_transition','u_clip','u_viewport','u_width','u_color','u_cap_only'].map(name=>[name,gl.getUniformLocation(program,name)]));
  bindings.position=gl.getAttribLocation(program,'a_geo');bindings.side=gl.getAttribLocation(program,'a_side');
 }
 function upload(packet){
  if(buffers.has(packet))return buffers.get(packet);
  const positions=packet.positions||[],values=packet.values||new Float32Array(positions.length/2*5);
  if(!packet.values)for(let i=0;i<positions.length/2;i++){
   const x=positions[i*2],y=positions[i*2+1],offset=i*5;
   values[offset]=x;values[offset+1]=y;values[offset+2]=x;values[offset+3]=y;
  }
  const indices=packet.indices;
  const vertex=gl.createBuffer(),index=gl.createBuffer();
  if(!vertex||!index){if(vertex)gl.deleteBuffer(vertex);if(index)gl.deleteBuffer(index);throw Error('Could not allocate polar buffers.');}
  // WebGL2 types an index buffer on its first ELEMENT_ARRAY_BUFFER bind.
  // The caller owns the bound VAO. COPY_WRITE_BUFFER leaves ARRAY_BUFFER untouched.
  try{
   gl.bindBuffer(gl.COPY_WRITE_BUFFER,vertex);gl.bufferData(gl.COPY_WRITE_BUFFER,values,gl.STATIC_DRAW);
   gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,index);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,indices,gl.STATIC_DRAW);
  }catch(error){gl.deleteBuffer(vertex);gl.deleteBuffer(index);throw error;}
  finally{gl.bindBuffer(gl.COPY_WRITE_BUFFER,null);}
  uploadedBytes+=values.byteLength+indices.byteLength;
  const record={vertex,index,ranges:packet.ranges||[{cap:BOTH_CAPS,offset:0,count:indices.length}]};
  buffers.set(packet,record);return record;
 }
 function retire(batch){
  for(const packet of batch.packets){
   if(staticBatch.packets.has(packet)||gridBatch.packets.has(packet)||overlayBatch.packets.has(packet)
    ||highlightBatch.packets.has(packet)||stagedHighlights.packets.has(packet))continue;
   const b=buffers.get(packet);if(!b)continue;
   gl.deleteBuffer(b.vertex);gl.deleteBuffer(b.index);buffers.delete(packet);
  }
 }
 function release(){
  contextGeneration++;stagedHighlights=emptyBatch;
  if(!gl)return;
  for(const b of buffers.values()){gl.deleteBuffer(b.vertex);gl.deleteBuffer(b.index);}
  buffers.clear();if(program)gl.deleteProgram(program);if(vao)gl.deleteVertexArray(vao);program=null;vao=null;variant='';
 }
 function presentBatch(batch,capVisibility){
  for(const row of batch.rows){
   const caps=row.fullExtent?BOTH_CAPS:capVisibility;
   if(!caps||row.packet.ranges&&!row.packet.ranges.some(range=>range.cap&caps))continue;
   const color=loadingSurface?loadingSurface[row.loadingRole]:row.color;
   if(!color||!row.packet.indices.length)continue;
   const b=upload(row.packet);gl.bindBuffer(gl.ARRAY_BUFFER,b.vertex);gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,b.index);
   const pos=bindings.position,side=bindings.side;gl.enableVertexAttribArray(pos);gl.vertexAttribPointer(pos,4,gl.FLOAT,false,20,0);gl.enableVertexAttribArray(side);gl.vertexAttribPointer(side,1,gl.FLOAT,false,20,16);
   gl.uniform1i(bindings.u_cap_only,row.fullExtent?0:1);gl.uniform1f(bindings.u_width,row.width||1);gl.uniform4fv(bindings.u_color,color);
   gl.blendFunc(row.multiply?gl.DST_COLOR:gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
   for(const {cap,offset,count} of b.ranges)if(cap&caps){
    gl.drawElements(gl.TRIANGLES,count,gl.UNSIGNED_INT,offset*Uint32Array.BYTES_PER_ELEMENT);
    drawCalls++;submittedTriangles+=count/3;
   }
  }
 }
 const layer={id,type:'custom',renderingMode:'2d',onAdd(_map,context){gl=context;contextGeneration++;vao=gl.createVertexArray();},onRemove(){release();gl=null;},
  render(context,options){
   if(disposed||failed||(!staticBatch.rows.length&&!highlightBatch.rows.length))return;
   const capsVisible=visiblePolarCaps(options.defaultProjectionData);
   if(!capsVisible){culledFrames++;if(loadingSurface||(!staticBatch.fullExtent&&!highlightBatch.fullExtent))return;}
   // MapLibre's CustomLayerInterface restores its state after render returns
   // (drawCustom: context.setDirty + painter.setBaseState). Keep our own VAO
   // isolated; querying/restoring the preceding native draw stalls the GPU.
   try{
    compile(options);gl.bindVertexArray(vao);gl.useProgram(program);gl.disable(gl.DEPTH_TEST);gl.disable(gl.STENCIL_TEST);gl.disable(gl.CULL_FACE);gl.enable(gl.BLEND);gl.blendEquation(gl.FUNC_ADD);
    const uniform=name=>bindings[name],data=options.defaultProjectionData;
    gl.uniformMatrix4fv(uniform('u_projection_matrix'),false,new Float32Array(data.mainMatrix));gl.uniformMatrix4fv(uniform('u_projection_fallback_matrix'),false,new Float32Array(data.fallbackMatrix));
    gl.uniform4fv(uniform('u_projection_clipping_plane'),data.clippingPlane);gl.uniform4fv(uniform('u_projection_tile_mercator_coords'),data.tileMercatorCoords);gl.uniform1f(uniform('u_projection_transition'),data.projectionTransition);gl.uniform4fv(uniform('u_clip'),data.clippingPlane);
    gl.uniform2f(uniform('u_viewport'),map.getCanvas().clientWidth,map.getCanvas().clientHeight);gl.uniform1f(uniform('u_width'),1);
    presentBatch(staticBatch,capsVisible);
    if(!loadingSurface)presentBatch(overlayBatch,capsVisible);
    presentBatch(gridBatch,capsVisible);
    if(!loadingSurface)presentBatch(highlightBatch,capsVisible);
   }catch(error){failed=true;onError(error);}finally{
    gl.bindVertexArray(null);
   }
  }};
 const background=capMesh();
 async function mesh(geometry,fullExtent){
  // Only cap packets are trimmed by the Worker. Full-extent highlights keep the whole mesh.
  const cache=fullExtent?fullCache:capCache;
  if(!cache.has(geometry)){
   preparations++;
   cache.set(geometry,prepare(geometry,{fullExtent:fullExtent===true})
    .catch(error=>{cache.delete(geometry);throw error;}));
  }
  return cache.get(geometry);
 }
 const batchFor=rows=>({rows,packets:new Set(rows.map(row=>row.packet)),fullExtent:rows.some(row=>row.fullExtent)});
 const prepareRows=items=>Promise.all(items.map(async item=>({...item,packet:item.packet||await mesh(item.geometry,item.fullExtent)})));
 const obsoleteHighlight=()=>new DOMException('Polar highlights were superseded','AbortError');
 async function prepareHighlights(items){
  const request=++highlightSequence,generation=contextGeneration;
  const previous=stagedHighlights;stagedHighlights=emptyBatch;retire(previous);
  const current=()=>!disposed&&request===highlightSequence&&generation===contextGeneration&&gl?.isContextLost?.()!==true;
  const next=batchFor(await prepareRows(items));
  if(!current())throw obsoleteHighlight();
  stagedHighlights=next;
  try{
   const missing=gl&&[...next.packets].filter(packet=>packet.indices.length&&!buffers.has(packet));
   if(missing?.length){
    // This path runs only for a new staged highlight, outside native drawing.
    const previousVao=gl.getParameter(gl.VERTEX_ARRAY_BINDING);
    gl.bindVertexArray(vao);
    try{for(const packet of missing)upload(packet);}
    finally{gl.bindVertexArray(previousVao);}
   }
  }
  catch(error){stagedHighlights=emptyBatch;retire(next);throw error;}
  if(!current()){stagedHighlights=emptyBatch;retire(next);throw obsoleteHighlight();}
  return ()=>{
   if(!current()||stagedHighlights!==next)return false;
   const previous=highlightBatch;highlightBatch=next;stagedHighlights=emptyBatch;retire(previous);
   map.triggerRepaint?.();return true;
  };
 }
 function clearHighlights(){
  highlightSequence++;
  const previous=highlightBatch,staged=stagedHighlights;
  highlightBatch=stagedHighlights=emptyBatch;retire(previous);retire(staged);
  if(previous.rows.length)map.triggerRepaint?.();
 }
 function resetContext(){failed=false;release();if(gl)vao=gl.createVertexArray();}
 return {id,stats:()=>({preparations,pending,rows:staticBatch.rows.length+gridBatch.rows.length+overlayBatch.rows.length+highlightBatch.rows.length,culledFrames,drawCalls,submittedTriangles,uploadedBytes}),
  retry(){sequence++;pending=false;key='';resetContext();},resetContext,
  ensure(){if(!map.getLayer(id))map.addLayer(layer,map.getLayer('viewer-label-dot')?'viewer-label-dot':undefined);},get pending(){return pending;},
  prepareHighlights,clearHighlights,
  setOverlayLines(items){
   const previous=overlayBatch;
   overlayBatch=batchFor(items);
   retire(previous);
   map.triggerRepaint?.();
  },
  setLoadingSurface(surface){loadingSurface=surface;},
  update(nextKey,items,backgroundColor){if(nextKey===key)return;key=nextKey;pending=true;const version=++sequence;
   prepareRows(items).then(next=>{
    if(disposed||version!==sequence)return;
    const previous=staticBatch,previousGrid=gridBatch;
    staticBatch=batchFor([{packet:background,color:backgroundColor,loadingRole:'ocean'},...next.filter(row=>row.loadingRole!=='grid')]);
    gridBatch=batchFor(next.filter(row=>row.loadingRole==='grid'));
    retire(previous);retire(previousGrid);pending=false;onChange();
   },error=>{if(!disposed&&version===sequence){pending=false;key='';failed=error?.name!=='AbortError';onError(error);}});
  },dispose(){disposed=true;sequence++;if(map.getLayer(id))map.removeLayer(id);else release();}};
}
