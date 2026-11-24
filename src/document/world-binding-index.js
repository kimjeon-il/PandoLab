import {compareTemporalKeys,temporalFollowingDay} from './temporal.js';

// Exact Core calendar keys, inclusive lower and exclusive upper bounds.
// Every source-binding boundary is conservative: even overlapping or
// absent bindings retain their existing first-match precedence.
export function sourceBindingCertificate(candidates,date,intervalFor){
 const key=date.endKey;
 let selected=null,start=null,end=null;
 function boundary(value){
  if(!value)return;
  if(compareTemporalKeys(value,key)<=0){
   if(!start||compareTemporalKeys(start,value)<0)start=value;
  }else if(!end||compareTemporalKeys(value,end)<0)end=value;
 }
 for(const row of candidates){
  const interval=intervalFor(row),low=interval.start?.startKey??null,high=interval.end?.endKey??null;
  boundary(low);
  if(high){
   row.followingEnd??=temporalFollowingDay(high);
   boundary(row.followingEnd);
  }
  if(!selected&&(!low||compareTemporalKeys(low,key)<=0)&&(!high||compareTemporalKeys(key,high)<=0))selected=row;
 }
 return {selected,range:{start,end}};
}
const later=(a,b)=>!a?b:!b?a:compareTemporalKeys(a,b)<0?b:a;
const earlier=(a,b)=>!a?b:!b?a:compareTemporalKeys(a,b)<0?a:b;
const valid=(node,key)=>(!node.start||compareTemporalKeys(node.start,key)<=0)&&(!node.end||compareTemporalKeys(key,node.end)<0);
function combine(left,right){
 return {start:later(left.start,right.start),end:earlier(left.end,right.end),left,right};
}
function build(ranges,lo,hi){
 if(hi-lo===1)return ranges[lo];
 const middle=lo+Math.floor((hi-lo)/2);
 return combine(build(ranges,lo,middle),build(ranges,middle,hi));
}
// Immutable balanced tree. Unchanged subtrees share their certificates;
// queries prune a whole range of rows when its intersection still holds.
function view(root,size){
 function changed(date,limit=Infinity){
  const result=[],key=date.endKey;
  function visit(node,lo,hi){
   if(!node||valid(node,key)||result.length>limit)return;
   if(hi-lo===1){result.push(lo);return;}
   const middle=lo+Math.floor((hi-lo)/2);
   visit(node.left,lo,middle);visit(node.right,middle,hi);
  }
  visit(root,0,size);return result;
 }
 function fork(updates){
  if(!updates.size)return view(root,size);
  const rows=[...updates].sort(([a],[b])=>a-b);
  function patch(node,lo,hi,from,to){
   if(from===to)return node;
   if(hi-lo===1)return rows[from][1];
   const middle=lo+Math.floor((hi-lo)/2);
   let a=from,b=to;
   while(a<b){const m=a+Math.floor((b-a)/2);if(rows[m][0]<middle)a=m+1;else b=m;}
   return combine(patch(node.left,lo,middle,from,a),patch(node.right,middle,hi,a,to));
  }
  return view(patch(root,0,size,0,rows.length),size);
 }
 return Object.freeze({allows:date=>!root||valid(root,date.endKey),changed,fork});
}
export function createWorldBindingIndex(ranges){
 return view(ranges.length?build(ranges,0,ranges.length):null,ranges.length);
}
