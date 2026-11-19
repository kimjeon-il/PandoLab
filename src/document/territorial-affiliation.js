import {normalizeTemporalInterval,temporalContains,temporalIntervalsOverlap,temporalMonthEnd} from "./temporal.js";

// A child's free-text relationship label is source metadata, not a second parent graph.
// The Core's dated parent relations alone decide whether a child has a parent.
export function normalizeAffiliationMetadata(raw={}) {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))
    throw new TypeError('Affiliation metadata must be an object.');
  const result=structuredClone(raw);
  const hasType=Object.hasOwn(result,'affiliationType');
  const hasHistory=Object.hasOwn(result,'affiliationTypeHistory');
  if(hasType&&hasHistory)throw new Error('Use either affiliationType or affiliationTypeHistory, not both.');
  if(hasType) {
    if(typeof result.affiliationType!=='string')throw new Error('Affiliation type must be a string.');
    result.affiliationType=result.affiliationType.trim();
  }
  if(hasHistory) {
    const history=result.affiliationTypeHistory;
    if(!Array.isArray(history)||!history.length)throw new Error('Affiliation type history must be nonempty.');
    result.affiliationTypeHistory=history.map((entry,i)=>{
      if(!entry||typeof entry!=='object'||Array.isArray(entry)
        ||Object.keys(entry).length!==3
        ||!['validFrom','validTo','type'].every(key=>Object.hasOwn(entry,key))
        ||typeof entry.type!=='string'||!entry.type.trim())
        throw new Error('Invalid affiliation type history entry: '+i);
      const {validFrom,validTo}=normalizeTemporalInterval(entry.validFrom,entry.validTo);
      return {validFrom,validTo,type:entry.type.trim()};
    });
    for(let i=0;i<result.affiliationTypeHistory.length;i++)
      for(let j=i+1;j<result.affiliationTypeHistory.length;j++)
        if(temporalIntervalsOverlap(result.affiliationTypeHistory[i],result.affiliationTypeHistory[j]))
          throw new Error('Overlapping affiliation type history.');
  }
  return result;
}

/** The month cursor means its last calendar day; history gaps are intentionally unclassified. */
export function affiliationTypeAt(metadata,month) {
  if(!metadata||typeof metadata!=='object')return '';
  const history=metadata.affiliationTypeHistory;
  if(Array.isArray(history)) {
    if(!month)return '';
    const date=temporalMonthEnd(month);
    const found=history.find(row=>temporalContains(row,date));
    return typeof found?.type==='string'?found.type.trim():'';
  }
  return typeof metadata.affiliationType==='string'?metadata.affiliationType.trim():'';
}
