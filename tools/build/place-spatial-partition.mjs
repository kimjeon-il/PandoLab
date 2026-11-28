/**
 * Deterministic multi-resolution spatial publisher for approved city labels.
 * Every stage contains the full approved set; the Worker selects one stage
 * for the current zoom and viewport. Dense cells are recursively paged.
 */
import { createHash } from 'node:crypto';
import { encodePlaceTile, decodePlaceTile } from '../../src/data/place-codec.js';
import { comparePlaces, normalizePlace, normalizePlaceQuery, selectedPlaceNames, PLACE_LIMITS } from '../../src/document/place-contract.js';

export const PLACE_SPATIAL_STAGES = Object.freeze([
  Object.freeze({id:0,minZoom:0,columns:8,rows:8}),
  Object.freeze({id:1,minZoom:4.5,columns:16,rows:16}),
  Object.freeze({id:2,minZoom:7,columns:32,rows:32}),
]);
const MAX_SPLIT_DEPTH=16;
const hash=value=>createHash('sha256').update(value).digest('hex');
const stableBucket=value=>{
  let result=2166136261;
  for(const char of String(value))result=Math.imul(result^char.charCodeAt(0),16777619);
  return result>>>0;
};
const tileX=(longitude,columns)=>Math.max(0,Math.min(columns-1,Math.floor((longitude+180)*columns/360)));
const tileY=(latitude,rows)=>Math.max(0,Math.min(rows-1,Math.floor((90-latitude)*rows/180)));
const tileKey=(stage,x,y)=>stage+'/'+x+'-'+y;
const comparePageRank=(a,b)=>b.priority-a.priority||b.population-a.population||
  a.shard.localeCompare(b.shard)||a.offset-b.offset;

function splitCell(records,bounds,depth,path,output) {
  let bytes=null;
  if(records.length<=PLACE_LIMITS.tileRecords) {
    try {bytes=Buffer.from(encodePlaceTile(records));}
    catch(error) {
      if(!(error instanceof RangeError&&/Place tile (?:record|byte) budget exceeded/u.test(error.message)))throw error;
    }
  }
  if(bytes) {
    const decoded=decodePlaceTile(bytes);
    if(decoded.length!==records.length||decoded.some((row,index)=>row.id!==records[index].id))
      throw new Error('Place spatial tile round-trip identity mismatch');
    output.push({records,bytes,path});return;
  }
  if(depth>=MAX_SPLIT_DEPTH)throw new RangeError('Place spatial overflow partition depth exceeded: '+path);
  const [west,south,east,north]=bounds,midLongitude=(west+east)/2,midLatitude=(south+north)/2;
  const quadrants=[[],[],[],[]];
  for(const row of records) {
    const x=row.coordinates[0]>=midLongitude?1:0,y=row.coordinates[1]>=midLatitude?1:0;
    quadrants[y*2+x].push(row);
  }
  let children=quadrants.map((rows,index)=>({rows,index})).filter(row=>row.rows.length);
  const first=records[0],coordinatesVary=records.some(row=>
    row.coordinates[0]!==first.coordinates[0]||row.coordinates[1]!==first.coordinates[1]);
  const geographic=children.length>1||(coordinatesVary&&depth<MAX_SPLIT_DEPTH-1);
  if(!geographic) {
    const buckets=[[],[],[],[]];
    for(const row of records)buckets[stableBucket(row.id)&3].push(row);
    children=buckets.map((rows,index)=>({rows,index})).filter(row=>row.rows.length);
    if(children.length===1&&children[0].rows.length===records.length) {
      const ordered=[...records].sort((a,b)=>a.id.localeCompare(b.id));
      children=[];
      const chunkSize=Math.max(1,Math.ceil(ordered.length/4));
      for(let firstIndex=0;firstIndex<ordered.length;firstIndex+=chunkSize)
        children.push({rows:ordered.slice(firstIndex,firstIndex+chunkSize),index:firstIndex/chunkSize});
    }
  }
  for(const child of children) {
    const childBounds=geographic?[
      child.index%2?midLongitude:west,
      child.index>=2?midLatitude:south,
      child.index%2?east:midLongitude,
      child.index>=2?north:midLatitude,
    ]:bounds;
    splitCell(child.rows,childBounds,depth+1,path+(geographic?'q':'h')+child.index,output);
  }
}

function pagesForStage(records,stage) {
  const cells=new Map();
  for(const record of records) {
    const x=tileX(record.coordinates[0],stage.columns),y=tileY(record.coordinates[1],stage.rows),key=tileKey(stage.id,x,y);
    let rows=cells.get(key);if(!rows){rows=[];cells.set(key,rows);}rows.push(record);
  }
  const pages=[];
  for(const [key,rows] of [...cells].sort(([a],[b])=>a.localeCompare(b))) {
    rows.sort(comparePlaces);
    const [,cell]=key.split('/'),[x,y]=cell.split('-').map(Number);
    const bounds=[-180+x*360/stage.columns,90-(y+1)*180/stage.rows,
      -180+(x+1)*360/stage.columns,90-y*180/stage.rows];
    const parts=[];splitCell(rows,bounds,0,'',parts);
    for(const part of parts)pages.push({key,stage:stage.id,x,y,path:part.path,records:part.records,bytes:part.bytes,
      priority:part.records[0]?.priority??0,population:part.records[0]?.population??0});
  }
  return pages;
}

/** Build bounded binary tiles, packed shards, spatial stages and search references. */
export function buildPlaceSpatialPartition(inputRecords) {
  if(!Array.isArray(inputRecords))throw new TypeError('Place spatial partition requires records');
  const records=inputRecords.map(normalizePlace).sort(comparePlaces);
  const tiles={},search={},shards={},shardFiles=[],stageStats=[],allPages=[];
  for(const stage of PLACE_SPATIAL_STAGES) {
    const pages=pagesForStage(records,stage);
    allPages.push(...pages);
    stageStats.push({id:stage.id,minZoom:stage.minZoom,columns:stage.columns,rows:stage.rows,
      tileCount:new Set(pages.map(row=>row.key)).size,pageCount:pages.length,
      maxRecords:pages.reduce((max,row)=>Math.max(max,row.records.length),0),
      maxBytes:pages.reduce((max,row)=>Math.max(max,row.bytes.length),0)});
    if(pages.reduce((sum,row)=>sum+row.records.length,0)!==records.length)
      throw new Error('Place spatial stage lost or duplicated records: '+stage.id);
  }
  let shardIndex=0,current=[],currentBytes=0;
  const flush=()=>{
    if(!current.length)return;
    const bytes=Buffer.concat(current.map(row=>row.bytes)),id='places-v1-'+String(shardIndex).padStart(3,'0');
    const name=shardIndex===0?'places-v1.bin':id+'.bin';
    shards[id]={url:name,bytes:bytes.length,sha256:hash(bytes)};
    shardFiles.push({name,bytes});
    let offset=0;
    for(const page of current) {
      const descriptor={shard:id,offset,length:page.bytes.length,sha256:hash(page.bytes),
        recordCount:page.records.length,priority:page.priority,population:page.population};
      let cellRows=tiles[page.key];if(!cellRows){cellRows=[];tiles[page.key]=cellRows;}cellRows.push(descriptor);
      if(page.stage===0) {
        const prefixes=new Set();
        for(const record of page.records)for(const name of selectedPlaceNames(record)) {
          const query=normalizePlaceQuery(name),characters=[...query];
          if(characters.length>=2)prefixes.add(characters.slice(0,2).join(''));
        }
        for(const prefix of prefixes) {
          if(!search[prefix])search[prefix]=[];
          search[prefix].push({...descriptor,first:prefix,last:prefix+'\uffff',rank:page.priority});
        }
      }
      offset+=page.bytes.length;
    }
    shardIndex++;current=[];currentBytes=0;
  };
  for(const page of allPages) {
    if(page.bytes.length>PLACE_LIMITS.shardBytes)throw new RangeError('Place spatial page exceeds shard limit');
    if(current.length&&currentBytes+page.bytes.length>PLACE_LIMITS.shardBytes)flush();
    current.push(page);currentBytes+=page.bytes.length;
  }
  flush();
  for(const [key,rows] of Object.entries(tiles))tiles[key]=rows.length===1?rows[0]:rows;
  for(const pages of Object.values(search))pages.sort(comparePageRank);
  const spatialPartition={schema:'pando-place-spatial-partition-v1',algorithm:'equirectangular-grid-bounded-overflow-v1',
    maxTileRecords:PLACE_LIMITS.tileRecords,maxTileBytes:PLACE_LIMITS.shardBytes,maxQueryPages:PLACE_LIMITS.queryTiles,
    sourceRecordCount:records.length,totalCells:stageStats.reduce((sum,row)=>sum+row.tileCount,0),
    totalPages:allPages.length,shards:shardFiles.length,stages:stageStats};
  return {stages:PLACE_SPATIAL_STAGES.map(row=>({...row})),tiles,search,shards,shardFiles,spatialPartition};
}
