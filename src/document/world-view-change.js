// Small immutable receipt keyed by the exact accepted view identities.
// A receipt never owns its previous array (avoids retaining a history chain).
const tokens=new WeakMap(),changes=new WeakMap();
const token=rows=>{
 let value=tokens.get(rows);
 if(!value){value={};tokens.set(rows,value);}
 return value;
};
export function rememberWorldViewChange(previous,next,indices){
 if(previous===next)return;
 changes.set(next,{base:token(previous),indices:Object.freeze([...indices])});
}
export function worldViewChange(previous,next){
 if(previous===next)return [];
 const record=changes.get(next);
 return record&&record.base===tokens.get(previous)?record.indices:null;
}
