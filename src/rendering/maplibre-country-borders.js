import {admittedGeometryKey as geometryKey} from '../geometry/geometry-version-store.js';
import {clipMercatorLines,polarLinePacket} from './maplibre-polar-layer.js';
import {countryBoundaryOwner} from './country-boundary-seed.js';

export function createMapLibreCountryBorders({getBoundaryGeometry,prepareRenderGeometry,metrics,getStats}){
 let acknowledgedBoundary=null,sequence=0,boundaryRequest=0;
 async function prepareCountryBorders(features,revision,signal){
  const serial=++boundaryRequest,key='topology:'+ ++sequence;
  const versions=new Map(),paints=new Map();
  for(const {id,geometry,properties:{borderColor,borderAlpha,borderWidth}} of features){
   versions.set(id,geometryKey(geometry));
   if(borderAlpha>0&&borderWidth>0){
    const paint={borderColor,borderAlpha,borderWidth};
    paints.set(countryBoundaryOwner(id),{key:JSON.stringify(paint),paint});
   }
  }
  const known=new Map();
  for(const row of getBoundaryGeometry().values())
   if(row.partitionId!=null)known.set(row.partitionId,row);
  const request=base=>{
   const boundary=metrics.run('border.payload',()=>({
    key,baseKey:base?.key??null,partitioned:true,visibleOwners:[...paints.keys()],
    knownPartitions:[...known].map(([id,row])=>[id,row.revision]),
    upserts:features.filter(row=>base?.versions.get(row.id)!==versions.get(row.id))
     .map(({id,geometry})=>({id,geometry,geometryRevision:versions.get(id)})),
    remove:base?[...base.versions.keys()].filter(id=>!versions.has(id)):[],
   }));
   getStats().boundaryRequests++;getStats().boundaryGeometryRows+=boundary.upserts.length;
   return prepareRenderGeometry([],revision,boundary,signal);
  };
  let result=await request(acknowledgedBoundary);
  if(result.boundaryMiss){getStats().boundaryCacheMisses++;result=await request(null);}
  if(result.boundaryMiss||!Array.isArray(result.boundaryPartitions))throw new Error('Shared border worker could not synchronize its source');
  const fresh=new Map(result.packets.map(({cacheKey,boundaryRevision,geometry})=>[cacheKey,{
   revision:boundaryRevision,paths:{native:clipMercatorLines(geometry),polar:polarLinePacket(geometry.coordinates)}
  }]));
  getStats().strokePreparedPackets+=fresh.size;
  const rows=[];
  for(const partition of result.boundaryPartitions){
   const cached=fresh.get(partition.id)??known.get(partition.id);
   if(cached?.revision!==partition.revision)throw new Error('Shared border partition revision mismatch');
   const styles=new Map();
   for(const owner of partition.ownerIds){
    const style=paints.get(owner);if(style)styles.set(style.key,style.paint);
   }
   let index=0;
   for(const [,paint] of [...styles].sort(([a],[b])=>a.localeCompare(b))){
    const id='country-border:'+partition.id+':'+index++;
    rows.push({key:id,partitionId:partition.id,revision:partition.revision,paths:cached.paths,
     feature:{type:'Feature',id,geometry:cached.paths.native,properties:{...paint,objectKey:id,displayRole:'country-border'}}});
   }
  }
  signal?.throwIfAborted();
  if(serial===boundaryRequest)acknowledgedBoundary={key,versions};
  return rows;
 }
 return Object.freeze({prepareCountryBorders,reset(){acknowledgedBoundary=null;boundaryRequest++;}});
}
