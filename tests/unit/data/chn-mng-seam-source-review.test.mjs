import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {assertChnMngSeamReplay as gate,hasChnMngSeam,chnMngSeamMethod as method,chnMngSeamRelation as relation} from '../../../tools/gis/chn-mng-seam-source-review.mjs';
import {replayRetainedCoast,exactCyclicChain,sharedExactEdges} from '../../../tools/gis/retained-coast-source-review.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex'),digest=g=>hash(JSON.stringify([g.type,g.coordinates]));
const versionId='state:CHN:paektu-lsib-11.4',status='raw-source-only-not-display-approved';
const pin='7'.repeat(40),reference='reports/borders/validation/modern-raw-source-20261110/chn-mng-test/review.json';
const polygon=ring=>({coordinates:[ring],type:'Polygon'});
const prepared={adoptionMode:'lossless-original-shared-arc',priorReview:{points:3580}};
const base='assets/data/territorial-entities/source/';
const india=polygon([[0,0],[1,0],[2,0],[2,2],[0,2],[0,0]]);
const source=polygon([[0,0],[1,0.5],[2,0],[2,2],[0,2],[0,0]]);
const bangladesh=polygon([[2,0],[1,0.5],[0,0],[0,-1],[2,-1],[2,0]]);
const other=polygon([[10,10],[12,10],[12,12],[10,12],[10,10]]);
function fixture({ind=india,raw=bangladesh,bgd=bangladesh}={}){
 const entity={entityId:'state:CHN',metadata:{representativeGeometryVersionId:versionId},sourceInfo:{geometryVersionId:versionId,geometrySha256:digest(ind),attribution:'protected'},geometryVersions:[{versionId,validFrom:null,validTo:null,geometry:ind,modernBoundarySupplement:structuredClone(prepared)}]};
 const next=structuredClone(entity);
 const mngArc={polygonIndex:0,ringIndex:0,startIndex:2,endIndex:0,direction:-1}; const operations=[{polygonIndex:0,ringIndex:0,startIndex:0,endIndex:2,raw:mngArc}],ringStarts=[{polygonIndex:0,ringIndex:0,startIndex:0}];
 const peers=new Map(['AFG','BTN','IND','KAS','KAZ','KOR','LAO','MMR','MNG','NPL','PAK','PRK','RUS','TWN','VNM'].map(c=>[c,c==='MNG'?bgd:other]));
 const draft={geometry:structuredClone(source),operations,ringStarts,peers,mngArc};
 function compile(){
  const geometrySha256=digest(draft.geometry),geometryResourceSha256=hash(JSON.stringify(draft.geometry)+'\n');
  const r={schemaVersion:1,method,status,sourcePin:pin,entityId:entity.entityId,versionId,validFrom:null,validTo:null,previousGeometrySha256:digest(ind),
   originalGeometrySha256:digest(raw),geometrySha256,geometryResourceSha256,operations:draft.operations,ringStarts:draft.ringStarts,mngArc:draft.mngArc,
   peerGeometrySha256:Object.fromEntries([...draft.peers].map(([c,g])=>[c,digest(g)]))};
  const reviewBytes=Buffer.from(JSON.stringify(r)),binding={sourcePin:pin,review:{reference,sha256:hash(reviewBytes)},operation:operations[0],ringStart:ringStarts[0],mngArc};
  next.geometryVersions[0].geometry=draft.geometry;
  next.geometryVersions[0].modernBoundarySupplement={adoptionMode:method,status,resultRelation:relation,wholeCountryRaw:false,priorPreparedAttribution:structuredClone(prepared),geometrySha256,seamReview:binding.review};
  next.sourceInfo.geometrySha256=geometrySha256;
  const options={prefixes:[base+'countries/state-CHN.json',base+'geometries/sha256-'+geometryResourceSha256+'.json'],readEvidence:p=>{assert.equal(p,reference);return reviewBytes;},
   binding,originalGeometry:raw,peers:draft.peers,replayRetainedCoast,exactCyclicChain,sharedExactEdges};
  return {entity,next,options};
 }
 return {draft,compile};
}
const invoke=f=>{const {entity,next,options}=f.compile();return gate(next,entity,options);};

test('accepts one exact frozen CHN mainland arc and a read-only reverse MNG seam',()=>{
 const f=fixture();
 const {entity,next,options}=f.compile();
 assert.equal(hasChnMngSeam(entity),false);
 assert.equal(hasChnMngSeam(next),true);
 assert.equal(gate(next,entity,options),1);
});

test('rejects immutable evidence drift, peer writes, metadata and supplement edits',()=>{
 const mutations=[
  x=>{x.options.readEvidence=()=>Buffer.from('{}');},
  x=>{x.options.prefixes.push(base+'countries/state-MNG.json');},
  x=>{x.options.peers=new Map(x.options.peers).set('MNG',other);},
  x=>{x.next.sourceInfo.attribution='altered';},
  x=>{x.next.geometryVersions[0].validFrom='1999-01-01';},
  x=>{x.next.geometryVersions[0].modernBoundarySupplement.priorPreparedAttribution.priorReview.points=12;},
 ];
 for(const mutate of mutations){const x=fixture().compile();mutate(x);assert.throws(()=>gate(x.next,x.entity,x.options),/CHN\/MNG exact current seam/);}
});

test('rejects unpaired MNG raw edge and out-of-scope edits even with self-consistent digests',()=>{
 const wrongPeer=fixture({bgd:polygon([[2,0],[1,0.6],[0,0],[0,-1],[2,-1],[2,0]])});
 assert.throws(()=>invoke(wrongPeer),/must be the exact official raw geometry/);
 const wrongOutside=fixture();
 wrongOutside.draft.geometry.coordinates[0][3]=[2,2.1];
 assert.throws(()=>invoke(wrongOutside),/candidate must equal exact replay/);
 const otherContact=fixture();
 otherContact.draft.peers.set('PAK',polygon([[0,0],[1,0.5],[1,1],[0,0]]));
 assert.throws(()=>invoke(otherContact),/protected shared edges changed for PAK/);
});

