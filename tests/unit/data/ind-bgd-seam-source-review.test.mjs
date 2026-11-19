import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {assertIndBgdSeamReplay as gate,hasIndBgdSeam,indBgdSeamMethod as method,indBgdSeamRelation as relation} from '../../../tools/gis/ind-bgd-seam-source-review.mjs';
import {replayRetainedCoast,exactCyclicChain,sharedExactEdges} from '../../../tools/gis/retained-coast-source-review.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex'),digest=g=>hash(JSON.stringify([g.type,g.coordinates]));
const versionId='state:IND:natural-earth-5.1.1',status='raw-source-only-not-display-approved';
const pin='7'.repeat(40),reference='reports/borders/validation/modern-raw-source-20261110/ind-bgd-test/review.json';
const polygon=ring=>({coordinates:[ring],type:'Polygon'});
const prepared={adoptionMode:'exact-original-retained-coast-arcs-current-batch',coastProof:{points:3580}};
const base='assets/data/territorial-entities/source/';
const india=polygon([[0,0],[1,0],[2,0],[2,2],[0,2],[0,0]]);
const source=polygon([[0,0],[1,0.5],[2,0],[2,2],[0,2],[0,0]]);
const bangladesh=polygon([[2,0],[1,0.5],[0,0],[0,-1],[2,-1],[2,0]]);
const other=polygon([[10,10],[12,10],[12,12],[10,12],[10,10]]);
function fixture({ind=india,raw=source,bgd=bangladesh,holePolicy,holeReceipt}={}){
 const entity={entityId:'state:IND',metadata:{representativeGeometryVersionId:versionId},sourceInfo:{geometryVersionId:versionId,geometrySha256:digest(ind),attribution:'protected'},geometryVersions:[{versionId,validFrom:null,validTo:null,geometry:ind,modernBoundarySupplement:structuredClone(prepared)}]};
 const next=structuredClone(entity);
 const operations=[{polygonIndex:0,ringIndex:0,startIndex:0,endIndex:2,raw:{polygonIndex:0,ringIndex:0,startIndex:0,endIndex:2,direction:1}}],ringStarts=[{polygonIndex:0,ringIndex:0,startIndex:0}];
 const peers=new Map(['AFG','BGD','BTN','CHN','KAS','LKA','MDV','MMR','NPL','PAK'].map(c=>[c,c==='BGD'?bgd:other]));
 const draft={geometry:structuredClone(raw),operations,ringStarts,peers};
 function compile(){
  const geometrySha256=digest(draft.geometry),geometryResourceSha256=hash(JSON.stringify(draft.geometry)+'\n');
  const r={schemaVersion:1,method,status,sourcePin:pin,entityId:entity.entityId,versionId,validFrom:null,validTo:null,previousGeometrySha256:digest(ind),
   originalGeometrySha256:digest(raw),geometrySha256,geometryResourceSha256,operations:draft.operations,ringStarts:draft.ringStarts,
   ...(holeReceipt?{hole:holeReceipt}:{}),peerGeometrySha256:Object.fromEntries([...draft.peers].map(([c,g])=>[c,digest(g)]))};
  const reviewBytes=Buffer.from(JSON.stringify(r)),binding={sourcePin:pin,review:{reference,sha256:hash(reviewBytes)},targetPolygonIndex:0,originalPolygonIndex:0,...(holePolicy?{hole:holePolicy}:{})};
  next.geometryVersions[0].geometry=draft.geometry;
  next.geometryVersions[0].modernBoundarySupplement={adoptionMode:method,status,resultRelation:relation,wholeCountryRaw:false,priorPreparedAttribution:structuredClone(prepared),geometrySha256,seamReview:binding.review};
  next.sourceInfo.geometrySha256=geometrySha256;
  const options={prefixes:[base+'countries/state-IND.json',base+'geometries/sha256-'+geometryResourceSha256+'.json'],readEvidence:p=>{assert.equal(p,reference);return reviewBytes;},
   binding,originalGeometry:raw,peers:draft.peers,replayRetainedCoast,exactCyclicChain,sharedExactEdges};
  return {entity,next,options};
 }
 return {draft,compile};
}
const invoke=f=>{const {entity,next,options}=f.compile();return gate(next,entity,options);};

test('accepts one exact frozen IND mainland arc and a read-only reverse BGD seam',()=>{
 const f=fixture();
 const {entity,next,options}=f.compile();
 assert.equal(hasIndBgdSeam(entity),false);
 assert.equal(hasIndBgdSeam(next),true);
 assert.equal(gate(next,entity,options),1);
});

test('rejects immutable evidence drift, peer writes, metadata and supplement edits',()=>{
 const mutations=[
  x=>{x.options.readEvidence=()=>Buffer.from('{}');},
  x=>{x.options.prefixes.push(base+'countries/state-BGD.json');},
  x=>{x.options.peers=new Map(x.options.peers).set('BGD',other);},
  x=>{x.next.sourceInfo.attribution='altered';},
  x=>{x.next.geometryVersions[0].validFrom='1999-01-01';},
  x=>{x.next.geometryVersions[0].modernBoundarySupplement.priorPreparedAttribution.coastProof.points=12;},
 ];
 for(const mutate of mutations){const x=fixture().compile();mutate(x);assert.throws(()=>gate(x.next,x.entity,x.options),/IND\/BGD exact current seam/);}
});

test('rejects unpaired BGD raw edge and out-of-scope edits even with self-consistent digests',()=>{
 const wrongPeer=fixture({bgd:polygon([[2,0],[1,0.6],[0,0],[0,-1],[2,-1],[2,0]])});
 assert.throws(()=>invoke(wrongPeer),/not in frozen Bangladesh/);
 const wrongOutside=fixture();
 wrongOutside.draft.geometry.coordinates[0][3]=[2,2.1];
 assert.throws(()=>invoke(wrongOutside),/candidate must equal exact replay/);
 const otherContact=fixture();
 otherContact.draft.peers.set('PAK',polygon([[0,0],[1,0.5],[1,1],[0,0]]));
 assert.throws(()=>invoke(otherContact),/protected shared edges changed for PAK/);
});

const oldHole=[[0.5,1],[0.5,1.5],[1,1.5],[1,1],[0.5,1]];
const rawHole=[[1,1],[1,1.5],[0.5,1.5],[0.5,1.25],[0.5,1],[1,1]];
const exactAnchoredHole=[[0.5,1],[0.5,1.25],[0.5,1.5],[1,1.5],[1,1],[0.5,1]];
const holePolicy={targetRingIndex:1,originalRingIndex:1,bgdPolygonIndex:1,oldVertexCount:4,newVertexCount:5};
const holeReceipt={...holePolicy,rawStartIndex:4,rawDirection:-1};
function enclave({ind={...india,coordinates:[india.coordinates[0],oldHole]},p=holePolicy,r=holeReceipt,peer=rawHole}={}){
 const f=fixture({ind,raw:{...source,coordinates:[source.coordinates[0],rawHole]},
  bgd:{type:'MultiPolygon',coordinates:[bangladesh.coordinates,[peer]]},holePolicy:p,holeReceipt:r});
 f.draft.geometry.coordinates[1]=structuredClone(exactAnchoredHole);
 return f;
}

test('admits exactly one existing enclave ring with frozen BGD membership and inherited vertex order',()=>{
 assert.equal(invoke(enclave()),1);
});

test('rejects hidden new holes, added components, arbitrary replottings, and missing or reordered old anchors',()=>{
 assert.throws(()=>invoke(enclave({ind:india})),/bounded old, raw, and frozen Bangladesh ring/);
 const extra=enclave();extra.draft.geometry.coordinates.push([[0.7,1],[0.7,1.1],[0.8,1.1],[0.7,1]]);
 assert.throws(()=>invoke(extra),/exact replay/);
 const wrong=enclave({peer:oldHole});
 assert.throws(()=>invoke(wrong),/complete exact frozen Bangladesh enclave boundary/);
 const m=enclave({r:{...holeReceipt,rawDirection:1}});
 assert.throws(()=>invoke(m),/must remain in order/);
 const n=enclave({r:{...holeReceipt,rawStartIndex:3}});
 assert.throws(()=>invoke(n),/ring start vertex not preserved/);
 const a=enclave({p:null});
 assert.throws(()=>invoke(a),/unexpected additional ring/);
});

