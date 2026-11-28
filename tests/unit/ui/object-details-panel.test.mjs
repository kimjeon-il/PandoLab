import test from 'node:test';
import assert from 'node:assert/strict';
import {createObjectDetailsPanel,groupObjectDetailChildren} from '../../../src/ui/object-details-panel.js';
import {createSurfaceController} from '../../../src/ui/surface-controller.js';

function fakeElement(id='') {
  const listeners=new Map(),attrs=new Map(),classes=new Set();
  return {id,inert:true,hidden:false,tabIndex:-1,textContent:'',className:'',children:[],dataset:{},
    classList:{toggle(name,enabled){if(enabled)classes.add(name);else classes.delete(name);},
      contains:name=>classes.has(name)},
    append(...values){this.children.push(...values);},
    appendChild(value){this.append(value);},
    replaceChildren(...values){this.children=[...values];},
    get firstElementChild(){return this.children[0]??null;},
    contains(node){return this===node||this.children.some(child=>child.contains(node));},
    setAttribute:(key,value)=>attrs.set(key,String(value)),removeAttribute:key=>attrs.delete(key),
    getAttribute:key=>attrs.get(key)??null,
    addEventListener:(event,fn)=>listeners.set(event,fn),
    removeEventListener:(event,fn)=>{if(listeners.get(event)===fn)listeners.delete(event);},
    focus(){this.focused=true;},
    fire(type,event={}){listeners.get(type)?.({preventDefault(){this.prevented=true;},...event});},
  };
}
const ref=(id)=>({domain:'territorial',type:'entity',key:'territorial:entity:'+id,id});

test('child-authored types group under their parent, child buttons navigate, and roots have an empty subtitle',()=>{
  const ids=['objectDetailObjectName','objectDetailAffiliation','objectDetailFlag','objectDetailGroups','objectDetailInfoEmpty',
    'objectDetailTabs','objectDetailTabInfo','objectDetailInfoPane',
    'objectDetailTabHistory','objectDetailHistoryPane'];
  const nodes=new Map(ids.map(id=>[id,fakeElement(id)])),operations=[],selected=[],hovered=[];
  const document={getElementById:id=>nodes.get(id),createElement:tag=>fakeElement(tag),createElementNS:(_ns,tag)=>fakeElement(tag)};
  const surfaces={openSurface:name=>{operations.push('open:'+name);return true;},
    closeSurface:name=>{operations.push('close:'+name);return true;}};
  let view={parentName:'',affiliationType:'',children:[
    {id:'RUS',name:'러시아',affiliationType:'구성국',flagUrl:'flags/shared.svg'},
    {id:'UKR',name:'우크라이나',affiliationType:'구성국',flagUrl:'flags/shared.svg'},
    {id:'OTHER',name:'미등록 속령',affiliationType:''},
  ]};
  const ui=createObjectDetailsPanel({document,surfaces,displayInfo:row=>({name:'Selected '+row.id,type:'객체',flagUrl:'flags/'+row.id+'.svg'}),
    relations:()=>view,selectObject:id=>selected.push(id),hoverObject:(id,entered)=>hovered.push([id,entered])});
  const first=ref('USSR'),snapshot={projectGeneration:1,selection:{items:[first]}};
  assert.equal(ui.syncSelection(snapshot),true);
  assert.equal(nodes.get('objectDetailObjectName').textContent,'Selected USSR');
  assert.equal(nodes.get('objectDetailFlag').getAttribute('src'),'flags/USSR.svg');
  assert.equal(nodes.get('objectDetailAffiliation').textContent,'');
  assert.equal(nodes.get('objectDetailAffiliation').hidden,true);
  assert.equal(nodes.get('objectDetailInfoEmpty').hidden,true);
  const groups=nodes.get('objectDetailGroups').children;
  assert.deepEqual(groups.map(group=>[group.id,group.children[0].id,group.children[0].textContent]),
    [['section','h3','구성국'],['section','h3','미분류']]);
  assert.ok(groups.every(group=>group.children.length===2&&group.children[0].children.length===0));
  const [russia,ukraine]=groups[0].children[1].children;
  const other=groups[1].children[1].firstElementChild;
  assert.equal(russia.getAttribute('aria-label'),'러시아');
  assert.equal(ukraine.dataset.tooltip,'우크라이나');
  assert.equal(russia.firstElementChild.getAttribute('src'),'flags/shared.svg');
  assert.equal(ukraine.firstElementChild.getAttribute('src'),'flags/shared.svg');
  assert.equal(other.firstElementChild.children[0].getAttribute('href'),'#icon-flag-outline');
  russia.fire('click');
  ukraine.fire('click');
  assert.deepEqual(selected,['RUS','UKR']);

  russia.fire('pointerenter',{pointerType:'mouse'});
  ukraine.fire('pointerenter',{pointerType:'mouse'});
  russia.fire('pointerleave',{pointerType:'mouse'});
  ukraine.fire('pointerleave',{pointerType:'mouse'});
  assert.deepEqual(hovered,[['RUS',true],['UKR',true],['UKR',false]]);

  const oldImage=ukraine.firstElementChild;
  view.children[1]={...view.children[1],flagUrl:'flags/dated.svg'};
  ui.syncSelection(snapshot);
  assert.strictEqual(groups[0].children[1].children[1],ukraine);
  oldImage.fire('error');
  assert.equal(ukraine.firstElementChild.getAttribute('src'),'flags/dated.svg');
  ukraine.firstElementChild.fire('error');
  assert.equal(ukraine.firstElementChild.children[0].getAttribute('href'),'#icon-flag-outline');

  // Re-read the active dated parent; no second parent/child registry is kept by the UI.
  view={parentName:'소련',affiliationType:'구성국',children:[]};
  ui.syncSelection(snapshot);
  assert.equal(nodes.get('objectDetailAffiliation').textContent,'소련의 구성국');
  assert.equal(nodes.get('objectDetailAffiliation').hidden,false);
  assert.equal(nodes.get('objectDetailGroups').children.length,0);
  assert.equal(nodes.get('objectDetailInfoEmpty').hidden,false);

  view={parentName:'',affiliationType:'구성국',children:[]};
  ui.syncSelection(snapshot);
  assert.equal(nodes.get('objectDetailAffiliation').textContent,'');
  assert.equal(nodes.get('objectDetailAffiliation').hidden,true);
  view={parentName:'소련',affiliationType:'',children:[]};
  ui.syncSelection(snapshot);
  assert.equal(nodes.get('objectDetailAffiliation').textContent,'소련 소속');
  view={parentName:'쿠바',affiliationSubjectName:'미국',affiliationType:'조차지',children:[]};
  ui.syncSelection(snapshot);
  assert.equal(nodes.get('objectDetailAffiliation').textContent,'미국의 조차지');

  nodes.get('objectDetailTabHistory').fire('click');
  assert.equal(nodes.get('objectDetailInfoPane').hidden,true);
  assert.equal(nodes.get('objectDetailHistoryPane').hidden,false);
  nodes.get('objectDetailTabs').fire('keydown',{key:'Home'});
  assert.equal(nodes.get('objectDetailInfoPane').hidden,false);
  assert.equal(nodes.get('objectDetailTabInfo').focused,true);
  assert.equal(ui.reveal(first),true);
  assert.equal(operations.at(-1),'open:details');
  assert.equal(ui.syncSelection({projectGeneration:1,selection:{items:[]}}),false);
  assert.equal(operations.at(-1),'close:details');
  ui.dispose();
});
test('groups are deterministic and omit invalid source rows',()=>{
  assert.deepEqual(groupObjectDetailChildren([
    {id:'B',name:'Z',affiliationType:'총독부'},
    {id:'A',name:'A',affiliationType:'총독부'},
    {id:'',name:'Invalid',affiliationType:'총독부'},
  ]),[{label:'총독부',items:[{id:'A',name:'A',flagUrl:''},{id:'B',name:'Z',flagUrl:''}]}]);
});
test('details and search share one mutually exclusive responsive surface owner',()=>{
  const nodes=new Map(['objectSearchSurface','objectDetailSurface','objectSearchBtn','mobileSearchBtn']
    .map(id=>[id,fakeElement(id)]));
  const workspace=fakeElement('workspace'),document={querySelector:key=>key==='.workspace'?workspace:null,
    body:{classList:fakeElement().classList}};
  let layout='mobile';
  const surfaces=createSurfaceController({getElement:id=>nodes.get(id),getLayout:()=>layout,document});
  surfaces.render();
  assert.equal(nodes.get('objectSearchSurface').inert,false);
  assert.equal(surfaces.isOpen('search'),false);
  assert.equal(surfaces.open('details'),true);
  surfaces.render();
  assert.equal(nodes.get('objectDetailSurface').inert,false);
  assert.equal(nodes.get('objectSearchSurface').inert,true);
  assert.equal(surfaces.activeMobileSheet,'details');
  surfaces.close('details');surfaces.render();
  assert.equal(nodes.get('objectSearchSurface').inert,false);
  surfaces.open('search');surfaces.render();
  assert.equal(nodes.get('objectDetailSurface').inert,true);
  assert.equal(nodes.get('objectSearchSurface').inert,false);
  assert.equal(surfaces.close('details'),false);
  layout='wide';surfaces.syncLayout('mobile');surfaces.render();
  assert.equal(surfaces.activeMobileSheet,null);
  assert.equal(nodes.get('objectSearchSurface').getAttribute('role'),null);
});

test('repeated selection refresh reuses groups and buttons, preserving focus and live name changes',()=>{
  const ids=['objectDetailObjectName','objectDetailAffiliation','objectDetailFlag','objectDetailGroups','objectDetailInfoEmpty',
    'objectDetailTabs','objectDetailTabInfo','objectDetailInfoPane',
    'objectDetailTabHistory','objectDetailHistoryPane'];
  const nodes=new Map(ids.map(id=>[id,fakeElement(id)]));
  const selected=[],document={activeElement:null,getElementById:id=>nodes.get(id),createElement:tag=>fakeElement(tag),
    createElementNS:(_ns,tag)=>fakeElement(tag)};
  let view={parentName:'',affiliationType:'',children:[
    {id:'A',name:'가',affiliationType:'구성국'},{id:'B',name:'나',affiliationType:'구성국'},
  ]};
  const ui=createObjectDetailsPanel({document,surfaces:{openSurface:()=>true,closeSurface:()=>true},
    displayInfo:row=>({name:row.id}),relations:()=>view,selectObject:id=>selected.push(id)});
  const snapshot={projectGeneration:1,selection:{items:[ref('P')]}};
  try{
    ui.syncSelection(snapshot);
    const host=nodes.get('objectDetailGroups'),group=host.children[0],list=group.children[1];
    const first=list.children[0],second=list.children[1];
    document.activeElement=second;
    ui.syncSelection(snapshot);
    assert.equal(host.children[0],group,'Unchanged relation group preserves DOM identity');
    assert.equal(list.children[1],second,'Unchanged children preserve button identity');

    // Simulate focus being lost when a reordered DOM list detaches its children.
    const replace=list.replaceChildren;
    list.replaceChildren=function(...rows){if(this.children.includes(document.activeElement))document.activeElement=null;replace.call(this,...rows);};
    second.focus=()=>{document.activeElement=second;};
    view={...view,children:[
      {id:'B',name:'나 개명',affiliationType:'구성국'},
      {id:'A',name:'가',affiliationType:'구성국'},
      {id:'C',name:'다',affiliationType:'구성국'},
    ]};
    ui.syncSelection(snapshot);
    // Sorted display still reuses the original buttons, even after a name change.
    assert.equal(host.children[0],group);
    assert.equal(list.children[0],first);
    assert.equal(list.children[1],second);
    assert.equal(second.getAttribute('aria-label'),'나 개명');
    assert.equal(document.activeElement,second);
    second.fire('click');assert.deepEqual(selected,['B']);

    ui.syncSelection({projectGeneration:1,selection:{items:[ref('Q')]}});
    const newGroup=host.children[0];
    assert.notEqual(newGroup,group);
    ui.syncSelection({projectGeneration:2,selection:{items:[ref('Q')]}});
    assert.notEqual(host.children[0],newGroup,'New project generations build a clean relation tree');
  }finally{ui.dispose();}
});

test('virtual windows bound mounted rows and preserve the final partial grid row',async()=>{
  const {objectListWindow}=await import('../../../src/ui/virtual-object-list.js');
  const top=objectListWindow(100000,{height:320,stride:40});
  assert.deepEqual(top,{start:0,end:12,before:0,after:(100000-12)*40});
  const middle=objectListWindow(100000,{scroll:400000,height:320,stride:40,columns:4});
  assert.ok(middle.end-middle.start<=64);assert.equal(middle.start%4,0);
  const end=objectListWindow(100001,{scroll:1000000,height:320,stride:40,columns:4});
  assert.equal(end.end,100001);assert.equal(end.after,0);
});
