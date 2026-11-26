import { GLOBE_FIELD_OF_VIEW } from './globe-camera.js';
import { createThreeGlobeStrokes, hydroStyleLookup } from './three-globe-strokes.js';
import { createThreeGlobeLabels } from './three-globe-labels.js';
import { PLACE_LIMITS } from '../document/place-limits.js';
import {renderCacheBudget,renderPacketBytes,touchRenderCache,trimRenderCache} from './render-cache-budget.js';
import {partitionGlobeMesh,partitionGlobeStrokes,globeStrokeRange,createGlobeRangeCuller,visibleGlobeMeshRanges} from './globe-spatial-partition.js';

const surfaceVertex = `
  attribute vec3 positionLow;
  #ifdef COUNTRY_PALETTE
    attribute float objectSlot;
    uniform sampler2D objectColors;
    uniform float objectCount;
  #endif
  #ifdef HYDRO_PALETTE
    attribute float objectSlot;
    ${hydroStyleLookup}
  #endif
  uniform vec3 eyeHigh, eyeLow, surfaceColor;
  uniform float zoom, minZoom;
  uniform mat3 viewRotation;
  varying vec3 surfaceNormal, surfaceRay;
  varying vec4 paint;
  void main() {
    if (zoom < minZoom) {
      gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
      return;
    }
    surfaceNormal = position;
    surfaceRay = (position - eyeHigh) + (positionLow - eyeLow);
    #ifdef COUNTRY_PALETTE
      paint = texture2D(objectColors, vec2((objectSlot + 0.5) / objectCount, 0.5));
    #elif defined(HYDRO_PALETTE)
      paint = vec4(mix(surfaceColor, hydroTint, hydroStyle(objectSlot).z), 1.0);
    #else
      paint = vec4(surfaceColor,1.0);
    #endif
    gl_Position = projectionMatrix * vec4(viewRotation * surfaceRay, 1.0);
  }
`;

const surfaceFragment = `
  varying vec3 surfaceNormal, surfaceRay;
  varying vec4 paint;
  void main() {
    if (paint.a == 0.0 || dot(surfaceNormal, surfaceRay) >= 0.0) discard;
    gl_FragColor = paint;
    #include <colorspace_fragment>
  }
`;

// Index immutable outline segments once by owner group and owner slot.
export function indexGlobeOutlineRanges(packet,owners){
  const groupsBySlot=new Map(),rangesByGroup=Array.from({length:owners.length},()=>[]);
  owners.forEach((slots,group)=>{
    for(const slot of slots){
      let groups=groupsBySlot.get(slot);
      if(!groups){groups=[];groupsBySlot.set(slot,groups);}
      groups.push(group);
    }
  });
  for(let first=0;first<packet.count;){
    const group=packet.ownerGroups[first];
    let end=first+1;
    while(end<packet.count&&packet.ownerGroups[end]===group)end++;
    rangesByGroup[group].push([first,end]);first=end;
  }
  return {groupsBySlot,rangesByGroup};
}

export function selectGlobeOutlineGroups(index,roles,styles){
  const groups=new Map();
  for(const [slot,code] of roles){
    const style=styles[code];
    if(!style||style.width<=0||style.alpha<=0)continue;
    for(const group of index.groupsBySlot.get(slot)??[]){
      if(code>(groups.get(group)??0))groups.set(group,code);
    }
  }
  return groups;
}

export function globeOutlineRanges(index,groups){
  return [...groups].flatMap(([group,code])=>index.rangesByGroup[group].map(([first,end])=>({first,end,code})))
    .sort((a,b)=>a.first-b.first);
}

export function createThreeGlobeSurface(THREE, { canvas, context, palette, packets, countryCount, hydroCount, cacheBudget=renderCacheBudget() }) {
  const renderer = new THREE.WebGLRenderer({ canvas, context });
  renderer.setClearColor(palette.ocean);
  renderer.debug.onShaderError = (gl, program, vertexShader, fragmentShader) => {
    throw new Error([gl.getProgramInfoLog(program), gl.getShaderInfoLog(vertexShader), gl.getShaderInfoLog(fragmentShader)].filter(Boolean).join('\n'));
  };
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(GLOBE_FIELD_OF_VIEW, 1);
  const channels = new Uint8Array(countryCount * 4);
  const texture = new THREE.DataTexture(channels, countryCount, 1);
  texture.colorSpace = THREE.SRGBColorSpace;
  let countryTextureUploaded=false;
  texture.onUpdate=()=>{countryTextureUploaded=true;};
  texture.needsUpdate=true;
  const hydroWidth=Math.min(1024,Math.max(1,hydroCount)),hydroHeight=Math.ceil(Math.max(1,hydroCount)/hydroWidth);
  const hydroBytes=new Uint8Array(hydroWidth*hydroHeight);
  const hydroTexture=new THREE.DataTexture(hydroBytes,hydroWidth,hydroHeight,THREE.RedFormat);
  hydroTexture.needsUpdate=true;
  const hydroTint=new THREE.Color(),hydroStyles=Array.from({length:5},()=>new THREE.Vector3());
  const hydroUniforms={hydroRoles:{value:hydroTexture},hydroSize:{value:new THREE.Vector2(hydroWidth,hydroHeight)},
    hydroTint:{value:hydroTint},hydroStyles:{value:hydroStyles},hasHydroHighlight:{value:false}};
  let previousHydro=new Map(),waterMeshes=new Map();
  const eyeHigh = new THREE.Vector3(), eyeLow = new THREE.Vector3();
  const viewRotation = new THREE.Matrix3();
  const zoom = { value: 0 };
  const cameraUniforms = { eyeHigh: { value: eyeHigh }, eyeLow: { value: eyeLow }, viewRotation: { value: viewRotation }, zoom };
  const viewport = { value: new THREE.Vector2() }, margin = { value: 0.5 };
  const labels=createThreeGlobeLabels(THREE,{scene,palette:palette.labels,capacity:Math.max(countryCount,PLACE_LIMITS.layoutCandidates),viewport,byteBudget:cacheBudget.labelAtlasBytes});
  const reusableColor = new THREE.Color(), highlightColor = new THREE.Color();
  function restoreCountryPaint(){
    countryTextureUploaded=false;texture.clearUpdateRanges();texture.needsUpdate=true;
  }
  function setCountryPaint(paint,{full=false}={}) {
    let changed = false;
    // Full refreshes and device restoration must not inherit partial ranges.
    if(full||!countryTextureUploaded)texture.clearUpdateRanges();
    for(const [index,{color,visible,highlight}] of paint){
      reusableColor.set(color||palette.defaultLand);
      if(highlight?.alpha>0)reusableColor.lerp(highlightColor.set(highlight.color),highlight.alpha);
      reusableColor.convertLinearToSRGB();
      const offset = index * 4;
      const next = [Math.round(reusableColor.r*255),Math.round(reusableColor.g*255),Math.round(reusableColor.b*255),visible?255:0];
      if(next.every((value,channel)=>value===channels[offset+channel]))continue;
      channels.set(next,offset);
      if(!full&&countryTextureUploaded)texture.addUpdateRange(offset,4);
      changed = true;
    }
    if(changed)texture.needsUpdate = true;
  }
  const layers=new Map(),datedCountries=new Map(),residentMeshes=new Map();
  const spatialResources=new Set(),activeSpatialResources=new Set();
  let spatialStats={triangles:0,submittedTriangles:0,segments:0,submittedSegments:0,ranges:0,visibleRanges:0};
  let cullingCamera=null,cullingWidth=0,cullingHeight=0,cullers=new Map();
  let residencyDirty=true,meshResidentBytes=0,outlineResidentBytes=0;
  let activePhysical=null,physicalLayers=null;
  const visibleLayers={lakes:true,rivers:true};
  let activeView=null,activeCountries=[],activeBorders=[],showBorders=true;
  function addLayer(name,mesh){
    if(!layers.has(name))layers.set(name,[]);
    layers.get(name).push(mesh);
  }
  function geometryBytes(mesh){
    const attributes=mesh.geometry.attributes;
    return Object.values(attributes).reduce((sum,attribute)=>sum+attribute.array.byteLength,0)
      +(mesh.geometry.index?.array.byteLength??0);
  }
  // The logical visibility/ownership of a packet is independent of which
  // spatial ranges its current camera actually submits.
  function spatialResource(objects,material,update){
    let enabled=true,disposed=false;
    const bytes=objects.reduce((sum,mesh)=>sum+geometryBytes(mesh),0);
    const resource={
      material,bytes,update,
      get visible(){return enabled;},
      set visible(value){
        if(disposed||enabled===Boolean(value))return;
        enabled=Boolean(value);
        if(enabled)activeSpatialResources.add(resource);
        else{activeSpatialResources.delete(resource);for(const mesh of objects)mesh.visible=false;}
      },
      dispose(){
        if(disposed)return;
        disposed=true;activeSpatialResources.delete(resource);spatialResources.delete(resource);
        for(const mesh of objects){scene.remove(mesh);mesh.geometry.dispose();}
        material?.dispose();
      },
    };
    for(const mesh of objects){mesh.visible=false;scene.add(mesh);}
    spatialResources.add(resource);activeSpatialResources.add(resource);
    return resource;
  }
  function strokePadding(options,maxWidth){
    let radius=options.style.width/2*maxWidth;
    if(options.hydroUniforms)for(const role of hydroStyles)if(role.y>0)radius=Math.max(radius,role.x/2);
    if(options.outlineUniforms)for(const role of options.outlineUniforms.outlineStyles.value)if(role.y>0)radius=Math.max(radius,role.x);
    // Include the end cap and normal expansion in both screen axes.
    return 2*(radius+margin.value)+1;
  }
  function spatialStrokes(packet,options){
    const ranges=partitionGlobeStrokes(packet);
    let material,maxWidth=1;
    if(packet.widths.length){
      maxWidth=1.5;
      for(const width of packet.widths)maxWidth=Math.max(maxWidth,width);
    }
    const objects=ranges.map(({first,end})=>{
      const mesh=createThreeGlobeStrokes(THREE,{...options,packet:globeStrokeRange(packet,first,end),sharedMaterial:material});
      material??=mesh.material;
      return mesh;
    });
    let previousCuller=null,previousZoom=null,admitted=[];
    return spatialResource(objects,material,(getCuller,currentZoom,stats)=>{
      const cull=getCuller(strokePadding(options,maxWidth)),zoomVisible=currentZoom>=(options.minZoom??-2);
      if(cull!==previousCuller||zoomVisible!==previousZoom){
        admitted=ranges.map(range=>zoomVisible&&cull(range.bounds));
        previousCuller=cull;previousZoom=zoomVisible;
      }
      stats.segments+=packet.count;stats.ranges+=ranges.length;
      for(let i=0;i<ranges.length;i++){
        const range=ranges[i],visible=admitted[i];
        objects[i].visible=visible;
        if(visible){stats.submittedSegments+=range.end-range.first;stats.visibleRanges++;}
      }
    });
  }
  function setLayerVisibility(name,visible){
    if(name==='graticule')graticuleVisible=visible;
    for(const mesh of layers.get(name)??[])mesh.visible=visible;
    if(Object.hasOwn(visibleLayers,name)){
      visibleLayers[name]=visible;
      for(const mesh of physicalLayers?.[name]??[])mesh.visible=visible;
    }
    if(name==='borders'){
      showBorders=visible;
      for(const mesh of activeBorders)mesh.visible=visible;
    }
  }
  function register(name, packet, color, order, minZoom = -2, style = '') {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(packet.positions, 3));
    geometry.setAttribute('positionLow', new THREE.BufferAttribute(packet.residuals, 3));
    geometry.setIndex(new THREE.BufferAttribute(packet.indices, 1));
    if (packet.slots.length) geometry.setAttribute('objectSlot', new THREE.BufferAttribute(packet.slots, 1));
    const material = new THREE.ShaderMaterial({
      vertexShader: surfaceVertex, fragmentShader: surfaceFragment,
      depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      defines: style==='country'?{COUNTRY_PALETTE:1}:style==='lake'?{HYDRO_PALETTE:1}:{},
      uniforms: { ...cameraUniforms,
        surfaceColor: { value: new THREE.Color(color) }, objectColors: { value: texture }, objectCount: { value: countryCount }, minZoom: { value: minZoom },...hydroUniforms },
    });
    const ranges=partitionGlobeMesh(packet);
    // One shared vertex/index buffer. Only admitted contiguous index ranges
    // become draw groups; equal material and object IDs preserve their order.
    const mesh = new THREE.Mesh(geometry, [material]);
    mesh.frustumCulled = false;
    mesh.renderOrder = order;
    let selected=[],previousCuller=null,previousZoom=null,visibleCount=0;
    const resource=spatialResource([mesh],material,(getCuller,currentZoom,stats)=>{
      const cull=getCuller(0),zoomVisible=currentZoom>=minZoom;
      if(cull!==previousCuller||zoomVisible!==previousZoom){
        visibleCount=0;
        const next=zoomVisible?visibleGlobeMeshRanges(ranges,bounds=>{
          if(!cull(bounds))return false;
          visibleCount++;return true;
        }):[];
        const changed=next.length!==selected.length||next.some((row,i)=>row.first!==selected[i]?.first||row.end!==selected[i]?.end);
        if(changed){
          geometry.clearGroups();
          for(const {first,end} of next)geometry.addGroup(first*3,(end-first)*3,0);
        }
        selected=next;previousCuller=cull;previousZoom=zoomVisible;
      }
      mesh.visible=selected.length>0;
      stats.triangles+=packet.indices.length/3;stats.ranges+=ranges.length;
      for(const {first,end} of selected)stats.submittedTriangles+=end-first;
      stats.visibleRanges+=visibleCount;
    });
    if(name)addLayer(name,resource);
    return resource;
  }
  register('objects',packets.countries,palette.defaultLand,1,-2,'country');
  const multisampling = Boolean(context.getContextAttributes().antialias);
  const riverStyle = { ...palette.strokes.river, color: palette.ocean };
  const riverMesh=(packet,minZoom)=>spatialStrokes(packet,{order:3,minZoom,
    style:riverStyle,cameraUniforms,viewport,margin,multisampling,hydroUniforms});
  function attachRiverDetail(row,packet){
    const resource=riverMesh(packet,row.minZoom);
    return {setVisible:visible=>{resource.visible=visible;},dispose:()=>resource.dispose()};
  }
  const strokeOptions={style:palette.strokes.country,cameraUniforms,viewport,margin,multisampling};
  let graticule=null,graticuleVisible=true;
  function installGraticule(packet){
    if(graticule)return;
    graticule=spatialStrokes(packet,{...strokeOptions,order:5.5,
      multisampling:false,style:{color:'#aaaaaa',width:0.55,opacity:0.34}});
    addLayer('graticule',graticule);graticule.visible=graticuleVisible;
  }
  if(packets.graticule)installGraticule(packets.graticule);
  function meshBytes(resource){return resource.bytes;}
  function releaseMesh(resource){resource.dispose();}
  function useMesh(role,identity,prepare){
    const key=role+':'+identity;
    const existing=touchRenderCache(residentMeshes,key);
    if(existing)return existing.mesh;
    const mesh=prepare();
    // Buffer attributes retain their CPU arrays alongside the device copy.
    residentMeshes.set(key,{mesh,bytes:meshBytes(mesh)*2});residencyDirty=true;
    return mesh;
  }
  function activatePhysicalContext(parts){
    if(activePhysical===parts)return;
    residencyDirty=true;
    if(physicalLayers)for(const mesh of Object.values(physicalLayers).flat())mesh.visible=false;
    const {spec}=parts;
    physicalLayers={
      waters:parts.waters.map(({id,spec:row,mesh})=>useMesh('water',`${id}:${row.sha256}`,()=>register(null,mesh.packet,palette.ocean,2))),
      lakes:parts.lakes.map(({spec:row,mesh,minZoom})=>useMesh('lake',`${row.sha256}:${minZoom}`,
        ()=>register(null,mesh.packet,palette.ocean,2,minZoom,'lake'))),
      rivers:parts.rivers?[useMesh('river',`${spec.rivers.sha256}:${spec.riverMinZoom}`,()=>riverMesh(parts.rivers,spec.riverMinZoom))]:[],
    };
    waterMeshes=new Map(parts.waters.map((row,index)=>[row.id,physicalLayers.waters[index]]));
    activePhysical=parts;
    for(const [role,meshes] of Object.entries(physicalLayers))for(const mesh of meshes)mesh.visible=visibleLayers[role]!==false;
  }
  function setHydroPaint(slots,waters,styles,color){
    let dirty=false;
    for(const slot of new Set([...previousHydro.keys(),...slots.keys()])){
      const next=slots.get(slot)??0;
      if(hydroBytes[slot]!==next){hydroBytes[slot]=next;dirty=true;}
    }
    if(dirty)hydroTexture.needsUpdate=true;
    previousHydro=slots;
    hydroUniforms.hasHydroHighlight.value=slots.size>0;
    if(color)hydroTint.set(color);
    for(const [code,style] of styles.entries())hydroStyles[code].set(style.width,style.alpha,style.fillAlpha??0);
    for(const [id,mesh] of waterMeshes){
      const fill=styles[waters.get(id)??0]?.fillAlpha??0;
      mesh.material.uniforms.surfaceColor.value.set(palette.ocean).lerp(hydroTint,fill);
    }
  }
  const borderBytes=new Uint8Array(Math.max(1,packets.borderGroupCount)).fill(255);
  const borderTexture=new THREE.DataTexture(borderBytes,borderBytes.length,1,THREE.RedFormat);
  borderTexture.needsUpdate=true;
  let baseBordersInstalled=false;
  function installBaseBorders(packet){
    if(baseBordersInstalled)return;
    if(packet.count){
      const resource=spatialStrokes(packet,{...strokeOptions,order:5,
        visibilityUniforms:{groupVisibility:{value:borderTexture},groupCount:{value:borderBytes.length}},
      });
      addLayer('borders',resource);resource.visible=showBorders;
    }
    baseBordersInstalled=true;
  }
  if(packets.borders)installBaseBorders(packets.borders);

  function createOutlines({packet,owners}){
    const index=indexGlobeOutlineRanges(packet,owners);
    const partitions=partitionGlobeStrokes(packet);
    const outlineStyles=Array.from({length:5},()=>new THREE.Vector2());
    const vectorNames=['start','startLow','end','endLow'];
    const chunks=new Map();
    let previousGroups=new Map(),activeChunks=new Set();
    const sameRanges=(a,b)=>a.length===b.length&&a.every((row,i)=>
      row.first===b[i].first&&row.end===b[i].end&&row.code===b[i].code);
    function ensureCapacity(chunk,partition,count){
      if(chunk.capacity>=count)return;
      chunk.resource?.dispose();
      const capacity=Math.min(partition.end-partition.first,Math.max(count,Math.ceil(chunk.capacity*1.5),64));
      const buffer={count:capacity,widths:new Float32Array(0),ownerGroups:new Uint16Array(capacity)};
      for(const name of vectorNames)buffer[name]=new Float32Array(capacity*3);
      const options={...strokeOptions,order:6,outlineUniforms:{outlineStyles:{value:outlineStyles}}};
      const mesh=createThreeGlobeStrokes(THREE,{...options,packet:buffer});
      for(const name of [...vectorNames,'ownerGroup'])mesh.geometry.getAttribute(name).setUsage(THREE.DynamicDrawUsage);
      mesh.geometry.instanceCount=0;
      const resource=spatialResource([mesh],mesh.material,(getCuller,_zoom,stats)=>{
        const count=mesh.geometry.instanceCount;
        mesh.visible=count>0&&getCuller(strokePadding(options,1))(partition.bounds);
        stats.segments+=count;stats.ranges++;
        if(mesh.visible){stats.submittedSegments+=count;stats.visibleRanges++;}
      });
      chunk.capacity=capacity;chunk.buffer=buffer;chunk.mesh=mesh;chunk.resource=resource;
      chunk.ranges=[];
    }
    function hide(){for(const chunk of activeChunks)chunk.resource.visible=false;}
    function paint(roles,styles,color){
      for(const [code,style] of styles.entries())outlineStyles[code].set(style.width/2,style.alpha);
      const groups=selectGlobeOutlineGroups(index,roles,styles);
      if(!groups.size){hide();return;}
      const changed=groups.size!==previousGroups.size||[...groups].some(([group,code])=>previousGroups.get(group)!==code);
      if(changed){
        const ranges=globeOutlineRanges(index,groups),next=new Set();
        let cursor=0;
        for(let part=0;part<partitions.length&&cursor<ranges.length;part++){
          const partition=partitions[part],local=[];
          while(cursor<ranges.length&&ranges[cursor].first<partition.end){
            const {first,end,code}=ranges[cursor];
            if(end>partition.first)local.push({first:Math.max(first,partition.first),end:Math.min(end,partition.end),code});
            if(end>partition.end)break;
            cursor++;
          }
          if(!local.length)continue;
          let chunk=chunks.get(part);
          if(!chunk){chunk={capacity:0,ranges:[]};chunks.set(part,chunk);}
          const count=local.reduce((sum,{first,end})=>sum+end-first,0);
          ensureCapacity(chunk,partition,count);
          if(!sameRanges(local,chunk.ranges)){
            let offset=0;
            for(const {first,end,code} of local){
              for(const name of vectorNames)chunk.buffer[name].set(packet[name].subarray(first*3,end*3),offset*3);
              chunk.buffer.ownerGroups.fill(code,offset,offset+end-first);offset+=end-first;
            }
            for(const name of [...vectorNames,'ownerGroup']){
              const attribute=chunk.mesh.geometry.getAttribute(name);
              attribute.clearUpdateRanges();attribute.addUpdateRange(0,count*attribute.itemSize);attribute.needsUpdate=true;
            }
            chunk.mesh.geometry.instanceCount=count;chunk.ranges=local;
          }
          next.add(chunk);
        }
        for(const chunk of activeChunks)if(!next.has(chunk))chunk.resource.visible=false;
        activeChunks=next;previousGroups=groups;
      }
      for(const chunk of activeChunks){
        chunk.resource.visible=true;
        chunk.resource.material.uniforms.strokeColor.value.set(color);
      }
    }
    const indexBytes=owners.reduce((sum,slots)=>sum+slots.length*8,0)
      +index.rangesByGroup.reduce((sum,ranges)=>sum+ranges.length*32,0)+partitions.length*80;
    function bytes(){return renderPacketBytes(packet)+indexBytes+[...chunks.values()].reduce((sum,chunk)=>sum+chunk.resource.bytes*2,0);}
    function dispose(){for(const chunk of chunks.values())chunk.resource?.dispose();chunks.clear();activeChunks.clear();previousGroups.clear();}
    return {paint,hide,bytes,dispose};
  }
  const outlineCache=new Map();
  let paintedOutlines=new Set();
  function installOutlines(slot,data){
    if(outlineCache.has(slot))return;
    outlineCache.set(slot,createOutlines(data));residencyDirty=true;
  }
  function setOutlinePaint(roles,styles,color){
    const targets=new Map();
    for(const [slot,code] of roles){
      const target=touchRenderCache(outlineCache,datedCountries.has(slot)?slot:null);
      if(!target)continue;
      let local=targets.get(target);
      if(!local){local=new Map();targets.set(target,local);}
      local.set(slot,code);
    }
    for(const target of paintedOutlines)if(!targets.has(target))target.hide();
    for(const [target,local] of targets)target.paint(local,styles,color);
    paintedOutlines=new Set(targets.keys());residencyDirty=true;
  }
  function activateDatedView(view,parts){
    if(view===activeView)return;
    residencyDirty=true;
    for(const row of activeCountries){row.mesh.visible=false;}
    for(const mesh of activeBorders)mesh.visible=false;
    activeView=view;
    activeCountries=(parts?.countries??[]).map(({slot,key,mesh})=>{
      if(!datedCountries.has(slot))datedCountries.set(slot,{
        mesh:useMesh('dated-country',key,()=>register(null,mesh.packet,palette.defaultLand,1,-2,'country')),
      });
      const row=datedCountries.get(slot);
      touchRenderCache(residentMeshes,'dated-country:'+key);
      return row;
    });
    activeBorders=(parts?.borders??[]).map(({key,packet})=>useMesh('dated-border',key,()=>spatialStrokes(packet,{...strokeOptions,order:5})));
    for(const row of activeCountries)row.mesh.visible=true;
    for(const mesh of activeBorders)mesh.visible=showBorders;
    borderBytes.fill(255);
    for(const slot of view?.hiddenBorders??[])borderBytes[slot]=0;
    borderTexture.needsUpdate=true;
  }

  // Only called after successful visual publication. Never dispose the
  // previously published scene while a replacement is still being drawn.
  function trimResidency(){
    labels.trim();
    if(!residencyDirty)return;
    residencyDirty=false;
    const activeMeshes=new Set([...activeCountries.map(row=>row.mesh),...activeBorders,...Object.values(physicalLayers??{}).flat()]);
    const protectedMeshes=new Set();
    for(const [key,entry] of residentMeshes)if(activeMeshes.has(entry.mesh))protectedMeshes.add(key);
    meshResidentBytes=trimRenderCache(residentMeshes,protectedMeshes,cacheBudget.residentMeshBytes,entry=>entry.bytes,(_key,entry)=>{
      for(const [slot,row] of datedCountries)if(row.mesh===entry.mesh)datedCountries.delete(slot);
      releaseMesh(entry.mesh);
    },{entryLimit:512});
    const protectedOutlines=new Set();
    for(const [slot,resource] of outlineCache)if(paintedOutlines.has(resource))protectedOutlines.add(slot);
    outlineResidentBytes=trimRenderCache(outlineCache,protectedOutlines,cacheBudget.outlineBytes,entry=>entry.bytes(),(_slot,entry)=>entry.dispose(),{entryLimit:128});
  }
  function cacheStats(){return {meshes:residentMeshes.size,meshResidentBytes,outlines:outlineCache.size,outlineResidentBytes};}

  function resize(width, height, dpr) {
    viewport.value.set(width, height);
    margin.value = 0.5 / dpr;
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false);
  }
  function draw(globeCamera, width, height) {
    const {frame,view}=globeCamera;
    zoom.value = view.zoom;
    eyeHigh.fromArray(frame.eye.map(Math.fround));
    eyeLow.set(frame.eye[0] - eyeHigh.x, frame.eye[1] - eyeHigh.y, frame.eye[2] - eyeHigh.z);
    viewRotation.set(...frame.right, ...frame.up, ...frame.forward.map(value => -value));
    camera.near = frame.distance * 0.01;
    camera.far = frame.distance + 4;
    camera.setViewOffset(width, height, width / 2 - frame.center[0], height / 2 - frame.center[1], width, height);
    if(globeCamera!==cullingCamera||width!==cullingWidth||height!==cullingHeight){
      cullingCamera=globeCamera;cullingWidth=width;cullingHeight=height;cullers=new Map();
    }
    const getCuller=padding=>{
      if(!cullers.has(padding))cullers.set(padding,createGlobeRangeCuller(frame,width,height,padding));
      return cullers.get(padding);
    };
    const stats={triangles:0,submittedTriangles:0,segments:0,submittedSegments:0,ranges:0,visibleRanges:0};
    for(const resource of activeSpatialResources)resource.update(getCuller,view.zoom,stats);
    spatialStats=stats;
    labels.update(globeCamera,width,height);
    renderer.render(scene, camera);
  }
  function dispose() {
    labels.dispose();
    for(const entry of outlineCache.values())entry.dispose();
    outlineCache.clear();paintedOutlines.clear();residentMeshes.clear();datedCountries.clear();
    for(const resource of [...spatialResources])resource.dispose();
    layers.clear();waterMeshes.clear();
    texture.dispose();hydroTexture.dispose();
    borderTexture.dispose();
    renderer.dispose();
  }
  return Object.freeze({resize,draw,setCountryPaint,restoreCountryPaint,installGraticule,hasGraticule:()=>graticule!==null,installBaseBorders,hasBaseBorders:()=>baseBordersInstalled,installOutlines,hasOutlines:slot=>outlineCache.has(slot),setOutlinePaint,setHydroPaint,setLayerVisibility,attachRiverDetail,activateDatedView,activatePhysicalContext,trimResidency,cacheStats,labels,dispose,
    drawCalls:()=>renderer.info.render.calls,spatialStats:()=>({...spatialStats})});
}
