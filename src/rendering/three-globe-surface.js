import { GLOBE_FIELD_OF_VIEW } from './globe-camera.js';
import { createThreeGlobeStrokes, createGlobeStrokePointTexture, hydroStyleLookup } from './three-globe-strokes.js';
import {createGlobeOutlineCache} from './globe-outline-cache.js';
import {planGlobeCompactionUpdates,mergeGlobeDrawRanges,copyGlobeDrawWrites,applyGlobeDrawWrites,useDirectGlobeStrokeAttributes,writeDirectGlobeStrokes} from './globe-draw-compaction.js';
export {indexGlobeOutlineRanges,selectGlobeOutlineGroups,globeOutlineRanges} from './globe-outline-cache.js';
import { createThreeGlobeLabels } from './three-globe-labels.js';
import { PLACE_LIMITS } from '../document/place-limits.js';
import {renderCacheBudget,renderPacketBytes,renderPacketBuffers,touchRenderCache,trimRenderCache} from './render-cache-budget.js';
import {createGlobeSpatialSelection,createGlobeRangeCuller,globeStrokeRange} from './globe-spatial-partition.js';

const surfaceVertex = `
  attribute vec3 positionLow;
  #ifdef COUNTRY_PALETTE
    attribute float objectSlot;
    uniform sampler2D objectColors;
    uniform vec2 objectSize;
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
      vec2 pixel=vec2(mod(objectSlot,objectSize.x),floor(objectSlot/objectSize.x));
      paint=texture2D(objectColors,(pixel+0.5)/objectSize);
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

// Consecutive changed bytes in one texture row form one upload. Identical
// spans in adjacent rows merge into one rectangle.
export function globeHydroTextureRects(slots,width){
  const ordered=[...new Set(slots)].sort((a,b)=>a-b),rows=[];
  for(const slot of ordered){
    const x=slot%width,y=Math.floor(slot/width),last=rows.at(-1);
    if(last&&last.y===y&&last.x+last.width===x)last.width++;
    else rows.push({x,y,width:1,height:1});
  }
  const merged=[],bySpan=new Map();
  for(const row of rows){
    const key=row.x+':'+row.width,last=bySpan.get(key);
    if(last&&last.y+last.height===row.y)last.height++;
    else{merged.push(row);bySpan.set(key,row);}
  }
  return merged;
}

export function createThreeGlobeSurface(THREE, { canvas, context, palette, packets, countryCount, hydroCount, cacheBudget=renderCacheBudget(),residency,onLabelReady=()=>{},onLabelError=()=>{} }) {
  const renderer = new THREE.WebGLRenderer({ canvas, context });
  const maxPointTextureSize=renderer.capabilities.maxTextureSize;
  renderer.setClearColor(palette.ocean);
  renderer.debug.onShaderError = (gl, program, vertexShader, fragmentShader) => {
    throw new Error([gl.getProgramInfoLog(program), gl.getShaderInfoLog(vertexShader), gl.getShaderInfoLog(fragmentShader)].filter(Boolean).join('\n'));
  };
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(GLOBE_FIELD_OF_VIEW, 1);
  const countryWidth=Math.min(maxPointTextureSize,Math.max(1,countryCount)),countryHeight=Math.ceil(Math.max(1,countryCount)/countryWidth);
  const channels=new Uint8Array(countryWidth*countryHeight*4),countryVisible=new Uint8Array(countryCount);
  let countryVisibilityRevision=0,borderVisibilityRevision=0;
  const texture=new THREE.DataTexture(channels,countryWidth,countryHeight);
  texture.colorSpace = THREE.SRGBColorSpace;
  let countryTextureUploaded=false;
  texture.onUpdate=()=>{countryTextureUploaded=true;};
  texture.needsUpdate=true;
  const hydroWidth=Math.min(1024,Math.max(1,hydroCount)),hydroHeight=Math.ceil(Math.max(1,hydroCount)/hydroWidth);
  const hydroBytes=new Uint8Array(hydroWidth*hydroHeight);
  const hydroTexture=new THREE.DataTexture(hydroBytes,hydroWidth,hydroHeight,THREE.RedFormat);
  const hydroUploadSource=new THREE.DataTexture(null,1,1,THREE.RedFormat),hydroDirtySlots=new Set();
  const hydroCopyRegion=new THREE.Box2(new THREE.Vector2(),new THREE.Vector2()),hydroCopyPosition=new THREE.Vector2();
  let hydroUploaded=false;
  const hydroUploadStats={fullUploads:0,partialUploads:0,fullBytes:0,partialBytes:0};
  hydroTexture.onUpdate=()=>{hydroUploaded=true;hydroUploadStats.fullUploads++;hydroUploadStats.fullBytes+=hydroBytes.byteLength;};
  hydroTexture.needsUpdate=true;
  const hydroTint=new THREE.Color(),hydroStyles=Array.from({length:5},()=>new THREE.Vector3());
  const hydroUniforms={hydroRoles:{value:hydroTexture},hydroSize:{value:new THREE.Vector2(hydroWidth,hydroHeight)},
    hydroTint:{value:hydroTint},hydroStyles:{value:hydroStyles},hasHydroHighlight:{value:false}};
  let previousHydro=new Map(),waterMeshes=new Map(),previousWaters=new Map(),waterPaintDirty=true,previousWaterTint=null,previousWaterStyles=[];
  const eyeHigh = new THREE.Vector3(), eyeLow = new THREE.Vector3();
  const viewRotation = new THREE.Matrix3();
  const zoom = { value: 0 };
  const cameraUniforms = { eyeHigh: { value: eyeHigh }, eyeLow: { value: eyeLow }, viewRotation: { value: viewRotation }, zoom };
  const viewport = { value: new THREE.Vector2() }, margin = { value: 0.5 };
  const labels=createThreeGlobeLabels(THREE,{scene,renderer,palette:palette.labels,capacity:PLACE_LIMITS.layoutCandidates,maxTextureSize:maxPointTextureSize,viewport,byteBudget:cacheBudget.labelAtlasBytes,onReady:onLabelReady,onError:onLabelError});
  const reusableColor = new THREE.Color(), highlightColor = new THREE.Color();
  function restoreCountryPaint(){
    countryTextureUploaded=false;texture.clearUpdateRanges();texture.needsUpdate=true;
    hydroUploaded=false;hydroDirtySlots.clear();hydroTexture.needsUpdate=true;labels.restoreTextures();
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
      if(countryVisible[index]!==Number(visible)){countryVisible[index]=Number(visible);countryVisibilityRevision++;}
      channels.set(next,offset);
      if(!full&&countryTextureUploaded)texture.addUpdateRange(offset,4);
      changed = true;
    }
    if(changed)texture.needsUpdate = true;
  }
  const layers=new Map(),datedCountries=new Map(),residentMeshes=new Map();
  const spatialResources=new Set(),activeSpatialResources=new Set(),dirtyOutlineOwners=new Map();
  let spatialStats={triangles:0,submittedTriangles:0,segments:0,submittedSegments:0,ranges:0,visibleRanges:0,strokeBatches:0,strokeDrawCalls:0,directStrokeSegments:0,compactionUploadBytes:0};
  let cullingCamera=null,cullingWidth=0,cullingHeight=0,cullers=new Map();
  let residencyDirty=true;
  let activePhysical=null,physicalLayers=null;
  const visibleLayers={lakes:true,rivers:true};
  let activeView=null,activeCountries=[],activeBorders=[],activeBase=[],baseInput=null,showBorders=true;
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
  function spatialResource(objects,material,update,pointResources=[],retained=null){
    let enabled=true,disposed=false;
    const materials=new Set(objects.flatMap(mesh=>Array.isArray(mesh.material)?mesh.material:[mesh.material]));
    if(material)materials.add(material);
    const deviceBytes=objects.reduce((sum,mesh)=>sum+geometryBytes(mesh),0)+pointResources.reduce((sum,row)=>sum+row.bytes,0);
    const buffers=renderPacketBuffers([retained,...objects.flatMap(mesh=>[...Object.values(mesh.geometry.attributes).map(attribute=>attribute.array),mesh.geometry.index?.array]),...pointResources.map(row=>row.texture.image.data)]);
    const resource={
      material,bytes:deviceBytes,update,lastUsed:performance.now(),buffers,deviceBytes,
      footprint:()=>({buffers,extraBytes:deviceBytes}),
      setOrder(order,span=0){objects.forEach((mesh,i)=>{mesh.renderOrder=order+span*i/Math.max(1,objects.length);});},
      get visible(){return enabled;},
      set visible(value){
        if(disposed||enabled===Boolean(value))return;
        enabled=Boolean(value);
        if(enabled){resource.lastUsed=performance.now();activeSpatialResources.add(resource);}
        else{activeSpatialResources.delete(resource);for(const mesh of objects)mesh.visible=false;}
      },
      dispose(){
        if(disposed)return;
        disposed=true;activeSpatialResources.delete(resource);spatialResources.delete(resource);
        for(const mesh of objects){scene.remove(mesh);mesh.geometry.dispose();}
        for(const item of materials)item.dispose();
        for(const item of pointResources)item.texture.dispose();
      },
    };
    for(const mesh of objects){mesh.visible=false;scene.add(mesh);}
    spatialResources.add(resource);activeSpatialResources.add(resource);residencyDirty=true;
    return resource;
  }
  function strokePadding(options,maxWidth){
    let radius=options.style.width/2*maxWidth;
    if(options.hydroUniforms)for(const role of hydroStyles)if(role.y>0)radius=Math.max(radius,role.x/2);
    if(options.outlineUniforms)for(const role of options.outlineUniforms.outlineStyles.value)if(role.y>0)radius=Math.max(radius,role.x);
    // Include the end cap and normal expansion in both screen axes.
    return 2*(radius+margin.value)+1;
  }
  const admitNone=()=>false;
  const countryOwnerVisible=slot=>slot<0||countryVisible[slot]===1;
  const borderOwnerVisible=slot=>slot<0||borderBytes[slot]!==0;
  function spatialStrokes(packet,options){
    const pointResources=[],textures=new Map(),drawParts=[];
    let maxWidth=1;
    if(packet.widths.length){
      maxWidth=1.5;
      for(const width of packet.widths)maxWidth=Math.max(maxWidth,width);
    }
    // Spatial leaves are query granularity, not draw-call granularity.
    // Consecutive parts sharing a dictionary and style use one instance
    // stream, in original segment order. A local dictionary remains separate.
    const groups=[];
    for(const row of packet.spatialParts){
      const last=groups.at(-1);
      if(last&&last.end===row.first&&last.points===packet.points&&row.packet.points===last.points&&row.end-last.first<=1_000_000){
        last.parts.push(row);last.end=row.end;
      }else groups.push({first:row.first,end:row.end,points:row.packet.points,parts:[row]});
    }
    for(const group of groups){
      const source=group.points===packet.points?globeStrokeRange(packet,group.first,group.end):group.parts[0].packet;
      const direct=useDirectGlobeStrokeAttributes(source);
      let points=null;
      if(!direct){
        points=textures.get(source.points);
        if(!points){points=createGlobeStrokePointTexture(THREE,source.points,maxPointTextureSize);textures.set(source.points,points);pointResources.push(points);}
      }
      const output={count:source.count,widths:new Float32Array(source.widths.length),ownerGroups:new Uint16Array(options.hydroUniforms?source.ownerGroups.length:0)};
      if(direct)for(const name of ['start','startLow','end','endLow'])output[name]=new Float32Array(source.count*3);
      else output.endpointIndices=new Uint32Array(source.count*2);
      const mesh=createThreeGlobeStrokes(THREE,{...options,packet:output,pointUniforms:points?.uniforms});
      const attributes=Object.values(mesh.geometry.attributes).filter(attribute=>attribute.isInstancedBufferAttribute);
      for(const attribute of attributes)attribute.setUsage(THREE.DynamicDrawUsage);
      mesh.geometry.instanceCount=0;
      drawParts.push({source,mesh,output,direct,prior:new Uint32Array(),parts:group.parts.map(row=>({
        ...row,offset:row.first-group.first,selection:createGlobeSpatialSelection(row.packet,row.index)
      }))});
    }
    const count=packet.count;
    return spatialResource(drawParts.map(row=>row.mesh),null,(getCuller,currentZoom,stats)=>{
      const cull=currentZoom>=(options.minZoom??-2)?getCuller(strokePadding(options,maxWidth)):admitNone;
      stats.segments+=count;stats.strokeBatches+=drawParts.length;
      for(const batch of drawParts){
        const {source,mesh,output,direct,parts}=batch;
        const selections=[];let changed=false,total=0;
        for(const row of parts){
          const selected=row.selection.select(cull,options.baseBorder?borderVisibilityRevision:0,options.baseBorder?borderOwnerVisible:null);
          stats.ranges+=row.index.leafCount;stats.visibleRanges+=selected.leaves;
          total+=selected.count;changed||=selected.changed;
          selections.push({ranges:selected.ranges,offset:row.offset});
        }
        if(changed){
          const {ranges}=mergeGlobeDrawRanges(selections),writes=planGlobeCompactionUpdates(ranges,batch.prior);
          if(direct&&writes.length){
            writeDirectGlobeStrokes(output,source,writes);
            for(const name of ['start','startLow','end','endLow'])stats.compactionUploadBytes+=applyGlobeDrawWrites(mesh.geometry.getAttribute(name),writes);
          }else if(!direct)stats.compactionUploadBytes+=copyGlobeDrawWrites(mesh.geometry.getAttribute('endpointIndices'),source.endpointIndices,writes);
          if(output.widths.length)stats.compactionUploadBytes+=copyGlobeDrawWrites(mesh.geometry.getAttribute('sourceWidth'),source.widths,writes);
          if(output.ownerGroups.length)stats.compactionUploadBytes+=copyGlobeDrawWrites(mesh.geometry.getAttribute('ownerGroup'),source.ownerGroups,writes);
          batch.prior=ranges;
        }
        mesh.geometry.instanceCount=total;mesh.visible=total>0;
        stats.submittedSegments+=total;
        if(total){stats.strokeDrawCalls++;if(direct)stats.directStrokeSegments+=total;}
      }
    },pointResources,packet);
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
    const drawIndices=new Uint32Array(packet.indices.length),drawIndex=new THREE.BufferAttribute(drawIndices,1).setUsage(THREE.DynamicDrawUsage);
    geometry.setIndex(drawIndex);geometry.setDrawRange(0,0);
    if (packet.slots.length) geometry.setAttribute('objectSlot', new THREE.BufferAttribute(packet.slots, 1));
    const material = new THREE.ShaderMaterial({
      vertexShader: surfaceVertex, fragmentShader: surfaceFragment,
      depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      defines: style==='country'?{COUNTRY_PALETTE:1}:style==='lake'?{HYDRO_PALETTE:1}:{},
      uniforms: { ...cameraUniforms,
        surfaceColor: { value: new THREE.Color(color) }, objectColors: { value: texture }, objectSize:{value:new THREE.Vector2(countryWidth,countryHeight)}, minZoom: { value: minZoom },...hydroUniforms },
    });
    const index=packet.spatial,selection=createGlobeSpatialSelection(packet,index);
    let priorRanges=new Uint32Array();
    const mesh=new THREE.Mesh(geometry,material);
    mesh.frustumCulled=false;mesh.renderOrder=order;
    const resource=spatialResource([mesh],material,(getCuller,currentZoom,stats)=>{
      const cull=currentZoom>=minZoom?getCuller(0):admitNone;
      const selected=selection.select(cull,style==='country'?countryVisibilityRevision:0,style==='country'?countryOwnerVisible:null);
      if(selected.changed){
        stats.compactionUploadBytes+=copyGlobeDrawWrites(drawIndex,packet.indices,planGlobeCompactionUpdates(selected.ranges,priorRanges),3);
        priorRanges=selected.ranges;
      }
      geometry.setDrawRange(0,selected.count*3);mesh.visible=selected.count>0;
      stats.triangles+=index.count;stats.ranges+=index.leafCount??index.owners.length;
      stats.submittedTriangles+=selected.count;stats.visibleRanges+=selected.leaves;
    },[],packet);
    if(name)addLayer(name,resource);
    return resource;
  }
  if(packets.countries)register('objects',packets.countries,palette.defaultLand,1,-2,'country');
  const multisampling = Boolean(context.getContextAttributes().antialias);
  const riverStyle = { ...palette.strokes.river, color: palette.ocean };
  const riverMesh=(packet,minZoom)=>spatialStrokes(packet,{order:3,minZoom,
    style:riverStyle,cameraUniforms,viewport,margin,multisampling,hydroUniforms});
  function attachRiverDetail(row,packet){
    const resource=riverMesh(packet,row.minZoom);
    resource.externalOwner=true;
    return {residentBytes:[...resource.buffers].reduce((sum,buffer)=>sum+buffer.byteLength,0)+resource.deviceBytes,footprint:resource.footprint,setVisible:visible=>{resource.visible=visible;},dispose:()=>resource.dispose()};
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
  function releaseMesh(resource){resource.dispose();}
  function useMesh(role,identity,prepare){
    const key=role+':'+identity;
    const existing=touchRenderCache(residentMeshes,key);
    if(existing)return existing.mesh;
    const mesh=prepare();
    // Buffer attributes retain their CPU arrays alongside the device copy.
    residentMeshes.set(key,{mesh,bytes:[...mesh.buffers].reduce((sum,buffer)=>sum+buffer.byteLength,0)+mesh.deviceBytes});residencyDirty=true;
    return mesh;
  }
  function activateBaseCountries(rows){
    if(baseInput===rows)return;
    baseInput=rows;residencyDirty=true;
    for(const resource of activeBase)resource.visible=false;
    activeBase=rows.map(({key,order,mesh})=>{
      const resource=useMesh('base-country',key,()=>register(null,mesh.packet,palette.defaultLand,1,-2,'country'));
      resource.setOrder(1-.1/(order+1));resource.visible=true;return resource;
    });
  }
  function activatePhysicalContext(parts){
    if(activePhysical===parts)return;
    residencyDirty=true;
    if(physicalLayers)for(const mesh of Object.values(physicalLayers).flat())mesh.visible=false;
    const {spec}=parts;
    physicalLayers={
      waters:parts.waters.map(({key,id,spec:row,mesh},i)=>{
        const resource=useMesh('water',key??`${id}:${row.sha256}`,()=>register(null,mesh.packet,palette.ocean,2));
        resource.setOrder(1.6+.3*i/Math.max(1,parts.waters.length));return resource;
      }),
      lakes:parts.lakes.map(({spec:row,mesh,minZoom})=>useMesh('lake',`${row.sha256}:${minZoom}`,
        ()=>register(null,mesh.packet,palette.ocean,2,minZoom,'lake'))),
      rivers:parts.rivers?[useMesh('river',`${spec.rivers.sha256}:${spec.riverMinZoom}`,()=>riverMesh(parts.rivers,spec.riverMinZoom))]:[],
    };
    waterMeshes=new Map();
    parts.waters.forEach((row,index)=>{let group=waterMeshes.get(row.id);if(!group){group=[];waterMeshes.set(row.id,group);}group.push(physicalLayers.waters[index]);});
    activePhysical=parts;waterPaintDirty=true;
    for(const [role,meshes] of Object.entries(physicalLayers))for(const mesh of meshes)mesh.visible=visibleLayers[role]!==false;
  }
  function setHydroPaint(slots,waters,styles,color){
    for(const slot of new Set([...previousHydro.keys(),...slots.keys()])){
      const next=slots.get(slot)??0;
      if(hydroBytes[slot]!==next){hydroBytes[slot]=next;hydroDirtySlots.add(slot);}
    }
    previousHydro=slots;
    hydroUniforms.hasHydroHighlight.value=slots.size>0;
    if(color)hydroTint.set(color);
    for(const [code,style] of styles.entries())hydroStyles[code].set(style.width,style.alpha,style.fillAlpha??0);
    const fills=styles.map(row=>row?.fillAlpha??0),tint=hydroTint.getHex();
    const allWater=waterPaintDirty||tint!==previousWaterTint||fills.length!==previousWaterStyles.length||fills.some((value,i)=>value!==previousWaterStyles[i]);
    const changed=allWater?waterMeshes.keys():new Set([...previousWaters.keys(),...waters.keys()].filter(id=>previousWaters.get(id)!==waters.get(id)));
    for(const id of changed){
      const fill=styles[waters.get(id)??0]?.fillAlpha??0;
      for(const mesh of waterMeshes.get(id)??[])mesh.material.uniforms.surfaceColor.value.set(palette.ocean).lerp(hydroTint,fill);
    }
    previousWaters=waters;previousWaterTint=tint;previousWaterStyles=fills;waterPaintDirty=false;
  }
  function flushHydroPaint(){
    if(!hydroDirtySlots.size)return;
    const rects=globeHydroTextureRects(hydroDirtySlots,hydroWidth);
    hydroDirtySlots.clear();
    if(!hydroUploaded)return; // initial/restore upload reads the current CPU buffer
    const area=rects.reduce((sum,row)=>sum+row.width*row.height,0);
    if(rects.length>64||area>=hydroBytes.length*.6||!renderer.copyTextureToTexture){
      hydroUploaded=false;hydroTexture.needsUpdate=true;return;
    }
    // RedFormat is one component; Three.js generic updateRanges assumes
    // RGBA, so use its supported CPU rectangular copy path instead.
    hydroUploadSource.image=hydroTexture.image;
    try{
      for(const {x,y,width,height} of rects){
        hydroCopyRegion.min.set(x,y);hydroCopyRegion.max.set(x+width,y+height);hydroCopyPosition.set(x,y);
        renderer.copyTextureToTexture(hydroUploadSource,hydroTexture,hydroCopyRegion,hydroCopyPosition);
        hydroUploadStats.partialUploads++;hydroUploadStats.partialBytes+=width*height;
      }
    }finally{hydroUploadSource.image=null;}
  }
  const borderBytes=new Uint8Array(Math.max(1,packets.borderGroupCount)).fill(255);

  let baseBordersInstalled=false;
  function installBaseBorders(packet){
    if(baseBordersInstalled)return;
    if(packet.count){
      const resource=spatialStrokes(packet,{...strokeOptions,order:5,baseBorder:true});
      addLayer('borders',resource);resource.visible=showBorders;
    }
    baseBordersInstalled=true;
  }
  if(packets.borders)installBaseBorders(packets.borders);

  const outlineCache=new Map();
  let paintedOutlines=new Set();
  function installOutlines(slot,data){
    if(outlineCache.has(slot))return;
    const outline=createGlobeOutlineCache(THREE,{scene,...data,strokeOptions,maxTextureSize:maxPointTextureSize,
      orderForChunk:(part,count)=>6+.9*((slot===null?0:slot+1)+(part+1)/(count+1))/(countryCount+1),
      residency,onResidencyChange:()=>{dirtyOutlineOwners.set(outline,slot);}});
    outlineCache.set(slot,outline);dirtyOutlineOwners.set(outline,slot);
  }
  function setOutlinePaint(roles,styles,color){
    const targets=new Map();
    for(const [slot,code] of roles){
      if(!(styles[code]?.width>0&&styles[code]?.alpha>0))continue;
      const target=touchRenderCache(outlineCache,datedCountries.has(slot)?slot:null);
      if(!target)continue;
      let local=targets.get(target);
      if(!local){local=new Map();targets.set(target,local);}
      local.set(slot,code);
    }
    for(const target of paintedOutlines)if(!targets.has(target))target.hide();
    paintedOutlines=new Set([...targets].filter(([target,local])=>target.paint(local,styles,color)).map(([target])=>target));
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
      row.mesh.setOrder(1+.5*(slot+1)/(countryCount+1));
      touchRenderCache(residentMeshes,'dated-country:'+key);
      return row;
    });
    activeBorders=(parts?.borderBatches??[]).map(({key,packet})=>useMesh('dated-border-batch',key,()=>spatialStrokes(packet,{...strokeOptions,order:5})));
    for(const row of activeCountries)row.mesh.visible=true;
    for(const [i,mesh] of activeBorders.entries()){mesh.setOrder(5+.4*(i+1)/(activeBorders.length+1),.4/(activeBorders.length+1));mesh.visible=showBorders;}
    borderBytes.fill(255);
    for(const slot of view?.hiddenBorders??[])borderBytes[slot]=0;
    borderVisibilityRevision++;
  }

  // Only called after successful visual publication. Never dispose the
  // previously published scene while a replacement is still being drawn.
  function activeMeshesNow(){return new Set([...activeBase,...activeCountries.map(row=>row.mesh),...activeBorders,...Object.values(physicalLayers??{}).flat()]);}
  function evictMesh(key,entry){
    for(const [slot,row] of datedCountries)if(row.mesh===entry.mesh)datedCountries.delete(slot);
    residentMeshes.delete(key);releaseMesh(entry.mesh);
  }
  function meshMemoryEntries(){
    const rows=[],protectedMeshes=activeMeshesNow(),owned=new Set();
    for(const [key,entry] of residentMeshes){
      owned.add(entry.mesh);
      rows.push({key:entry.mesh,...entry.mesh.footprint(),lastUsed:entry.mesh.lastUsed,protected:protectedMeshes.has(entry.mesh),evict:()=>evictMesh(key,entry)});
    }
    for(const resource of spatialResources)if(!owned.has(resource)&&!resource.outlineOwner&&!resource.externalOwner)rows.push({key:resource,...resource.footprint(),protected:true});
    rows.push({key:channels,buffers:renderPacketBuffers([channels,countryVisible,hydroBytes,borderBytes]),extraBytes:channels.byteLength+hydroBytes.byteLength,protected:true});
    return rows;
  }
  const refreshMeshLedger=residency.register(meshMemoryEntries),refreshLabelLedger=residency.register(labels.memoryEntries);
  function evictOutline(slot,entry){
    if(outlineCache.get(slot)!==entry)return;
    outlineCache.delete(slot);dirtyOutlineOwners.delete(entry);entry.dispose();dirtyOutlineOwners.delete(entry);
  }
  function trimResidency(){
    const labelsChanged=labels.trim();
    if(labelsChanged)refreshLabelLedger();
    const meshChanged=residencyDirty,outlineChanged=dirtyOutlineOwners.size>0;
    if(meshChanged){
      residencyDirty=false;
      const activeMeshes=activeMeshesNow(),protectedMeshes=new Set();
      for(const [key,entry] of residentMeshes)if(activeMeshes.has(entry.mesh))protectedMeshes.add(key);
      trimRenderCache(residentMeshes,protectedMeshes,cacheBudget.residentMeshBytes,entry=>entry.bytes,(_key,entry)=>{
        for(const [slot,row] of datedCountries)if(row.mesh===entry.mesh)datedCountries.delete(slot);
        releaseMesh(entry.mesh);
      },{entryLimit:512});
      refreshMeshLedger();
    }
    for(const [entry,slot] of dirtyOutlineOwners){
      if(outlineCache.get(slot)===entry)entry.syncResidency({active:paintedOutlines.has(entry),evict:()=>evictOutline(slot,entry)});
    }
    dirtyOutlineOwners.clear();
    return labelsChanged||meshChanged||outlineChanged;
  }
  function cacheStats(){
    const outlineChunks={residentChunks:0,visibleChunks:0,activeChunks:0,evictedChunks:0,createdChunks:0,shrunkBuffers:0,updatedChunks:0};
    for(const entry of outlineCache.values())for(const [key,value] of Object.entries(entry.stats()))outlineChunks[key]+=value;
    return {meshes:residentMeshes.size,meshResidentBytes:[...residentMeshes.values()].reduce((sum,row)=>sum+row.bytes,0),outlines:outlineCache.size,outlineResidentBytes:[...outlineCache.values()].reduce((sum,row)=>sum+row.bytes(),0),outlineChunks};
  }

  function resize(width, height, dpr) {
    viewport.value.set(width, height);
    margin.value = 0.5 / dpr;
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false);
  }
  function draw(globeCamera, width, height,{requireCompleteLabels=false}={}) {
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
    const labelsReady=labels.update(globeCamera,width,height,getCuller(0),requireCompleteLabels);
    if(requireCompleteLabels&&!labelsReady)return false;
    flushHydroPaint();
    const stats={triangles:0,submittedTriangles:0,segments:0,submittedSegments:0,ranges:0,visibleRanges:0,strokeBatches:0,strokeDrawCalls:0,directStrokeSegments:0,compactionUploadBytes:0};
    for(const resource of activeSpatialResources)resource.update(getCuller,view.zoom,stats);
    for(const outline of paintedOutlines)outline.update(getCuller,strokePadding,stats);
    spatialStats=stats;
    renderer.render(scene, camera);return true;
  }
  function dispose() {
    labels.dispose();
    for(const entry of outlineCache.values())entry.dispose();
    outlineCache.clear();paintedOutlines.clear();dirtyOutlineOwners.clear();residentMeshes.clear();datedCountries.clear();
    refreshMeshLedger.dispose();refreshLabelLedger.dispose();
    for(const resource of [...spatialResources])resource.dispose();
    layers.clear();waterMeshes.clear();activeCountries=[];activeBorders=[];activeBase=[];baseInput=null;physicalLayers=activePhysical=null;graticule=null;
    texture.dispose();hydroTexture.dispose();hydroUploadSource.dispose();
    renderer.dispose();
  }
  return Object.freeze({resize,draw,setCountryPaint,restoreCountryPaint,installGraticule,hasGraticule:()=>graticule!==null,installBaseBorders,hasBaseBorders:()=>baseBordersInstalled,installOutlines,hasOutlines:slot=>outlineCache.has(slot),setOutlinePaint,setHydroPaint,setLayerVisibility,attachRiverDetail,activateBaseCountries,activateDatedView,activatePhysicalContext,trimResidency,cacheStats,labels,dispose,
    drawCalls:()=>renderer.info.render.calls,hydroUploadStats:()=>({...hydroUploadStats}),spatialStats:()=>({...spatialStats})});
}
