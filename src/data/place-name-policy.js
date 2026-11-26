import { parseTemporal, sharedCalculationCore, temporalMonthEnd } from "../document/temporal.js";
import { DEFAULT_PLACE_LANGUAGES } from "../document/place-contract.js";

/** Shared period projection. No evidence exists here for builtin places in BCE. */
export function placeLabelRowsAtMonth(place, month, languages = DEFAULT_PLACE_LANGUAGES) {
  if (String(month || '').startsWith('-')) return [];
  const date = typeof month === 'string' && /^\d{4}-\d{2}$/.test(month) ? temporalMonthEnd(month).canonical : null;
  return resolvePlaceLabelRows(place, languages, date);
}

/** Select period-appropriate names, then suppress duplicate visual text across all languages. */
export function resolvePlaceLabelRows(place, languages = DEFAULT_PLACE_LANGUAGES, mapDate = null,
  sourceReferenceDate = new Date().toISOString().slice(0, 10)) {
  if (mapDate != null && !/^\d{4}-\d{2}-\d{2}$/u.test(mapDate)) throw new TypeError('Invalid map label date');
  if (typeof sharedCalculationCore.placeNameRows !== 'function') throw new Error('Required place naming capability is unavailable');
  const reference = mapDate == null ? null : parseTemporal(sourceReferenceDate, { nullable: false });
  if (reference && reference.precision !== 'date') throw new TypeError('Invalid place name reference date');
  // The current year uses the published current names, including earlier months.
  const historicalCutoff = reference?.canonical.replace(/-\d{2}-\d{2}$/u, '-01-01') || '';
  const rows = [], seen = new Set();
  const add = (language, value, modernName) => {
    const name = String(value || '').trim(), key = name.normalize('NFKC').toLocaleLowerCase();
    if (name && !seen.has(key)) { seen.add(key); rows.push(Object.freeze({ language,
      text: (modernName ? '(현)' : '') + name, modernName })); }
  };
  for (const row of sharedCalculationCore.placeNameRows(place, languages || {}, mapDate || '', historicalCutoff)) {
    add(row.language, row.text, row.modernName);
  }
  return rows;
}

// Normalized place records and their timelines are immutable. Cache the
// effective naming interval, not every calendar month. Core still resolves
// the exact spelling and historical-prefix policy on interval changes.
const mapNameCache=new WeakMap();
function mapNamingInterval(place,month,showNativeNames){
 if(!place||!Object.isFrozen(place)||!Array.isArray(place.nameTimeline)||!Object.isFrozen(place.nameTimeline)||
  place.nameTimeline.some(row=>!Object.isFrozen(row)))return null;
 const value=String(month??'');
 if(value.startsWith('-'))return 'bce:'+Number(showNativeNames);
 if(!/^\d{4}-\d{2}$/.test(value))return 'reference:'+Number(showNativeNames);
 if(!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(value)||value.startsWith('0000'))return null;
 const cutoff=String(new Date().getUTCFullYear()).padStart(4,'0')+'-01';
 let reached=0;
 for(const row of place.nameTimeline){
  const boundary=row.fromDate?row.fromDate.slice(0,7):String(row.fromYear).padStart(4,'0')+'-01';
  if(value<boundary)break;reached++;
 }
 return cutoff+':'+Number(value<cutoff)+':'+reached+':'+Number(showNativeNames);
}

/** Rows of a single map symbol, starting with the mandatory Korean name. */
export function mapPlaceLabelRowsAtMonth(place, month, { showNativeNames = false } = {}) {
  const key=mapNamingInterval(place,month,showNativeNames);
  const cached=key!==null?mapNameCache.get(place):null;
  if(cached?.key===key)return cached.rows;
  const rows = placeLabelRowsAtMonth(place, month, { ko: true });
  if (rows.length&&showNativeNames) {
    // Query native-only so identical Korean/native names do not promote a
    // second co-official name to the primary native position.
    const primaryNative=placeLabelRowsAtMonth(place,month,{native:true})[0];
    const normalized=text=>String(text||'').replace(/^\(현\)/u,'').normalize('NFKC').toLocaleLowerCase();
    if(primaryNative&&!rows.some(row=>normalized(row.text)===normalized(primaryNative.text)))rows.push(primaryNative);
  }
  if(key!==null){Object.freeze(rows);mapNameCache.set(place,{key,rows});}
  return rows;
}
