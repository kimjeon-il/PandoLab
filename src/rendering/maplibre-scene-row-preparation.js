import {admittedGeometryKey as geometryKey} from '../geometry/geometry-version-store.js';

// Only immutable input rows receive derived-row certificates. Mutable
// producers continue through the value-comparison path.
export function createSceneRowPreparation(){
 const preparedRows=new WeakMap(),preparedFeatures=new WeakMap(),rowIdentities=new WeakMap();
 const vectorRows=new WeakMap();
 const identityFor=rows=>rows.map(row=>{
  let value=rowIdentities.get(row);
  if(!value){
   value=[row.key,row.objectKey,row.geometryRevision??geometryKey(row.geometry),row.order,row.role,row.kind,row.blendMode,JSON.stringify(row.style)];
   if(Object.isFrozen(row))rowIdentities.set(row,value);
  }
  return value;
 });
 function prepareRow(item,kind){
  const cached=preparedRows.get(item);
  if(cached?.kind===kind)return cached.row;
  const point=item.geometry?.type==='Point'||item.geometry?.type==='MultiPoint';
  const native=kind==='line'||item.blendMode==='multiply'||item.style?.blendMode==='multiply';
  const row={...item,kind:point?(native?'point':'circle'):kind};
  const value={row:Object.isFrozen(item)?Object.freeze(row):row,kind};
  if(Object.isFrozen(item))preparedRows.set(item,value);
  return value.row;
 }
 function featureFor(item){
  let row=preparedFeatures.get(item);
  if(!row){
   row={revision:item.geometryRevision,feature:{type:'Feature',id:item.key,geometry:item.geometry,
    properties:{objectKey:item.objectKey||'',color:item.style?.color||'#ffffff',alpha:item.style?.fillAlpha??item.style?.alpha??1}}};
   if(Object.isFrozen(item))preparedFeatures.set(item,row);
  }
  return row;
 }
 function vectorRowFor(row,antiAlias){
  const cached=vectorRows.get(row);
  if(cached&&cached.antiAlias===antiAlias)return cached.value;
  const value={...row,style:row.kind==='line'?{...row.style,antiAlias:antiAlias??row.style?.antiAlias??true}:row.style,
   geometryRevision:(row.kind||'fill')+':'+(row.geometryRevision??geometryKey(row.geometry))};
  if(Object.isFrozen(row)){Object.freeze(value);vectorRows.set(row,{antiAlias,value});}
  return value;
 }

 return Object.freeze({identityFor,prepareRow,featureFor,vectorRowFor});
}
