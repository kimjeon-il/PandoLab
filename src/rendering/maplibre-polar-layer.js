// Hand over before Mercator's 85.051129-degree tile edge: a line ending on
// that edge can still acquire a stretched polar segment during tile clipping.
export const POLAR_LATITUDE = 85;
export function clipMercatorLines(geometry){
 const lines=geometry?.type==='LineString'?[geometry.coordinates]:geometry?.type==='MultiLineString'?geometry.coordinates:null;
 if(!lines||lines.every(line=>line.every(p=>Math.abs(p[1])<=POLAR_LATITUDE)))return geometry;
 const result=[];let part=[];
 const flush=()=>{if(part.length>1)result.push(part);part=[];};
 for(const line of lines){
  for(let i=1;i<line.length;i++){
   const a=line[i-1],b=line[i],dy=b[1]-a[1];let start=0,end=1;
   if(dy){const t0=(-POLAR_LATITUDE-a[1])/dy,t1=(POLAR_LATITUDE-a[1])/dy;start=Math.max(0,Math.min(t0,t1));end=Math.min(1,Math.max(t0,t1));}
   else if(Math.abs(a[1])>POLAR_LATITUDE){flush();continue;}
   if(start>=end){flush();continue;}
   const point=t=>[a[0]+(b[0]-a[0])*t,a[1]+dy*t],first=point(start),last=point(end),previous=part.at(-1);
   if(previous&&(Math.abs(previous[0]-first[0])>1e-9||Math.abs(previous[1]-first[1])>1e-9))flush();
   if(!part.length)part.push(first);part.push(last);if(end<1)flush();
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
 const values=[],indices=[];
 for(const line of lines)for(let i=1;i<line.length;i++){const a=line[i-1],b=line[i];if(!fullExtent&&Math.max(Math.abs(a[1]),Math.abs(b[1]))<POLAR_LATITUDE)continue;const n=values.length/5;values.push(...a,...b,1,...a,...b,-1,...b,...a,-1,...b,...a,1);indices.push(n,n+1,n+2,n+2,n+1,n+3);}
 return {values:new Float32Array(values),indices:new Uint32Array(indices)};
}
export function polarGridPacket(){const lines=[];for(const sign of [-1,1])for(let lon=-180;lon<180;lon+=10){const line=[];for(let i=0;i<=40;i++)line.push([lon,sign*(POLAR_LATITUDE+(90-POLAR_LATITUDE)*i/40)]);lines.push(line);}return polarLinePacket(lines);}
function capMesh(){
 const positions=[],indices=[];
 for(const sign of [-1,1]){const offset=positions.length/2;
  for(let j=0;j<=20;j++)for(let i=0;i<=360;i++)positions.push(i-180,sign*(POLAR_LATITUDE+(90-POLAR_LATITUDE)*j/20));
  for(let j=0;j<20;j++)for(let i=0;i<360;i++){const a=offset+j*361+i,b=a+361;indices.push(a,a+1,b,a+1,b+1,b);}
 }
 return {positions:new Float32Array(positions),indices:new Uint32Array(indices)};
}
export function polarTriangleIndices(packet){
 if(!Number.isFinite(packet.maxEdgeDegrees))return packet.indices;
 const margin=packet.maxEdgeDegrees,positions=packet.positions,indices=[];
 for(let i=0;i<packet.indices.length;i+=3){const a=packet.indices[i],b=packet.indices[i+1],c=packet.indices[i+2];if(Math.max(Math.abs(positions[a*2+1]),Math.abs(positions[b*2+1]),Math.abs(positions[c*2+1]))+margin>=POLAR_LATITUDE)indices.push(a,b,c);}
 return new Uint32Array(indices);
}
export function polarCapsVisible(data){
 if(data?.projectionTransition<.999||data?.mainMatrix?.length!==16||!data.clippingPlane)return true;
 const m=data.mainMatrix,planes=[data.clippingPlane];
 for(const axis of [0,1])for(const sign of [-1,1])planes.push([m[3]+sign*m[axis],m[7]+sign*m[4+axis],m[11]+sign*m[8+axis],m[15]+sign*m[12+axis]]);
 const s=Math.sin(POLAR_LATITUDE*Math.PI/180),c=Math.cos(POLAR_LATITUDE*Math.PI/180);
 return [-1,1].some(sign=>planes.every(([x,y,z,w])=>{const v=y*sign,h=Math.hypot(x,z),length=Math.hypot(h,v);return (length&&v/length>=s?length:v*s+h*c)+w>=0;}));
}
export function createPolarLayer({map,prepare,onChange,onError}){
 const id='pando-polar-caps',cache=new WeakMap();let rows=[],key='',pending=false,sequence=0,disposed=false,gl,program,vao,bindings;
 let loadingSurface=null;
 let culledFrames=0,drawCalls=0,submittedTriangles=0,uploadedBytes=0;
 let buffers=new Map();
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
  for(let i=0;i<positions.length/2;i++)values.set([positions[i*2],positions[i*2+1],positions[i*2],positions[i*2+1],0],i*5);
  const indices=packet.indices;
  const vertex=gl.createBuffer(),index=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,vertex);gl.bufferData(gl.ARRAY_BUFFER,values,gl.STATIC_DRAW);gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,index);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,indices,gl.STATIC_DRAW);
  uploadedBytes+=values.byteLength+indices.byteLength;
  const record={vertex,index,count:indices.length};buffers.set(packet,record);return record;
 }
 function release(){if(!gl)return;for(const b of buffers.values()){gl.deleteBuffer(b.vertex);gl.deleteBuffer(b.index);}buffers.clear();if(program)gl.deleteProgram(program);if(vao)gl.deleteVertexArray(vao);program=null;vao=null;variant='';}
 const layer={id,type:'custom',renderingMode:'2d',onAdd(_map,context){gl=context;vao=gl.createVertexArray();},onRemove:release,
  render(context,options){
   if(disposed||failed||!rows.length)return;
   const capsVisible=polarCapsVisible(options.defaultProjectionData);
   if(!capsVisible){culledFrames++;if(loadingSurface||!rows.some(row=>row.fullExtent))return;}
   // MapLibre's CustomLayerInterface restores its state after render returns
   // (drawCustom: context.setDirty + painter.setBaseState). Keep our own VAO
   // isolated; querying/restoring the preceding native draw stalls the GPU.
   try{
    compile(options);gl.bindVertexArray(vao);gl.useProgram(program);gl.disable(gl.DEPTH_TEST);gl.disable(gl.STENCIL_TEST);gl.disable(gl.CULL_FACE);gl.enable(gl.BLEND);gl.blendEquation(gl.FUNC_ADD);
    const uniform=name=>bindings[name],data=options.defaultProjectionData;
    gl.uniformMatrix4fv(uniform('u_projection_matrix'),false,new Float32Array(data.mainMatrix));gl.uniformMatrix4fv(uniform('u_projection_fallback_matrix'),false,new Float32Array(data.fallbackMatrix));
    gl.uniform4fv(uniform('u_projection_clipping_plane'),data.clippingPlane);gl.uniform4fv(uniform('u_projection_tile_mercator_coords'),data.tileMercatorCoords);gl.uniform1f(uniform('u_projection_transition'),data.projectionTransition);gl.uniform4fv(uniform('u_clip'),data.clippingPlane);
    gl.uniform2f(uniform('u_viewport'),map.getCanvas().clientWidth,map.getCanvas().clientHeight);gl.uniform1f(uniform('u_width'),1);
    for(const row of rows){
     if(!capsVisible&&!row.fullExtent)continue;
     if(loadingSurface&&!row.loadingRole)continue;
     const b=upload(row.packet);gl.bindBuffer(gl.ARRAY_BUFFER,b.vertex);gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,b.index);
     const pos=bindings.position,side=bindings.side;gl.enableVertexAttribArray(pos);gl.vertexAttribPointer(pos,4,gl.FLOAT,false,20,0);gl.enableVertexAttribArray(side);gl.vertexAttribPointer(side,1,gl.FLOAT,false,20,16);
     gl.uniform1i(uniform('u_cap_only'),row.fullExtent?0:1);gl.uniform1f(uniform('u_width'),row.width||1);gl.uniform4fv(uniform('u_color'),loadingSurface?.[row.loadingRole]??row.color);
     gl.blendFunc(row.multiply?gl.DST_COLOR:gl.ONE,gl.ONE_MINUS_SRC_ALPHA);gl.drawElements(gl.TRIANGLES,b.count,gl.UNSIGNED_INT,0);drawCalls++;submittedTriangles+=b.count/3;
    }
   }catch(error){failed=true;onError(error);}finally{
    gl.bindVertexArray(null);
   }
  }};
 const background=capMesh();
 async function mesh(geometry,fullExtent){
  // Full highlights use canonical geometry. Cap rows always use the derived polarGeometry object.
  if(!cache.has(geometry)){
   preparations++;
   cache.set(geometry,prepare(geometry).then(packet=>fullExtent?packet:{...packet,indices:polarTriangleIndices(packet)})
    .catch(error=>{cache.delete(geometry);throw error;}));
  }
  return cache.get(geometry);
 }
 return {id,stats:()=>({preparations,pending,rows:rows.length,culledFrames,drawCalls,submittedTriangles,uploadedBytes}),retry(){sequence++;pending=false;failed=false;key='';release();vao=gl.createVertexArray();},resetContext(){failed=false;release();vao=gl.createVertexArray();},ensure(){if(!map.getLayer(id))map.addLayer(layer,map.getLayer('viewer-label-dot')?'viewer-label-dot':undefined);},get pending(){return pending;},
  setLoadingSurface(surface){loadingSurface=surface;},
  update(nextKey,items,backgroundColor){if(nextKey===key)return;key=nextKey;pending=true;const version=++sequence;
   Promise.all(items.map(async item=>({...item,packet:item.packet||await mesh(item.geometry,item.fullExtent)}))).then(next=>{if(disposed||version!==sequence)return;rows=[{packet:background,color:backgroundColor,loadingRole:'ocean'},...next];const active=new Set(rows.map(r=>r.packet));for(const [p,b]of buffers)if(!active.has(p)){gl.deleteBuffer(b.vertex);gl.deleteBuffer(b.index);buffers.delete(p);}pending=false;onChange();},error=>{if(!disposed&&version===sequence){pending=false;key='';failed=true;onError(error);}});
  },dispose(){disposed=true;sequence++;if(map.getLayer(id))map.removeLayer(id);else release();}};
}
