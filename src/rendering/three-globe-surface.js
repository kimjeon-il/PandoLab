import { createGlobeDataTexture, createGlobeMesh, globeMeshMaterials, gpuResourceFootprint, disposeGlobeGpuResources, createGlobeTextureCopier } from './globe-gpu-resources.js';
import { GLOBE_FIELD_OF_VIEW } from './globe-camera.js';
import { createThreeGlobeStrokes, createGlobeStrokePointTexture, hydroStyleLookup } from './three-globe-strokes.js';
import { createGlobeOutlineCache } from './globe-outline-cache.js';
import { planGlobeCompactionUpdates, mergeGlobeDrawRanges, copyGlobeDrawWrites, applyGlobeDrawWrites, useDirectGlobeStrokeAttributes, writeDirectGlobeStrokes, globeDrawCapacity, splitGlobeDrawRanges, globeDrawGroups, groupGlobeGpuMeshes, combineGlobeDrawMeshes } from './globe-draw-compaction.js';
export { indexGlobeOutlineRanges, selectGlobeOutlineGroups, globeOutlineRanges } from './globe-outline-cache.js';
import { createThreeGlobeLabels } from './three-globe-labels.js';
import { PLACE_LIMITS } from '../document/place-limits.js';
import { renderCacheBudget, renderPacketBuffers, renderFootprintBytes, touchRenderCache, trimRenderCache } from './render-cache-budget.js';
import { createGlobeSpatialSelection, createGlobeRangeCuller, globeStrokeRange } from './globe-spatial-partition.js';

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
export function globeHydroTextureRects(slots, width) {
  const ordered = [...new Set(slots)].sort((a, b) => a-b), rows = [];
  for (const slot of ordered) {
    const x = slot%width, y = Math.floor(slot/width),last=rows.at(-1);
    if (last&&last.y===y&&last.x+last.width===x)last.width++;
    else rows.push({x, y, width:1, height:1});
  }
  const merged = [], bySpan = new Map();
  for (const row of rows) {
    const key = row.x+':'+row.width, last = bySpan.get(key);
    if (last&&last.y+last.height===row.y)last.height++;
    else {merged.push(row); bySpan.set(key, row);}
  }
  return merged;
}

export function createThreeGlobeSurface(THREE, { canvas, context, palette, packets, countryCount, baseCountryCount = countryCount, hydroCount, cacheBudget = renderCacheBudget(), residency, workScheduler = null, onLabelReady = () => {}, onLabelError = () => {} }) {
  const renderer = new THREE.WebGLRenderer({ canvas, context });
  const maxPointTextureSize = renderer.capabilities.maxTextureSize;
  renderer.setClearColor(palette.ocean);
  renderer.debug.onShaderError = (gl, program, vertexShader, fragmentShader) => {
    throw new Error([gl.getProgramInfoLog(program), gl.getShaderInfoLog(vertexShader), gl.getShaderInfoLog(fragmentShader)].filter(Boolean).join('\n'));
  };
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(GLOBE_FIELD_OF_VIEW, 1);
  const countryWidth = Math.min(maxPointTextureSize, Math.max(1, countryCount)), countryHeight = Math.ceil(Math.max(1, countryCount)/countryWidth);
  const channels = new Uint8Array(countryWidth*countryHeight*4), countryVisible = new Uint8Array(countryCount);
  let countryVisibilityRevision = 0, borderVisibilityRevision = 0;
  const countrySlotRevisions = new Float64Array(countryCount), borderSlotRevisions = new Float64Array(Math.max(1, packets.borderGroupCount));
  const texture = createGlobeDataTexture(THREE, channels, countryWidth, countryHeight);
  texture.colorSpace = THREE.SRGBColorSpace;
  let countryTextureUploaded = false, countryPendingFull = true;
  const countryDirtySlots = new Set();
  texture.onUpdate = () => {countryTextureUploaded = true; countryPendingFull = false; countryDirtySlots.clear();};
  texture.needsUpdate = true;
  const hydroWidth = Math.min(1024, Math.max(1, hydroCount)), hydroHeight = Math.ceil(Math.max(1, hydroCount)/hydroWidth);
  const hydroBytes = new Uint8Array(hydroWidth*hydroHeight);
  const hydroTexture = createGlobeDataTexture(THREE, hydroBytes, hydroWidth, hydroHeight, {format:THREE.RedFormat});
  const hydroCopier = createGlobeTextureCopier(THREE, renderer), hydroDirtySlots = new Set();
  let hydroUploaded = false;
  const hydroUploadStats = {fullUploads:0, partialUploads:0, fullBytes:0, partialBytes:0};
  hydroTexture.onUpdate = () => {hydroUploaded = true; hydroUploadStats.fullUploads++; hydroUploadStats.fullBytes+=hydroBytes.byteLength;};
  hydroTexture.needsUpdate = true;
  const hydroTint = new THREE.Color(), hydroStyles = Array.from({length:5}, () => new THREE.Vector3());
  const hydroUniforms = {hydroRoles:{value:hydroTexture}, hydroSize:{value:new THREE.Vector2(hydroWidth, hydroHeight)},
    hydroTint:{value:hydroTint}, hydroStyles:{value:hydroStyles}, hasHydroHighlight:{value:false}};
  let previousHydro = new Map(), waterMeshes = new Map(), previousWaters = new Map(), waterPaintDirty = true, previousWaterTint = null, previousWaterStyles = [];
  const eyeHigh = new THREE.Vector3(), eyeLow = new THREE.Vector3();
  const viewRotation = new THREE.Matrix3();
  const zoom = { value: 0 };
  const cameraUniforms = { eyeHigh: { value: eyeHigh }, eyeLow: { value: eyeLow }, viewRotation: { value: viewRotation }, zoom };
  const viewport = { value: new THREE.Vector2() }, margin = { value: 0.5 };
  let refreshMeshLedger = () => {}, refreshLabelLedger = () => {};
  const labels = createThreeGlobeLabels(THREE, {scene, renderer, palette:palette.labels, capacity:PLACE_LIMITS.layoutCandidates, maxTextureSize:maxPointTextureSize, viewport, byteBudget:cacheBudget.labelAtlasBytes, residency, workScheduler, onReady:() => {refreshLabelLedger(); onLabelReady();}, onError:onLabelError});
  const reusableColor = new THREE.Color(), highlightColor = new THREE.Color();
  function restoreCountryPaint() {
    countryTextureUploaded = false; countryPendingFull = true; texture.clearUpdateRanges(); texture.needsUpdate = true;
    hydroUploaded = false; hydroDirtySlots.clear(); hydroTexture.needsUpdate = true; labels.restoreTextures();
  }
  function setCountryPaint(paint, {full = false} = {}) {
    // Keep unconsumed full and partial writes across deferred frames.
    // Only the actual texture upload callback may acknowledge them.
    countryPendingFull||=full||!countryTextureUploaded;
    for (const [index, {color, visible, highlight}] of paint) {
      reusableColor.set(color||palette.defaultLand);
      if (highlight?.alpha>0)reusableColor.lerp(highlightColor.set(highlight.color), highlight.alpha);
      reusableColor.convertLinearToSRGB();
      const offset = index*4, next = [Math.round(reusableColor.r*255), Math.round(reusableColor.g*255), Math.round(reusableColor.b*255), visible?255:0];
      if (next.every((value, channel) => value===channels[offset+channel]))continue;
      if (countryVisible[index]!==Number(visible)) {countryVisible[index] = Number(visible); countrySlotRevisions[index] = ++countryVisibilityRevision;}
      channels.set(next, offset); countryDirtySlots.add(index);
    }
  }
  function flushCountryPaint() {
    if (!countryPendingFull&&!countryDirtySlots.size)return;
    texture.clearUpdateRanges();
    if (countryTextureUploaded&&!countryPendingFull) {
      for (const slot of countryDirtySlots)texture.addUpdateRange(slot*4, 4);
    }
    texture.needsUpdate = true;
  }
  const layers = new Map(), residentMeshes = new Map();
  let meshResidentBytes = 0;
  const spatialResources = new Set(), activeSpatialResources = new Set(), dirtyOutlineOwners = new Map();
  const strokeResources = {country:new Set(), river:new Set()};
  let spatialStats = {triangles:0, submittedTriangles:0, segments:0, submittedSegments:0, ranges:0, visibleRanges:0, strokeBatches:0, strokeDrawCalls:0, directStrokeSegments:0, compactionUploadBytes:0, meshDrawCalls:0, immutableIndexTriangles:0, rewrittenBlocks:0};
  let cullingCamera = null, cullingWidth = 0, cullingHeight = 0, cullers = new Map();
  let residencyDirty = true;
  let activePhysical = null, physicalLayers = null;
  const visibleLayers = {lakes:true, rivers:true};
  let activeView = null, activeTerritoryInput = null, activeBorders = [], activeBase = [], showBorders = true;
  function addLayer(name, mesh) {
    if (!layers.has(name))layers.set(name, []);
    layers.get(name).push(mesh);
  }
  // The logical visibility/ownership of a packet is independent of which
  // spatial ranges its current camera actually submits.
  function spatialResource(objects, material, update, pointResources = [], retained = null, {geometries = null, workspace = () => [], disposeExtra = () => {}} = {}) {
    let enabled = true, disposed = false;
    const materials = globeMeshMaterials(objects);
    if (material)materials.add(material);
    function footprint() {
      return gpuResourceFootprint(geometries?geometries():objects.map(mesh => mesh.geometry),
        pointResources.map(row => row.texture), [retained, workspace()]);
    }
    const resource = {
      material, update, lastUsed:performance.now(), footprint,
      setOrder(order, span = 0) {objects.forEach((mesh, i) => {mesh.renderOrder = order+span*i/Math.max(1,objects.length);});},
      setStrokeStyle(style) {for (const material of materials) {const u = material.uniforms; if (u.radius)u.radius.value = style.width/2;if(u.strokeColor)u.strokeColor.value.set(style.color);if(u.strokeOpacity)u.strokeOpacity.value=style.opacity??style.alpha??1;}},
      get visible() {return enabled;},
      set visible(value) {
        if (disposed||enabled===Boolean(value))return;
        enabled = Boolean(value);
        if (enabled) {resource.lastUsed = performance.now(); activeSpatialResources.add(resource);}
        else {activeSpatialResources.delete(resource); for (const mesh of objects)mesh.visible = false;}
      },
      dispose() {
        if (disposed)return;
        disposed = true; activeSpatialResources.delete(resource); spatialResources.delete(resource);
        disposeGlobeGpuResources(scene, objects, {
          geometries:geometries?geometries():objects.map(mesh => mesh.geometry), materials,
          textures:pointResources.map(row => row.texture), afterGeometry:disposeExtra,
        });
      },
    };
    for (const mesh of objects) {mesh.visible = false; scene.add(mesh);}
    spatialResources.add(resource); activeSpatialResources.add(resource); residencyDirty = true; refreshMeshLedger();
    return resource;
  }
  function strokePadding(options, maxWidth) {
    let radius = options.style.width/2*maxWidth;
    if (options.hydroUniforms)for (const role of hydroStyles)if (role.y>0)radius = Math.max(radius, role.x/2);
    if (options.outlineUniforms)for (const role of options.outlineUniforms.outlineStyles.value)if (role.y>0)radius = Math.max(radius, role.x);
    // Include the end cap and normal expansion in both screen axes.
    return 2*(radius+margin.value)+1;
  }
  const admitNone = () => false;
  const countryOwnerVisible = slot => slot<0||countryVisible[slot]===1;
  const borderOwnerVisible = slot => slot<0||borderBytes[slot]!==0;
  function localOwnerRevision(slots, versions, current) {
    const owners = [...new Set(slots)]; let global = -1, local = 0;
    return () => {const revision = current(); if (global===revision)return local; global = revision;
      for (const owner of owners)local = Math.max(local, versions[owner]??0); return local;};
  }
  function spatialStrokes(packet, options) {
    const pointResources = [], textures = new Map(), drawParts = [];
    let maxWidth = 1;
    if (packet.widths.length) {
      maxWidth = 1.5;
      for (const width of packet.widths)maxWidth = Math.max(maxWidth, width);
    }
    // Spatial leaves are query granularity, not draw-call granularity.
    // Consecutive parts sharing a dictionary and style use one instance
    // stream, in original segment order. A local dictionary remains separate.
    const groups = [];
    for (const row of packet.spatialParts) {
      const last = groups.at(-1);
      if (last&&last.end===row.first&&last.points===packet.points&&row.packet.points===last.points&&row.end-last.first<=65_536) {
        last.parts.push(row); last.end = row.end;
      }else groups.push({first:row.first, end:row.end, points:row.packet.points, parts:[row]});
    }
    for (const group of groups) {
      const source = group.points===packet.points?globeStrokeRange(packet, group.first, group.end):group.parts[0].packet;
      const direct = useDirectGlobeStrokeAttributes(source);
      let points = null;
      if (!direct) {
        points = textures.get(source.points);
        if (!points) {points = createGlobeStrokePointTexture(THREE, source.points, maxPointTextureSize); textures.set(source.points, points); pointResources.push(points);}
      }
      const output = {count:source.count, widths:new Float32Array(source.widths.length), ownerGroups:new Uint16Array(options.hydroUniforms?source.ownerGroups.length:0)};
      if (direct)for (const name of ['start','startLow','end','endLow'])output[name] = new Float32Array(source.count*3);
      else output.endpointIndices = new Uint32Array(source.count*2);
      const mesh = createThreeGlobeStrokes(THREE, {...options, packet:output, pointUniforms:points?.uniforms});
      const attributes = Object.values(mesh.geometry.attributes).filter(attribute => attribute.isInstancedBufferAttribute);
      for (const attribute of attributes)attribute.setUsage(THREE.DynamicDrawUsage);
      mesh.geometry.instanceCount = 0;
      drawParts.push({source, mesh, output, direct, prior:new Uint32Array(), parts:group.parts.map(row => ({
        ...row, offset:row.first-group.first, selection:createGlobeSpatialSelection(row.packet, row.index), ownerRevision:options.baseBorder?localOwnerRevision(row.packet.ownerGroups, borderSlotRevisions, () => borderVisibilityRevision):() => 0
      }))});
    }
    const count = packet.count;
    const resource = spatialResource(drawParts.map(row => row.mesh), null, (getCuller, currentZoom, stats) => {
      const cull = currentZoom>=(options.minZoom??-2)?getCuller(strokePadding(options, maxWidth)):admitNone;
      stats.segments+=count; stats.strokeBatches+=drawParts.length;
      for (const batch of drawParts) {
        const {source, mesh, output, direct, parts} = batch;
        const selections = []; let changed = false, total = 0;
        for (const row of parts) {
          const selected = row.selection.select(cull, row.ownerRevision(), options.baseBorder?borderOwnerVisible:null);
          stats.ranges+=row.index.leafCount; stats.visibleRanges+=selected.leaves;
          total+=selected.count; changed||=selected.changed;
          selections.push({ranges:selected.ranges, offset:row.offset});
        }
        if (changed) {
          const {ranges} = mergeGlobeDrawRanges(selections), writes = planGlobeCompactionUpdates(ranges, batch.prior);
          if (direct&&writes.length) {
            writeDirectGlobeStrokes(output, source, writes);
            for (const name of ['start','startLow','end','endLow'])stats.compactionUploadBytes+=applyGlobeDrawWrites(mesh.geometry.getAttribute(name), writes);
          }else if (!direct)stats.compactionUploadBytes+=copyGlobeDrawWrites(mesh.geometry.getAttribute('endpointIndices'), source.endpointIndices, writes);
          if (output.widths.length)stats.compactionUploadBytes+=copyGlobeDrawWrites(mesh.geometry.getAttribute('sourceWidth'), source.widths, writes);
          if (output.ownerGroups.length)stats.compactionUploadBytes+=copyGlobeDrawWrites(mesh.geometry.getAttribute('ownerGroup'), source.ownerGroups, writes);
          batch.prior = ranges; residencyDirty = true;
        }
        mesh.geometry.instanceCount = total; mesh.visible = total>0;
        stats.submittedSegments+=total;
        if (total) {stats.strokeDrawCalls++; if (direct)stats.directStrokeSegments+=total;}
      }
    }, pointResources, packet, {workspace:() => drawParts.flatMap(row => [row.prior, ...row.parts.flatMap(part => part.selection.footprint())]), disposeExtra:() => strokeResources[options.strokeKind]?.delete(resource)});
    if (options.strokeKind)strokeResources[options.strokeKind].add(resource);
    return resource;
  }
  function setLayerVisibility(name, visible) {
    if (name==='graticule')graticuleVisible = visible;
    for (const mesh of layers.get(name)??[])mesh.visible = visible;
    if (Object.hasOwn(visibleLayers, name)) {
      visibleLayers[name] = visible;
      for (const mesh of physicalLayers?.[name]??[])mesh.visible = visible;
    }
    if (name==='borders') {
      showBorders = visible;
      for (const mesh of activeBorders)mesh.visible = visible;
    }
  }
  function register(name, packet, color, order, minZoom = -2, style = '') {
    const attributes = {
      position:new THREE.BufferAttribute(packet.positions, 3),
      positionLow:new THREE.BufferAttribute(packet.residuals, 3),
    };
    if (packet.slots.length)attributes.objectSlot = new THREE.BufferAttribute(packet.slots, 1);
    function makeGeometry(index) {
      const geometry = new THREE.BufferGeometry();
      for (const [key, attribute] of Object.entries(attributes))geometry.setAttribute(key, attribute);
      geometry.setIndex(index); geometry.setDrawRange(0, 0); return geometry;
    }
    const sourceGeometry = makeGeometry(new THREE.BufferAttribute(packet.indices, 1));
    let dynamicGeometry = null, drawIndex = null, blocks = new Map(), capacity = 0, stableDirectFrames = 0;
    const material = new THREE.ShaderMaterial({
      vertexShader:surfaceVertex, fragmentShader:surfaceFragment, depthTest:false, depthWrite:false, side:THREE.DoubleSide,
      defines:style==='country'?{COUNTRY_PALETTE:1}:style==='lake'?{HYDRO_PALETTE:1}:{},
      uniforms:{...cameraUniforms, surfaceColor:{value:new THREE.Color(color)}, objectColors:{value:texture},
        objectSize:{value:new THREE.Vector2(countryWidth, countryHeight)}, minZoom:{value:minZoom}, ...hydroUniforms},
    });
    const parts = (packet.drawParts??[{packet, index:packet.spatial, offset:0}]).map(row => ({...row,
      selection:createGlobeSpatialSelection(row.packet, row.index),
      ownerRevision:style==='country'?localOwnerRevision(row.packet.slots, countrySlotRevisions, () => countryVisibilityRevision):() => 0,
    }));
    const primitiveCount = packet.indices.length/3;
    const mesh = createGlobeMesh(THREE, sourceGeometry, [material], order);
    let priorSelection = new Uint32Array(), submitted = 0, visibleLeaves = 0, totalLeaves = parts.reduce((sum, row) => sum+row.index.leafCount, 0), activeCalls = 0;
    function releaseDynamic() {
      if (!dynamicGeometry)return;
      for (const key of Object.keys(attributes))dynamicGeometry.deleteAttribute(key);
      dynamicGeometry.dispose(); dynamicGeometry = null; drawIndex = null;
      blocks.clear(); capacity = 0; residencyDirty = true; refreshMeshLedger();
    }
    function setGroups(geometry, groups) {
      geometry.clearGroups(); for (const row of groups)geometry.addGroup(row.start, row.count, 0);
      geometry.setDrawRange(0, Infinity); activeCalls = groups.length;
    }
    function prepareDynamic(ranges, stats) {
      const selected = splitGlobeDrawRanges(ranges, primitiveCount);
      let needed = 0, layoutChanged = !dynamicGeometry;
      const next = new Map(), writes = [];
      for (const row of selected) {
        const old = blocks.get(row.id), cap = globeDrawCapacity(old?.capacity??0, row.count, row.limit);
        const entry = {...row, capacity:cap, offset:needed};
        needed+=cap; next.set(row.id, entry);
        if (!old||old.capacity!==cap||old.offset!==entry.offset)layoutChanged = true;
      }
      if (next.size!==blocks.size||needed!==capacity)layoutChanged = true;
      if (layoutChanged) {
        const replacement = residency.withTemporary(needed*12*2,'gpu-index-growth', () => {
          const index = new THREE.BufferAttribute(new Uint32Array(needed*3), 1).setUsage(THREE.DynamicDrawUsage);
          return {geometry:makeGeometry(index), index};
        });
        releaseDynamic();
        dynamicGeometry = replacement.geometry; drawIndex = replacement.index; capacity = needed;
      }
      for (const row of next.values()) {
        const old = layoutChanged?null:blocks.get(row.id);
        for (const write of planGlobeCompactionUpdates(row.ranges, old?.ranges)) {
          writes.push({...write, offset:write.offset+row.offset});
        }
      }
      stats.compactionUploadBytes+=copyGlobeDrawWrites(drawIndex, packet.indices, writes, 3);
      blocks = next; mesh.geometry = dynamicGeometry;
      setGroups(dynamicGeometry, globeDrawGroups([...blocks.values()]));
      stats.rewrittenBlocks+=new Set(writes.map(write => Math.floor(write.first/Math.max(1,primitiveCount<=32768?primitiveCount:Math.max(16384,Math.ceil(primitiveCount/4)))))).size;
    }
    const resource = spatialResource([mesh], material, (getCuller, currentZoom, stats) => {
      const cull = currentZoom>=minZoom?getCuller(0):admitNone;
      let changed = false, count = 0, leaves = 0;
      const selections = parts.map(row => {
        const selected = row.selection.select(cull, row.ownerRevision(), style==='country'?countryOwnerVisible:null);
        changed||=selected.changed; count+=selected.count; leaves+=selected.leaves;
        return {ranges:selected.ranges, offset:row.offset};
      });
      if (changed) {
        const {ranges} = mergeGlobeDrawRanges(selections);
        priorSelection = ranges; submitted = count; visibleLeaves = leaves; residencyDirty = true;
        if (!count) {activeCalls = 0; mesh.visible = false;}
        else if (ranges.length<=4) {
          mesh.geometry = sourceGeometry;
          const groups = []; for (let i = 0; i<ranges.length; i+=2)groups.push({start:ranges[i]*3, count:(ranges[i+1]-ranges[i])*3});
          setGroups(sourceGeometry, groups);
        }else {
          stableDirectFrames = 0; prepareDynamic(ranges, stats);
        }
      }
      if (mesh.geometry===sourceGeometry&&dynamicGeometry&&++stableDirectFrames>=16) {releaseDynamic(); stableDirectFrames = 0;}
      mesh.visible = submitted>0;
      stats.triangles+=primitiveCount; stats.ranges+=totalLeaves; stats.submittedTriangles+=submitted; stats.visibleRanges+=visibleLeaves;
      stats.meshDrawCalls+=activeCalls;
      if (mesh.geometry===sourceGeometry&&submitted)stats.immutableIndexTriangles+=submitted;
    }, [], packet, {geometries:() => [sourceGeometry, ...(dynamicGeometry?[dynamicGeometry]:[])],
      workspace:() => [priorSelection, ...[...blocks.values()].map(row => row.ranges), ...parts.flatMap(row => row.selection.footprint())]});
    if (name)addLayer(name, resource);
    return resource;
  }
  function registerGpuGroups(rows, role, compatibility, create) {
    return groupGlobeGpuMeshes(rows, compatibility).map(group => {
      const resource = useMesh(role, group.key, () => {
        const packet = group.rows.length===1?group.rows[0].mesh.packet:
          residency.withTemporary(group.vertices*52+group.triangles*24,'gpu-mesh-batch', () => combineGlobeDrawMeshes(group.rows));
        return create(packet, group.rows[0]);
      });
      return {resource, rows:group.rows};
    });
  }
  if (packets.countries)register('objects', packets.countries, palette.defaultLand, 1, -2,'country');
  const multisampling = Boolean(context.getContextAttributes().antialias);
  const riverStyle = { ...palette.strokes.river, color: palette.ocean };
  const riverMesh = (packet, minZoom) => spatialStrokes(packet, {order:3, minZoom, strokeKind:'river',
    style:riverStyle, cameraUniforms, viewport, margin, multisampling, hydroUniforms});
  function attachRiverDetail(row, packet) {
    const resource = riverMesh(packet, row.minZoom);
    const order = Math.max(0, row.order??0); resource.setOrder(4+.49*order/(order+1));
    resource.externalOwner = true;
    return {residentBytes:renderFootprintBytes(resource.footprint()), footprint:resource.footprint, setVisible:visible => {resource.visible = visible;}, dispose:() => resource.dispose()};
  }
  const countryStrokeStyle = {...palette.strokes.country};
  const strokeOptions = {style:countryStrokeStyle, cameraUniforms, viewport, margin, multisampling, strokeKind:'country'};
  let graticule = null, graticuleVisible = true;
  function installGraticule(packet) {
    if (graticule)return;
    graticule = spatialStrokes(packet, {...strokeOptions, order:5.5,
      multisampling:false, strokeKind:null, style:{color:'#aaaaaa', width:0.55, opacity:0.34}});
    addLayer('graticule', graticule); graticule.visible = graticuleVisible;
  }
  if (packets.graticule)installGraticule(packets.graticule);
  function useMesh(role, identity, prepare) {
    const key = role+':'+identity;
    const existing = touchRenderCache(residentMeshes, key);
    if (existing)return existing.mesh;
    const mesh = prepare();
    // Buffer attributes retain their CPU arrays alongside the device copy.
    const bytes = renderFootprintBytes(mesh.footprint());
    residentMeshes.set(key, {mesh, bytes}); meshResidentBytes+=bytes; residencyDirty = true;
    return mesh;
  }
  function activatePhysicalContext(parts) {
    if (activePhysical===parts)return;
    residencyDirty = true;
    const previous = new Set(Object.values(physicalLayers??{}).flat());
    const waterGroups = registerGpuGroups(parts.waters,'water', row => row.id, packet => register(null, packet, palette.ocean, 2));
    const lakeGroups = registerGpuGroups(parts.lakes,'lake', row => String(row.minZoom), (packet, row) => register(null, packet, palette.ocean, 2, row.minZoom,'lake'));
    physicalLayers = {
      waters:waterGroups.map(({resource}, i) => {resource.setOrder(1.6+.3*i/Math.max(1,waterGroups.length));return resource;}),
      lakes:lakeGroups.map(({resource}, i) => {resource.setOrder(2+.9*i/Math.max(1,lakeGroups.length));return resource;}),
      rivers:parts.riverChunks.map((row, i, rows) => {
        const resource = useMesh('river', row.key, () => riverMesh(row.packet, row.minZoom)); resource.setOrder(3+.9*i/Math.max(1,rows.length));return resource;
      }),
    };
    waterMeshes = new Map();
    waterGroups.forEach(({rows, resource}) => {const id = rows[0].id; let group = waterMeshes.get(id); if (!group) {group = []; waterMeshes.set(id, group);}group.push(resource);});
    activePhysical = parts; waterPaintDirty = true;
    for (const [role, meshes] of Object.entries(physicalLayers))for (const mesh of meshes) {mesh.visible = visibleLayers[role]!==false; previous.delete(mesh);}
    for (const mesh of previous)mesh.visible = false;
  }
  function setHydroPaint(slots, waters, styles, color) {
    for (const slot of new Set([...previousHydro.keys(), ...slots.keys()])) {
      const next = slots.get(slot)??0;
      if (hydroBytes[slot]!==next) {hydroBytes[slot] = next; hydroDirtySlots.add(slot);}
    }
    previousHydro = slots;
    hydroUniforms.hasHydroHighlight.value = slots.size>0;
    if (color)hydroTint.set(color);
    for (const [code, style] of styles.entries())hydroStyles[code].set(style.width, style.alpha, style.fillAlpha??0);
    const fills = styles.map(row => row?.fillAlpha??0), tint = hydroTint.getHex();
    const allWater = waterPaintDirty||tint!==previousWaterTint||fills.length!==previousWaterStyles.length||fills.some((value, i) => value!==previousWaterStyles[i]);
    const changed = allWater?waterMeshes.keys():new Set([...previousWaters.keys(), ...waters.keys()].filter(id => previousWaters.get(id)!==waters.get(id)));
    for (const id of changed) {
      const fill = styles[waters.get(id)??0]?.fillAlpha??0;
      for (const mesh of waterMeshes.get(id)??[])mesh.material.uniforms.surfaceColor.value.set(palette.ocean).lerp(hydroTint, fill);
    }
    previousWaters = waters; previousWaterTint = tint; previousWaterStyles = fills; waterPaintDirty = false;
  }
  function flushHydroPaint() {
    if (!hydroDirtySlots.size)return;
    const rects = globeHydroTextureRects(hydroDirtySlots, hydroWidth);
    hydroDirtySlots.clear();
    if (!hydroUploaded)return; // initial/restore upload reads the current CPU buffer
    const area = rects.reduce((sum, row) => sum+row.width*row.height, 0);
    if (rects.length>64||area>=hydroBytes.length*.6||!renderer.copyTextureToTexture) {
      hydroUploaded = false; hydroTexture.needsUpdate = true; return;
    }
    // RedFormat is one component; Three.js generic updateRanges assumes
    // RGBA, so use its supported CPU rectangular copy path instead.
    hydroCopier.copy(hydroTexture, rects, pixels => {hydroUploadStats.partialUploads++; hydroUploadStats.partialBytes+=pixels;});
  }
  const borderBytes = new Uint8Array(Math.max(1, packets.borderGroupCount)).fill(255);

  let baseBordersInstalled = false;
  function installBaseBorders(packet) {
    if (baseBordersInstalled)return;
    if (packet.count) {
      const resource = spatialStrokes(packet, {...strokeOptions, order:5, baseBorder:true});
      addLayer('borders', resource); resource.visible = showBorders;
    }
    baseBordersInstalled = true;
  }
  if (packets.borders)installBaseBorders(packets.borders);

  const outlineCache = new Map();
  let paintedOutlines = new Set();
  function installOutlines(key, data, {slot = null, order = 0, count = 1} = {}) {
    if (outlineCache.has(key))return;
    const outline = createGlobeOutlineCache(THREE, {scene, ...data, strokeOptions, maxTextureSize:maxPointTextureSize,
      orderForChunk:(part, parts) => 6+.9*((slot===null?0:slot+1)+(order+(part+1)/(parts+1))/Math.max(1,count))/(countryCount+1),
      residency, onResidencyChange:() => {dirtyOutlineOwners.set(outline, key);}});
    outlineCache.set(key, outline); dirtyOutlineOwners.set(outline, key);
  }
  function setOutlinePaint(requested, styles, color) {
    const targets = new Map();
    for (const [key, roles] of requested) {
      const target = touchRenderCache(outlineCache, key); if (target)targets.set(target, roles);
    }
    for (const target of paintedOutlines)if (!targets.has(target))target.hide();
    paintedOutlines = new Set([...targets].filter(([target, local]) => target.paint(local, styles, color)).map(([target]) => target));
  }
  function setPalette(next) {
    if (!next)return;
    if (palette.ocean!==next.ocean) {renderer.setClearColor(next.ocean); waterPaintDirty = true;
      for (const resource of physicalLayers?.lakes??[])resource.material.uniforms.surfaceColor.value.set(next.ocean);}
    const styles = {country:next.strokes.country, river:{...next.strokes.river, color:next.ocean}};
    for (const [kind, target] of [['country', countryStrokeStyle], ['river', riverStyle]]) {
      const value = styles[kind];
      if (target.width===value.width&&target.color===value.color&&target.alpha===value.alpha&&target.opacity===value.opacity)continue;
      Object.assign(target, value);
      for (const resource of strokeResources[kind])resource.setStrokeStyle(target);
    }
    if (palette.labels.text!==next.labels.text||palette.labels.halo!==next.labels.halo)labels.setPalette(next.labels);
    palette = next;
  }
  function activateTerritorialChunks(view, rows) {
    if (activeTerritoryInput===rows&&view===activeView)return;
    residencyDirty = true;
    // Reconcile resources by stable chunk identity. Do not toggle unchanged
    // meshes on every camera plan or temporal metadata update.
    const previous = new Set([...activeBase, ...activeBorders]);
    const countries = rows.filter(row => row.role==='country'), borders = rows.filter(row => row.role==='border');
    const groups = registerGpuGroups(countries,'territory', () => 'country', packet => register(null, packet, palette.defaultLand, 1, -2,'country'));
    activeBase = groups.map(({resource}, i) => {
      resource.setOrder(1+.5*i/Math.max(1,groups.length));resource.visible=true;previous.delete(resource);return resource;
    });
    activeBorders = borders.map((row, i) => {
      const resource = useMesh('border', row.key, () => spatialStrokes(row.packet, {...strokeOptions, order:5, baseBorder:row.baseBorder===true}));
      resource.setOrder(5+.4*i/Math.max(1,borders.length),.4/Math.max(1,borders.length));resource.visible=showBorders;
      previous.delete(resource); return resource;
    });
    for (const resource of previous)resource.visible = false;
    activeTerritoryInput = rows;
    if (view!==activeView) {
      activeView = view;
      const hidden = new Set(view?.hiddenBorders??[]);
      for (let slot = 0; slot<borderBytes.length; slot++) {
        const next = hidden.has(slot)?0:255;
        if (borderBytes[slot]!==next) {borderBytes[slot] = next; borderSlotRevisions[slot] = ++borderVisibilityRevision;}
      }
    }
  }

  // Only called after successful visual publication. Never dispose the
  // previously published scene while a replacement is still being drawn.
  function activeMeshesNow() {return new Set([...activeBase, ...activeBorders, ...Object.values(physicalLayers??{}).flat()]);}
  function evictMesh(key, entry) {
    if (residentMeshes.get(key)!==entry)return;
    residentMeshes.delete(key); meshResidentBytes-=entry.bytes; entry.mesh.dispose();
  }
  function meshMemoryEntries() {
    const rows = [], protectedMeshes = activeMeshesNow(), owned = new Set();
    for (const [key, entry] of residentMeshes) {
      owned.add(entry.mesh);
      rows.push({key:entry.mesh, ...entry.mesh.footprint(), lastUsed:entry.mesh.lastUsed, protected:protectedMeshes.has(entry.mesh), evict:() => evictMesh(key, entry)});
    }
    for (const resource of spatialResources)if (!owned.has(resource)&&!resource.outlineOwner&&!resource.externalOwner)rows.push({key:resource, ...resource.footprint(), protected:true});
    rows.push({key:channels, buffers:renderPacketBuffers([channels, countryVisible, hydroBytes, borderBytes, countrySlotRevisions, borderSlotRevisions]), extraBytes:channels.byteLength+hydroBytes.byteLength, protected:true});
    return rows;
  }
  refreshMeshLedger = residency.register(meshMemoryEntries); refreshLabelLedger = residency.register(labels.memoryEntries);
  function evictOutline(slot, entry) {
    if (outlineCache.get(slot)!==entry)return;
    outlineCache.delete(slot); dirtyOutlineOwners.delete(entry); entry.dispose(); dirtyOutlineOwners.delete(entry);
  }
  function trimResidency() {
    const labelsChanged = labels.trim();
    if (labelsChanged)refreshLabelLedger();
    const meshChanged = residencyDirty, outlineChanged = dirtyOutlineOwners.size>0;
    if (meshChanged) {
      residencyDirty = false;
      const activeMeshes = activeMeshesNow(), protectedMeshes = new Set();
      meshResidentBytes = 0;
      for (const [key, entry] of residentMeshes) {
        if (activeMeshes.has(entry.mesh))protectedMeshes.add(key);
        entry.bytes = renderFootprintBytes(entry.mesh.footprint()); meshResidentBytes+=entry.bytes;
      }
      meshResidentBytes = trimRenderCache(residentMeshes, protectedMeshes, cacheBudget.residentMeshBytes,
        entry => entry.bytes, (_key, entry) => entry.mesh.dispose(), {entryLimit:512, residentBytes:meshResidentBytes});
      refreshMeshLedger();
    }
    for (const [entry, slot] of dirtyOutlineOwners) {
      if (outlineCache.get(slot)===entry)entry.syncResidency({active:paintedOutlines.has(entry), evict:() => evictOutline(slot, entry)});
    }
    dirtyOutlineOwners.clear();
    return labelsChanged||meshChanged||outlineChanged;
  }
  function cacheStats() {
    const outlineChunks = {residentChunks:0, visibleChunks:0, activeChunks:0, evictedChunks:0, createdChunks:0, shrunkBuffers:0, updatedChunks:0, subsetHits:0, subsetBuilds:0};
    let outlineResidentBytes = 0;
    for (const entry of outlineCache.values()) {
      outlineResidentBytes+=entry.bytes();
      for (const [key, value] of Object.entries(entry.stats()))outlineChunks[key]+=value;
    }
    return {meshes:residentMeshes.size, meshResidentBytes, outlines:outlineCache.size, outlineResidentBytes, outlineChunks};
  }

  function resize(width, height, dpr) {
    viewport.value.set(width, height);
    margin.value = 0.5 / dpr;
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false);
  }
  function prepareLabels(globeCamera, width, height, requireComplete = false) {
    const complete = labels.update(globeCamera, width, height, createGlobeRangeCuller(globeCamera.frame, width, height), requireComplete);
    refreshLabelLedger(); return complete;
  }
  function draw(globeCamera, width, height) {
    const {frame, view} = globeCamera;
    zoom.value = view.zoom;
    eyeHigh.fromArray(frame.eye.map(Math.fround));
    eyeLow.set(frame.eye[0] - eyeHigh.x, frame.eye[1] - eyeHigh.y, frame.eye[2] - eyeHigh.z);
    viewRotation.set(...frame.right, ...frame.up, ...frame.forward.map(value => -value));
    camera.near = frame.distance * 0.01;
    camera.far = frame.distance + 4;
    camera.setViewOffset(width, height, width / 2 - frame.center[0], height / 2 - frame.center[1], width, height);
    if (globeCamera!==cullingCamera||width!==cullingWidth||height!==cullingHeight) {
      cullingCamera = globeCamera; cullingWidth = width; cullingHeight = height; cullers = new Map();
    }
    const getCuller = padding => {
      if (!cullers.has(padding))cullers.set(padding, createGlobeRangeCuller(frame, width, height, padding));
      return cullers.get(padding);
    };
    flushCountryPaint(); flushHydroPaint();
    const stats = {triangles:0, submittedTriangles:0, segments:0, submittedSegments:0, ranges:0, visibleRanges:0, strokeBatches:0, strokeDrawCalls:0, directStrokeSegments:0, compactionUploadBytes:0, meshDrawCalls:0, immutableIndexTriangles:0, rewrittenBlocks:0};
    for (const resource of activeSpatialResources)resource.update(getCuller, view.zoom, stats);
    for (const outline of paintedOutlines)outline.update(getCuller, strokePadding, stats);
    spatialStats = stats;
    renderer.render(scene, camera); return true;
  }
  function dispose() {
    labels.dispose();
    for (const entry of outlineCache.values())entry.dispose();
    outlineCache.clear(); paintedOutlines.clear(); dirtyOutlineOwners.clear(); residentMeshes.clear(); meshResidentBytes = 0;
    refreshMeshLedger.dispose(); refreshLabelLedger.dispose();
    for (const resource of [...spatialResources])resource.dispose();
    layers.clear(); waterMeshes.clear(); activeBorders = []; activeBase = []; activeTerritoryInput = null; physicalLayers = activePhysical = null; graticule = null;
    texture.dispose(); hydroTexture.dispose(); hydroCopier.dispose();
    renderer.dispose();
  }
  return Object.freeze({resize, draw, setPalette, setCountryPaint, restoreCountryPaint, installGraticule, hasGraticule:() => graticule!==null, installBaseBorders, hasBaseBorders:() => baseBordersInstalled, installOutlines, hasOutlines:slot => outlineCache.has(slot), setOutlinePaint, setHydroPaint, setLayerVisibility, attachRiverDetail, activateTerritorialChunks, activatePhysicalContext, prepareLabels, trimResidency, cacheStats, labels, dispose,
    drawCalls:() => renderer.info.render.calls, hydroUploadStats:() => ({...hydroUploadStats}), spatialStats:() => ({...spatialStats})});
}
