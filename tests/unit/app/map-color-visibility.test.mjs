import test from 'node:test';
import assert from 'node:assert/strict';
import {createMapSettings} from '../../../src/ui/app-map-settings.js';
import {mapVisualOrder,mapVisualRank,normalizeLayerPresentation} from '../../../src/ui/layer-presentation.js';

test('color visibility does not alter explicitly hidden objects or labels',async()=>{
 const state={layerVisibility:{objects:false,objectNames:false,labels:false,rivers:false,lakes:false},
  layerPresentation:{styles:{objects:{colorVisible:true,boundaryVisible:false}},objectStyles:{'territorial:entity:A':{colorVisible:false}}}};
 const submitted=[];
 const settings=createMapSettings({capabilities:{builtinHydro:true,builtinPlaces:true},
  viewPresentation:{applyPresentation:async payload=>{submitted.push(payload);
   if(payload.action==='groupStyle')Object.assign(state.layerPresentation.styles[payload.group],payload.patch);
   return true;}}});
 settings.connect({projectState:{state},feedback:{reportOperationError(){}},
  layerResources:{loadHydroData(){throw Error('must not load');},preparePlaces(){throw Error('must not load');}},
  layerStyleServices:{layerStyle:(_p,g)=>({...state.layerPresentation.styles[g]})},
  objectDisplay:{invalidateObjectPresentation(){}},
  rendering:{mapRenderer:{invalidateCountryColors(){}}},
  domains:{renderingDomain:{invalidateOverlayStyle(){}}}});
 const original=structuredClone(state.layerVisibility);
 await settings.updateLayerPresentationStyle('objects',{colorVisible:false});
 assert.deepEqual(state.layerVisibility,original);
 assert.deepEqual(state.layerPresentation.objectStyles,{'territorial:entity:A':{colorVisible:false}});
 assert.equal(state.layerPresentation.styles.objects.boundaryVisible,false);
 assert.deepEqual(submitted.map(payload=>payload.action),['groupStyle']);
});

test('color visibility changes presentation only, preserving territorial colors, labels and data',async()=>{
 const state={layerVisibility:{objects:true,objectNames:true},layerPresentation:{styles:{objects:{colorVisible:true,boundaryVisible:true}},objectStyles:{'territorial:entity:A':{colorVisible:true}}}};
 const projectColor='#aabbcc',events=[],originalVisibility=structuredClone(state.layerVisibility);
 let paint;
 const settings=createMapSettings({capabilities:{builtinHydro:true,builtinPlaces:true},viewPresentation:{applyPresentation:async payload=>{
  events.push(['command',payload]);
  if(payload.action==='groupStyle')Object.assign(state.layerPresentation.styles[payload.group],payload.patch);
  return true;
 }}});
 settings.connect({projectState:{state},feedback:{reportOperationError(){}},
  layerResources:{loadHydroData(){events.push(['hydro-reload']);},preparePlaces(){events.push(['label-reload']);}},
  layerStyleServices:{layerStyle:(_presentation,group)=>({...state.layerPresentation.styles[group]})},
  objectDisplay:{invalidateObjectPresentation(){events.push(['objects']);}},
  rendering:{mapRenderer:{invalidateCountryColors(){events.push(['paint']);paint.markCountryBase();},invalidateCountryPalette(){events.push(['palette']);},invalidatePhysicalStyle(){events.push(['physical']);}}},
  domains:{renderingDomain:{invalidateOverlayStyle(){events.push(['overlay']);}}}});
 const {createGlobePaintState}=await import('../../../src/rendering/globe-paint-state.js');
 const entity={id:'A',properties:{entityKind:'general',style:{color:projectColor},parentId:''}};
 const refs=[{id:'A',key:'territorial:entity:A'}], features=new Map([['A',entity]]);
 const activeSlots=new Set([0]),activeSlotByKey=new Map([[refs[0].key,0]]);
 const palette={defaultLand:'#f1f1f1',ocean:'#aabbdd'},slotPaint=new Map();
 paint=createGlobePaintState({state,refs,hydroSlots:new Map(),readPalette:()=>palette,
  territorialColor:feature=>feature.properties.style.color,objectRefVisible:()=>state.layerVisibility.objects,
  highlightCandidates:()=>[],onPickingChanged(){},onOutlineRolesChanged(){}});
 const surface={setPalette(){},setCountryPaint(rows){for(const [slot,value] of rows)slotPaint.set(slot,value);},
  setHydroPaint(){},setLayerVisibility(){}};
 const resolved=()=>{paint.updatePaint(surface,{activeSlots,activeSlotByKey,features,bordersNeeded:()=>true});return slotPaint.get(0);};
 assert.deepEqual(resolved(),{color:projectColor,visible:true,highlight:null});
 assert.equal(await settings.updateLayerPresentationStyle('objects',{colorVisible:false}),true);
 // A null material color uses the surface's default land palette; visibility remains independent.
 assert.deepEqual(resolved(),{color:null,visible:true,highlight:null});
 assert.equal(paint.visibleSlots().has(0),true);
 assert.deepEqual(state.layerVisibility,originalVisibility);
 assert.equal(entity.properties.style.color,projectColor);
 assert.equal(state.layerPresentation.objectStyles['territorial:entity:A'].colorVisible,true);
 assert.equal(await settings.updateLayerPresentationStyle('objects',{colorVisible:true}),true);
 assert.deepEqual(resolved(),{color:projectColor,visible:true,highlight:null});
 assert.equal(paint.visibleSlots().has(0),true);
 assert.deepEqual(events.map(e=>e[0]),['command','paint','command','paint']);
 paint.dispose();
});

test('active presentation groups preserve map object styles and visual order',()=>{
 const input={styles:{objects:{colorVisible:false,boundaryVisible:true}},
  objectStyles:{'territorial:entity:A':{colorVisible:true}}};
 const normalized=normalizeLayerPresentation(input);
 assert.equal(normalized.styles.objects.colorVisible,false);
 assert.equal(normalized.styles.objects.boundaryVisible,true);
 assert.deepEqual(normalized.objectStyles['territorial:entity:A'],{colorVisible:true});
 assert.ok(mapVisualOrder('all').includes('substrate'));
 assert.ok(mapVisualOrder('all').includes('country-boundary'));
 assert.ok(mapVisualOrder('all').includes('territorial-labels'));
 assert.throws(()=>mapVisualRank('unknown-role'),/Unknown visual role/);
});
