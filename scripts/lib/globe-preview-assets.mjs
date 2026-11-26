import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { gzipSync, gunzipSync } from 'node:zlib';
import { globeVector } from '../../src/rendering/globe-camera.js';
import {encodeGlobeHistoricalViews} from '../../src/rendering/globe-history-index.js';
import {globeSpatialPrimitiveOrder,globePrimitiveBounds,globePrimitiveOwner} from '../../src/rendering/globe-spatial-partition.js';
import { decodeGlobeMesh, decodeGlobeStrokes, packGlobeMesh, GLOBE_MESH_HEADER_BYTES, GLOBE_MESH_MAGIC,
  createGlobeStrokePointTable, encodeIndexedGlobeStrokes, globeTerritoryKey } from '../../src/rendering/globe-mesh.js';
import { decodePolygonMesh } from '../../src/rendering/polygon-mesh-codec.js';
import { applyPreparedMeshDelta, preparedMeshDeltaLayout } from '../../src/data/prepared-mesh-delta.js';
import { loadPhysicalLandGeometry, selectPhysicalLandAsset } from '../../src/data/physical-land-patch.js';
import { decodeHydroIndex, decodeHydroMetadata, decodeHydroPack } from '../../src/data/hydro-pack.js';
import { hydroDisplayStages } from '../../src/map/map-display-zoom.js';
import { readBuiltinGeometryRows } from './builtin-geometry-packs.mjs';
import { validateBuiltinReadIndex } from '../../src/data/builtin-country-files.js';
import { resolveBuiltinWorldGeometry } from '../../src/data/builtin-world-loader.js';
import { compareTemporalKeys, parseTemporal, temporalFollowingDay } from '../../src/document/temporal.js';
import { coordinateBounds } from '../../src/geometry/coordinate-bounds.js';
import { multiCoordinates } from '../../src/geometry/polygon-geometry-utils.js';
import { territorialLabelShortSide } from '../../src/rendering/label-layout.js';
import { buildRenderableBoundarySegments, densifyBoundarySegmentsForProjection, normalizeLongitudeNear } from '../../src/geometry/geographic-boundary.js';
import { createCountrySharedBoundaryState } from '../../src/rendering/country-shared-boundary-state.js';
import { createCountryBoundaryOutput } from '../../src/rendering/country-boundary-output.js';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const archivePath = url => url.startsWith('assets/data/') ? url : 'assets/data/' + url;
const toBuffer = value => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);

export function buildGlobeSkeleton(land, d3Source) {
  const context = {};
  runInNewContext(String(d3Source), context);
  const geo = context.d3.geo;
  const size = 768, radius = size / 2;
  const projection = geo.orthographic().rotate([-15, -12]).clipAngle(90)
    .translate([radius, radius]).scale(radius).precision(0.25);
  const coordinates = land.coordinates.map(rings =>
    geo.area({type: 'Polygon', coordinates: [rings[0]]}) > 2 * Math.PI
      ? rings.map(ring => ring.slice().reverse()) : rings);
  let ring = [];
  const paths = [];
  const drawing = {
    moveTo(x, y) {
      ring = [[Math.round(x), Math.round(y)]];
    },
    lineTo(x, y) {
      const point = [Math.round(x), Math.round(y)], previous = ring.at(-1);
      if (point[0] === previous[0] && point[1] === previous[1]) return;
      // Preserve shared edges. Only collapse a point on the same straight segment.
      const start = ring.at(-2);
      if (start) {
        const dx = previous[0] - start[0], dy = previous[1] - start[1];
        const nextX = point[0] - previous[0], nextY = point[1] - previous[1];
        if (dx * nextY === dy * nextX && dx * nextX + dy * nextY > 0) {
          ring[ring.length - 1] = point;
          return;
        }
      }
      ring.push(point);
    },
    closePath() {
      if (ring.length < 3) return;
      const offsets = ring.slice(1).map(([x, y], index) => [x - ring[index][0], y - ring[index][1]].join(','));
      paths.push(`M${ring[0]}l${offsets.join(' ')}Z`);
    },
  };
  geo.path().projection(projection).context(drawing)({type: 'MultiPolygon', coordinates});
  return {size,path:paths.join('')};
}

function writePosition(high, low, offset, longitude, latitude) {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(latitude) > 90) throw new Error('Invalid globe mesh coordinate');
  const vector = globeVector([longitude, latitude]);
  for (let axis = 0; axis < 3; axis++) {
    const index = offset + axis;
    high[index] = vector[axis];
    low[index] = vector[axis] - high[index];
  }
}

export function encodeGlobeMesh({ coordinates, indices, slots = new Uint16Array(0), units = 1 }) {
  const vertexCount = coordinates.length / 2;
  if (!Number.isInteger(vertexCount) || !(indices instanceof Uint32Array) || !(slots instanceof Uint16Array)) {
    throw new Error('Invalid globe mesh input');
  }
  const buffer = new ArrayBuffer(GLOBE_MESH_HEADER_BYTES + vertexCount * 24 + indices.byteLength + slots.byteLength);
  const header = new DataView(buffer);
  [GLOBE_MESH_MAGIC, vertexCount, indices.length, slots.length].forEach((value, index) => header.setUint32(index * 4, value, true));
  const offset = GLOBE_MESH_HEADER_BYTES + vertexCount * 24;
  new Uint32Array(buffer, offset, indices.length).set(indices);
  new Uint16Array(buffer, offset + indices.byteLength, slots.length).set(slots);
  const mesh = decodeGlobeMesh(buffer);
  for (let i = 0; i < vertexCount; i++) {
    writePosition(mesh.positions, mesh.residuals, i * 3, coordinates[i * 2] * units, coordinates[i * 2 + 1] * units);
  }
  return buffer;
}

export function combineGlobeCountryMeshes(rows,{slotOffset=0}={}) {
  const vertices = new Float64Array(rows.reduce((count, row) => count + row.vertices.length, 0));
  const indices = new Uint32Array(rows.reduce((count, row) => count + row.indices.length, 0));
  const slots = new Uint16Array(vertices.length / 2);
  let vertexOffset = 0, first = 0;
  const countrySlots = rows.map(({ id, geometry, vertices: points, indices: triangles, units = 1 }, index) => {
    const slot=index+slotOffset;
    const count = triangles.length;
    if (slot > 65535 || points.length % 2 || count % 3) throw Error('Invalid resolved territorial mesh layout');
    for (let i = 0; i < points.length; i++) vertices[vertexOffset * 2 + i] = points[i] * units;
    for (let i = 0; i < count; i++) {
      if (triangles[i] >= points.length / 2) throw Error('Invalid resolved territorial mesh index');
      indices[first + i] = vertexOffset + triangles[i];
    }
    const nextVertex = vertexOffset + points.length / 2;
    slots.fill(slot, vertexOffset, nextVertex);
    const result = { id, geometry, first, count };
    first += count;
    vertexOffset = nextVertex;
    return result;
  });
  return { countrySlots, buffer: encodeGlobeMesh({ coordinates: vertices, indices, slots }) };
}

const emptyChunkBounds=()=>[Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity];
// Spatially sort the primitives, retaining distinct owner runs in their
// original painter order when their displayed colors can differ. A large
// primitive may itself exceed the span; isolate it instead of weakening
// the spatial rule for every following primitive.
export function* globeSpatialChunkRanges(packet,{maxPrimitives=65_536,span=.45,preserveOwnerOrder=true}={}){
  const order=globeSpatialPrimitiveOrder(packet,{preserveOwnerOrder});
  let first=0,bounds=emptyChunkBounds();
  const primitive=emptyChunkBounds();
  const descriptor=(end)=>{
    const center=[0,1,2].map(axis=>(bounds[axis]+bounds[axis+3])/2);
    const cell=center.map(value=>Math.max(0,Math.min(7,Math.floor((value+1)*4)))).join(':');
    return {ids:order.subarray(first,end),bounds,first,end,cell};
  };
  for(let i=0;i<order.length;i++){
    globePrimitiveBounds(packet,order[i],primitive);
    let extent=0;
    for(let axis=0;axis<3;axis++)extent=Math.max(extent,Math.max(bounds[axis+3],primitive[axis+3])-Math.min(bounds[axis],primitive[axis]));
    if(i>first&&(i-first>=maxPrimitives||extent>span)){
      yield descriptor(i);first=i;bounds=emptyChunkBounds();
    }
    for(let axis=0;axis<3;axis++){
      bounds[axis]=Math.min(bounds[axis],primitive[axis]);bounds[axis+3]=Math.max(bounds[axis+3],primitive[axis+3]);
    }
  }
  if(first<order.length)yield descriptor(order.length);
}
export function* globeMeshChunks(buffer,{maxTriangles=65_536,span=.45}={}){
  const mesh=decodeGlobeMesh(buffer),{positions,residuals,indices,slots}=mesh;
  const oldHigh=new Uint32Array(positions.buffer,positions.byteOffset,positions.length),oldLow=new Uint32Array(residuals.buffer,residuals.byteOffset,residuals.length);
  for(const {ids,bounds,first,end,cell} of globeSpatialChunkRanges(mesh,{maxPrimitives:maxTriangles,span})){
    const remap=new Map(),vertices=[],local=new Uint32Array(ids.length*3);
    let at=0;
    for(const triangle of ids)for(let i=triangle*3;i<triangle*3+3;i++){
      const old=indices[i];let id=remap.get(old);
      if(id===undefined){id=vertices.length;remap.set(old,id);vertices.push(old);}
      local[at++]=id;
    }
    const count=vertices.length,slotCount=slots.length?count:0;
    const result=new ArrayBuffer(GLOBE_MESH_HEADER_BYTES+count*24+local.byteLength+slotCount*2);
    const header=new DataView(result);
    [GLOBE_MESH_MAGIC,count,local.length,slotCount].forEach((value,i)=>header.setUint32(i*4,value,true));
    const high=new Uint32Array(result,GLOBE_MESH_HEADER_BYTES,count*3),low=new Uint32Array(result,GLOBE_MESH_HEADER_BYTES+count*12,count*3);
    const localSlots=new Uint16Array(result,GLOBE_MESH_HEADER_BYTES+count*24+local.byteLength,slotCount),owners=new Set();
    for(let i=0;i<count;i++){
      const vertex=vertices[i];
      for(let axis=0;axis<3;axis++){high[i*3+axis]=oldHigh[vertex*3+axis];low[i*3+axis]=oldLow[vertex*3+axis];}
      if(slotCount){localSlots[i]=slots[vertex];owners.add(slots[vertex]);}
    }
    new Uint32Array(result,GLOBE_MESH_HEADER_BYTES+count*24,local.length).set(local);
    yield {buffer:result,bounds,first,end,cell,slots:[...owners].sort((a,b)=>a-b)};
  }
}
export function* globeStrokeChunks(buffer,{maxSegments=65_536,span=.45,preserveOwnerOrder=true}={}){
  const packet=decodeGlobeStrokes(buffer);
  const sourceWords=new Uint32Array(packet.points.buffer,packet.points.byteOffset,packet.points.length);
  for(const {ids,bounds,first,end,cell} of globeSpatialChunkRanges(packet,{maxPrimitives:maxSegments,span,preserveOwnerOrder})){
    const table=createGlobeStrokePointTable(ids.length*2),remap=new Map(),owners=new Set();
    const endpointIndices=new Uint32Array(ids.length*2),widths=new Float32Array(packet.widths.length?ids.length:0),ownerGroups=new Uint16Array(packet.ownerGroups.length?ids.length:0);
    let maxWidth=1;
    for(let i=0;i<ids.length;i++){
      const segment=ids[i];
      for(let side=0;side<2;side++){
        const old=packet.endpointIndices[segment*2+side];
        let local=remap.get(old);
        if(local===undefined){local=table.intern(sourceWords,old*6);remap.set(old,local);}
        endpointIndices[i*2+side]=local;
      }
      if(widths.length){widths[i]=packet.widths[segment];maxWidth=Math.max(maxWidth,widths[i]);}
      if(ownerGroups.length){ownerGroups[i]=packet.ownerGroups[segment];owners.add(ownerGroups[i]);}
    }
    yield {buffer:encodeIndexedGlobeStrokes({count:ids.length,points:table.finish(),endpointIndices,widths,ownerGroups}),
      bounds,first,end,cell,maxWidth,slots:[...owners].sort((a,b)=>a-b)};
  }
}

export function globeHistoryMonths(current,...recordSets){
  const months=new Set(['-999999-01',current]);
  const add=([year,month])=>{
    if(year>999999)return; // Core's exclusive upper sentinel is outside the public calendar.
    const prefix=year<0?'-':year>9999?'+':'';
    months.add(`${prefix}${String(Math.abs(year)).padStart(4,'0')}-${String(month).padStart(2,'0')}`);
  };
  for(const records of recordSets)for(const {validFrom,validTo} of [...records.lifetimes,...records.geometryBindings]){
    if(validFrom)add(parseTemporal(validFrom).startKey);
    if(validTo)add(temporalFollowingDay(parseTemporal(validTo).endKey));
  }
  return [...months].map(value=>parseTemporal(value)).sort((a,b)=>compareTemporalKeys(a.startKey,b.startKey)).map(row=>row.canonical);
}

export function encodeGlobeStrokes(coordinates, indices, widths = [], ownerGroups = new Uint16Array(0)) {
  const count=indices?indices.length/2:coordinates.length/4;
  if(!Number.isInteger(count)||(widths.length&&widths.length!==count)||(ownerGroups.length&&ownerGroups.length!==count))
    throw Error('Invalid globe stroke count');
  const table=createGlobeStrokePointTable(count*2),endpointIndices=new Uint32Array(count*2);
  const scratch=new Float32Array(6),words=new Uint32Array(scratch.buffer),high=scratch.subarray(0,3),low=scratch.subarray(3);
  for(let i=0;i<endpointIndices.length;i++){
    const at=(indices?indices[i]:i)*2;
    writePosition(high,low,0,coordinates[at],coordinates[at+1]);
    endpointIndices[i]=table.intern(words);
  }
  return encodeIndexedGlobeStrokes({count,points:table.finish(),endpointIndices,
    widths:Float32Array.from(widths),ownerGroups});
}

function buildGraticule(){
  const coordinates=[];
  for(let lon=-180;lon<180;lon+=10)for(let lat=-90;lat<90;lat+=2.5)
    coordinates.push(lon,lat,lon,lat+2.5);
  for(let lat=-80;lat<=80;lat+=10)for(let lon=-180;lon<180;lon+=2.5)
    coordinates.push(lon,lat,lon+2.5,lat);
  return encodeGlobeStrokes(coordinates);
}

export function buildGlobeOutlineStrokes(geometries,slotOffset=0) {
  const edgeIndex = new Map(), coordinates = [], edgeOwners = [];
  const pointKey = ([lon,lat]) => `${lon === 180 ? -180 : lon},${lat}`;
  for (const [index,geometry] of geometries.entries()) {
    const slot=index+slotOffset;
    const segments = densifyBoundarySegmentsForProjection(buildRenderableBoundarySegments(geometry));
    for (const [start,end] of segments) {
      const a = pointKey(start), b = pointKey(end);
      if(a===b)continue;
      const key = a < b ? `${a}/${b}` : `${b}/${a}`;
      const edge = edgeIndex.get(key);
      if (edge === undefined) {
        edgeIndex.set(key,edgeOwners.length);
        coordinates.push(...start,...end);
        edgeOwners.push([slot]);
      } else if (edgeOwners[edge].at(-1)!==slot) {
        edgeOwners[edge].push(slot);
      }
    }
  }
  const owners = [], groups = new Map();
  const ownerGroups = Uint16Array.from(edgeOwners, slots => {
    const key = slots.join(',');
    if (!groups.has(key)) {
      if (owners.length>65535) throw Error('Too many globe outline owner groups');
      groups.set(key,owners.length);
      owners.push(slots);
    }
    return groups.get(key);
  });
  return { buffer:encodeGlobeStrokes(coordinates,null,[],ownerGroups), owners };
}

function borderGroups(boundaries){
  const groups=new Map();
  for(const {start,end,ownerIds} of boundaries){
    const key=JSON.stringify(ownerIds);
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push([start,end]);
  }
  return [...groups].map(([key,segments])=>borderGroup(key,segments));
}

function borderGroup(key,segments){
  const rounded=point=>point.map(value=>Math.round(value*1e6)*1e-6);
  const compare=(a,b)=>a[0]-b[0]||a[1]-b[1]||(a.length===4&&(a[2]-b[2]||a[3]-b[3]))||0;
  const coordinates=densifyBoundarySegmentsForProjection(segments).map(([start,end])=>{
    const a=rounded(start),b=rounded(end);
    return compare(a,b)<=0?[...a,...b]:[...b,...a];
  }).sort(compare).flat();
  return {key,coordinates,hash:sha256(JSON.stringify(coordinates))};
}

function packBorders(groups,withOwners=false){
  const coordinates=[],owners=[];
  for(const {key,coordinates:points} of groups){
    const first=coordinates.length/4;
    for(const value of points)coordinates.push(value);
    const count=points.length/4;
    owners.push({ids:JSON.parse(key),first,count});
  }
  const slots=new Uint16Array(withOwners?coordinates.length/4:0);
  if(withOwners)owners.forEach(({first,count},slot)=>slots.fill(slot,first,first+count));
  return {buffer:encodeGlobeStrokes(coordinates,null,[],slots),owners};
}

function countryLabelMetadata(mesh, slots, anchors, features) {
  const {positions,residuals,indices}=mesh;
  const geometries=new Map(features.map(feature=>[feature.id,feature.geometry]));
  const point=index=>[0,1,2].map(axis=>positions[index*3+axis]+residuals[index*3+axis]);
  const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  return Object.fromEntries(slots.flatMap(({id,first,count})=>{
    const coordinate=anchors[id]?.coordinates;
    if(!coordinate||!count)return [];
    let area=0;
    for(let i=first;i<first+count;i+=3){
      const a=point(indices[i]),b=point(indices[i+1]),c=point(indices[i+2]);
      const cross=[b[1]*c[2]-b[2]*c[1],b[2]*c[0]-b[0]*c[2],b[0]*c[1]-b[1]*c[0]];
      area+=2*Math.atan2(Math.abs(dot(a,cross)),1+dot(a,b)+dot(b,c)+dot(c,a));
    }
    const components=multiCoordinates(geometries.get(id)).map(([exterior])=>coordinateBounds(exterior));
    return [[id,{coordinate,area,shortSide:territorialLabelShortSide(components,coordinate)}]];
  }));
}

export function buildGlobeRiverPackets(features,stages,slotFor){
  const basicStage=stages[0],base={coordinates:[],widths:[],slots:[]},detail=new Map();
  const byId=new Map(stages.map(stage=>[stage.id,stage]));
  for(const feature of features){
    const {properties,geometry}=feature,slot=slotFor?.(feature);
    const stage=byId.get(properties.stage);
    if(!stage)throw Error('Invalid river display stage');
    const parts=geometry.type==='LineString'?[geometry.coordinates]:geometry.coordinates;
    for(const [partIndex,points] of parts.entries()){
      const widths=properties.stroke_widths[partIndex];
      for(let index=1;index<points.length;index++){
        const a=points[index-1],b=points[index];
        const width=widths?(widths[index-1]+widths[index])/2:properties.stroke_width;
        let output=base;
        if(stage!==basicStage){
          const east=normalizeLongitudeNear(b[0],a[0]), middle=(east+a[0])/2;
          // This is storage partitioning only. Place each source segment in
          // one cell and retain its exact endpoints and width at cell seams.
          const degrees=stage.minZoom>=5?15:30;
          const column=Math.floor((((middle+180)%360+360)%360)/degrees);
          const row=Math.min(180/degrees-1,Math.floor(((a[1]+b[1])/2+90)/degrees));
          const id=`${stage.id}/${column}/${row}`;
          if(!detail.has(id))detail.set(id,{id,minZoom:stage.minZoom,bounds:[Infinity,Infinity,-Infinity,-Infinity],coordinates:[],widths:[],slots:[]});
          output=detail.get(id);
          const center=column*degrees-180+degrees/2;
          const left=normalizeLongitudeNear(a[0],center),right=normalizeLongitudeNear(b[0],left);
          const bounds=output.bounds;
          bounds[0]=Math.min(bounds[0],left,right);bounds[1]=Math.min(bounds[1],a[1],b[1]);
          bounds[2]=Math.max(bounds[2],left,right);bounds[3]=Math.max(bounds[3],a[1],b[1]);
        }
        output.coordinates.push(...a,...b);
        output.widths.push(Number.isFinite(width)?Math.max(.65,Math.min(width,3)):1);
        if(slot!==undefined)output.slots.push(slot);
      }
    }
  }
  const encode=({coordinates,widths,slots})=>encodeGlobeStrokes(coordinates,null,widths,Uint16Array.from(slots));
  return {base:encode(base),riverMinZoom:basicStage.minZoom,
    detail:[...detail.values()].map(({coordinates,widths,slots,...row})=>({...row,buffer:encode({coordinates,widths,slots})}))};
}

function readGlobeHydro({ hydro, hydroPath, readPinnedData, waterVisibility, slotFor }) {
  const resource = hydroPath.slice(0, hydroPath.lastIndexOf('/') + 1) + hydro.container.url;
  const bytes = readPinnedData(resource);
  if (bytes.length !== hydro.container.bytes || sha256(bytes) !== hydro.container.sha256) throw new Error('Globe hydro source integrity mismatch');
  const section = ({ offset, bytes: length, sha256: digest }) => {
    const result = bytes.subarray(offset, offset + length);
    if (result.length !== length || sha256(result) !== digest) throw new Error('Globe hydro section integrity mismatch');
    return result;
  };
  const { packSpecs } = decodeHydroIndex(gunzipSync(section(hydro.index)));
  const featureMetadata = decodeHydroMetadata(gunzipSync(section(hydro.metadata.core)));
  const stages = hydroDisplayStages(hydro.stages);
  const shards = new Map(hydro.shards.map(spec => [spec.id, section(spec)]));
  const lakesByZoom = new Map();
  function* activeRivers(){
    for (const pack of packSpecs.values()) {
      const compressed=shards.get(pack.shard).subarray(pack.offset,pack.offset+pack.length);
      for (const feature of decodeHydroPack(gunzipSync(compressed),pack.id,{featureMetadata,stages})) {
        if (!waterVisibility.isActive(feature.id))continue;
        const {category,min_zoom:zoom}=feature.properties;
        if(category!=='lake'){yield feature;continue;}
        if(!lakesByZoom.has(zoom))lakesByZoom.set(zoom,[]);
        lakesByZoom.get(zoom).push(feature);
      }
    }
  }
  return {...buildGlobeRiverPackets(activeRivers(),stages,slotFor),lakesByZoom};
}

export async function buildGlobePreviewAssets({ territorial, physical, prepared, hydro, hydroPath, month, readPinnedData, readPinnedDataBatch, readGeometryAssets,boundarySeed,computeLabelAnchor,d3Source }) {
  const { resolvePhysicalWaterObjects, physicalWaterContextKey, physicalWaterReferenceView } = await import('../../src/data/physical-water-model.js');
  const { timelineObjectKey } = await import('../../src/document/timeline-records.js');
  const assets = new Map();
  function source(spec) {
    if (spec.encoding !== 'gzip') throw new Error('Unexpected globe preview source encoding: ' + spec.url);
    const bytes = readPinnedData(archivePath(spec.url));
    if (bytes.length !== spec.compressedBytes || sha256(bytes) !== spec.sha256) throw new Error('Globe preview source integrity mismatch: ' + spec.url);
    const result = gunzipSync(bytes, { maxOutputLength: spec.decodedBytes });
    if (result.length !== spec.decodedBytes) throw new Error('Globe preview source size mismatch: ' + spec.url);
    return result;
  }
  function emit(decoded, directory = '', level = 3) {
    const bytes = gzipSync(new Uint8Array(decoded), { level });
    const digest = sha256(bytes);
    const url = 'assets/data/globe-preview/' + directory + 'sha256-' + digest + '.bin.gz';
    assets.set(url, bytes);
    return { url, sha256: digest, encoding: 'gzip', compressedBytes: bytes.length, decodedBytes: decoded.byteLength };
  }
  function preparedMeshSpec(geometry) {
    const digest = sha256(JSON.stringify([geometry.type, geometry.coordinates]));
    return prepared.meshes[digest];
  }
  function readCountryMeshInputs(features) {
    const specs = features.map(feature => preparedMeshSpec(feature.geometry));
    if (readPinnedDataBatch) {
      const paths = new Set();
      for (const spec of specs) {
        if (!spec) continue;
        const inputs = spec.storageLayout === preparedMeshDeltaLayout ? [spec.base, spec.replacement] : [spec];
        for (const input of inputs) paths.add(archivePath(input.url));
      }
      readPinnedDataBatch([...paths]);
    }
    return specs;
  }
  function preparedMesh(spec) {
    if (!spec) return null;
    let packet;
    if (spec.storageLayout === preparedMeshDeltaLayout) {
      const base = source(spec.base);
      if (sha256(base) !== spec.baseContentSha256) throw new Error('Invalid globe polygon delta base');
      packet = applyPreparedMeshDelta(toBuffer(base), toBuffer(source(spec.replacement)), { decodedBytes: spec.decodedBytes });
      if (sha256(new Uint8Array(packet)) !== spec.contentSha256) throw new Error('Invalid globe polygon delta result');
    } else {
      packet = toBuffer(source(spec));
    }
    return decodePolygonMesh(packet, { algorithmVersion: prepared.algorithmVersion, includeStrokeEndpoints: false });
  }
  const emitPackedMesh = (buffer, dir) => emit(packGlobeMesh(buffer), dir, 7);
  const emitMeshChunks=(buffer,dir='')=>{
    const rows=[];
    for(const {buffer:part,...row} of globeMeshChunks(buffer))rows.push({...row,spec:emitPackedMesh(part,dir)});
    return rows;
  };
  const emitStrokeChunks=(buffer,dir='',preserveOwnerOrder=true)=>{
    const rows=[];
    for(const {buffer:part,...row} of globeStrokeChunks(buffer,{preserveOwnerOrder}))rows.push({...row,spec:emit(part,dir)});
    return rows;
  };


  await import('../../src/rendering/workers/polygon-mesh-core.js');
  const engine = globalThis.PandoLabPolygonMeshCore;
  const physicalMesh=(geometry,id)=>{
    const packet=preparedMesh(preparedMeshSpec(geometry));
    if(packet)return packet;
    const mesh=engine.buildPolygonMeshFeatures([{id,geometry}],{validate:true});
    return {positions:Float64Array.from(mesh.positions,value=>value*1e-6),indices:mesh.triangleIndices};
  };
  const read=validateBuiltinReadIndex(territorial);
  const resolve=target=>resolveBuiltinWorldGeometry(territorial,read,target).sort((a,b)=>a.owner.localeCompare(b.owner));
  const baseRows=resolve(month);
  const features=readBuiltinGeometryRows(baseRows,readGeometryAssets);
  const countryMeshRow=(feature,spec)=>{
    const {id,version,contentSha256} = feature.asset;
    const geometry = {id,version,contentSha256};
    const packet = preparedMesh(spec);
    if (packet) return {id:feature.id,geometry,vertices:packet.positions,indices:packet.indices};
    const mesh = engine.buildPolygonMeshFeatures([feature],{validate:true});
    return {id:feature.id,geometry,vertices:mesh.positions,indices:mesh.triangleIndices,units:1e-6};
  };
  const baseMeshSpecs = readCountryMeshInputs(features);
  const preparedCountries = combineGlobeCountryMeshes(features.map((feature,index)=>countryMeshRow(feature,baseMeshSpecs[index])));
  const {countrySlots} = preparedCountries;
  const countryChunks=emitMeshChunks(preparedCountries.buffer,'countries/');
  const countryLabels = countryLabelMetadata(decodeGlobeMesh(preparedCountries.buffer),countrySlots,boundarySeed.spec.labelAnchors,features);
  const {buffer:outlineBuffer,owners:outlineOwners} = buildGlobeOutlineStrokes(features.map(feature=>feature.geometry));
  const outlines = emit(outlineBuffer,'outlines/');
  const readGeometry = async spec => JSON.parse(source(spec));
  const physicalContexts=new Map(),waterParts=new Map(),hydroParts=new Map();
  let skeleton;
  const hydroSlots=new Map(),hydroObjects=[];
  function hydroSlot(feature){
    const id=String(feature.id),bounds=feature.__awBounds;
    if(!hydroSlots.has(id)){
      if(hydroObjects.length>65535)throw Error('Too many Three.js hydro identities');
      hydroSlots.set(id,hydroObjects.length);
      const {category,layer_id,name,source,source_id,mainstem_name_ko,system_id}=feature.properties;
      hydroObjects.push({id,properties:{pandolab_id:id,category,layer_id,name,source,source_id,mainstem_name_ko,system_id},__awBounds:[...bounds]});
    }
    const slot=hydroSlots.get(id),saved=hydroObjects[slot].__awBounds;
    saved[0]=Math.min(saved[0],bounds[0]);saved[1]=Math.min(saved[1],bounds[1]);
    saved[2]=Math.max(saved[2],bounds[2]);saved[3]=Math.max(saved[3],bounds[3]);
    return slot;
  }
  const replacementIds=physical.waterObjects.geometries.flatMap(row=>(row.replaces??[]).map(ref=>ref.id));
  const waterIds=[...new Set([...physical.waterObjects.identities.map(row=>row.objectRef.id),...replacementIds])];
  async function preparePhysical(target){
    const selected=resolvePhysicalWaterObjects(physical.waterObjects,target)
      .sort((a,b)=>timelineObjectKey(a.objectRef).localeCompare(timelineObjectKey(b.objectRef)));
    const identity=physicalWaterContextKey(selected);
    if(physicalContexts.has(identity))return physicalContexts.get(identity);
    if(target===month){
      if(selected.some(row=>row.assets.land.sha256!==selected[0].assets.land.sha256))throw Error('Globe skeleton sources use different land surfaces');
      const landSpec=selectPhysicalLandAsset(physical.asset,physical.modernCoast,selected[0]?.assets.land??physical.asset,target);
      const geometry=await loadPhysicalLandGeometry(landSpec,{loadGeometry:readGeometry,loadPatch:readGeometry});
      skeleton=buildGlobeSkeleton(geometry,d3Source);
    }
    const waters=[];
    for(const row of selected){
      const asset=row.assets.asset,id=row.objectRef.id;
      if(!waterParts.has(asset.sha256)){
        const geometry=await readGeometry(asset),{positions,indices}=physicalMesh(geometry,id);
        waterParts.set(asset.sha256,{chunks:emitMeshChunks(encodeGlobeMesh({coordinates:positions,indices}),'waters/'),bounds:coordinateBounds(geometry.coordinates)});
      }
      const {chunks,bounds}=waterParts.get(asset.sha256);
      const {entityKind:category,layerId:layer_id,name,source,sourceId}=row.identity;
      waters.push({id,chunks,feature:{id,__awBounds:bounds,properties:{pandolab_id:id,category,layer_id,name,source,source_id:sourceId||id,physical_water:true}}});
    }
    const visibility=physicalWaterReferenceView(physical.waterObjects,selected,true);
    const mask=JSON.stringify(waterIds.map(id=>visibility.isActive(id)));
    if(!hydroParts.has(mask)){
      const {lakesByZoom,base,detail,riverMinZoom}=readGlobeHydro({hydro,hydroPath,readPinnedData,waterVisibility:visibility,slotFor:hydroSlot});
      const lakes=[];
      for(const [minZoom,features] of lakesByZoom){
        const mesh=engine.buildPolygonMeshFeatures(features,{validate:true});
        const objectSlots=features.map(hydroSlot),slots=Uint16Array.from(mesh.countryIndices,slot=>objectSlots[slot]);
        const chunks=emitMeshChunks(encodeGlobeMesh({coordinates:mesh.positions,indices:mesh.triangleIndices,slots,units:1e-6}),'lakes/');
        lakes.push({chunks,minZoom});
      }
      const riverDetail=detail.flatMap(({buffer,bounds:geographicBounds,...row})=>emitStrokeChunks(buffer,'river-detail/').map((chunk,index)=>({...row,...chunk,geographicBounds,id:row.id+':'+index+':'+chunk.spec.sha256})));
      hydroParts.set(mask,{lakes,riverChunks:emitStrokeChunks(base,'rivers/'),riverDetail,riverMinZoom});
    }
    const descriptor={identity,waters,...hydroParts.get(mask)};
    physicalContexts.set(identity,descriptor);
    return descriptor;
  }
  const basePhysical=await preparePhysical(month);
  if(boundarySeed.spec.month!==month)throw Error('Three.js boundaries were prepared for another month');
  const {segments:sharedBoundaries}=JSON.parse(gunzipSync(boundarySeed.bytes,{maxOutputLength:boundarySeed.spec.decodedBytes}));
  const baseGroups=borderGroups(sharedBoundaries);
  const {buffer:borderBuffer,owners:borderOwners}=packBorders(baseGroups,true);
  const borderChunks=emitStrokeChunks(borderBuffer,'borders/',false);
  const physicalRecords=physical.waterObjects.timelineRecords;
  for(const target of globeHistoryMonths(month,physicalRecords))await preparePhysical(target);
  const keys=rows=>rows.map(({owner,asset})=>globeTerritoryKey(owner,asset));
  const align=feature=>({...feature,boundaryGeometryRevision:feature.asset.contentSha256});
  const baseKeys=keys(baseRows),slotByKey=new Map(baseKeys.map((key,slot)=>[key,slot]));
  const baseSignature=baseKeys.join('\n'),worlds=new Map(),versions=new Map(),timeline=[];
  for(const target of globeHistoryMonths(month,read.records,physicalRecords)){
    const rows=target===month?baseRows:resolve(target),versionKeys=keys(rows),signature=versionKeys.join('\n');
    const physicalIdentity=(await preparePhysical(target)).identity;
    const prior=timeline.at(-1);
    if(!prior||prior.signature!==signature||prior.physicalIdentity!==physicalIdentity)timeline.push({month:target,signature,physicalIdentity});
    if(worlds.has(signature))continue;
    worlds.set(signature,{month:target,keys:versionKeys});
    rows.forEach((row,index)=>{
      const key=versionKeys[index];
      if(!slotByKey.has(key))versions.set(key,row);
    });
  }
  const historyDirectory='historical/';
  const versionFeatures=readBuiltinGeometryRows([...versions.values()],readGeometryAssets,features);
  const featureBySlot=[...features,...versionFeatures].map(align);
  const historicalMeshSpecs = readCountryMeshInputs(versionFeatures);
  const historicalCountries=versionFeatures.map((feature,index)=>{
    const slot=countrySlots.length+index;
    slotByKey.set(globeTerritoryKey(feature.id,feature.asset),slot);
    const packet=combineGlobeCountryMeshes([countryMeshRow(feature,historicalMeshSpecs[index])],{slotOffset:slot});
    const extraOutlines=buildGlobeOutlineStrokes([feature.geometry],slot);
    const anchors={[feature.id]:{coordinates:computeLabelAnchor(feature)}};
    return {...packet.countrySlots[0],label:countryLabelMetadata(decodeGlobeMesh(packet.buffer),packet.countrySlots,anchors,[feature])[feature.id]??null,
      countryChunks:emitMeshChunks(packet.buffer,historyDirectory+'countries/'),outlines:emit(extraOutlines.buffer,historyDirectory+'outlines/'),outlineOwners:extraOutlines.owners};
  });
  // Advance the same incremental boundary preparation as the Viewer worker.
  // The partition output only re-encodes owner groups touched by changed shapes.
  const topology=createCountrySharedBoundaryState(),output=createCountryBoundaryOutput();
  const partitionInputs=new Map(),partitionSlots=new Map(),historicalBorders=[],historicalViews=[],viewBySignature=new Map([[baseSignature,-1]]);
  const baseHashes=new Map(baseGroups.map(group=>[group.key,group.hash]));
  for(const [signature,world] of worlds){
    const orderedSlots=world.keys.map(key=>slotByKey.get(key));
    const partitions=orderedSlots.map(slot=>featureBySlot[slot]);
    topology.replace(partitions);
    output.patch(topology.changedEdges(),world.month);
    const {manifest,changed}=output.select(partitions.map(feature=>feature.id),[...partitionInputs]);
    partitionInputs.clear();
    for(const {id,revision} of manifest)partitionInputs.set(id,revision);
    for(const {id,segments} of changed){
      const group=borderGroup(id,segments.map(({start,end})=>[start,end]));
      const key=`${id}:${group.hash}`;
      if(!partitionSlots.has(key))partitionSlots.set(key,group.hash===baseHashes.get(id)?{base:true}:{historical:
        historicalBorders.push({chunks:emitStrokeChunks(packBorders([group]).buffer,historyDirectory+'borders/',false)})-1});
      partitionSlots.set(id,partitionSlots.get(key));
    }
    if(signature===baseSignature)continue;
    const activeBase=new Set(),activeHistory=[];
    for(const {id} of manifest){
      const row=partitionSlots.get(id);
      if(row.base)activeBase.add(id);else activeHistory.push(row.historical);
    }
    viewBySignature.set(signature,historicalViews.length);
    historicalViews.push({slots:orderedSlots.sort((a,b)=>a-b),
      hiddenBorders:baseGroups.flatMap(({key},slot)=>activeBase.has(key)?[]:[slot]),borders:activeHistory});
  }
  const hydroMetadata=emit(Buffer.from(JSON.stringify(hydroObjects)),'hydro-pick/');
  const otherPhysical=[...physicalContexts.values()].filter(row=>row!==basePhysical);
  const physicalIndex=new Map([basePhysical,...otherPhysical].map((row,index)=>[row.identity,index]));
  const historyCatalog=emit(Buffer.from(JSON.stringify({version:1,historicalCountries,historicalBorders,physicalContexts:otherPhysical,
    history:encodeGlobeHistoricalViews(historicalViews),historyTimeline:timeline.map(row=>[row.month,viewBySignature.get(row.signature),physicalIndex.get(row.physicalIdentity)])})),'catalog/');
  return {assets,skeleton,preview:{countryChunks,countrySlots,countryLabels,outlines,outlineOwners,borderChunks,borderOwners,graticule:emit(buildGraticule()),hydroMetadata,hydroCount:hydroObjects.length,
    physical:basePhysical,physicalMonth:month,historySlotCount:historicalCountries.length,historyCatalog}};
}
