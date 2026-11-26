import {createHash} from 'node:crypto';
import {isDeepStrictEqual as equal} from 'node:util';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export const geometryDigest=geometry=>hash(JSON.stringify([geometry.type,geometry.coordinates]));
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const sourceBase='assets/data/territorial-entities/source/';
const fail=message=>{throw Error('GIS source admission: '+message);};
const descriptorPath=id=>sourceBase+'countries/'+id.replace(':','-')+'.json';
const seamMethod=mode=>typeof mode==='string'&&(/^exact-original-[a-z0-9]+-[a-z0-9]+-(?:readonly|bilateral)-counterpart-seam$/.test(mode)||/^exact-original-[a-z0-9]+-[a-z0-9]+-terminal-chord$/.test(mode));
const supplement=version=>version?.modernBoundarySupplement;
const otherVersionFields=({geometry,modernBoundarySupplement,validFrom,validTo,...rest}={})=>rest;
const seam=version=>seamMethod(supplement(version)?.adoptionMode)||!!supplement(version)?.seamReview;

export function sourceGeometryChanges(next,previous){
 if(previous&&next.entityId!==previous.entityId)fail('entity identity changed');
 const old=new Map((previous?.geometryVersions||[]).map(version=>[version.versionId,version]));
 const ids=new Set();
 const infoChanged=previous&&(next.sourceInfo?.geometrySha256!==previous.sourceInfo?.geometrySha256||next.sourceInfo?.geometryVersionId!==previous.sourceInfo?.geometryVersionId);
 const changes=[];
 for(const version of next.geometryVersions||[]){
  if(typeof version.versionId!=='string'||!version.versionId||ids.has(version.versionId))fail('missing or duplicate geometry version ID');
  ids.add(version.versionId);
  const prior=old.get(version.versionId);
  const geometryChanged=!prior||!equal(version.geometry,prior.geometry);
  const sourceChanged=!prior||!equal(supplement(version),supplement(prior));
  const historicalChanged=!prior||!equal(otherVersionFields(version),otherVersionFields(prior));
  const sourceInfoChanged=!!infoChanged&&(next.sourceInfo?.geometryVersionId===version.versionId||previous.sourceInfo?.geometryVersionId===version.versionId);
  if(geometryChanged||sourceChanged||historicalChanged||sourceInfoChanged)changes.push({version,prior,geometryChanged,sourceChanged,historicalChanged,sourceInfoChanged});
 }
 return changes;
}

function archivedReview(receipt,readEvidence){
 if(!receipt||!sha(receipt.sha256)||typeof receipt.reference!=='string'
   ||!/^reports\/(?:[\w.-]+\/)*[\w.-]+\.json$/.test(receipt.reference)
   ||receipt.reference.split('/').some(part=>part==='.'||part==='..')
   ||typeof readEvidence!=='function')fail('archived source review required');
 const bytes=readEvidence(receipt.reference);
 if(!Buffer.isBuffer(bytes)||hash(bytes)!==receipt.sha256)fail('source review bytes differ from receipt');
 try{return JSON.parse(bytes);}catch{fail('invalid source review JSON');}
}

function checkBilateral(review,receipt,entityId,version,geometrySha256,options){
 const code=entityId.split(':').at(-1),members=Object.entries(review.countries||{}),own=review.countries?.[code];
 const expected=review.method.split('-').slice(2,4).map(value=>value.toUpperCase()).sort();
 if(!equal(members.map(([member])=>member).sort(),expected)||new Set(expected).size!==2||!own||own.versionId!==version.versionId||own.domain!==geometrySha256)fail('bilateral review does not identify both candidates');
 // Check only the members of this operation, by descriptor (not coordinates).
 // A previously committed reciprocal side is valid; unrelated peers are not read.
 if(typeof options.readCandidateDescriptor!=='function')fail('bilateral candidate descriptors required');
 for(const [member,row] of members){
  if(!/^[A-Z0-9_-]+$/.test(member)||row.descriptor!==descriptorPath('state:'+member)||!sha(row.cas)||!sha(row.domain))fail('invalid bilateral member receipt');
  const descriptor=options.readCandidateDescriptor(row.descriptor);
  const candidate=descriptor?.geometryVersions?.find(v=>v.versionId===row.versionId);
  if(descriptor?.entityId!=='state:'+member||candidate?.geometryResource?.sha256!==row.cas
    ||candidate.modernBoundarySupplement?.geometrySha256!==row.domain
    ||!equal(candidate.modernBoundarySupplement?.seamReview,receipt))fail('bilateral candidate is missing or differs from receipt: '+member);
 }
 if(own.oldCAS!==undefined){
  if(typeof options.readPreviousDescriptor!=='function')fail('bilateral preimage descriptor required');
  const prior=options.readPreviousDescriptor(own.descriptor)?.geometryVersions?.find(v=>v.versionId===version.versionId);
  if(prior?.geometryResource?.sha256!==own.oldCAS)fail('bilateral previous geometry differs from receipt');
 }
}

/** Automatic admission checks only the actual changed source claim. Exact
 * donor replay, historical peer snapshots and topology diagnostics are
 * research-time evidence, not repeated storage-time requirements.
 * Returns the versions whose geometry/source claim was handled here. */
export function assertCommonSeamSourceChanges(next,previous,options={},changes=sourceGeometryChanges(next,previous)){
 const handled=new Set();
 for(const {version,prior,geometryChanged,sourceChanged,sourceInfoChanged} of changes){
  if(!geometryChanged&&!sourceChanged&&!sourceInfoChanged)continue;
  const s=supplement(version),before=supplement(prior);
  if(!seam(version)){
   if(seam(prior)&&!geometryChanged&&!s?.sourceAdoptionReview)
    fail('unchanged seam geometry cannot lose its source evidence');
   continue;
  }
  if(!seamMethod(s?.adoptionMode)||s.status!=='raw-source-only-not-display-approved'||s.wholeCountryRaw!==false)
   fail('seam evidence must describe a partial raw source, not display approval');
  const actual=geometryDigest(version.geometry);
  if(actual!==s.geometrySha256)fail('stale source geometry digest');
  if(next.sourceInfo?.geometryVersionId===version.versionId&&next.sourceInfo.geometrySha256!==undefined
    &&next.sourceInfo.geometrySha256!==actual)fail('representative source geometry digest differs');
  // Once admitted, a metadata-only change must not replay the historical job.
  if(!geometryChanged&&equal(s.seamReview,before?.seamReview)){
   if(s.adoptionMode!==before.adoptionMode||!equal(s.priorPreparedAttribution,before.priorPreparedAttribution))
    fail('existing source attribution changed without a new receipt');
   handled.add(version.versionId);continue;
  }
  if(!prior)fail('a seam adoption requires an existing geometry version');
  if(geometryChanged&&!equal(s.priorPreparedAttribution,before))fail('previous source attribution must be retained');
  const review=archivedReview(s.seamReview,options.readEvidence);
  if(review.method!==s.adoptionMode||(review.status!==undefined&&review.status!==s.status))fail('source review method/status differs');
  if(s.adoptionMode.endsWith('-bilateral-counterpart-seam')){
   checkBilateral(review,s.seamReview,next.entityId,version,actual,options);
  }else{
   // The exact candidate digest and identity are the only required geometry
   // claims. Older completed reviews may omit optional period/preimage fields.
   if(review.geometrySha256!==actual
     ||(review.entityId!==undefined&&review.entityId!==next.entityId)
     ||(review.versionId!==undefined&&review.versionId!==version.versionId)
     ||(review.previousGeometrySha256!==undefined&&review.previousGeometrySha256!==geometryDigest(prior.geometry)))
    fail('source review does not bind the selected geometry and preimage');
   if(review.entityId===undefined){
    const code=s.adoptionMode.split('-')[2];
    if(next.entityId.split(':').at(-1).toLowerCase()!==code)fail('source review does not identify this entity');
   }
  }
  if((review.validFrom!==undefined&&review.validFrom!==version.validFrom)
     ||(review.validTo!==undefined&&review.validTo!==version.validTo))fail('source review period differs');
  handled.add(version.versionId);
 }
 return handled;
}
