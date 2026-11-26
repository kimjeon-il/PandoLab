import {INTERACTION_ROLE_PRIORITY,layerStyle,territorialNamesVisible} from '../ui/layer-presentation.js';
import {resolveMapStrokeStyle} from '../map/map-interaction-style.js';

export const emptyRoleStyles=Object.freeze([{width:0,alpha:0,fillAlpha:0}]);
export function globeInteractionStyles(style){
 const rows=[{width:0,alpha:0,fillAlpha:0}];
 if(style)for(const [role,code] of Object.entries(INTERACTION_ROLE_PRIORITY))rows[code]=resolveMapStrokeStyle(style,role);
 return rows;
}
export function globeRoleStyleKey(rows,kind){
 return JSON.stringify(rows.map(row=>kind==='fill'?[row?.color,row?.fillAlpha??0]:
  kind==='outline'?[row?.color,row?.width??0,row?.alpha??0]:[row?.color,row?.width??0,row?.alpha??0,row?.fillAlpha??0]));
}
export function globeInteractionRoles(selection,candidates=[]){
 const domains={territorial:new Map(),hydro:new Map()};
 function add(ref,role){
  const map=domains[ref?.domain],code=INTERACTION_ROLE_PRIORITY[role];
  if(map&&code>(map.get(ref.key)?.code??0))map.set(ref.key,{ref,code});
 }
 for(const ref of candidates)add(ref,'candidate');
 add(selection?.hover,'hover');
 for(const ref of selection?.selection?.items??[])add(ref,ref.key===selection.selection.primaryKey?'primary':'secondary');
 return domains;
}
export function sameGlobeRoleInputs(a,b){
 return a.size===b.size&&[...a].every(([key,row])=>b.get(key)?.code===row.code);
}
const sortedEntries=map=>Object.entries(map??{}).sort(([a],[b])=>a.localeCompare(b));
const hidden=map=>JSON.stringify(sortedEntries(map).filter(([,visible])=>visible===false).map(([id])=>id));
const territoryColors=map=>JSON.stringify(sortedEntries(map).filter(([key,row])=>
 (!key.includes(':')||key.startsWith('territorial:'))&&row&&Object.hasOwn(row,'colorVisible'))
 .map(([key,row])=>[key,row.colorVisible!==false]));
const labelSettings=(map,country)=>JSON.stringify(sortedEntries(map).filter(([key])=>key.startsWith('territorial:')===country));
export function createGlobePresentationInputReader(){
 const fingerprints=new Map();
 function signature(kind,source,project,force){
  const old=fingerprints.get(kind);
  if(!force&&old?.source===source&&old)return old.value;
  const value=project(source);fingerprints.set(kind,{source,value});return value;
 }
 return function read(state,preferences,{force=false}={}){
  const visibility=state.layerVisibility??{},items=state.itemVisibility??{},styles=state.layerPresentation??{};
  const snap=(kind,source,project=hidden)=>signature(kind,source,project,force);
  return {
   objects:visibility.objects!==false,objectItems:snap('objects',items.objects),objectStyles:snap('country-colors',styles.objectStyles,territoryColors),
   colors:layerStyle(styles,'objects').colorVisible!==false,
   borders:visibility.objects!==false&&layerStyle(styles,'objects').boundaryVisible!==false,
   lakes:visibility.lakes!==false,rivers:visibility.rivers!==false,hydroItems:snap('hydro',items.hydro),
   hydroLayers:snap('hydro-layers',state.physicalSettings?.hydroLayers),builtinHydro:state.resourceCapabilities?.builtinHydro!==false,
   names:territorialNamesVisible(state),nameItems:snap('object-labels',items.objectLabels),
   places:visibility.labels!==false,placeItems:snap('places',items.labels),builtinPlaces:state.resourceCapabilities?.builtinPlaces!==false,
   countryLabelSettings:snap('country-label-settings',state.labelSettings,map=>labelSettings(map,true)),
   placeLabelSettings:snap('place-label-settings',state.labelSettings,map=>labelSettings(map,false)),
   nativeNames:preferences?.labels?.place?.showNativeNames===true,
  };
 };
}
export function globeChangedHiddenIds(before,after){
 const old=new Set(JSON.parse(before??'[]')),next=new Set(JSON.parse(after??'[]'));
 return [...new Set([...old,...next])].filter(id=>old.has(id)!==next.has(id));
}
