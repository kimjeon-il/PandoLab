import { GLOBE_FIELD_OF_VIEW } from './globe-camera.js';
import { createThreeGlobeStrokes, hydroStyleLookup } from './three-globe-strokes.js';
import { createThreeGlobeLabels } from './three-globe-labels.js';
import { PLACE_LIMITS } from '../document/place-limits.js';
import {renderCacheBudget,renderPacketBytes,touchRenderCache,trimRenderCache} from './render-cache-budget.js';

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
  let residencyDirty=true,meshResidentBytes=0,outlineResidentBytes=0;
  let activePhysical=null,physicalLayers=null;
  const visibleLayers={lakes:true,rivers:true};
  let activeView=null,activeCountries=[],activeBorders=[],showBorders=true;
  function addLayer(name,mesh){
    if(!layers.has(name))layers.set(name,[]);
    layers.get(name).push(mesh);scene.add(mesh);
  }
  function setLayerVisibility(name,visible){
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
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = order;
    if(name)addLayer(name,mesh);else scene.add(mesh);
    return mesh;
  }
  register('objects',packets.countries,palette.defaultLand,1,-2,'country');
  const multisampling = Boolean(context.getContextAttributes().antialias);
  const riverStyle = { ...palette.strokes.river, color: palette.ocean };
  const riverMesh=(packet,minZoom)=>createThreeGlobeStrokes(THREE,{packet,order:3,minZoom,
    style:riverStyle,cameraUniforms,viewport,margin,multisampling,hydroUniforms});
  function attachRiverDetail(row,packet){
    const mesh=riverMesh(packet,row.minZoom);
    scene.add(mesh);
    return {setVisible:visible=>{mesh.visible=visible;},dispose(){
      scene.remove(mesh);mesh.geometry.dispose();mesh.material.dispose();
    }};
  }
  const strokeOptions={style:palette.strokes.country,cameraUniforms,viewport,margin,multisampling};
  addLayer('graticule',createThreeGlobeStrokes(THREE,{...strokeOptions,packet:packets.graticule,order:5.5,
    multisampling:false,style:{color:'#aaaaaa',width:0.55,opacity:0.34}}));
  function meshBytes(mesh){
    const attributes=mesh.geometry.attributes;
    return Object.values(attributes).reduce((sum,attribute)=>sum+attribute.array.byteLength,0)
      +(mesh.geometry.index?.array.byteLength??0);
  }
  function releaseMesh(mesh){scene.remove(mesh);mesh.geometry.dispose();mesh.material.dispose();}
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
      rivers:[useMesh('river',`${spec.rivers.sha256}:${spec.riverMinZoom}`,()=>{
        const mesh=riverMesh(parts.rivers,spec.riverMinZoom);
        scene.add(mesh);return mesh;
      })],
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
  if(packets.borders.count)addLayer('borders',createThreeGlobeStrokes(THREE,{...strokeOptions,packet:packets.borders,order:5,
    visibilityUniforms:{groupVisibility:{value:borderTexture},groupCount:{value:borderBytes.length}},
  }));

  function createOutlines({packet,owners}){
    const index=indexGlobeOutlineRanges(packet,owners);
    const outlineStyles=Array.from({length:5},()=>new THREE.Vector2());
    const vectorNames=['start','startLow','end','endLow'];
    let mesh=null,capacity=0,buffer=null,previousGroups=new Map();
    function ensureCapacity(count){
      if(capacity>=count)return;
      if(mesh){scene.remove(mesh);mesh.geometry.dispose();mesh.material.dispose();}
      capacity=Math.min(packet.count,Math.max(count,Math.ceil(capacity*1.5),64));
      buffer={count:capacity,widths:new Float32Array(0),ownerGroups:new Uint16Array(capacity)};
      for(const name of vectorNames)buffer[name]=new Float32Array(capacity*3);
      mesh=createThreeGlobeStrokes(THREE,{...strokeOptions,packet:buffer,order:6,outlineUniforms:{
        outlineStyles:{value:outlineStyles},
      }});
      for(const name of [...vectorNames,'ownerGroup'])mesh.geometry.getAttribute(name).setUsage(THREE.DynamicDrawUsage);
      mesh.geometry.instanceCount=0;mesh.visible=false;scene.add(mesh);
    }
    function hide(){if(mesh)mesh.visible=false;}
    function paint(roles,styles,color){
      for(const [code,style] of styles.entries())outlineStyles[code].set(style.width/2,style.alpha);
      const groups=selectGlobeOutlineGroups(index,roles,styles);
      if(!groups.size){hide();return;}
      const changed=groups.size!==previousGroups.size||[...groups].some(([group,code])=>previousGroups.get(group)!==code);
      if(changed){
        const ranges=globeOutlineRanges(index,groups),count=ranges.reduce((sum,{first,end})=>sum+end-first,0);
        if(!count){hide();return;}
        ensureCapacity(count);
        let offset=0;
        for(const {first,end,code} of ranges){
          for(const name of vectorNames)buffer[name].set(packet[name].subarray(first*3,end*3),offset*3);
          buffer.ownerGroups.fill(code,offset,offset+end-first);offset+=end-first;
        }
        for(const name of [...vectorNames,'ownerGroup']){
          const attribute=mesh.geometry.getAttribute(name);
          attribute.clearUpdateRanges();attribute.addUpdateRange(0,count*attribute.itemSize);attribute.needsUpdate=true;
        }
        mesh.geometry.instanceCount=count;previousGroups=groups;
      }
      if(mesh){mesh.visible=true;mesh.material.uniforms.strokeColor.value.set(color);}
    }
    const indexBytes=owners.reduce((sum,slots)=>sum+slots.length*8,0)
      +index.rangesByGroup.reduce((sum,ranges)=>sum+ranges.length*32,0);
    function bytes(){return renderPacketBytes(packet)+indexBytes+(mesh?meshBytes(mesh)*2:0);}
    function dispose(){if(mesh)releaseMesh(mesh);mesh=null;buffer=null;capacity=0;previousGroups.clear();}
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
    activeBorders=(parts?.borders??[]).map(({key,packet})=>useMesh('dated-border',key,()=>{
        const mesh=createThreeGlobeStrokes(THREE,{...strokeOptions,packet,order:5});
        scene.add(mesh);return mesh;
    }));
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
    labels.update(globeCamera,width,height);
    renderer.render(scene, camera);
  }
  function dispose() {
    labels.dispose();
    for(const entry of outlineCache.values())entry.dispose();
    outlineCache.clear();paintedOutlines.clear();residentMeshes.clear();datedCountries.clear();
    for (const mesh of scene.children) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    texture.dispose();hydroTexture.dispose();
    borderTexture.dispose();
    renderer.dispose();
  }
  return Object.freeze({resize,draw,setCountryPaint,restoreCountryPaint,installOutlines,hasOutlines:slot=>outlineCache.has(slot),setOutlinePaint,setHydroPaint,setLayerVisibility,attachRiverDetail,activateDatedView,activatePhysicalContext,trimResidency,cacheStats,labels,dispose,
    drawCalls:()=>renderer.info.render.calls});
}
