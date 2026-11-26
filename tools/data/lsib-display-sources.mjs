import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {MINOR_OUTLYING_ISLAND_FEATURE_IDS} from '../../src/data/world-bundle-manifest.js';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

function readProof(read,reference,sha256){
 const bytes=read(reference);
 if(digest(bytes)!==sha256)throw Error('LSIB source mapping evidence differs: '+reference);
 return JSON.parse(reference.endsWith('.gz')?gunzipSync(bytes):bytes);
}

export function approvedLsibSource({sourceId,review},read){
 if(review){
  const reference=review.source?.reference??'';
  const ids=review.featureIds??(review.featureId?[review.featureId]:[]);
  const divisionSource=review.divisionSource??(reference.includes('-partitions/')?review.source:null);
  if(divisionSource){
   if(!read)return {wpIds:[]};
   const evidence=readProof(read,divisionSource.reference,divisionSource.sha256);
   const division=evidence.partitions?.find(row=>row.featureId===ids[0]
    &&(row.ownerEntityId===sourceId||row.memberEntityId===sourceId));
   if(ids.length!==1||!division)return {wpIds:[]};
   return {wpIds:ids,division:{...division,
    side:division.ownerEntityId===sourceId?'owner':'member',source:divisionSource}};
  }
  if(!reference.includes('-reviewed/'))return {wpIds:ids};
  if(!read)return {wpIds:[]};
  const evidence=readProof(read,reference,review.source.sha256);
  const current=evidence.current?.find(candidate=>candidate.entityId===(review.sourceMemberEntityId??sourceId)
   &&candidate.outcome==='candidate'&&candidate.ownerSourceEntityId===sourceId);
  if(!current||ids.length!==1||current.candidateIds?.length!==1||current.candidateIds[0]!==ids[0])
   return {wpIds:[]};
  if(current.entityId===sourceId&&!current.ownerFeatureId)return {wpIds:ids};
  if(current.entityId===review.sourceMemberEntityId&&current.ownerFeatureId)
   return {wpIds:[current.ownerFeatureId,...ids]};
  return {wpIds:[]};
 }
 const code=sourceId.startsWith('state:')?sourceId.slice(6):'';
 if(!read||!MINOR_OUTLYING_ISLAND_FEATURE_IDS.includes(code))return {wpIds:[]};
 const descriptor=JSON.parse(read('assets/data/territorial-entities/source/countries/state-'+code+'.json'));
 const {originalFeature,sourceReview}=descriptor.sourceInfo??{};
 if(descriptor.entityId!==sourceId||originalFeature?.genc!==code||!sourceReview)return {wpIds:[]};
 const evidence=readProof(read,sourceReview.path,sourceReview.sha256);
 const selected=evidence.features?.find(row=>row.feature?.genc===code);
 if(evidence.sourceLayer!=='DoS_WP_11_4_G99_5'||!selected||selected.id!==originalFeature.id
  ||selected.feature.wkbSha256!==originalFeature.wkbSha256)return {wpIds:[]};
 return {wpIds:[selected.id]};
}
