import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { gzipSync, gunzipSync } from 'node:zlib';
import { globeVector } from '../../src/rendering/globe-camera.js';
import { decodeGlobeMesh, packGlobeMesh, decodeGlobeStrokes, GLOBE_MESH_HEADER_BYTES, GLOBE_MESH_MAGIC,
  GLOBE_STROKE_HEADER_BYTES, GLOBE_STROKE_MAGIC, INDEXED_GLOBE_STROKE_HEADER_BYTES, INDEXED_GLOBE_STROKE_MAGIC,
  globeTerritoryKey } from '../../src/rendering/globe-mesh.js';
import { decodePolygonMesh } from '../../src/rendering/polygon-mesh-codec.js';
import { applyPreparedMeshDelta, preparedMeshDeltaLayout } from '../../src/data/prepared-mesh-delta.js';
import { loadPhysicalLandGeometry, selectPhysicalLandAsset } from '../../src/data/physical-land-patch.js';
import { decodeHydroIndex, decodeHydroMetadata, decodeHydroPack } from '../../src/data/hydro-pack.js';
import { hydroDisplayStages } from '../../src/map/map-display-zoom.js';
import { readBuiltinGeometryRows } from './builtin-geometry-packs.mjs';
import { validateBuiltinReadIndex } from '../../src/data/builtin-country-files.js';
import { resolveBuiltinWorldGeometry } from '../../src/data/builtin-world-loader.js';
import { compareTemporalKeys, parseTemporal, temporalFollowingDay } from '../../src/document/temporal.js';
import { buildGlobePickGrid, buildGlobeStrokePickGrid } from './globe-pick-grid.mjs';
import { coordinateBounds } from '../../src/geometry/coordinate-bounds.js';
import { buildRenderableBoundarySegments, densifyBoundarySegmentsForProjection, normalizeLongitudeNear } from '../../src/geometry/geographic-boundary.js';
import { createCountrySharedBoundaryState } from '../../src/rendering/country-shared-boundary-state.js';
import { createCountryBoundaryOutput } from '../../src/rendering/country-boundary-output.js';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const archivePath = url => url.startsWith('assets/data/') ? url : 'assets/data/' + url;
const toBuffer = value => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);

export function globeSkeletonLandPath(land, d3Source) {
  const context = {};
  runInNewContext(String(d3Source), context);
  const geo = context.d3.geo;
  const projection = geo.orthographic().rotate([-15, -12]).clipAngle(90)
    .translate([128, 128]).scale(128).precision(1);
  const coordinates = land.coordinates.flatMap(([exterior]) => {
    const area = geo.area({type: 'Polygon', coordinates: [exterior]});
    if (Math.min(area, 4 * Math.PI - area) < 0.0003) return [];
    return [[area > 2 * Math.PI ? exterior.slice().reverse() : exterior]];
  });
  let ring = [];
  const paths = [];
  const drawing = {
    moveTo(x, y) {
      ring = [[Math.round(x), Math.round(y)]];
    },
    lineTo(x, y) {
      const point = [Math.round(x), Math.round(y)], previous = ring.at(-1);
      if ((point[0] - previous[0]) ** 2 + (point[1] - previous[1]) ** 2 >= 9) ring.push(point);
    },
    closePath() {
      if (ring.length >= 3) paths.push('M' + ring.join('L') + 'Z');
    },
  };
  geo.path().projection(projection).context(drawing)({type: 'MultiPolygon', coordinates});
  return paths.join('');
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
  const count = indices ? indices.length / 2 : coordinates.length / 4;
  if (!Number.isInteger(count) || (widths.length && widths.length !== count) ||
    (ownerGroups.length && ownerGroups.length !== count)) throw new Error('Invalid globe stroke count');
  const buffer = new ArrayBuffer(GLOBE_STROKE_HEADER_BYTES + count * 48 + widths.length * 4 + ownerGroups.byteLength);
  const header = new DataView(buffer);
  header.setUint32(0, GLOBE_STROKE_MAGIC, true);
  header.setUint32(4, count, true);
  header.setUint32(8, widths.length, true);
  header.setUint32(12, ownerGroups.length, true);
  const { start, startLow, end, endLow, widths: outputWidths, ownerGroups: outputOwners } = decodeGlobeStrokes(buffer);
  outputWidths.set(widths);
  outputOwners.set(ownerGroups);
  for (let index = 0; index < count; index++) {
    const a = (indices ? indices[index * 2] : index * 2) * 2;
    const b = (indices ? indices[index * 2 + 1] : index * 2 + 1) * 2;
    writePosition(start, startLow, index * 3, coordinates[a], coordinates[a + 1]);
    writePosition(end, endLow, index * 3, coordinates[b], coordinates[b + 1]);
  }
  return buffer;
}

/** Index equal high/low endpoint bits without changing line order or attributes. */
export function packGlobeStrokes(buffer) {
  const { count, start } = decodeGlobeStrokes(buffer);
  if (start.buffer !== buffer) throw new Error('Expected unpacked globe strokes');
  const vectorWords = count * 3;
  const endpoints = new Uint32Array(buffer, GLOBE_STROKE_HEADER_BYTES, count * 12);
  const points = new Uint32Array(endpoints.length), indices = new Uint32Array(count * 2);
  let capacity = 1;
  while (capacity < count * 3) capacity *= 2;
  // An open-addressed table avoids retaining a string per endpoint while building.
  const table = new Uint32Array(capacity), mask = capacity - 1;
  let pointCount = 0;
  for (let segment = 0; segment < count; segment++) {
    for (let side = 0; side < 2; side++) {
      const high = segment * 3 + side * vectorWords * 2, low = high + vectorWords;
      const x = endpoints[high], y = endpoints[high + 1], z = endpoints[high + 2];
      const lx = endpoints[low], ly = endpoints[low + 1], lz = endpoints[low + 2];
      let bucket = (Math.imul(x, 2654435761) ^ Math.imul(y, 2246822519) ^ Math.imul(z, 3266489917) ^
        Math.imul(lx, 668265263) ^ Math.imul(ly, 374761393) ^ lz) & mask;
      while (table[bucket]) {
        const point = (table[bucket] - 1) * 6;
        if (points[point] === x && points[point + 1] === y && points[point + 2] === z &&
            points[point + 3] === lx && points[point + 4] === ly && points[point + 5] === lz) break;
        bucket = (bucket + 1) & mask;
      }
      if (!table[bucket]) {
        const point = pointCount * 6;
        points[point] = x; points[point + 1] = y; points[point + 2] = z;
        points[point + 3] = lx; points[point + 4] = ly; points[point + 5] = lz;
        table[bucket] = ++pointCount;
      }
      indices[segment * 2 + side] = table[bucket] - 1;
    }
  }
  const tail = new Uint8Array(buffer, GLOBE_STROKE_HEADER_BYTES + count * 48);
  const pointOffset = INDEXED_GLOBE_STROKE_HEADER_BYTES, indexOffset = pointOffset + pointCount * 24;
  const tailOffset = indexOffset + indices.byteLength;
  const packed = new ArrayBuffer(tailOffset + tail.byteLength);
  new Uint8Array(packed, 0, GLOBE_STROKE_HEADER_BYTES).set(new Uint8Array(buffer, 0, GLOBE_STROKE_HEADER_BYTES));
  const header = new DataView(packed);
  header.setUint32(0, INDEXED_GLOBE_STROKE_MAGIC, true);
  header.setUint32(16, pointCount, true);
  new Uint32Array(packed, pointOffset, pointCount * 6).set(points.subarray(0, pointCount * 6));
  new Uint32Array(packed, indexOffset, indices.length).set(indices);
  new Uint8Array(packed, tailOffset).set(tail);
  return packed;
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

function countryLabelMetadata(mesh, slots, anchors) {
  const {positions,residuals,indices}=mesh;
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
    return [[id,{coordinate,area}]];
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
  const withPickGrid = (buffer, dir = '', emitMesh = emit) => ({
    ...emitMesh(buffer, dir),
    pickGrid: emit(buildGlobePickGrid(decodeGlobeMesh(buffer)), dir + 'pick/'),
  });
  const withStrokePickGrid=(buffer,dir='',stored=buffer)=>({...emit(stored,dir),
    pickGrid:emit(buildGlobeStrokePickGrid(decodeGlobeStrokes(buffer)),'hydro-pick/')});

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
  const countries = withPickGrid(preparedCountries.buffer, '', emitPackedMesh);
  const countryLabels = countryLabelMetadata(decodeGlobeMesh(preparedCountries.buffer),countrySlots,boundarySeed.spec.labelAnchors);
  const {buffer:outlineBuffer,owners:outlineOwners} = buildGlobeOutlineStrokes(features.map(feature=>feature.geometry));
  const outlines = emit(outlineBuffer,'outlines/');
  const readGeometry = async spec => JSON.parse(source(spec));
  const physicalContexts=new Map(),landPackets=new Map(),waterParts=new Map(),hydroParts=new Map();
  let skeletonLandPath;
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
    if(selected.some(row=>row.assets.land.sha256!==selected[0].assets.land.sha256))throw Error('Globe physical contexts use different land surfaces');
    const landSpec=selectPhysicalLandAsset(physical.asset,physical.modernCoast,selected[0]?.assets.land??physical.asset,target);
    const identity=JSON.stringify([landSpec.sha256,physicalWaterContextKey(selected)]);
    if(physicalContexts.has(identity))return physicalContexts.get(identity);
    if(!landPackets.has(landSpec.sha256)){
      const geometry=await loadPhysicalLandGeometry(landSpec,{loadGeometry:readGeometry,loadPatch:readGeometry});
      if(target===month)skeletonLandPath=globeSkeletonLandPath(geometry,d3Source);
      const mesh=physicalMesh(geometry,'physical-land');
      const land = emitPackedMesh(encodeGlobeMesh({ coordinates: mesh.positions, indices: mesh.indices }));
      landPackets.set(landSpec.sha256,land);
    }
    const waters=[];
    for(const row of selected){
      const asset=row.assets.asset,id=row.objectRef.id;
      if(!waterParts.has(asset.sha256)){
        const geometry=await readGeometry(asset),{positions,indices}=physicalMesh(geometry,id);
        waterParts.set(asset.sha256,{spec:withPickGrid(encodeGlobeMesh({coordinates:positions,indices})),bounds:coordinateBounds(geometry.coordinates)});
      }
      const {spec,bounds}=waterParts.get(asset.sha256);
      const {entityKind:category,layerId:layer_id,name,source,sourceId}=row.identity;
      waters.push({id,spec,feature:{id,__awBounds:bounds,properties:{pandolab_id:id,category,layer_id,name,source,source_id:sourceId||id,physical_water:true}}});
    }
    const visibility=physicalWaterReferenceView(physical.waterObjects,selected,true);
    const mask=JSON.stringify(waterIds.map(id=>visibility.isActive(id)));
    if(!hydroParts.has(mask)){
      const {lakesByZoom,base,detail,riverMinZoom}=readGlobeHydro({hydro,hydroPath,readPinnedData,waterVisibility:visibility,slotFor:hydroSlot});
      const lakes=[];
      for(const [minZoom,features] of lakesByZoom){
        const mesh=engine.buildPolygonMeshFeatures(features,{validate:true});
        const objectSlots=features.map(hydroSlot),slots=Uint16Array.from(mesh.countryIndices,slot=>objectSlots[slot]);
        const spec=withPickGrid(encodeGlobeMesh({coordinates:mesh.positions,indices:mesh.triangleIndices,slots,units:1e-6}));
        lakes.push({spec,minZoom});
      }
      const riverDetail=detail.map(({buffer,...row})=>{
        const spec=withStrokePickGrid(buffer,'river-detail/');
        return {...row,id:row.id+':'+spec.sha256,spec};
      });
      hydroParts.set(mask,{lakes,rivers:withStrokePickGrid(base,'',packGlobeStrokes(base)),riverDetail,riverMinZoom});
    }
    const descriptor={identity,land:landPackets.get(landSpec.sha256),waters,...hydroParts.get(mask)};
    physicalContexts.set(identity,descriptor);
    return descriptor;
  }
  const basePhysical=await preparePhysical(month);
  if(boundarySeed.spec.month!==month)throw Error('Three.js boundaries were prepared for another month');
  const {segments:sharedBoundaries}=JSON.parse(gunzipSync(boundarySeed.bytes,{maxOutputLength:boundarySeed.spec.decodedBytes}));
  const baseGroups=borderGroups(sharedBoundaries);
  const {buffer:borderBuffer,owners:borderOwners}=packBorders(baseGroups,true);
  const borders=emit(packGlobeStrokes(borderBuffer));
  const physicalRecords=physical.waterObjects.timelineRecords;
  const coastDates=physical.modernCoast?[{validFrom:physical.modernCoast.validFrom,validTo:null}]:[];
  for(const target of globeHistoryMonths(month,physicalRecords,{lifetimes:coastDates,geometryBindings:[]}))await preparePhysical(target);
  const keys=rows=>rows.map(({owner,asset})=>globeTerritoryKey(owner,asset));
  const align=feature=>({...feature,boundaryGeometryRevision:feature.asset.contentSha256});
  const baseKeys=keys(baseRows),slotByKey=new Map(baseKeys.map((key,slot)=>[key,slot]));
  const baseSignature=baseKeys.join('\n'),worlds=new Map(),versions=new Map();
  for(const target of globeHistoryMonths(month,read.records)){
    const rows=target===month?baseRows:resolve(target),versionKeys=keys(rows),signature=versionKeys.join('\n');
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
    return {...packet.countrySlots[0],label:countryLabelMetadata(decodeGlobeMesh(packet.buffer),packet.countrySlots,anchors)[feature.id]??null,
      countries:withPickGrid(packet.buffer,historyDirectory,emitPackedMesh),outlines:emit(extraOutlines.buffer,historyDirectory+'outlines/'),outlineOwners:extraOutlines.owners};
  });
  // Advance the same incremental boundary preparation as the Viewer worker.
  // The partition output only re-encodes owner groups touched by changed shapes.
  const topology=createCountrySharedBoundaryState(),output=createCountryBoundaryOutput();
  const partitionInputs=new Map(),partitionSlots=new Map(),historicalBorders=[],historicalViews=[];
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
        historicalBorders.push(emit(packBorders([group]).buffer,historyDirectory))-1});
      partitionSlots.set(id,partitionSlots.get(key));
    }
    if(signature===baseSignature)continue;
    const activeBase=new Set(),activeHistory=[];
    for(const {id} of manifest){
      const row=partitionSlots.get(id);
      if(row.base)activeBase.add(id);else activeHistory.push(row.historical);
    }
    historicalViews.push({slots:orderedSlots.sort((a,b)=>a-b),
      hiddenBorders:baseGroups.flatMap(({key},slot)=>activeBase.has(key)?[]:[slot]),borders:activeHistory});
  }
  const hydroMetadata=emit(Buffer.from(JSON.stringify(hydroObjects)),'hydro-pick/');
  return {assets,skeletonLandPath,preview:{countries,countrySlots,countryLabels,outlines,outlineOwners,borders,borderOwners,graticule:emit(buildGraticule()),hydroMetadata,hydroCount:hydroObjects.length,
    physical:basePhysical,physicalContexts:[...physicalContexts.values()].filter(row=>row!==basePhysical),physicalMonth:month,
    historicalCountries,historicalBorders,historicalViews}};
}
