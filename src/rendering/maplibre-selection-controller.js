import {clipMercatorLines,polarGeometry,polarLinePacket} from './maplibre-polar-layer.js';
import {buildRenderableBoundarySegments} from '../geometry/geographic-boundary.js';
import {connectBoundarySegments} from '../geometry/boundary-lines.js';
import {admittedGeometryKey as geometryKey} from '../geometry/geometry-version-store.js';
import {distributionEntriesForLayer,DISTRIBUTION_MODES} from '../document/distribution-model.js';
import {createMapLibreHighlight,partitionHighlightLines} from './maplibre-highlight.js';
import {createMapLibrePicking} from './maplibre-picking-controller.js';
// Selection presentation and picking are owned together; the application
// remains authoritative for the actual selected object references.
export function createMapLibreSelection({getMap,state,styleReady,ensurePolar,setData,orderSceneLayers,metrics,invalidate,
 feedback,suppressHover,objectRefVisible,getTerritory,getHydroFeature,getInteractionStyle,rgba,pickingPorts,
 createHighlight=createMapLibreHighlight,getGeneric=id=>state.genericFeatures.find(value=>String(value.id)===id),
 getLabel=id=>state.labels.find(value=>String(value.id)===id),readDistributionEntries=()=>state.distributionEntries}){
 let selectionSnapshot=null,highlight=null,pendingSelection=false;
 const highlightLines=new WeakMap();
 const picking=createMapLibrePicking({...pickingPorts,objectRefVisible,ownsHighlight:source=>highlight?.owns(source)});
 function setSelection(snapshot){
  selectionSnapshot=snapshot;
  submitSelection(snapshot);
 }
 function submitSelection(snapshot,selectionOnly=false){
  if(!snapshot)return;
  if(!styleReady()){pendingSelection=true;return;}
  pendingSelection=false;
  const polarOwner=ensurePolar();
  highlight ||=createHighlight({map:getMap(),write:setData,onStructure:orderSceneLayers,
   preparePolar:items=>polarOwner.prepareHighlights(items),clearPolar:()=>polarOwner.clearHighlights(),
   onRestoreSelection:()=>submitSelection(selectionSnapshot,true),
   onShown:result=>{metrics.record('highlight.prepare-to-render',result.shownAt-result.startedAt);invalidate('highlight-shown');},
   onError:cause=>{if(cause?.name!=='AbortError')feedback.reportOperationError(cause,'지도 강조 표시를 준비하지 못했습니다.','PL-MAPLIBRE-HIGHLIGHT-001');invalidate('highlight-failed');}});
  const selected=snapshot.selection?.items||snapshot.selection?.refs||[];
  const hoverRef=selectionOnly||suppressHover()?null:snapshot.hover;
  const primary=snapshot.selection?.primaryKey,hover=hoverRef?.key;
  const refs=[...selected];
  if(hoverRef&&!selected.some(ref=>ref.key===hover))refs.push(hoverRef);
  const native=[],polar=[],keys=[],selectedKeys=[],nativeKeys=[];
  const interactionStyle=getInteractionStyle();
  for(const ref of refs){
   if(!objectRefVisible(ref))continue;
   const feature=ref.domain==='territorial'?getTerritory(ref.id):ref.domain==='generic'?getGeneric(ref.id):ref.domain==='hydro'?getHydroFeature(ref.id):ref.domain==='label'?getLabel(ref.id):null;
   const geometries=ref.domain==='distribution'?distributionEntriesForLayer(readDistributionEntries(),ref.id).map(entry=>entry.mode===DISTRIBUTION_MODES.TERRITORIAL?getTerritory(entry.territorialUnitId)?.geometry:entry.geometry):feature?.geometry?[feature.geometry]:feature?.coordinates?[{type:'Point',coordinates:feature.coordinates}]:[];
   const hovered=ref.key===hover&&!selected.some(item=>item.key===ref.key);
   const role=ref.key===primary?interactionStyle?.selection.primary:hovered?interactionStyle?.hover:interactionStyle?.selection.secondary;
   const color=(hovered?interactionStyle?.hover.color:interactionStyle?.selection.color)||'#ffd453';
   const width=role?.innerWidth??role?.width??2,fillAlpha=role?.fillAlpha??0.2,strokeAlpha=role?.innerAlpha??role?.alpha??1;
   for(const geometry of geometries.filter(Boolean)){
    const revision=geometryKey(geometry);
    const key=[ref.key,revision,color,width,fillAlpha,strokeAlpha,hovered];
    keys.push(key);if(!hovered)selectedKeys.push(key);
    const cap=polarGeometry(geometry);
    const polygon=geometry.type==='Polygon'||geometry.type==='MultiPolygon';
    const addNative=(shape,alpha,partitioned=false)=>{
     nativeKeys.push([ref.key,revision,shape.type,color,alpha,width]);
     const properties={objectKey:ref.key,color,alpha,width};
     if(partitioned&&alpha<1)properties.splitOpacity=alpha;
     native.push({type:'Feature',geometry:shape,properties});
    };
    if(polygon&&fillAlpha>0)addNative(geometry,fillAlpha);
    if(geometry.type==='Point'||geometry.type==='MultiPoint')addNative(geometry,1);
    if(cap&&fillAlpha>0)polar.push({geometry:cap,color:rgba(color,fillAlpha)});
    if(!(strokeAlpha>0)||!(width>0)||(!polygon&&!['LineString','MultiLineString'].includes(geometry.type)))continue;
    let paths=highlightLines.get(geometry);
    if(!paths){
     paths={segments:buildRenderableBoundarySegments(geometry)};
     highlightLines.set(geometry,paths);
    }
    if(!paths.native){
     const clipped=clipMercatorLines({type:'MultiLineString',coordinates:connectBoundarySegments(paths.segments)});
     paths.native=partitionHighlightLines(clipped);
     paths.partitioned=paths.native!==clipped;
    }
    if(paths.native.coordinates.length)addNative(paths.native,strokeAlpha,paths.partitioned);
    const packet=paths.cap ||=polarLinePacket(paths.segments);
    if(packet.indices.length)polar.push({packet,color:rgba(color,strokeAlpha),width});
   }
  }
  highlight.submit(JSON.stringify(keys),native,polar,JSON.stringify(selectedKeys),JSON.stringify(nativeKeys));
 }

 function refresh(){if(selectionSnapshot)setSelection(selectionSnapshot);}
 function reset({restore=false}={}){highlight?.reset();pendingSelection=restore&&!!selectionSnapshot;}
 function onStyleChanged(){if(highlight)reset({restore:true});}
 function onTemporalAdmission(){if(highlight?.hasHover())highlight.reset();refresh();}
 return Object.freeze({setSelection,refresh,reset,onStyleChanged,onTemporalAdmission,
  get snapshot(){return selectionSnapshot;},
  flushPending(){if(pendingSelection)refresh();},
  queryObjectRefs:picking.queryObjectRefs,pickBounds:picking.pickBounds,invalidateLayers:picking.invalidateLayers,
  owns:source=>highlight?.owns(source)??false,ids:()=>highlight?.ids()||[],
  onCameraChange:()=>highlight?.onCameraChange(),onRender:()=>highlight?.onRender(),
  selectionPending:()=>highlight?.selectionPending()??false,stats:()=>highlight?.stats(),
  dispose(){highlight?.dispose();highlight=null;selectionSnapshot=null;pendingSelection=false;picking.reset();}
 });
}
