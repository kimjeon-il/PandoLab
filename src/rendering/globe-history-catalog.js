import { validateGlobeLodChunks } from './globe-lod.js';

// A small immutable directory preserves Core's global historical slots and
// border indices. Spatial descriptor pages are independent content-addressed
// assets; a missing page must never be interpreted as an empty region.
export const GLOBE_HISTORY_CATALOG_VERSION=2;
const KINDS=['historicalCountries','historicalBorders','physicalContexts'];
const validBounds=box=>Array.isArray(box)&&box.length===6&&box.every(Number.isFinite)&&
  box.slice(0,3).every((min,axis)=>min<=box[axis+3]);
function familyBounds(rows) {
  if (!rows.length)return null;
  const bounds=[Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity];
  for (const row of rows) {
    if (!validBounds(row.bounds))throw Error('Invalid historical catalog chunk bounds');
    for (let axis=0;axis<3;axis++) {
      bounds[axis]=Math.min(bounds[axis],row.bounds[axis]);
      bounds[axis+3]=Math.max(bounds[axis+3],row.bounds[axis+3]);
    }
  }
  return bounds;
}
const rowBounds=(kind,row)=>kind==='historicalCountries'?familyBounds([...row.countryChunks,...row.outlineChunks]):
  kind==='historicalBorders'?familyBounds(row.chunks):null;
const cell=box=>box?box.slice(0,3).map((min,axis)=>Math.floor((min+box[axis+3]+2)*2)).join(':'):'empty';
function sameBounds(a,b) {return a===null?b===null:validBounds(a)&&validBounds(b)&&a.every((v,i)=>v===b[i]);}

// Keep complete LOD families together. Pack nearby historical versions and
// borders in bounded groups; an unusually large individual family is isolated.
export function partitionGlobeHistoryCatalog(source,emit,{maxRows=64,maxBytes=256*1024}={}) {
  const directory={version:GLOBE_HISTORY_CATALOG_VERSION,lodVersion:source.lodVersion,
    historicalCountries:[],historicalBorders:[],physicalContexts:[],pages:[]};
  for (const kind of KINDS) {
    const groups=new Map();
    source[kind].forEach((row,index)=>{
      const bounds=rowBounds(kind,row);
      const {countryChunks,outlineChunks,...metadata}=kind==='historicalCountries'?row:{};
      const value=kind==='historicalCountries'?{countryChunks,outlineChunks}:row;
      directory[kind].push(kind==='historicalCountries'?{...metadata,bounds,page:null}:
        kind==='historicalBorders'?{bounds,page:null}:{identity:row.identity,page:null});
      const key=kind==='physicalContexts'?String(index):cell(bounds);
      let group=groups.get(key);if (!group){group=[];groups.set(key,group);}
      group.push({index,value});
    });
    for (const group of groups.values()) {
      let entries=[],bytes=0;
      const flush=()=>{
        if (!entries.length)return;
        const page=directory.pages.length,indices=entries.map(row=>row.index);
        const spec=emit({version:GLOBE_HISTORY_CATALOG_VERSION,kind,entries});
        directory.pages.push({kind,indices,spec});
        for (const index of indices)directory[kind][index].page=page;
        entries=[];bytes=0;
      };
      for (const entry of group) {
        // UTF-8 can take up to 3 bytes per UTF-16 code unit.
        const estimate=JSON.stringify(entry).length*3;
        if (entries.length&&(entries.length>=maxRows||bytes+estimate>maxBytes))flush();
        entries.push(entry);bytes+=estimate;
      }
      flush();
    }
  }
  return directory;
}

export function validateGlobeHistoryDirectory(directory,{lodVersion,slotCount}={}) {
  if (directory?.version!==GLOBE_HISTORY_CATALOG_VERSION||directory.lodVersion!==lodVersion||
      !Array.isArray(directory.pages)||KINDS.some(kind=>!Array.isArray(directory[kind]))||
      (slotCount!==undefined&&directory.historicalCountries.length!==slotCount)||
      !Array.isArray(directory.historyTimeline)||!directory.history)throw Error('Invalid Three.js history directory');
  const seen=Object.fromEntries(KINDS.map(kind=>[kind,new Set()]));
  for (const [page,record] of directory.pages.entries()) {
    const {kind,indices,spec}=record??{};
    if (!KINDS.includes(kind)||!Array.isArray(indices)||!indices.length||!spec||
        typeof spec.sha256!=='string'||!Number.isSafeInteger(spec.decodedBytes)||spec.decodedBytes<=0)
      throw Error('Invalid historical catalog page reference');
    for (const index of indices) {
      const row=directory[kind][index];
      if (!Number.isSafeInteger(index)||index<0||!row||row.page!==page||seen[kind].has(index)||
          (kind!=='physicalContexts'&&row.bounds!==null&&!validBounds(row.bounds)))
        throw Error('Invalid historical catalog page membership');
      seen[kind].add(index);
    }
  }
  if (KINDS.some(kind=>seen[kind].size!==directory[kind].length))throw Error('Incomplete historical catalog directory');
  const identities=directory.physicalContexts.map(row=>row.identity);
  if (identities.some(id=>typeof id!=='string'||!id)||new Set(identities).size!==identities.length)
    throw Error('Invalid historical physical identities');
  return directory;
}

export function validateGlobeHistoryPage(directory,page,value) {
  const record=directory.pages[page];
  if (!record||value?.version!==GLOBE_HISTORY_CATALOG_VERSION||value.kind!==record.kind||
      !Array.isArray(value.entries)||value.entries.length!==record.indices.length)
    throw Error('Invalid historical catalog page');
  const chunks=rows=>{validateGlobeLodChunks(rows,directory.lodVersion);familyBounds(rows);};
  for (const [i,entry] of value.entries.entries()) {
    const index=record.indices[i],row=entry?.value,metadata=directory[record.kind][index];
    if (entry?.index!==index||!row||!sameBounds(rowBounds(record.kind,row),record.kind==='physicalContexts'?null:metadata.bounds))
      throw Error('Historical catalog page membership/bounds mismatch');
    if (record.kind==='historicalCountries') {chunks(row.countryChunks);chunks(row.outlineChunks);}
    else if (record.kind==='historicalBorders')chunks(row.chunks);
    else {
      if (row.identity!==metadata.identity||!Array.isArray(row.waters)||!Array.isArray(row.lakes))
        throw Error('Historical physical context identity mismatch');
      for (const item of [...row.waters,...row.lakes])chunks(item.chunks);
      chunks(row.riverChunks);chunks(row.riverDetail);
    }
  }
  return value;
}

// The conservative union of every LOD's bounds must intersect the padded
// viewport before an active historical family needs descriptor I/O.
export function selectGlobeHistoryPages(directory,prepared,identity,{baseCount,baseIdentity,cull=()=>true}) {
  const pages=new Set();
  const include=(kind,index)=>{
    const row=directory[kind][index];
    if (!row)throw Error('Missing active historical catalog member');
    if (row.bounds===undefined||row.bounds!==null&&cull(row.bounds))pages.add(row.page);
  };
  for (const slot of prepared.slots)if (slot>=baseCount)include('historicalCountries',slot-baseCount);
  for (const index of prepared.view?.borders??[])include('historicalBorders',index);
  if (identity!==baseIdentity) {
    const index=directory.physicalContexts.findIndex(row=>row.identity===identity);
    include('physicalContexts',index);
  }
  return [...pages].sort((a,b)=>a-b);
}

export function collectGlobeHistoryPages(directory,ids,values) {
  const result={lodVersion:directory.lodVersion,historicalCountries:[],historicalBorders:[],physicalContexts:[]};
  if (ids.length!==values.length)throw Error('Incomplete historical page read');
  for (const [i,page] of ids.entries()) {
    const value=validateGlobeHistoryPage(directory,page,values[i]);
    for (const entry of value.entries)result[value.kind][entry.index]=entry.value;
  }
  return result;
}
