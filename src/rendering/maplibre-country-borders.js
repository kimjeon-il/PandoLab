import {admittedGeometryKey as geometryKey} from '../geometry/geometry-version-store.js';
import {clipMercatorLines,polarLinePacket} from './maplibre-polar-layer.js';
export function createMapLibreCountryBorders({getBoundaryGeometry,prepareRenderGeometry,metrics,getStats}){
 let acknowledgedBoundary=null,boundaryRequest=0;
 async function prepareCountryBorders(features,revision,signal){
  const countryFeatures=[...features].sort((a,b)=>a.id.localeCompare(b.id));
  const topologyKey=countryFeatures.map(feature=>feature.id+':'+geometryKey(feature.geometry)).join('|');
  const groups=new Map();
  for(const {id,properties:{borderColor,borderAlpha,borderWidth}} of countryFeatures){
   if(!(borderAlpha>0&&borderWidth>0))continue;
   const key=JSON.stringify([borderColor,borderAlpha,borderWidth]);
   if(!groups.has(key))groups.set(key,{borderColor,borderAlpha,borderWidth,owners:[]});
   groups.get(key).owners.push(id);
  }
  const rows=[...groups.values()].map(({owners,...paint},index)=>({
   id:'country-border:'+index,paint,key:JSON.stringify([paint,owners]),owners,
  }));
  const prepared=await prepareBoundaryGroups(countryFeatures,topologyKey,rows,revision,signal);
  const geometries=new Map(prepared?.packets.map(({cacheKey,geometry})=>[
   cacheKey,{native:clipMercatorLines(geometry),polar:polarLinePacket(geometry.coordinates)},
  ]));
  getStats().strokePreparedPackets+=geometries.size;
  return rows.map(row=>{
   const paths=geometries.get(row.key)||getBoundaryGeometry().get(row.key)?.paths;
   if(!paths)throw new Error('Shared country boundary was not prepared');
   return {key:row.key,paths,feature:{type:'Feature',id:row.id,geometry:paths.native,
    properties:{...row.paint,objectKey:row.id,displayRole:'country-border'}}};
  });
 }
 async function prepareBoundaryGroups(features,key,groups,revision,signal){
  const serial=++boundaryRequest;
  const versions=new Map(features.map(feature=>[feature.id,geometryKey(feature.geometry)]));
  const previous=acknowledgedBoundary;
  const items=groups.map(row=>({kind:'stroke',cacheKey:row.key,countryVisibleIds:row.owners,
    knownGeometry:getBoundaryGeometry().has(row.key)}));
  const request=async(base)=>{
   const boundary=metrics.run('border.payload',()=>({
    key,baseKey:base?.key??null,
    upserts:features.filter(row=>base?.versions.get(row.id)!==versions.get(row.id))
     .map(({id,geometry})=>({id,geometry})),
    remove:base?[...base.versions.keys()].filter(id=>!versions.has(id)):[],
   }));
   getStats().boundaryRequests++;
   getStats().boundaryGeometryRows+=boundary.upserts.length;
   return prepareRenderGeometry(items,revision,boundary,signal);
  };
  let result=await request(previous);
  if(result.boundaryMiss){
   getStats().boundaryCacheMisses++;
   result=await request(null);
  }
  if(result.boundaryMiss)throw new Error('Shared border worker could not synchronize its source');
  if(serial===boundaryRequest)acknowledgedBoundary={key,versions};
  return result;
 }

 return Object.freeze({prepareCountryBorders,reset(){acknowledgedBoundary=null;boundaryRequest++;}});
}
