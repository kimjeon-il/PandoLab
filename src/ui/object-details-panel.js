/** Read-only territorial details. Canonical selection/dated ancestry are supplied by the Viewer. */
export function groupObjectDetailChildren(children=[]) {
  const grouped=new Map();
  for(const row of children){
    if(!row||typeof row.id!=='string'||!row.id)continue;
    const type=typeof row.affiliationType==='string'?row.affiliationType.trim():'';
    const label=type||'미분류';
    const list=grouped.get(label)||[];
    list.push({id:row.id,name:String(row.name||row.id)});
    grouped.set(label,list);
  }
  return [...grouped.entries()]
    .sort(([a],[b])=>a.localeCompare(b,'ko'))
    .map(([label,items])=>({label,items:items.sort((a,b)=>a.name.localeCompare(b.name,'ko'))}));
}

export function createObjectDetailsPanel({document,surfaces,displayInfo,relations=()=>({}),selectObject=()=>{},onError=()=>{}}={}) {
  if(!document||typeof surfaces?.openSurface!=='function'||typeof surfaces?.closeSurface!=='function'
    ||typeof displayInfo!=='function'||typeof relations!=='function'||typeof selectObject!=='function')
    throw new TypeError('Object details requires Viewer selection and relation read ports.');
  const get=id=>{
    const node=document.getElementById(id);
    if(!node)throw new TypeError('Missing object details element: '+id);
    return node;
  };
  const title=get('objectDetailObjectName'),affiliation=get('objectDetailAffiliation'),
    flag=get('objectDetailFlag'),
    groupHost=get('objectDetailGroups'),infoEmpty=get('objectDetailInfoEmpty'),
    closeButton=get('objectDetailCloseBtn'),tablist=get('objectDetailTabs');
  const tabs=[
    {name:'info',button:get('objectDetailTabInfo'),pane:get('objectDetailInfoPane')},
    {name:'history',button:get('objectDetailTabHistory'),pane:get('objectDetailHistoryPane')},
  ];
  let currentKey=null,projectGeneration=null,disposed=false;
  let renderedGroups=new Map();
  const subscriptions=[];
  const listen=(element,event,fn)=>{
    element.addEventListener(event,fn);
    subscriptions.push(()=>element.removeEventListener(event,fn));
  };
  function selectTab(name,{focus=false}={}) {
    if(disposed)return;
    for(const tab of tabs){
      const selected=tab.name===name;
      tab.button.setAttribute('aria-selected',String(selected));
      tab.button.classList.toggle('active',selected);
      tab.button.tabIndex=selected?0:-1;
      tab.pane.hidden=!selected;
      if(selected&&focus)tab.button.focus({preventScroll:true});
    }
  }
  for(const tab of tabs)listen(tab.button,'click',()=>selectTab(tab.name));
  listen(tablist,'keydown',event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    const active=tabs.findIndex(tab=>tab.button.getAttribute('aria-selected')==='true');
    const next=event.key==='Home'?0:event.key==='End'?tabs.length-1
      :(active+(event.key==='ArrowRight'?1:tabs.length-1))%tabs.length;
    event.preventDefault();
    selectTab(tabs[next].name,{focus:true});
  });
  listen(closeButton,'click',()=>surfaces.closeSurface('details',{restoreFocus:true}));

  const node=(tag,className,text)=>{
    const element=document.createElement(tag);
    if(className)element.className=className;
    if(text!==undefined)element.textContent=text;
    return element;
  };
  function renderRelations(ref,{reset=false}={}) {
    const view=relations(ref)||{};
    const parentName=typeof view.parentName==='string'?view.parentName.trim():'';
    const type=typeof view.affiliationType==='string'?view.affiliationType.trim():'';
    // A missing parent must remain empty, without an invented affiliation.
    const affiliationSubjectName=view.affiliationSubjectName||parentName;
    const subtitle=parentName?(type?`${affiliationSubjectName}의 ${type}`:`${parentName} 소속`):'';
    if(affiliation.textContent!==subtitle)affiliation.textContent=subtitle;
    affiliation.hidden=!parentName;
    const groups=groupObjectDetailChildren(view.children);
    infoEmpty.hidden=groups.length>0;

    // Preserve the actual disclosure and button nodes for an unchanged object.
    // A new selection/project generation starts a fresh UI tree.
    const previous=reset?new Map():renderedGroups;
    const next=new Map();
    const focused=document.activeElement;
    let focusedRetained=false;
    const elements=groups.map(group=>{
      let entry=previous.get(group.label);
      if(!entry){
        const disclosure=node('details','object-details-group');
        disclosure.open=true;
        const heading=node('summary','ui-choice-row object-details-group-heading');
        const count=node('span','ui-status object-details-group-count');
        heading.append(node('strong','object-details-group-title',group.label),count);
        const list=node('div','ui-action-list object-details-group-list');
        disclosure.append(heading,list);
        entry={disclosure,heading,count,list,buttons:new Map()};
      }
      entry.count.textContent=group.items.length+'개';
      if(focused===entry.disclosure||focused===entry.heading)focusedRetained=true;
      const buttons=new Map();
      const rows=group.items.map(child=>{
        let button=entry.buttons.get(child.id);
        if(!button){
          button=node('button','ui-button ui-selectable-row object-details-child',child.name);
          button.type='button';
          button.addEventListener('click',()=>{
            if(disposed)return;
            try{void Promise.resolve(selectObject(child.id)).catch(onError);}
            catch(error){onError(error);}
          });
        }else if(button.textContent!==child.name)button.textContent=child.name;
        if(focused===button)focusedRetained=true;
        buttons.set(child.id,button);
        return button;
      });
      // Do not detach buttons, their focus or their event handlers when the
      // hierarchy is unchanged. Reuse retained buttons when rows are reordered.
      const oldRows=Array.from(entry.list.children);
      if(oldRows.length!==rows.length||rows.some((row,index)=>row!==oldRows[index]))
        entry.list.replaceChildren(...rows);
      entry.buttons=buttons;
      next.set(group.label,entry);
      return entry.disclosure;
    });
    const oldElements=Array.from(groupHost.children);
    if(oldElements.length!==elements.length||elements.some((item,index)=>item!==oldElements[index]))
      groupHost.replaceChildren(...elements);
    renderedGroups=next;
    // A reordered retained button may briefly be detached. Restore keyboard
    // focus only if it was inside this same object and was actually lost.
    if(focusedRetained&&focused&&document.activeElement!==focused)
      focused.focus?.({preventScroll:true});
  }

  function syncSelection(snapshot) {
    if(disposed)return false;
    const items=snapshot?.selection?.items||[];
    const selected=items.length===1&&items[0].domain==='territorial'?items[0]:null;
    if(!selected){
      currentKey=null;projectGeneration=null;renderedGroups.clear();
      if(affiliation.textContent!=='')affiliation.textContent='';
      affiliation.hidden=true;
      if(groupHost.children.length)groupHost.replaceChildren();
      surfaces.closeSurface('details');
      return false;
    }
    const changed=selected.key!==currentKey||snapshot.projectGeneration!==projectGeneration;
    currentKey=selected.key;projectGeneration=snapshot.projectGeneration;
    const info=displayInfo(selected);
    const nextTitle=info?.name||'이름 없는 객체';
    if(title.textContent!==nextTitle)title.textContent=nextTitle;
    const flagUrl=info?.flagUrl||'';
    if(flagUrl&&flag.getAttribute('src')!==flagUrl)flag.setAttribute('src',flagUrl);
    if(!flagUrl)flag.removeAttribute('src');
    flag.hidden=!flagUrl;
    renderRelations(selected,{reset:changed});
    if(changed){
      selectTab('info');
      surfaces.openSurface('details');
    }
    return true;
  }
  function reveal(ref) {
    if(disposed||!ref||ref.domain!=='territorial'||ref.key!==currentKey)return false;
    return surfaces.openSurface('details');
  }
  return Object.freeze({syncSelection,reveal,selectTab,dispose(){
    if(disposed)return;
    disposed=true;
    for(const unsubscribe of subscriptions.splice(0))unsubscribe();
  }});
}
