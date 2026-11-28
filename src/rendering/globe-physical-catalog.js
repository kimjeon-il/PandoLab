import { globeChunkLod, validateGlobeLodChunks } from './globe-lod.js';
import { partitionGlobeSpatialCatalog,validateGlobeSpatialCatalog,collectGlobeSpatialPages } from './globe-spatial-catalog.js';

const ROLES=['water','lake','river','detail'];
export function describeGlobePhysicalChunks(spec,lodVersion) {
  const mesh=(families,role)=>families.flatMap((family,i)=>validateGlobeLodChunks(family.chunks,lodVersion).map((row,j)=>({
    ...row,role,kind:'mesh',id:family.id,minZoom:family.minZoom,
    key:role+':'+globeChunkLod(row)+':'+(family.id??i)+':'+j+':'+row.spec.sha256,
  })));
  return {
    water:mesh(spec.waters,'water'),lake:mesh(spec.lakes,'lake'),
    river:validateGlobeLodChunks(spec.riverChunks,lodVersion).map((row,i)=>({...row,role:'river',kind:'stroke',
      minZoom:spec.riverMinZoom,key:'river:'+globeChunkLod(row)+':'+i+':'+row.spec.sha256})),
    detail:validateGlobeLodChunks(spec.riverDetail,lodVersion).map(row=>({...row,role:'detail',kind:'stroke',key:'detail:'+globeChunkLod(row)+':'+row.id})),
  };
}

export function partitionGlobePhysicalCatalog(spec,lodVersion,emit,options) {
  const roles=describeGlobePhysicalChunks(spec,lodVersion);
  const {waters,lakes,riverChunks,riverDetail,...metadata}=spec;
  return {...metadata,waters:waters.map(({chunks,...row})=>row),catalog:partitionGlobeSpatialCatalog(roles,lodVersion,emit,options)};
}
export function validateGlobePhysicalCatalog(context,lodVersion) {
  if (typeof context?.identity!=='string'||!context.identity||!Number.isFinite(context.riverMinZoom)||!Array.isArray(context.waters))
    throw Error('Invalid physical catalog directory');
  const waterIds=context.waters.map(row=>row.id);
  if (waterIds.some(id=>typeof id!=='string'||!id)||new Set(waterIds).size!==waterIds.length)
    throw Error('Invalid physical water identities');
  validateGlobeSpatialCatalog(context.catalog,lodVersion,ROLES);
  return context;
}
export function collectGlobePhysicalPages(context,ids,values,options) {
  const rows=collectGlobeSpatialPages(context.catalog,ids,values,options),waterIds=new Set(context.waters.map(row=>row.id));
  for (const row of rows)if (row.role==='water'&&!waterIds.has(row.id)||row.role==='detail'&&typeof row.id!=='string')
    throw Error('Invalid physical catalog object identity');
  return rows;
}
