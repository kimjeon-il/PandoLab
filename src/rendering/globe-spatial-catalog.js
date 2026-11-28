import { globeChunkLod, globeLodEnabled, validateGlobeLodChunks } from './globe-lod.js';
import { createGlobePacketIndex } from './globe-picking.js';

export const GLOBE_SPATIAL_CATALOG_VERSION=1;
const ROLE_KINDS={country:'mesh',border:'stroke',outline:'stroke',water:'mesh',lake:'mesh',river:'stroke',detail:'stroke'};
const validBounds=box=>Array.isArray(box)&&box.length===6&&box.every(Number.isFinite)&&
  box.slice(0,3).every((min,axis)=>min<=box[axis+3]);
function boundsFor(rows) {
  const bounds=[Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity];
  for (const row of rows) {
    if (!validBounds(row.bounds))throw Error('Invalid spatial catalog bounds');
    for (let axis=0;axis<3;axis++) {
      bounds[axis]=Math.min(bounds[axis],row.bounds[axis]);
      bounds[axis+3]=Math.max(bounds[axis+3],row.bounds[axis+3]);
    }
  }
  return bounds;
}
const cell=box=>box.slice(0,3).map((min,axis)=>Math.floor((min+box[axis+3]+2)*2)).join(':');
const hasZoom=role=>role==='lake'||role==='river'||role==='detail';
const zoomFor=row=>hasZoom(row.role)?row.minZoom:null;

// Normalize once at asset generation. Role-local ordinals and keys remain
// stable regardless of which descriptor pages a viewport has loaded.
// Role-local numbering makes unchanged hydro pages content-addressable
// across contexts with different water polygons.
export function partitionGlobeSpatialCatalog(roles,lodVersion,emit,{maxRows=128,maxBytes=256*1024}={}) {
  const pages=[],counts={};
  for (const [role,rows] of Object.entries(roles)) {
    if (!ROLE_KINDS[role])throw Error('Unknown spatial catalog role');
    const groups=new Map();
    counts[role]=rows.length;
    rows.forEach((row,index)=>{
      if (row.role!==role||row.kind!==ROLE_KINDS[role]||!validBounds(row.bounds)||hasZoom(role)&&!Number.isFinite(row.minZoom))throw Error('Invalid spatial chunk range');
      const key=globeChunkLod(row)+':'+zoomFor(row)+':'+cell(row.bounds);
      let group=groups.get(key);if (!group){group=[];groups.set(key,group);}
      group.push({index,row});
    });
    for (const group of groups.values()) {
      let entries=[],bytes=0;
      const flush=()=>{
        if (!entries.length)return;
        const lod=globeChunkLod(entries[0].row),minZoom=zoomFor(entries[0].row);
        const value={version:GLOBE_SPATIAL_CATALOG_VERSION,role,lod,minZoom,entries};
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
  return {version:GLOBE_SPATIAL_CATALOG_VERSION,lodVersion,counts,pages};
}
export function validateGlobeSpatialCatalog(catalog,lodVersion,roles) {
  if (!catalog||catalog.version!==GLOBE_SPATIAL_CATALOG_VERSION||catalog.lodVersion!==lodVersion||
      !Array.isArray(catalog.pages)||!catalog.counts||Object.keys(catalog.counts).length!==roles.length)
    throw Error('Invalid spatial catalog directory');
  const enabled=globeLodEnabled(lodVersion),counts=Object.fromEntries(roles.map(role=>[role,0]));
  for (const page of catalog.pages) {
    if (!roles.includes(page?.role)||!Number.isInteger(page.lod)||page.lod<0||page.lod>2||
        !enabled&&page.lod!==2||!Number.isSafeInteger(page.count)||page.count<1||!validBounds(page.bounds)||
        (hasZoom(page.role)?!Number.isFinite(page.minZoom):page.minZoom!==null)||
        !page.spec||typeof page.spec.sha256!=='string'||!Number.isSafeInteger(page.spec.decodedBytes)||page.spec.decodedBytes<1)
      throw Error('Invalid spatial catalog page directory');
    counts[page.role]+=page.count;
  }
  if (roles.some(role=>!Number.isSafeInteger(catalog.counts[role])||catalog.counts[role]!==counts[role]))
    throw Error('Incomplete spatial catalog directory');
  return catalog;
}
function validateGlobeSpatialPage(catalog,index,value) {
  const page=catalog.pages[index];
  if (!page||value?.version!==GLOBE_SPATIAL_CATALOG_VERSION||value.role!==page.role||value.lod!==page.lod||
      value.minZoom!==page.minZoom||!Array.isArray(value.entries)||value.entries.length!==page.count)
    throw Error('Invalid spatial catalog page');
  const keys=new Set();
  let previous=-1;
  for (const entry of value.entries) {
    const row=entry?.row;
    if (!Number.isSafeInteger(entry?.index)||entry.index<=previous||entry.index>=catalog.counts[page.role]||
        !row||row.role!==page.role||row.kind!==ROLE_KINDS[page.role]||
        globeChunkLod(row)!==page.lod||zoomFor(row)!==page.minZoom||typeof row.key!=='string'||
        keys.has(row.key)||!row.spec||typeof row.spec.sha256!=='string')
      throw Error('Invalid spatial catalog page row');
    previous=entry.index;keys.add(row.key);
  }
  if (!boundsFor(value.entries.map(entry=>entry.row)).every((v,i)=>v===page.bounds[i]))
    throw Error('Spatial catalog page bounds mismatch');
  return value;
}
const indexes=new WeakMap();
export function selectGlobeSpatialPages(catalog,{cull=()=>true,zoom=Infinity,roles=Object.keys(catalog.counts),lod=null,maxLod=Infinity}={}) {
  let index=indexes.get(catalog);
  if (!index) {
    index=createGlobePacketIndex(catalog.pages.map((page,i)=>({page,i})),row=>row.page.bounds);
    indexes.set(catalog,index);
  }
  const allowed=new Set(roles);
  return index.query(cull).filter(({page})=>allowed.has(page.role)&&(lod===null||page.lod===lod)&&page.lod<=maxLod&&
    (page.minZoom===null||zoom>=page.minZoom)).map(row=>row.i);
}
export function collectGlobeSpatialPages(catalog,ids,values,{complete=false}={}) {
  if (ids.length!==values.length)throw Error('Incomplete physical page read');
  const roles=Object.keys(catalog.counts),rows=[],seen=new Set(),keys=new Set();
  for (const [i,id] of ids.entries()) {
    const value=validateGlobeSpatialPage(catalog,id,values[i]),page=catalog.pages[id];
    for (const {index,row} of value.entries) {
      const ordinal=row.role+':'+index;
      if (seen.has(ordinal)||keys.has(row.key))throw Error('Duplicate spatial catalog row');
      seen.add(ordinal);keys.add(row.key);
      rows.push({...row,catalogPage:page.spec.sha256,catalogOrder:index});
    }
  }
  rows.sort((a,b)=>roles.indexOf(a.role)-roles.indexOf(b.role)||a.catalogOrder-b.catalogOrder);
  if (complete) {
    for (const role of roles)if (rows.filter(row=>row.role===role).length!==catalog.counts[role])
      throw Error('Incomplete spatial catalog coverage');
    const families=new Map();
    for (const row of rows) {
      const key=row.role+':'+(row.role==='water'?row.id:row.role==='lake'?row.minZoom:'');
      let family=families.get(key);if (!family){family=[];families.set(key,family);}
      family.push(row);
    }
    for (const family of families.values())validateGlobeLodChunks(family,catalog.lodVersion);
  }
  return rows;
}

export function describeGlobeOutlineChunks(rows,lodVersion,slot=null) {
  const byLod=new Map(),result=[];
  for (const row of validateGlobeLodChunks(rows,lodVersion)) {
    const lod=globeChunkLod(row);let level=byLod.get(lod);
    if (!level){level=[];byLod.set(lod,level);}level.push(row);
  }
  for (const [lod,level] of byLod)for (const [order,row] of level.entries())
    result.push({...row,role:'outline',kind:'stroke',slot,order,count:level.length,
      key:'outline:'+lod+':'+(slot??'base')+':'+order+':'+row.spec.sha256});
  return result;
}
export function describeGlobeTerritorialChunks(spec,lodVersion) {
  return {
    country:validateGlobeLodChunks(spec.countryChunks,lodVersion).map((row,i)=>({...row,role:'country',kind:'mesh',
      key:'base-country:'+globeChunkLod(row)+':'+i+':'+row.spec.sha256})),
    border:validateGlobeLodChunks(spec.borderChunks,lodVersion).map((row,i)=>({...row,role:'border',kind:'stroke',baseBorder:true,
      key:'base-border:'+globeChunkLod(row)+':'+i+':'+row.spec.sha256})),
    outline:describeGlobeOutlineChunks(spec.outlineChunks,lodVersion),
  };
}
