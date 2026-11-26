import { GLOBE_FIELD_OF_VIEW } from './globe-camera.js';
import { createThreeGlobeStrokes, hydroStyleLookup } from './three-globe-strokes.js';
import { createThreeGlobeLabels } from './three-globe-labels.js';
import { PLACE_LIMITS } from '../document/place-limits.js';

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

export function createThreeGlobeSurface(THREE, { canvas, context, palette, packets, countryCount, hydroCount }) {
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
  const labels=createThreeGlobeLabels(THREE,{scene,palette:palette.labels,capacity:Math.max(countryCount,PLACE_LIMITS.layoutCandidates),viewport});
  const reusableColor = new THREE.Color(), highlightColor = new THREE.Color();
  function setCountryPaint(paint) {
    let changed = false;
    paint.forEach(({color,visible,highlight}, index) => {
      reusableColor.set(color||palette.defaultLand);
      if(highlight?.alpha>0)reusableColor.lerp(highlightColor.set(highlight.color),highlight.alpha);
      reusableColor.convertLinearToSRGB();
      const offset = index * 4;
      const next = [Math.round(reusableColor.r*255),Math.round(reusableColor.g*255),Math.round(reusableColor.b*255),visible?255:0];
      if(next.every((value,channel)=>value===channels[offset+channel]))return;
      channels.set(next,offset);
      changed = true;
    });
    if(changed)texture.needsUpdate = true;
  }
  const layers=new Map(),datedCountries=new Map(),residentMeshes=new Map();
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
  function useMesh(role,identity,prepare){
    const key=role+':'+identity;
    if(!residentMeshes.has(key))residentMeshes.set(key,prepare());
    return residentMeshes.get(key);
  }
  function activatePhysicalContext(parts){
    if(activePhysical===parts)return;
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
    const rolesByGroup=new Uint8Array(Math.max(1,owners.length));
    const groupTexture=new THREE.DataTexture(rolesByGroup,rolesByGroup.length,1,THREE.RedFormat);
    groupTexture.needsUpdate=true;
    const outlineStyles=Array.from({length:5},()=>new THREE.Vector2());
    const mesh=createThreeGlobeStrokes(THREE,{...strokeOptions,packet,order:6,outlineUniforms:{
      outlineGroups:{value:groupTexture},outlineGroupCount:{value:rolesByGroup.length},outlineStyles:{value:outlineStyles},
    }});
    mesh.geometry.instanceCount=0;mesh.visible=false;scene.add(mesh);
    function paint(roles,styles,color){
      let changed=false,active=false;
      for(const [code,style] of styles.entries())outlineStyles[code].set(style.width/2,style.alpha);
      for(const [group,slots] of owners.entries()){
        let code=0;
        for(const slot of slots)if(roles[slot]>code&&outlineStyles[roles[slot]].x>0&&outlineStyles[roles[slot]].y>0)code=roles[slot];
        active||=code!==0;
        if(rolesByGroup[group]===code)continue;
        rolesByGroup[group]=code;changed=true;
      }
      if(changed)groupTexture.needsUpdate=true;
      mesh.geometry.instanceCount=active?packet.count:0;
      mesh.visible=active;
      if(active)mesh.material.uniforms.strokeColor.value.set(color);
    }
    return {mesh,texture:groupTexture,paint};
  }
  let outlines=null;
  function installOutlines(slot,data){
    if(slot===null)outlines=createOutlines(data);
    else datedCountries.get(slot).outlines=createOutlines(data);
  }
  function setOutlinePaint(roles,styles,color){
    outlines?.paint(roles,styles,color);
    for(const row of activeCountries)row.outlines?.paint(roles,styles,color);
  }
  function activateDatedView(view,parts){
    if(view===activeView)return;
    for(const row of activeCountries){row.mesh.visible=false;if(row.outlines)row.outlines.mesh.visible=false;}
    for(const mesh of activeBorders)mesh.visible=false;
    activeView=view;
    activeCountries=(parts?.countries??[]).map(({slot,key,mesh})=>{
      if(!datedCountries.has(slot))datedCountries.set(slot,{
        mesh:useMesh('dated-country',key,()=>register(null,mesh.packet,palette.defaultLand,1,-2,'country')),outlines:null,
      });
      return datedCountries.get(slot);
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
    for (const mesh of scene.children) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    texture.dispose();hydroTexture.dispose();
    outlines?.texture.dispose();borderTexture.dispose();
    for(const value of datedCountries.values())value.outlines?.texture.dispose();
    renderer.dispose();
  }
  return Object.freeze({resize,draw,setCountryPaint,installOutlines,setOutlinePaint,setHydroPaint,setLayerVisibility,attachRiverDetail,activateDatedView,activatePhysicalContext,labels,dispose,
    drawCalls:()=>renderer.info.render.calls});
}
