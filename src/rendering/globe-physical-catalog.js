import { globeChunkLod, globeLodEnabled, validateGlobeLodChunks } from './globe-lod.js';
import { createGlobePacketIndex } from './globe-picking.js';

export const GLOBE_PHYSICAL_CATALOG_VERSION=1;
const ROLES=['water','lake','river','detail'];
const validBounds=box=>Array.isArray(box)&&box.length===6&&box.every(Number.isFinite)&&
  box.slice(0,3).every((min,axis)=>min<=box[axis+3]);
function boundsFor(rows) {
  const bounds=[Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity];
  for (const row of rows) {
    if (!validBounds(row.bounds))throw Error('Invalid physical catalog bounds');
    for (let axis=0;axis<3;axis++) {
      bounds[axis]=Math.min(bounds[axis],row.bounds[axis]);
      bounds[axis+3]=Math.max(bounds[axis+3],row.bounds[axis+3]);
    }
  }
  return bounds;
}
const cell=box=>box.slice(0,3).map((min,axis)=>Math.floor((min+box[axis+3]+2)*2)).join(':');
const zoomFor=row=>row.role==='water'?null:row.minZoom;

// Normalize once at asset generation. Role-local ordinals and keys remain
// stable regardless of which descriptor pages a viewport has loaded.
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

// Role-local numbering makes unchanged hydro pages content-addressable
// across contexts with different water polygons.
export function partitionGlobePhysicalCatalog(spec,lodVersion,emit,{maxRows=128,maxBytes=256*1024}={}) {
  const roles=describeGlobePhysicalChunks(spec,lodVersion),pages=[],counts={};
  for (const role of ROLES) {
    const groups=new Map();
    counts[role]=roles[role].length;
    roles[role].forEach((row,index)=>{
      if (!validBounds(row.bounds)||role!=='water'&&!Number.isFinite(row.minZoom))throw Error('Invalid physical chunk range');
      const key=globeChunkLod(row)+':'+zoomFor(row)+':'+cell(row.bounds);
      let group=groups.get(key);if (!group){group=[];groups.set(key,group);}
      group.push({index,row});
    });
    for (const group of groups.values()) {
      let entries=[],bytes=0;
      const flush=()=>{
        if (!entries.length)return;
        const lod=globeChunkLod(entries[0].row),minZoom=zoomFor(entries[0].row);
        const value={version:GLOBE_PHYSICAL_CATALOG_VERSION,role,lod,minZoom,entries};
        pages.push({role,lod,minZoom,count:entries.length,bounds:boundsFor(entries.map(e=>e.row)),spec:emit(value)});
        entries=[];bytes=0;
      };
      for (const entry of group) {
        const estimate=JSON.stringify(entry).length*3;
        if (entries.length&&(entries.length>=maxRows||bytes+estimate>maxBytes))flush();
        entries.push(entry);bytes+=estimate;
      }
      flush();
    }
  }
  const {waters,lakes,riverChunks,riverDetail,...metadata}=spec;
  return {...metadata,waters:waters.map(({chunks,...row})=>row),
    catalog:{version:GLOBE_PHYSICAL_CATALOG_VERSION,lodVersion,counts,pages}};
}
export function validateGlobePhysicalCatalog(context,lodVersion) {
  const catalog=context?.catalog;
  if (typeof context?.identity!=='string'||!context.identity||!Number.isFinite(context.riverMinZoom)||
      !Array.isArray(context.waters)||!catalog||catalog.version!==GLOBE_PHYSICAL_CATALOG_VERSION||
      catalog.lodVersion!==lodVersion||!Array.isArray(catalog.pages)||!catalog.counts)
    throw Error('Invalid physical catalog directory');
  const waterIds=context.waters.map(row=>row.id);
  if (waterIds.some(id=>typeof id!=='string'||!id)||new Set(waterIds).size!==waterIds.length)
    throw Error('Invalid physical water identities');
  const enabled=globeLodEnabled(lodVersion),counts=Object.fromEntries(ROLES.map(role=>[role,0]));
  for (const page of catalog.pages) {
    if (!ROLES.includes(page?.role)||!Number.isInteger(page.lod)||page.lod<0||page.lod>2||
        !enabled&&page.lod!==2||!Number.isSafeInteger(page.count)||page.count<1||!validBounds(page.bounds)||
        (page.role==='water'?page.minZoom!==null:!Number.isFinite(page.minZoom))||
        !page.spec||typeof page.spec.sha256!=='string'||!Number.isSafeInteger(page.spec.decodedBytes)||page.spec.decodedBytes<1)
      throw Error('Invalid physical catalog page directory');
    counts[page.role]+=page.count;
  }
  if (ROLES.some(role=>!Number.isSafeInteger(catalog.counts[role])||catalog.counts[role]!==counts[role]))
    throw Error('Incomplete physical catalog directory');
  return context;
}
export function validateGlobePhysicalPage(context,index,value) {
  const page=context.catalog.pages[index];
  if (!page||value?.version!==GLOBE_PHYSICAL_CATALOG_VERSION||value.role!==page.role||value.lod!==page.lod||
      value.minZoom!==page.minZoom||!Array.isArray(value.entries)||value.entries.length!==page.count)
    throw Error('Invalid physical catalog page');
  const keys=new Set(),waterIds=new Set(context.waters.map(row=>row.id));
  let previous=-1;
  for (const entry of value.entries) {
    const row=entry?.row;
    if (!Number.isSafeInteger(entry?.index)||entry.index<=previous||entry.index>=context.catalog.counts[page.role]||
        !row||row.role!==page.role||row.kind!==(page.role==='water'||page.role==='lake'?'mesh':'stroke')||
        globeChunkLod(row)!==page.lod||zoomFor(row)!==page.minZoom||typeof row.key!=='string'||
        keys.has(row.key)||!row.spec||typeof row.spec.sha256!=='string'||
        page.role==='water'&&!waterIds.has(row.id)||page.role==='detail'&&typeof row.id!=='string')
      throw Error('Invalid physical catalog page row');
    previous=entry.index;keys.add(row.key);
  }
  if (!boundsFor(value.entries.map(entry=>entry.row)).every((v,i)=>v===page.bounds[i]))
    throw Error('Physical catalog page bounds mismatch');
  return value;
}
const indexes=new WeakMap();
export function selectGlobePhysicalPages(context,{cull=()=>true,zoom=Infinity,roles=ROLES,lod=null}={}) {
  const catalog=context.catalog;
  let index=indexes.get(catalog);
  if (!index) {
    index=createGlobePacketIndex(catalog.pages.map((page,i)=>({page,i})),row=>row.page.bounds);
    indexes.set(catalog,index);
  }
  const allowed=new Set(roles);
  return index.query(cull).filter(({page})=>allowed.has(page.role)&&(lod===null||page.lod===lod)&&
    (page.minZoom===null||zoom>=page.minZoom)).map(row=>row.i);
}
export function collectGlobePhysicalPages(context,ids,values,{complete=false}={}) {
  if (ids.length!==values.length)throw Error('Incomplete physical page read');
  const rows=[],seen=new Set(),keys=new Set();
  for (const [i,id] of ids.entries()) {
    const value=validateGlobePhysicalPage(context,id,values[i]),page=context.catalog.pages[id];
    for (const {index,row} of value.entries) {
      const ordinal=row.role+':'+index;
      if (seen.has(ordinal)||keys.has(row.key))throw Error('Duplicate physical catalog row');
      seen.add(ordinal);keys.add(row.key);
      rows.push({...row,catalogPage:page.spec.sha256,catalogOrder:index});
    }
  }
  rows.sort((a,b)=>ROLES.indexOf(a.role)-ROLES.indexOf(b.role)||a.catalogOrder-b.catalogOrder);
  if (complete) {
    for (const role of ROLES)if (rows.filter(row=>row.role===role).length!==context.catalog.counts[role])
      throw Error('Incomplete physical catalog coverage');
    const families=new Map();
    for (const row of rows) {
      const key=row.role+':'+(row.role==='water'?row.id:row.role==='lake'?row.minZoom:'');
      let family=families.get(key);if (!family){family=[];families.set(key,family);}
      family.push(row);
    }
    for (const family of families.values())validateGlobeLodChunks(family,context.catalog.lodVersion);
  }
  return rows;
}
