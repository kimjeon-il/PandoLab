import {Linter} from 'eslint';

// GeoJSON-VT 6.3.1's existing tile generator supplies projected, clipped
// features. Derive only the tile output, leaving its index/source untouched.
export function simplifySharedTileGeometry(features,z,tx,ty,options){
 if(!Array.isArray(features)||!features.length||options?.tolerance!==0
  ||options.cluster||(options.coordinates&&options.coordinates!=='lngLat')
  ||!Number.isInteger(z)||z<0||z>10||z>=options.maxZoom)return features;
 const physical=z<=6&&['physical-land','physical-water'].includes(features[0].tags?.displayRole);
 if(!physical&&options.promoteId!=='objectKey')return features;
 const physicalRole=physical?features[0].tags.displayRole:null;
 const scale=2**z,px=1/(512*scale),tol2=(0.25*px)**2,cell=16*px;
 // Overview tiles can consider longer subpixel shortcuts and borderless
 // shared fill edges, without relaxing the existing error bound.
 const overview=z<=4,extended=z<=6,maxSpan=(overview?16:8)*px;
 const west=tx/scale,east=(tx+1)/scale,north=ty/scale,south=(ty+1)/scale;
 const polar=0.5-Math.log((1+Math.sin(84*Math.PI/180))/(1-Math.sin(84*Math.PI/180)))/(4*Math.PI);
 const EPS=1e-14,MAX_POINTS=1000000,MAX_CANDIDATES=16384,MAX_CANDIDATES_PER_CELL=64,MAX_CHECKS=6000000;
 const records=[],candidates=new Map(),candidateCounts=new Uint8Array(1024);let points=0,checks=0;
 const point=(p,i)=>[p[i],p[i+1]],key=p=>p[0]+','+p[1],same=(a,b)=>a[0]===b[0]&&a[1]===b[1];
 const ends=(a,c,u,v)=>same(a,u)&&same(c,v)||same(a,v)&&same(c,u);
 const safeWest=Math.max(4*px,west+4*px),safeEast=Math.min(1-4*px,east-4*px),
  safeNorth=Math.max(polar,north+4*px),safeSouth=Math.min(1-polar,south-4*px);
 const safeXY=(x,y)=>x>safeWest&&x<safeEast&&y>safeNorth&&y<safeSouth;
 const safe=p=>safeXY(p[0],p[1]);
 function eachRing(feature,visit){
  const g=feature.geometry;
  switch(feature.type){
   case 'LineString':visit(g,false);return;
   case 'MultiLineString':g.forEach(line=>visit(line,false));return;
   case 'Polygon':g.forEach((line,i)=>visit(line,i!==0));return;
   case 'MultiPolygon':g.forEach(poly=>poly.forEach((line,i)=>visit(line,i!==0)));return;
  }
 }
 for(const feature of features){
  const role=feature.tags?.displayRole;
  if(physical?role!==physicalRole:role!=='country-fill'&&role!=='country-border')return features;
  if(role!=='country-border'&&!['Polygon','MultiPolygon'].includes(feature.type)
   ||role==='country-border'&&!['LineString','MultiLineString'].includes(feature.type))return features;
  eachRing(feature,(ring,hole)=>{
   points+=(ring?.points?.length??0)/3;
   records.push({ring,hole,role,id:feature.id});
  });
  if(points>MAX_POINTS)return features;
 }
 // Prioritize actual shared strokes, then consider borderless fill pairs.
 // Bound proposals in dense overview cells, rather than discarding a tile
 // when its candidate capacity is reached. Every admitted candidate still
 // passes all occurrence and crossing checks, including unproposed edges.
 function propose(ring){
  const p=ring.points;
  for(let i=3;i+3<p.length;i+=3){
   if(!safeXY(p[i],p[i+1]))continue;
   const b=point(p,i),slot=Math.floor((b[1]-north)/cell)*32+Math.floor((b[0]-west)/cell);
   if(candidates.size>=MAX_CANDIDATES||extended&&candidateCounts[slot]>=MAX_CANDIDATES_PER_CELL)continue;
   const id=key(b);
   if(candidates.has(id))continue;
   const a=point(p,i-3),c=point(p,i+3);
   if(!safe(a)||!safe(c)||same(a,b)||same(b,c)||same(a,c))continue;
   const dx=c[0]-a[0],dy=c[1]-a[1],length=dx*dx+dy*dy;
   const collinear=(b[0]-a[0])*dy===(b[1]-a[1])*dx;
   if(physical&&!collinear)continue;
   const t=((b[0]-a[0])*dx+(b[1]-a[1])*dy)/length;
   if(!(t>0&&t<1))continue;
   const error=(b[0]-a[0]-t*dx)**2+(b[1]-a[1]-t*dy)**2;
   const minX=Math.min(a[0],b[0],c[0]),maxX=Math.max(a[0],b[0],c[0]),minY=Math.min(a[1],b[1],c[1]),maxY=Math.max(a[1],b[1],c[1]);
   if(error>tol2||maxX-minX>maxSpan||maxY-minY>maxSpan)continue;
   // A single-owner shortcut preserves the exact projected segment.
   candidates.set(id,{id,a,b,c,error,collinear,minX,minY,maxX,maxY,invalid:false,fills:[],borders:0,occurrences:[]});
   if(extended)candidateCounts[slot]++;
  }
 }
 for(const {ring,role} of records)if(role==='country-border')propose(ring);
 if(extended)for(const {ring,role,hole} of records)
  if(role!=='country-border'&&!hole&&ring.points.length>=24&&ring.size>16*px*px)propose(ring);
 if(!candidates.size)return features;
 // Match every occurrence of the vertex, including endpoints, holes and
 // other owners. Require two distinct, oppositely traversed exterior rings.
 for(const {ring,hole,role,id} of records){
  const p=ring.points;
  for(let i=0;i<p.length;i+=3){
   if(!safeXY(p[i],p[i+1]))continue;
   const candidate=candidates.get(p[i]+','+p[i+1]);
   if(!candidate||candidate.invalid)continue;
   if(i===0||i+3===p.length){candidate.invalid=true;continue;}
   const a=point(p,i-3),c=point(p,i+3);
   if(!ends(candidate.a,candidate.c,a,c)){candidate.invalid=true;continue;}
   if(role!=='country-border'){
    if(hole||p.length<24||!(ring.size>16*px*px)){candidate.invalid=true;continue;}
    candidate.fills.push({id,forward:same(candidate.a,a)});
    if(candidate.fills.length>2){candidate.invalid=true;continue;}
   }else candidate.borders++;
   candidate.occurrences.push({ring,i});
  }
 }
 const eligible=[...candidates.values()].filter(v=>!v.invalid&&(
  (!physical&&(extended||v.borders>0)&&v.fills.length===2
   &&v.fills[0].id!==v.fills[1].id&&v.fills[0].forward!==v.fills[1].forward)
  ||(extended&&v.collinear&&!v.borders&&v.fills.length===1)));
 if(!eligible.length)return features;
 // Spatially index the small changed rectangles, not the millions of
 // original edges. An unrelated edge entering one means no simplification.
 const grid=Array.from({length:1024},()=>[]);
 const range=(min,max,origin)=>[Math.max(0,Math.floor((min-origin-EPS)/cell)),Math.min(31,Math.floor((max-origin+EPS)/cell))];
 function buckets(box,visit){
  const [x0,x1]=range(box.minX,box.maxX,west),[y0,y1]=range(box.minY,box.maxY,north);
  for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
   if(++checks>MAX_CHECKS)return false;
   visit(grid[y*32+x]);
  }
  return true;
 }
 for(const v of eligible)if(!buckets(v,rows=>rows.push(v)))return features;
 const overlap=(a,b)=>a.minX<=b.maxX+EPS&&a.maxX+EPS>=b.minX&&a.minY<=b.maxY+EPS&&a.maxY+EPS>=b.minY;
 function leavesAtEndpoint(v,a,b){
  if(!same(a,v.a)&&!same(a,v.c))return false;
  return a[0]===v.minX&&b[0]<v.minX-EPS||a[0]===v.maxX&&b[0]>v.maxX+EPS
   ||a[1]===v.minY&&b[1]<v.minY-EPS||a[1]===v.maxY&&b[1]>v.maxY+EPS;
 }
 function intersects(v,a,b){
  let lo=0,hi=1;
  for(const [axis,min,max] of [[0,v.minX-EPS,v.maxX+EPS],[1,v.minY-EPS,v.maxY+EPS]]){
   const d=b[axis]-a[axis];
   if(d===0){if(a[axis]<min||a[axis]>max)return false;continue;}
   const s=(min-a[axis])/d,t=(max-a[axis])/d;
   lo=Math.max(lo,Math.min(s,t));hi=Math.min(hi,Math.max(s,t));
   if(lo>hi+EPS)return false;
  }
  return true;
 }
 let edgeSerial=0;
 for(const {ring} of records){
  const p=ring.points;
  for(let i=3;i<p.length;i+=3){
   const a=point(p,i-3),b=point(p,i);
   const box={minX:Math.min(a[0],b[0]),maxX:Math.max(a[0],b[0]),minY:Math.min(a[1],b[1]),maxY:Math.max(a[1],b[1])};
   const serial=++edgeSerial;
   if(!buckets(box,rows=>{
    for(const v of rows){
     if(v.invalid||v.seen===serial)continue;
     v.seen=serial;
     if(++checks>MAX_CHECKS)return;
     if(!overlap(v,box)||ends(a,b,v.a,v.b)||ends(a,b,v.b,v.c)
      ||leavesAtEndpoint(v,a,b)||leavesAtEndpoint(v,b,a)||!intersects(v,a,b))continue;
     v.invalid=true;
    }
   })||checks>MAX_CHECKS)return features;
  }
 }
 // Independent triangles only: adjacent removals and overlapping shortcuts
 // are forbidden. Stable error/coordinate order makes the choice repeatable.
 eligible.sort((a,b)=>a.error-b.error||(a.id<b.id?-1:a.id>b.id?1:0));
 const removals=new Map();
 for(const v of eligible){
  if(v.invalid||v.blocked)continue;
  for(const {ring,i} of v.occurrences){
   let indices=removals.get(ring);if(!indices)removals.set(ring,indices=new Set());indices.add(i);
  }
  if(!buckets(v,rows=>{for(const other of rows)if(other!==v&&overlap(v,other))other.blocked=true;}))return features;
 }
 if(!removals.size)return features;
 const derived=new Map();
 for(const [ring,indices] of removals){
  const p=ring.points,out=ArrayBuffer.isView(p)?new Float64Array(p.length-3*indices.size):new Array(p.length-3*indices.size);
  let at=0;
  for(let i=0;i<p.length;i+=3)if(!indices.has(i)){out[at++]=p[i];out[at++]=p[i+1];out[at++]=p[i+2];}
  derived.set(ring,{...ring,points:out});
 }
 const line=ring=>derived.get(ring)??ring;
 const lines=rows=>rows.some(row=>derived.has(row))?rows.map(line):rows;
 return features.map(feature=>{
  const g=feature.geometry;
  let geometry=g;
  if(feature.type==='LineString')geometry=line(g);
  else if(feature.type==='Polygon'||feature.type==='MultiLineString')geometry=lines(g);
  else if(feature.type==='MultiPolygon'&&g.some(poly=>poly.some(ring=>derived.has(ring))))geometry=g.map(lines);
  return geometry===g?feature:{...feature,geometry,tags:{...feature.tags,pandoDisplayLod:1}};
 });
}

// The locked dependency's constructor is identified structurally, never by
// minified variable names. A missing/ambiguous hook stops vendor publication.
export function patchMapLibreTopologyLod(source){
 if(!source.includes('numSimplified')||!source.includes('numFeatures'))return {source,matches:0};
 const parser=new Linter(),errors=parser.verify(source,{languageOptions:{ecmaVersion:'latest',sourceType:'module'}});
 if(errors.some(error=>error.fatal))throw Error('MapLibre topology LOD vendor parse failed: '+errors.find(e=>e.fatal).message);
 const code=parser.getSourceCode(),matches=[];
 function visit(node){
  if(!node||typeof node!=='object')return;
  if(['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(node.type)
    &&node.body?.type==='BlockStatement'&&node.params.length===5&&node.params.every(p=>p.type==='Identifier')){
   const candidates=node.body.body.flatMap(statement=>statement.type==='VariableDeclaration'?statement.declarations.map(d=>d.init):[]);
   const tile=candidates.find(value=>value?.type==='ObjectExpression'&&['transformed','source','features','numPoints','numSimplified','numFeatures'].every(name=>
    value.properties.some(p=>p.type==='Property'&&(p.key.name??p.key.value)===name)));
   if(tile){
    const count=tile.properties.find(p=>(p.key.name??p.key.value)==='numFeatures')?.value;
    if(count?.type==='MemberExpression'&&count.object.name===node.params[0].name&&count.property.name==='length'
     &&source.slice(node.body.range[0],node.body.range[1]).includes('.maxZoom'))matches.push(node);
   }
  }
  for(const name of code.visitorKeys[node.type]||[])for(const child of Array.isArray(node[name])?node[name]:[node[name]])visit(child);
 }
 visit(code.ast);
 if(matches.length!==1)return {source,matches:matches.length};
 const node=matches[0],args=node.params.map(p=>p.name),at=node.body.range[0]+1;
 return {matches:1,source:'const pandoSimplifySharedTileGeometry=('+simplifySharedTileGeometry.toString()+');\n'
  +source.slice(0,at)+args[0]+'=pandoSimplifySharedTileGeometry('+args.join(',')+');'+source.slice(at)};
}
