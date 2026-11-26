import { GLOBE_FIELD_OF_VIEW } from './globe-camera.js';
import { createThreeGlobeStrokes, createGlobeStrokePointTexture, hydroStyleLookup } from './three-globe-strokes.js';
import {compactGlobeStrokeRange} from './globe-mesh.js';
import { createThreeGlobeLabels } from './three-globe-labels.js';
import { PLACE_LIMITS } from '../document/place-limits.js';
import {renderCacheBudget,renderPacketBytes,renderPacketBuffers,touchRenderCache,trimRenderCache} from './render-cache-budget.js';
import {createGlobeSpatialSelection,createGlobeRangeCuller} from './globe-spatial-partition.js';

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
      if(countryVisible[index]!==Number(visible)){countryVisible[index]=Number(visible);countryVisibilityRevision++;}
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
  let residencyDirty=true;
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
    for(const {packet:part,index} of packet.spatialParts){
      let points=textures.get(part.points);
      if(!points){points=createGlobeStrokePointTexture(THREE,part.points,maxPointTextureSize);textures.set(part.points,points);pointResources.push(points);}
      const output={count:part.count,endpointIndices:new Uint32Array(part.count*2),widths:new Float32Array(part.widths.length),ownerGroups:new Uint16Array(options.hydroUniforms?part.ownerGroups.length:0)};
      const mesh=createThreeGlobeStrokes(THREE,{...options,packet:output,pointUniforms:points.uniforms});
      const attributes=Object.values(mesh.geometry.attributes).filter(attribute=>attribute.isInstancedBufferAttribute);
      for(const attribute of attributes)attribute.setUsage(THREE.DynamicDrawUsage);
      mesh.geometry.instanceCount=0;
      drawParts.push({part,index,mesh,output,attributes,selection:createGlobeSpatialSelection(part,index)});
    }
    const count=packet.count;
    return spatialResource(drawParts.map(row=>row.mesh),null,(getCuller,currentZoom,stats)=>{
      const cull=currentZoom>=(options.minZoom??-2)?getCuller(strokePadding(options,maxWidth)):admitNone;
      stats.segments+=count;
      for(const {part,index,mesh,output,attributes,selection} of drawParts){
        const selected=selection.select(cull,options.baseBorder?borderVisibilityRevision:0,options.baseBorder?borderOwnerVisible:null);
        stats.ranges+=index.leafCount??index.owners.length;
        stats.submittedSegments+=selected.count;stats.visibleRanges+=selected.leaves;
        if(selected.changed&&selected.count){
          let offset=0;
          for(let i=0;i<selected.ranges.length;i+=2){
            const first=selected.ranges[i],end=selected.ranges[i+1];
            output.endpointIndices.set(part.endpointIndices.subarray(first*2,end*2),offset*2);
            if(output.widths.length)output.widths.set(part.widths.subarray(first,end),offset);
            if(output.ownerGroups.length)output.ownerGroups.set(part.ownerGroups.subarray(first,end),offset);
            offset+=end-first;
          }
          for(const attribute of attributes){
            attribute.clearUpdateRanges();attribute.addUpdateRange(0,selected.count*attribute.itemSize);attribute.needsUpdate=true;
          }
        }
        mesh.geometry.instanceCount=selected.count;mesh.visible=selected.count>0;
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
    const mesh=new THREE.Mesh(geometry,material);
    mesh.frustumCulled=false;mesh.renderOrder=order;
    const resource=spatialResource([mesh],material,(getCuller,currentZoom,stats)=>{
      const cull=currentZoom>=minZoom?getCuller(0):admitNone;
      const selected=selection.select(cull,style==='country'?countryVisibilityRevision:0,style==='country'?countryOwnerVisible:null);
      if(selected.changed&&selected.count){
        let offset=0;
        for(let i=0;i<selected.ranges.length;i+=2){
          const first=selected.ranges[i]*3,end=selected.ranges[i+1]*3;
          drawIndices.set(packet.indices.subarray(first,end),offset);offset+=end-first;
        }
        drawIndex.clearUpdateRanges();drawIndex.addUpdateRange(0,selected.count*3);drawIndex.needsUpdate=true;
      }
      geometry.setDrawRange(0,selected.count*3);mesh.visible=selected.count>0;
      stats.triangles+=index.count;stats.ranges+=index.leafCount??index.owners.length;
      stats.submittedTriangles+=selected.count;stats.visibleRanges+=selected.leaves;
    },[],packet);
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

  function createOutlines({packet,owners}){
    const index=indexGlobeOutlineRanges(packet,owners);
    const partitions=packet.spatialParts;
    const outlineStyles=Array.from({length:5},()=>new THREE.Vector2());
    const attributeNames=['endpointIndices','ownerGroup'];
    const chunks=new Map();
    let previousGroups=new Map(),activeChunks=new Set(),groupRevision=0;
    function ensureCapacity(chunk,partition,count){
      if(chunk.capacity>=count)return;
      chunk.resource?.dispose();
      const capacity=Math.min(partition.end-partition.first,Math.max(count,Math.ceil(chunk.capacity*1.5),64));
      chunk.source??=compactGlobeStrokeRange(packet,partition.first,partition.end);
      const buffer={count:capacity,endpointIndices:new Uint32Array(capacity*2),widths:new Float32Array(0),ownerGroups:new Uint16Array(capacity)};
      const points=createGlobeStrokePointTexture(THREE,chunk.source.points,maxPointTextureSize);
      const options={...strokeOptions,order:6,outlineUniforms:{outlineStyles:{value:outlineStyles}}};
      const mesh=createThreeGlobeStrokes(THREE,{...options,packet:buffer,pointUniforms:points.uniforms});
      for(const name of attributeNames)mesh.geometry.getAttribute(name).setUsage(THREE.DynamicDrawUsage);
      mesh.geometry.instanceCount=0;
      const selection=createGlobeSpatialSelection(chunk.source,partition.index);
      const resource=spatialResource([mesh],mesh.material,(getCuller,_zoom,stats)=>{
        const selected=selection.select(getCuller(strokePadding(options,1)),chunk.revision,group=>chunk.groups.has(group));
        if(selected.changed&&selected.count){
          let offset=0;
          for(let i=0;i<selected.ranges.length;i+=2){
            const first=selected.ranges[i],end=selected.ranges[i+1];
            buffer.endpointIndices.set(chunk.source.endpointIndices.subarray(first*2,end*2),offset*2);
            for(let id=first;id<end;id++)buffer.ownerGroups[offset++]=chunk.groups.get(chunk.source.ownerGroups[id])??0;
          }
          for(const name of attributeNames){
            const attribute=mesh.geometry.getAttribute(name);
            attribute.clearUpdateRanges();attribute.addUpdateRange(0,selected.count*attribute.itemSize);attribute.needsUpdate=true;
          }
        }
        mesh.geometry.instanceCount=selected.count;mesh.visible=selected.count>0;
        stats.segments+=chunk.selectedCount;stats.ranges+=partition.index.leafCount;
        stats.submittedSegments+=selected.count;stats.visibleRanges+=selected.leaves;
      },[points],chunk.source);
      resource.outlineOwner=true;
      chunk.capacity=capacity;chunk.buffer=buffer;chunk.mesh=mesh;chunk.resource=resource;
    }
    function hide(){for(const chunk of activeChunks)chunk.resource.visible=false;}
    function paint(roles,styles,color){
      for(const [code,style] of styles.entries())outlineStyles[code].set(style.width/2,style.alpha);
      const groups=selectGlobeOutlineGroups(index,roles,styles);
      if(!groups.size){hide();return;}
      const changed=groups.size!==previousGroups.size||[...groups].some(([group,code])=>previousGroups.get(group)!==code);
      if(changed){
        groupRevision++;
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
          if(!chunk){chunk={capacity:0};chunks.set(part,chunk);}
          const count=local.reduce((sum,{first,end})=>sum+end-first,0);
          ensureCapacity(chunk,partition,count);
          chunk.groups=groups;chunk.revision=groupRevision;chunk.selectedCount=count;
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
      +index.rangesByGroup.reduce((sum,ranges)=>sum+ranges.length*32,0);
    function bytes(){return renderPacketBytes(packet)+indexBytes+[...chunks.values()].reduce((sum,chunk)=>sum+chunk.resource.bytes*2+chunk.source.points.byteLength+chunk.source.endpointIndices.byteLength,0);}
    function dispose(){for(const chunk of chunks.values())chunk.resource?.dispose();chunks.clear();activeChunks.clear();previousGroups.clear();}
    function footprint(){
      const buffers=renderPacketBuffers(packet);let extraBytes=indexBytes;
      for(const chunk of chunks.values())if(chunk.resource){
        for(const buffer of chunk.resource.buffers)buffers.add(buffer);
        extraBytes+=chunk.resource.deviceBytes;
      }
      return {buffers,extraBytes};
    }
    return {paint,hide,bytes,dispose,footprint,lastUsed:performance.now()};
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
    for(const [target,local] of targets){target.lastUsed=performance.now();target.paint(local,styles,color);}
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
  function activeMeshesNow(){return new Set([...activeCountries.map(row=>row.mesh),...activeBorders,...Object.values(physicalLayers??{}).flat()]);}
  function evictMesh(key,entry){
    for(const [slot,row] of datedCountries)if(row.mesh===entry.mesh)datedCountries.delete(slot);
    residentMeshes.delete(key);releaseMesh(entry.mesh);
  }
  function memoryEntries(){
    const rows=[],protectedMeshes=activeMeshesNow(),owned=new Set();
    for(const [key,entry] of residentMeshes){
      owned.add(entry.mesh);
      rows.push({...entry.mesh.footprint(),lastUsed:entry.mesh.lastUsed,protected:protectedMeshes.has(entry.mesh),evict:()=>evictMesh(key,entry)});
    }
    for(const [slot,entry] of outlineCache)rows.push({...entry.footprint(),lastUsed:entry.lastUsed,protected:paintedOutlines.has(entry),evict:()=>{outlineCache.delete(slot);entry.dispose();}});
    for(const resource of spatialResources)if(!owned.has(resource)&&!resource.outlineOwner&&!resource.externalOwner)rows.push({...resource.footprint(),protected:true});
    rows.push({buffers:renderPacketBuffers([channels,countryVisible,hydroBytes,borderBytes]),extraBytes:channels.byteLength+hydroBytes.byteLength,protected:true});
    return [...rows,...labels.memoryEntries()];
  }
  function trimResidency(){
    const labelsChanged=labels.trim();
    if(!residencyDirty)return labelsChanged;
    residencyDirty=false;
    const activeMeshes=activeMeshesNow();
    const protectedMeshes=new Set();
    for(const [key,entry] of residentMeshes)if(activeMeshes.has(entry.mesh))protectedMeshes.add(key);
    trimRenderCache(residentMeshes,protectedMeshes,cacheBudget.residentMeshBytes,entry=>entry.bytes,(_key,entry)=>{
      for(const [slot,row] of datedCountries)if(row.mesh===entry.mesh)datedCountries.delete(slot);
      releaseMesh(entry.mesh);
    },{entryLimit:512});
    const protectedOutlines=new Set();
    for(const [slot,resource] of outlineCache)if(paintedOutlines.has(resource))protectedOutlines.add(slot);
    trimRenderCache(outlineCache,protectedOutlines,cacheBudget.outlineBytes,entry=>entry.bytes(),(_slot,entry)=>entry.dispose(),{entryLimit:128});
    return true;
  }
  function cacheStats(){return {meshes:residentMeshes.size,meshResidentBytes:[...residentMeshes.values()].reduce((sum,row)=>sum+row.bytes,0),outlines:outlineCache.size,outlineResidentBytes:[...outlineCache.values()].reduce((sum,row)=>sum+row.bytes(),0)};}

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
    layers.clear();waterMeshes.clear();activeCountries=[];activeBorders=[];physicalLayers=activePhysical=null;graticule=null;
    texture.dispose();hydroTexture.dispose();
    renderer.dispose();
  }
  return Object.freeze({resize,draw,setCountryPaint,restoreCountryPaint,installGraticule,hasGraticule:()=>graticule!==null,installBaseBorders,hasBaseBorders:()=>baseBordersInstalled,installOutlines,hasOutlines:slot=>outlineCache.has(slot),setOutlinePaint,setHydroPaint,setLayerVisibility,attachRiverDetail,activateDatedView,activatePhysicalContext,trimResidency,cacheStats,memoryEntries,labels,dispose,
    drawCalls:()=>renderer.info.render.calls,spatialStats:()=>({...spatialStats})});
}
