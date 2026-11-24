const pointKey=point=>point.map(value=>Math.round(value*1e6)).join(',');
const validPoint=point=>Array.isArray(point)&&point.length===2&&point.every((value,index)=>
  Number.isFinite(value)&&Math.abs(value)<=(index===0?180:90));
const systemId=value=>typeof value==='string'&&/^\d+$/.test(value);
const reachId=value=>Number.isSafeInteger(value)&&value>0;
const equal=(a,b)=>pointKey(a)===pointKey(b);
const start=reach=>reach.parts[0][0];
const end=reach=>reach.parts.at(-1).at(-1);

export function hydroDisplayReview(document, sources) {
  if(document===undefined)return new Map();
  if(document?.version!==1||!Array.isArray(document.regions)||!document.regions.length)
    throw Error('Invalid Hydro display review');
  const result=new Map();
  for(const region of document.regions){
    const source=sources.find(row=>row.specification.datasetCode===region.datasetCode)?.specification;
    const shp=source?.files.find(row=>row.file.endsWith('.shp'));
    if(!shp||shp.sha256!==region.sourceSha256||result.has(region.datasetCode))
      throw Error('Hydro display review does not match the selected source edition');
    if(!Array.isArray(region.exclusions)||!Array.isArray(region.replacements)||'smoothing' in region)
      throw Error('Hydro display review requires exclusions and traced centerlines');
    const excluded=new Map(),replacements=new Map();
    for(const entry of region.exclusions){
      if(!systemId(entry.systemId)||!Array.isArray(entry.reachIds)||!entry.reachIds.length||!entry.evidence?.length)
        throw Error('Hydro exclusion requires source identity, reaches and evidence');
      for(const id of entry.reachIds){
        if(!reachId(id)||excluded.has(id))throw Error('Invalid or duplicate Hydro exclusion');
        excluded.set(id,entry.systemId);
      }
    }
    for(const entry of region.replacements){
      const {id,coordinates,sourceStart,sourceEnd,evidence}=entry;
      if(!reachId(id)||!systemId(entry.systemId)||excluded.has(id)||replacements.has(id)||
        !Array.isArray(evidence)||!evidence.length||!validPoint(sourceStart)||!validPoint(sourceEnd)||
        !Array.isArray(coordinates)||coordinates.length<2||!coordinates.every(validPoint)||
        new Set(coordinates.map(pointKey)).size!==coordinates.length)
        throw Error('Invalid or duplicate reviewed Hydro centerline');
      replacements.set(id,entry);
    }
    result.set(region.datasetCode,{excluded,replacements});
  }
  return result;
}

export function applyReviewedHydroReaches(reaches, review) {
  if(!review||(!review.excluded.size&&!review.replacements.size))return reaches;
  const {excluded,replacements}=review;
  const previous=new Map(reaches.map(row=>[row.id,row]));
  for(const [id,system] of excluded){
    if(String(previous.get(id)?.mainRiver)!==system)
      throw Error('Reviewed Hydro exclusion is absent or belongs to another source system');
  }
  for(const [id,entry] of replacements){
    const old=previous.get(id);
    if(!old||String(old.mainRiver)!==entry.systemId||old.parts?.length!==1||
      !equal(start(old),entry.sourceStart)||!equal(end(old),entry.sourceEnd))
      throw Error('Reviewed Hydro centerline does not match the original reach: '+id);
  }
  const edited=reaches.filter(row=>!excluded.has(row.id)).map(row=>{
    const replacement=replacements.get(row.id);
    let next=row.next;
    if(excluded.has(next)){
      if(!row.endorheic)throw Error('Hydro exclusion would disconnect an outward-draining route: '+row.id);
      next=0;
    }
    if(!replacement)return next===row.next?row:{...row,next};
    return {...row,next,parts:[replacement.coordinates],originalEndpoint:replacement.coordinates.at(-1)};
  });
  const byId=new Map(edited.map(row=>[row.id,row]));
  const incoming=new Map();
  for(const row of edited){
    if(!replacements.has(row.next))continue;
    if(!incoming.has(row.next))incoming.set(row.next,[]);
    incoming.get(row.next).push(row);
  }
  for(const id of replacements.keys()){
    const before=previous.get(id),after=byId.get(id);
    if(!equal(start(before),start(after))){
      const tributaries=incoming.get(id)||[];
      if(!tributaries.length||tributaries.some(row=>!equal(end(row),start(after))))
        throw Error('Reviewed Hydro centerline disconnects its upstream junction: '+id);
    }
    if(!equal(end(before),end(after))){
      const downstream=byId.get(after.next);
      if(!downstream||!equal(end(after),start(downstream)))
        throw Error('Reviewed Hydro centerline disconnects its downstream junction: '+id);
    }
  }
  return edited;
}
