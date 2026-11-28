import { createSemanticIcon } from './icon-utils.js';
import {objectListWindow,objectListSpacer,observeObjectList,virtualListMetrics} from './virtual-object-list.js';

/** Read-only territorial details. Canonical selection/dated ancestry are supplied by the Viewer. */
export function groupObjectDetailChildren(children = []) {
  const grouped = new Map();
  for (const row of children) {
    if (!row||typeof row.id!=='string'||!row.id)continue;
    const type = typeof row.affiliationType==='string'?row.affiliationType.trim():'';
    const label = type||'미분류';
    const list = grouped.get(label)||[];
    list.push({id:row.id, name:String(row.name||row.id), flagUrl:row.flagUrl||''});
    grouped.set(label, list);
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b,'ko'))
    .map(([label, items]) => ({label, items:items.sort((a, b) => a.name.localeCompare(b.name,'ko'))}));
}

export function createObjectDetailsPanel({document, surfaces, displayInfo, relations = () => ({}), selectObject = () => {}, hoverObject = () => {}, onError = () => {}} = {}) {
  if (!document||typeof surfaces?.openSurface!=='function'||typeof surfaces?.closeSurface!=='function'
    ||typeof displayInfo!=='function'||typeof relations!=='function'||typeof selectObject!=='function'
    ||typeof hoverObject!=='function')
    throw new TypeError('Object details requires Viewer selection and relation read ports.');
  const get = id => {
    const node = document.getElementById(id);
    if (!node)throw new TypeError('Missing object details element: '+id);
    return node;
  };
  const title = get('objectDetailObjectName'), affiliation = get('objectDetailAffiliation'),
    flag = get('objectDetailFlag'),
    groupHost = get('objectDetailGroups'), infoEmpty = get('objectDetailInfoEmpty'), tablist = get('objectDetailTabs');
  const tabs = [
    {name:'info', button:get('objectDetailTabInfo'), pane:get('objectDetailInfoPane')},
    {name:'history', button:get('objectDetailTabHistory'), pane:get('objectDetailHistoryPane')},
  ];
  let currentKey = null, projectGeneration = null, disposed = false;
  let renderedGroups = new Map();
  const window=document.defaultView,scrollHost=groupHost.closest?.('.object-details-body');
  let stopVirtual=()=>{};
  let preview = null;
  const subscriptions = [];
  const listen = (element, event, fn) => {
    element.addEventListener(event, fn);
    subscriptions.push(() => element.removeEventListener(event, fn));
  };
  function selectTab(name, {focus = false} = {}) {
    if (disposed)return;
    if (name!=='info')clearHover();
    for (const tab of tabs) {
      const selected = tab.name===name;
      tab.button.setAttribute('aria-selected', String(selected));
      tab.button.classList.toggle('active', selected);
      tab.button.tabIndex = selected?0:-1;
      tab.pane.hidden = !selected;
      if (selected&&focus)tab.button.focus({preventScroll:true});
    }
  }
  for (const tab of tabs)listen(tab.button,'click', () => selectTab(tab.name));
  listen(tablist,'keydown', event => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    const active = tabs.findIndex(tab => tab.button.getAttribute('aria-selected')==='true');
    const next = event.key==='Home'?0:event.key==='End'?tabs.length-1
      :(active+(event.key==='ArrowRight'?1:tabs.length-1))%tabs.length;
    event.preventDefault();
    selectTab(tabs[next].name, {focus:true});
  });
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className)element.className = className;
    if (text!==undefined)element.textContent = text;
    return element;
  };
  function sendHover(tile, entered) {
    const isCurrent = () => !entered||preview?.tile===tile;
    const fail = error => {
      if (isCurrent()&&!error?.cancelled&&error?.name!=='AbortError')onError(error,'hover');
    };
    try {void Promise.resolve(hoverObject(tile.id, entered, isCurrent)).catch (fail);}
    catch (error) {fail(error);}
  }
  function clearHover() {
    if (!preview)return;
    const {tile} = preview;
    preview = null;
    sendHover(tile, false);
  }
  function createTile(id) {
    const button = node('button','ui-button ui-selectable-row object-details-child');
    button.type = 'button';
    const tile = {id, button, flagUrl:undefined};
    function enter(input) {
      if (disposed)return;
      const changed = preview?.tile!==tile;
      preview = {tile, input};
      if (changed)sendHover(tile, true);
    }
    function leave(input) {
      if (preview?.tile===tile&&preview.input===input)clearHover();
    }
    button.addEventListener('pointerenter', event => {
      if (event.pointerType!=='touch'&&!event.buttons)enter('pointer');
    });
    button.addEventListener('pointerleave', () => leave('pointer'));
    button.addEventListener('focus', () => {
      if (button.matches(':focus-visible'))enter('keyboard');
    });
    button.addEventListener('blur', () => leave('keyboard'));
    button.addEventListener('click', () => {
      if (disposed)return;
      clearHover();
      try {void Promise.resolve(selectObject(id)).catch (onError);}
      catch (error) {onError(error);}
    });
    return tile;
  }
  function updateTile(tile, child) {
    const {button} = tile;
    if (button.getAttribute('aria-label')!==child.name) {
      button.setAttribute('aria-label', child.name);
      button.dataset.tooltip = child.name;
    }
    if (tile.flagUrl===child.flagUrl)return;
    tile.flagUrl = child.flagUrl;
    const showFallback = () => button.replaceChildren(createSemanticIcon(document,'flagOutline','ui-icon object-details-flag-fallback'));
    if (!child.flagUrl) {
      showFallback();
      return;
    }
    const image = node('img','object-details-child-flag');
    image.setAttribute('alt','');
    image.loading='lazy';image.decoding='async';
    image.addEventListener('error', () => {
      if (button.firstElementChild===image)showFallback();
    }, {once:true});
    button.replaceChildren(image);
    image.setAttribute('src', child.flagUrl);
  }
  function renderGroupTiles(entry,{focusIndex=null}={}) {
    const items=entry.items,focused=document.activeElement;
    let range={start:0,end:items.length,before:0,after:0},gap=0;
    const virtual=items.length>64&&window&&scrollHost;
    if (virtual) {
      let sample=entry.list.querySelector('.object-details-child');
      if (!sample) {
        const tile=entry.buttons.get(items[0].id)||createTile(items[0].id);
        updateTile(tile,items[0]);entry.buttons.set(items[0].id,tile);entry.list.replaceChildren(tile.button);sample=tile.button;
      }
      const metrics=virtualListMetrics(window,entry.list,sample,{grid:true});
      gap=metrics.gap;
      const hostBox=scrollHost.getBoundingClientRect(),listBox=entry.list.getBoundingClientRect();
      let scroll=hostBox.top-listBox.top;
      if (focusIndex!==null) {
        const offset=Math.floor(focusIndex/metrics.columns)*metrics.stride;
        if(offset<scroll||offset+metrics.stride>scroll+scrollHost.clientHeight) {
          scrollHost.scrollTop+=offset-scroll;scroll=offset;
        }
      }
      range=objectListWindow(items.length,{scroll,height:scrollHost.clientHeight,stride:metrics.stride,columns:metrics.columns});
      if (listBox.bottom<hostBox.top-200||listBox.top>hostBox.bottom+200) {
        const rows=Math.ceil(items.length/metrics.columns);
        range={start:0,end:0,before:0,after:rows*metrics.stride};
      }
    }
    const buttons=new Map(),rows=[];let focusedRetained=false;
    if(range.before)rows.push(objectListSpacer(document,range.before,gap));
    for(let i=range.start;i<range.end;i++) {
      const child=items[i],tile=entry.buttons.get(child.id)||createTile(child.id);
      updateTile(tile,child);
      tile.button.dataset.objectDetailIndex=String(i);
      if(focused===tile.button)focusedRetained=true;
      buttons.set(child.id,tile);rows.push(tile.button);
    }
    if(range.after)rows.push(objectListSpacer(document,range.after,gap));
    const old=Array.from(entry.list.children);
    // On scroll within the same window retain both spacers and live buttons.
    const same=entry.range?.start===range.start&&entry.range?.end===range.end&&entry.range?.before===range.before&&entry.range?.after===range.after;
    const sameButtons=entry.buttons.size===buttons.size&&[...buttons].every(([id,tile],i)=>entry.buttons.get(id)===tile&&[...entry.buttons.keys()][i]===id);
    if(!same||!sameButtons||old.length!==rows.length)entry.list.replaceChildren(...rows);
    entry.range=range;entry.buttons=buttons;
    if(preview&&!groupHost.contains(preview.tile.button))clearHover();
    if(focusIndex!==null)buttons.get(items[focusIndex]?.id)?.button.focus({preventScroll:true});
    else if(focusedRetained&&document.activeElement!==focused)focused.focus?.({preventScroll:true});
  }
  stopVirtual=observeObjectList(window,scrollHost,()=>{
    if(!disposed)for(const entry of renderedGroups.values())if(entry.items.length>64)renderGroupTiles(entry);
  });
  function renderRelations(ref, {reset = false} = {}) {
    if (reset)clearHover();
    const view = relations(ref)||{};
    const parentName = typeof view.parentName==='string'?view.parentName.trim():'';
    const type = typeof view.affiliationType==='string'?view.affiliationType.trim():'';
    // A missing parent must remain empty, without an invented affiliation.
    const affiliationSubjectName = view.affiliationSubjectName||parentName;
    const subtitle=parentName?(type?`${affiliationSubjectName}의 ${type}`:`${parentName} 소속`):'';
    if (affiliation.textContent!==subtitle)affiliation.textContent = subtitle;
    affiliation.hidden = !parentName;
    const groups = groupObjectDetailChildren(view.children);
    infoEmpty.hidden = groups.length>0;

    // Preserve the group and button nodes for an unchanged object.
    // A new selection/project generation starts a fresh UI tree.
    const previous = reset?new Map():renderedGroups;
    const next = new Map();
    const elements = groups.map(group => {
      let entry = previous.get(group.label);
      if (!entry) {
        const section = node('section','object-details-group');
        const heading = node('h3','object-details-group-heading', group.label);
        const list = node('div','object-details-group-list');
        section.append(heading, list);
        entry = {section,list,buttons:new Map(),items:[],range:null};
        list.addEventListener('keydown',event=>{
          const i=Number(event.target.dataset?.objectDetailIndex);
          if(!Number.isInteger(i)||entry.items.length<=64)return;
          let next=null;
          if(event.key==='Tab'&&!event.shiftKey&&i===entry.range.end-1&&i+1<entry.items.length)next=i+1;
          else if(event.key==='Tab'&&event.shiftKey&&i===entry.range.start&&i>0)next=i-1;
          if(next!==null){event.preventDefault();renderGroupTiles(entry,{focusIndex:next});}
        });
      }
      entry.items=group.items;
      next.set(group.label, entry);
      return entry.section;
    });
    const oldElements = Array.from(groupHost.children);
    if (oldElements.length!==elements.length||elements.some((item, index) => item!==oldElements[index]))
      groupHost.replaceChildren(...elements);
    renderedGroups=next;
    for(const entry of next.values())renderGroupTiles(entry);
    if(preview&&!groupHost.contains(preview.tile.button))clearHover();
  }

  function syncSelection(snapshot) {
    if (disposed)return false;
    const items = snapshot?.selection?.items||[];
    const selected = items.length===1&&items[0].domain==='territorial'?items[0]:null;
    if (!selected) {
      clearHover();
      currentKey = null; projectGeneration = null; renderedGroups.clear();
      if (affiliation.textContent!=='')affiliation.textContent = '';
      affiliation.hidden = true;
      if (groupHost.children.length)groupHost.replaceChildren();
      surfaces.closeSurface('details');
      return false;
    }
    const changed = selected.key!==currentKey||snapshot.projectGeneration!==projectGeneration;
    currentKey = selected.key; projectGeneration = snapshot.projectGeneration;
    const info = displayInfo(selected);
    const nextTitle = info?.name||'이름 없는 객체';
    if (title.textContent!==nextTitle)title.textContent = nextTitle;
    const flagUrl = info?.flagUrl||'';
    if (flagUrl&&flag.getAttribute('src')!==flagUrl)flag.setAttribute('src', flagUrl);
    if (!flagUrl)flag.removeAttribute('src');
    flag.hidden = !flagUrl;
    renderRelations(selected, {reset:changed});
    if (changed) {
      selectTab('info');
      surfaces.openSurface('details');
    }
    return true;
  }
  function reveal(ref) {
    if (disposed||!ref||ref.domain!=='territorial'||ref.key!==currentKey)return false;
    return surfaces.openSurface('details');
  }
  return Object.freeze({syncSelection, reveal, selectTab, clearHover, dispose() {
    if (disposed)return;
    clearHover();
    disposed = true;stopVirtual();renderedGroups.clear();
    for (const unsubscribe of subscriptions.splice(0))unsubscribe();
  }});
}
