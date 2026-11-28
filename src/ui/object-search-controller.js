import { normalizeObjectRef } from '../document/object-ref-identity.js';
import { normalizePlaceQuery, PLACE_LIMITS } from '../document/place-contract.js';
import { createObjectSearchCatalog, createObjectSearchModel, visibleObjectSearchRows } from '../document/object-search-model.js';
import { resourceKey, resourceUpdate } from '../runtime/resource-dependency-policy.js';
import { objectListWindow,objectListSpacer,observeObjectList,virtualListMetrics } from './virtual-object-list.js';

/**
 * Object search is deliberately flat. The project still owns object grouping and
 * visibility, but the map no longer exposes that structure as a persistent tree.
 */
export function createObjectSearchController({
  window,
  document,
  elements,
  groups,
  commands,
  model,
  createEmptyState,
  createIcon,
  searchDelay = 120,
  builtinSearch = null,
  cancelBuiltinSearch = () => {},
  builtinRecordVisible = () => true,
  searchRuntime = null,
  onSearchError = () => {},
} = {}) {
  let searchTimer = 0;
  let renderedDependencies = null;
  let renderedSearchRefs = [],resultRows=[],renderedWindow=null,resultNodes=new Map(),stopVirtual=()=>{};
  let windowMetrics=null,renderedQuery='',renderedTruncated=false;
  let cachedCatalog = null, cachedCatalogPromise = null, fallbackCatalog = null, fallbackRevision;
  let hydrated = false;
  let disposed = false;
  let bound = false;
  const subscriptions = [];
  const listen = (node, name, handler) => {
    if (!node) return;
    node.addEventListener(name, handler);
    subscriptions.push(() => node.removeEventListener(name, handler));
  };
  let searchGeneration = 0;
  let activeSearchRequest = null, catalogGeneration = 0, builtinGeneration = 0;
  let builtinQuery = null;
  let builtinRows = [];
  let builtinTruncated = false;
  let rowRevision = 0, projectTransition = 0, projectSuspended = false, focusIntentRevision = 0;
  let projectScope = String(model.snapshot()?.projectScope??'');
  const readProjectScope = () => String(model.snapshot()?.projectScope??'');
  const currentRow = target => !disposed && !projectSuspended
    && target?.dataset?.searchRowRevision === String(rowRevision)
    && target?.dataset?.searchProjectScope === readProjectScope();
  function cancelObjectSearchRequest() {
    const request = activeSearchRequest;
    activeSearchRequest = null;
    request?.controller.abort();
  }

  function currentCatalogKey(scope = projectScope) {
    return resourceKey(['object-search-index', scope, model.catalogRevision?.() ?? 'uncached']);
  }

  function getSearchRequest(query) {
    const key = currentCatalogKey();
    if (activeSearchRequest && activeSearchRequest.generation === searchGeneration
      && activeSearchRequest.scope === projectScope && activeSearchRequest.query === query
      && activeSearchRequest.catalogKey === key && !activeSearchRequest.controller.signal.aborted)
      return activeSearchRequest;
    cancelObjectSearchRequest();
    activeSearchRequest = {
      generation:searchGeneration,
      scope:projectScope,
      query,
      catalogKey:key,
      controller:new AbortController(),
      objectRowsPromise:null,
      reportedError:false,
    };
    return activeSearchRequest;
  }

  function isCurrentSearchRequest(request) {
    return !!request && !disposed && !projectSuspended && activeSearchRequest === request
      && request.generation === searchGeneration && request.scope === readProjectScope()
      && request.catalogKey === currentCatalogKey(request.scope)
      && request.query === String(model.snapshot().search || '').trim()
      && !request.controller.signal.aborted;
  }

  function syncProjectScope() {
    const next = readProjectScope();
    if (next === projectScope) return false;
    projectScope = next;
    searchGeneration++;
    rowRevision++;
    cancelObjectSearchRequest();
    catalogGeneration++;
    cachedCatalog = null;
    cachedCatalogPromise = null;
    fallbackCatalog = null;
    fallbackRevision = undefined;
    renderedDependencies = null;
    renderedSearchRefs = [];
    resultRows = [];
    renderedWindow = null;
    resultNodes.clear();
    windowMetrics = null;
    builtinQuery = null;
    builtinRows = [];
    builtinTruncated = false;
    builtinGeneration++;
    cancelBuiltinSearch();
    void searchRuntime?.invalidate?.();
    return true;
  }

  const selection = () => model.selectionSnapshot?.().selection || { primaryKey: null, items: [] };

  function searchResultIcon(item) {
    const semanticName = item.layerGroup === 'hydro'
      ? item.typeLabel === '호수' ? 'lake' : 'river'
      : ({
        objects: 'territory', distributions: 'distribution',
        labels: 'place', genericFeatures: 'territory',
      })[item.layerGroup] || 'map';
    return createIcon?.(semanticName, 'ui-icon object-search-result-icon') || null;
  }

  function searchResultVisual(item) {
    if (!item.flagUrl) return searchResultIcon(item);
    const flag = document.createElement('img');
    flag.className = 'object-search-result-flag';
    flag.src = item.flagUrl;
    flag.alt = '';
    flag.decoding = 'async';
    flag.loading='lazy';
    flag.addEventListener('error', () => {
      const fallback = searchResultIcon(item);
      if (fallback && flag.isConnected) flag.replaceWith(fallback);
    }, { once: true });
    return flag;
  }

  function rowFor(item,index) {
    const current = selection();
    const selected = current.items?.some(candidate => candidate.key === item.key) || false;
    const primary = current.primaryKey === item.key;
    const row = document.createElement('div');
    row.className = 'object-search-result ui-selectable-row';
    row.dataset.objectKey = item.key;
    row.dataset.searchRowRevision = String(rowRevision);
    row.dataset.searchProjectScope = projectScope;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-posinset',String(index+1));
    row.setAttribute('aria-setsize',String(resultRows.length));
    row.setAttribute('aria-selected', String(selected));
    row.classList.toggle('is-selected', selected);
    row.classList.toggle('is-primary-selected', primary);

    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'ui-button object-search-result-select';
    select.dataset.objectSearchSelect = item.layerGroup;
    select.dataset.itemId = item.id;
    select.dataset.searchRowRevision = String(rowRevision);
    select.dataset.searchProjectScope = projectScope;
    select.setAttribute('aria-label', item.name);
    const name = document.createElement('strong');
    name.textContent = item.name;
    const visual = searchResultVisual(item);
    if (visual) name.prepend(visual);
    select.append(name);

    const focus = document.createElement('button');
    focus.type = 'button';
    focus.className = 'ui-button icon-btn object-search-focus-action';
    focus.dataset.objectSearchFocus = item.layerGroup;
    focus.dataset.itemId = item.id;
    focus.dataset.searchRowRevision = String(rowRevision);
    focus.dataset.searchProjectScope = projectScope;
    focus.dataset.tooltip = '선택 객체로 이동';
    focus.setAttribute('aria-label', `${item.name} 선택 객체로 이동`);
    const focusIcon = createIcon?.('focus', 'ui-icon');
    if (focusIcon) focus.append(focusIcon);
    row.append(select, focus);
    return row;
  }

  function prepareSearchCatalog(request) {
    if (cachedCatalog?.key === request.catalogKey) return Promise.resolve(cachedCatalog);
    if (cachedCatalogPromise?.key === request.catalogKey) return cachedCatalogPromise.promise;

    const source = createObjectSearchCatalog({
      items:model.items,
      groups:groups.search,
      itemRef:model.itemRef,
    });
    const indexCatalog = {
      keys:source.items.map(item => String(item.key)),
      ids:source.items.map(item => String(item.id)),
      names:source.items.map(item => String(item.name || '')),
      typeLabels:source.items.map(item => String(item.typeLabel || '')),
      searchTexts:source.items.map(item => String(item.searchText || '')),
    };
    const generation = ++catalogGeneration;
    const promise = searchRuntime.prepare({key:request.catalogKey, catalog:indexCatalog}).then(order => {
      if (!(order instanceof Uint32Array) || order.length !== source.items.length)
        throw new TypeError('Object search Worker returned an invalid catalog order.');
      const orderedItems = new Array(order.length), seen = new Set();
      for (let i = 0; i < order.length; i++) {
        const index = order[i];
        if (index >= source.items.length || seen.has(index))
          throw new RangeError('Object search Worker returned an invalid catalog position.');
        seen.add(index);
        orderedItems[i] = source.items[index];
      }
      if (seen.size !== source.items.length)
        throw new RangeError('Object search Worker omitted catalog rows.');
      const catalog = {key:request.catalogKey, items:Object.freeze(orderedItems)};
      if (generation === catalogGeneration && request.scope === projectScope
        && request.catalogKey === currentCatalogKey(request.scope)) cachedCatalog = catalog;
      return catalog;
    }).finally(() => {
      if (cachedCatalogPromise?.promise === promise) cachedCatalogPromise = null;
    });
    cachedCatalogPromise = {key:request.catalogKey, promise};
    return promise;
  }

  function rowsFor(query, request) {
    if (!request.objectRowsPromise) request.objectRowsPromise = (async() => {
      if (!query) return [];
      const revision = model.catalogRevision?.();
      if (!searchRuntime || revision === undefined) {
        if (!fallbackCatalog || revision === undefined || revision !== fallbackRevision) {
          fallbackCatalog = createObjectSearchModel({
            items:model.items,
            groups:groups.search,
            itemRef:model.itemRef,
            compare:model.compare,
          });
          fallbackRevision = revision;
        }
        return visibleObjectSearchRows(fallbackCatalog, query);
      }

      const catalog = await prepareSearchCatalog(request);
      request.controller.signal.throwIfAborted();
      if (!isCurrentSearchRequest(request)) return null;
      const indices = await searchRuntime.search({
        key:catalog.key,
        query,
        signal:request.controller.signal,
      });
      request.controller.signal.throwIfAborted();
      if (!isCurrentSearchRequest(request)) return null;
      if (!(indices instanceof Uint32Array))
        throw new TypeError('Object search Worker returned invalid result positions.');
      const rows = new Array(indices.length);
      for (let i = 0; i < indices.length; i++) {
        const index = indices[i];
        if (index >= catalog.items.length)
          throw new RangeError('Object search Worker returned an out-of-range result.');
        rows[i] = catalog.items[index];
      }
      return rows;
    })();
    return request.objectRowsPromise;
  }

  function renderWindow({force=false,focusIndex=null,focusAction=false}={}) {
    const results=elements.searchResults;
    if (!results||disposed||projectSuspended||!resultRows.length)return;
    const virtual=resultRows.length>48&&results.clientHeight>0&&typeof window.getComputedStyle==='function';
    let range={start:0,end:resultRows.length,before:0,after:0},gap=0;
    if (virtual) {
      let sample=results.querySelector('.object-search-result');
      if (!sample) {sample=rowFor(resultRows[0],0);results.replaceChildren(sample);resultNodes.set(resultRows[0].key,sample);}
      windowMetrics=virtualListMetrics(window,results,sample);gap=windowMetrics.gap;
      if (focusIndex!==null) {
        const offset=focusIndex*windowMetrics.stride;
        if (offset<results.scrollTop||offset+windowMetrics.stride>results.scrollTop+results.clientHeight)
          results.scrollTop=Math.max(0,offset-windowMetrics.stride);
      }
      range=objectListWindow(resultRows.length,{scroll:results.scrollTop,height:results.clientHeight,stride:windowMetrics.stride});
    }else if (resultRows.length>48&&typeof window.getComputedStyle==='function') {
      // Hidden/collapsed search: wait for the resize observer before mounting
      // rows that cannot currently be seen.
      range={start:0,end:Math.min(24,resultRows.length),before:0,after:0};
    }
    if (!force&&focusIndex===null&&renderedWindow?.start===range.start&&renderedWindow?.end===range.end&&
      renderedWindow?.before===range.before&&renderedWindow?.after===range.after)return;
    const nextNodes=new Map(),nodes=[];
    if (range.before)nodes.push(objectListSpacer(document,range.before,gap));
    for (let i=range.start;i<range.end;i++) {
      const item=resultRows[i],row=resultNodes.get(item.key)||rowFor(item,i);
      row.setAttribute('aria-posinset',String(i+1));row.setAttribute('aria-setsize',String(resultRows.length));
      nextNodes.set(item.key,row);nodes.push(row);
    }
    if (range.after)nodes.push(objectListSpacer(document,range.after,gap));
    if (renderedTruncated)nodes.push(createEmptyState('내장 도시 검색 결과를 일부 표시했습니다.','이름의 앞부분을 더 입력해 범위를 좁히세요.'));
    const focused=document.activeElement,retained=focused&&nodes.some(node=>node.contains(focused));
    if ([...resultNodes].some(([key,node])=>!nextNodes.has(key)&&node.matches?.(':hover')))commands.clearSearchHover();
    results.replaceChildren(...nodes);resultNodes=nextNodes;renderedWindow=range;
    commands.syncCanonicalControls?.(results);syncSelection();
    if (focusIndex!==null) {
      const row=resultNodes.get(resultRows[focusIndex]?.key);
      row?.querySelector(focusAction?'[data-object-search-focus]':'[data-object-search-select]')?.focus({preventScroll:true});
    }else if (retained&&document.activeElement!==focused)focused.focus?.({preventScroll:true});
  }
  function commitRows(query, rows) {
    const next = { source: resourceKey(['object-search', projectScope]), content: resourceKey(rows.map(item =>
      [item.key, item.id, item.layerGroup, item.name || '', item.typeLabel || '', item.flagUrl || ''])),
      preparation: 'search-rows-v1', context: null, presentation: resourceKey([query, builtinTruncated]) };
    const results = elements.searchResults;
    if (!resourceUpdate(renderedDependencies, next).present) {
      if (results) {
        results.inert = false;
        results.setAttribute('aria-busy', 'false');
      }
      syncSelection();
      return false;
    }
    results.inert = false;
    results.setAttribute('aria-busy', 'false');
    rowRevision++;
    const resetScroll=query!==renderedQuery;
    commands.clearSearchHover();
    results.replaceChildren();resultNodes.clear();renderedWindow=null;
    resultRows=rows;renderedQuery=query;renderedTruncated=builtinTruncated;
    if (resetScroll)results.scrollTop=0;
    renderedSearchRefs = rows.map(item => item.ref).filter(Boolean);
    if (query&&rows.length)renderWindow({force:true});
    else if (query)results.append(createEmptyState('검색 결과가 없습니다.','내장 도시는 두 글자 이상으로 이름의 앞부분을 검색하세요.'));
    commands.syncCanonicalControls?.(results);
    syncSelection();
    renderedDependencies = next;
    return true;
  }

  async function combinedRows(query, request) {
    const objects = await rowsFor(query, request);
    if (!Array.isArray(objects) || !isCurrentSearchRequest(request)) return null;
    const rows = [...objects, ...builtinRows.filter(row => builtinRecordVisible(row))];
    return [...new Map(rows.map(row => [row.key, row])).values()];
  }

  async function commitSearchRequest(request) {
    const rows = await combinedRows(request.query, request);
    if (!rows || !isCurrentSearchRequest(request)) return false;
    return commitRows(request.query, rows);
  }

  function reportSearchError(error, request) {
    if (!isCurrentSearchRequest(request)) return;
    const results = elements.searchResults;
    if (results) {
      results.inert = false;
      results.setAttribute('aria-busy', 'false');
    }
    if (error.cancelled || error.name === 'AbortError' || request.reportedError) return;
    request.reportedError = true;
    onSearchError(error);
  }

  function requestBuiltinRows(query, request) {
    const normalized = normalizePlaceQuery(query);
    const next = {
      source:resourceKey(['builtin-search', projectScope]),
      content:resourceKey([normalized, model.snapshot().builtinContext ?? null]),
      preparation:'search-v1',
      context:null,
      presentation:'results',
    };
    if (model.snapshot().searchActive === false || !resourceUpdate(builtinQuery, next).prepare) return;
    builtinQuery = next;
    const generation = ++builtinGeneration, requestScope = projectScope;
    cancelBuiltinSearch();
    builtinRows = [];
    builtinTruncated = false;
    if (!builtinSearch || [...normalized].length < 2) return;
    Promise.resolve().then(() => builtinSearch(normalized)).then(result => {
      if (disposed || generation !== builtinGeneration || requestScope !== readProjectScope()
        || !isCurrentSearchRequest(request) || model.snapshot().searchActive === false
        || normalizePlaceQuery(model.snapshot().search) !== normalized) return;
      builtinTruncated = result.truncated === true;
      builtinRows = result.records.slice(0, PLACE_LIMITS.searchResults).map(record => {
        const ref = normalizeObjectRef({domain:'label', type:record.kind, id:record.id});
        return {...record, key:ref.key, ref, layerGroup:'labels', kind:'object', meta:'내장 도시'};
      });
      return commitSearchRequest(request);
    }).catch(error => {
      if (disposed || generation !== builtinGeneration || requestScope !== readProjectScope()
        || !isCurrentSearchRequest(request)) return;
      builtinQuery = null;
      if (error.cancelled || error.name === 'AbortError' || request.reportedError) return;
      request.reportedError = true;
      onSearchError(error);
    });
  }

  function render() {
    if (disposed || projectSuspended) return false;
    syncProjectScope();
    const snapshot = model.snapshot();
    const query = String(snapshot.search || '').trim();
    const results = elements.searchResults;
    if (!results) return false;
    results.classList.toggle('hidden', !query);
    const request = getSearchRequest(query);
    results.inert = true;
    results.setAttribute('aria-busy', 'true');
    requestBuiltinRows(query, request);
    void commitSearchRequest(request).catch(error => reportSearchError(error, request));
    return true;
  }

  function syncSelection() {
    const current = selection();
    const keys = new Set((current.items || []).map(item => item.key));
    elements.searchResults?.querySelectorAll('[data-object-key]').forEach(row => {
      const selected = keys.has(row.dataset.objectKey);
      const primary = current.primaryKey === row.dataset.objectKey;
      row.classList.toggle('is-selected', selected);
      row.classList.toggle('is-primary-selected', primary);
      row.setAttribute('aria-selected', String(selected));
    });
  }

  function beginHydration() {
    commands.beginHydration?.();
  }

  async function completeHydration({isCurrent = () => true} = {}) {
    if (disposed||!isCurrent()||hydrated) return false;
    elements.section?.classList.remove('is-hydrating');
    elements.section?.setAttribute('aria-busy', 'false');
    if (elements.search) elements.search.disabled = false;
    commands.syncSearchClear?.();
    commands.objectSearchRendered?.();
    commands.layerReady?.();
    hydrated = true;
    window.dispatchEvent(new window.CustomEvent('pandolab:layer-ready'));
    return true;
  }

  async function selectResult(target, event) {
    focusIntentRevision++;
    if (!currentRow(target)) return false;
    const group = target.dataset.objectSearchSelect;
    const id = target.dataset.itemId;
    if (!group || !id) return false;
    const additive = event.ctrlKey || event.metaKey;
    const range = event.shiftKey;
    const queryRevision = searchGeneration, rowTicket = rowRevision, sourceScope = projectScope;
    const selected = await commands.selectItem({
      group, id, additive, range,
      orderedRefs: range ? renderedSearchRefs : [],
    });
    if (disposed || projectSuspended || queryRevision !== searchGeneration
      || rowTicket !== rowRevision || sourceScope !== readProjectScope()) return false;
    if (selected === true && !additive && !range) commands.closeAfterSingleSelection?.();
    return selected === true;
  }

  async function focusResult(target) {
    if (!currentRow(target)) return false;
    const group = target.dataset.objectSearchFocus;
    const id = target.dataset.itemId;
    if (!group || !id) return false;
    const intent = ++focusIntentRevision, sourceScope = projectScope;
    const selected = await commands.selectItem({ group, id, additive: false, range: false, orderedRefs: [] });
    // Selection opens details and retires the search rows. That expected UI
    // transition must not cancel the camera command belonging to this intent.
    if (selected !== true || disposed || projectSuspended || intent!==focusIntentRevision
      || sourceScope !== readProjectScope()) return false;
    await commands.focusItem?.(group,id);
    return true;
  }

  function bind() {
    if (bound || disposed) return;
    bound = true;
    stopVirtual=observeObjectList(window,elements.searchResults,()=>renderWindow());
    listen(elements.searchResults,'keydown',event=>{
      if (!renderedWindow||resultRows.length<=48||!['Tab','ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
      const row=event.target.closest('[data-object-key]');if(!row)return;
      const i=Number(row.getAttribute('aria-posinset'))-1;
      const action=Boolean(event.target.closest('[data-object-search-focus]'));
      let next=null,nextAction=action;
      if(event.key==='Tab') {
        if(!event.shiftKey&&action&&i===renderedWindow.end-1&&i+1<resultRows.length){next=i+1;nextAction=false;}
        else if(event.shiftKey&&!action&&i===renderedWindow.start&&i>0){next=i-1;nextAction=true;}
      }else next=event.key==='Home'?0:event.key==='End'?resultRows.length-1:i+(event.key==='ArrowDown'?1:-1);
      if(next!==null&&next>=0&&next<resultRows.length){event.preventDefault();renderWindow({focusIndex:next,focusAction:nextAction});}
    });
    const hoverRow = event => event.target.closest('[data-object-search-select]');
    listen(elements.searchResults, 'pointerover', event => {
      if (event.pointerType === 'touch') return;
      const row = hoverRow(event);
      if (currentRow(row) && !row.contains(event.relatedTarget))
        commands.hoverItem?.(row.dataset.objectSearchSelect, row.dataset.itemId, true);
    });
    listen(elements.searchResults, 'pointerout', event => {
      const row = hoverRow(event);
      if (currentRow(row) && !row.contains(event.relatedTarget))
        commands.hoverItem?.(row.dataset.objectSearchSelect, row.dataset.itemId, false);
    });
    listen(elements.search, 'input', event => {
      searchGeneration += 1;
      cancelObjectSearchRequest();
      builtinGeneration++;
      builtinQuery = null;
      cancelBuiltinSearch();
      commands.setSearchValue(event.currentTarget.value || '');
      if (elements.searchResults) {
        elements.searchResults.inert = true;
        elements.searchResults.setAttribute('aria-busy', 'true');
      }
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => {
        render();
      }, searchDelay);
    });
    listen(elements.searchClear, 'click', () => {
      if (!elements.search) return;
      elements.search.value = '';
      elements.search.dispatchEvent(new window.Event('input', { bubbles: true }));
      elements.search.focus({ preventScroll: true });
    });
    listen(elements.searchResults, 'click', event => {
      const focus = event.target.closest('[data-object-search-focus]');
      if (focus) {
        event.preventDefault();
        void focusResult(focus).catch (onSearchError);
        return;
      }
      const row = event.target.closest('[data-object-search-select]');
      if (row) void selectResult(row, event).catch (onSearchError);
    });
  }

  function cancelSearch() {
    searchGeneration++;
    cancelObjectSearchRequest();
    builtinGeneration++;
    builtinQuery = null;
    builtinRows = [];
    builtinTruncated = false;
    window.clearTimeout(searchTimer);
    cancelBuiltinSearch();
    if (elements.searchResults) {
      elements.searchResults.inert = false;
      elements.searchResults.setAttribute('aria-busy', 'false');
    }
    // Surface closure may detach the hovered row before pointerout is delivered.
    if (model.snapshot().searchSurfaceOpen === false) commands.clearSearchHover();
  }

  // The old map remains visible while a new C++ snapshot is prepared. Keep
  // its search rows visible but inert; they cannot select a disappearing ID
  // after Core admission or act on a superseded project generation.
  function beginProjectTransition() {
    if (disposed) return null;
    const ticket = ++projectTransition;
    projectSuspended = true;
    rowRevision++;
    cancelSearch();
    if (elements.searchResults) {
      elements.searchResults.inert = true;
      elements.searchResults.setAttribute('aria-busy', 'true');
    }
    return ticket;
  }

  function endProjectTransition(ticket) {
    if (disposed || !projectSuspended || ticket !== projectTransition) return false;
    projectSuspended = false;
    if (elements.searchResults) {
      elements.searchResults.inert = false;
      elements.searchResults.setAttribute('aria-busy', 'false');
    }
    renderedDependencies = null;
    renderedSearchRefs = [];
    cachedCatalog = null;
    cachedCatalogPromise = null;
    fallbackCatalog = null;
    fallbackRevision = undefined;
    catalogGeneration++;
    builtinQuery = null;
    builtinRows = [];
    builtinTruncated = false;
    void searchRuntime?.invalidate?.();
    syncProjectScope();
    // Reconcile a visible query immediately after accepted map publication.
    // Post-hydration may still be pending, but no retired country can remain.
    return String(model.snapshot().search || '').trim() ? render() : true;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    stopVirtual();resultNodes.clear();resultRows=[];
    for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
    bound = false;
    projectSuspended = false;
    projectTransition++;
    if (elements.searchResults) {
      elements.searchResults.inert = false;
      elements.searchResults.setAttribute('aria-busy', 'false');
    }
    searchGeneration++;
    cancelObjectSearchRequest();
    catalogGeneration++;
    builtinGeneration++;
    cancelBuiltinSearch();
    builtinRows = [];
    renderedSearchRefs = [];
    cachedCatalog = null;
    cachedCatalogPromise = null;
    fallbackCatalog = null;
    window.clearTimeout(searchTimer);
  }

  return Object.freeze({ bind, render, syncSelection, beginHydration, completeHydration,
    cancelSearch, beginProjectTransition, endProjectTransition, dispose });
}

const searchNameCollator = new Intl.Collator('ko', {numeric:true, sensitivity:'base'});
const compareSearchItems = (left, right) => searchNameCollator.compare(left.name, right.name)||searchNameCollator.compare(left.id, right.id);
export function syncSearchClearButton(input, button) {
  button?.classList.toggle('hidden', !String(input?.value||'').length);
}

export function createAppObjectSearchController(runtime = {}) {
  const {
    window, document, getElement: $, state,
    objectSearchGroupKeys, listObjectSearchItems, layerItemObjectRef, selectionDomain,
    selectObjectSearchItem, closeSearchAfterSingleSelection, focusObjectRef, createIcon,
  } = runtime;
  let searchValue = '';
  const handleHoverError = error => {if (!error.cancelled&&error.name!=='AbortError')runtime.onSearchError(error);};
  return createObjectSearchController({
    window,
    document,
    elements: {
      search: $('objectSearchInput'),
      searchClear: $('objectSearchClearBtn'),
      searchResults: $('objectSearchResults'),
      section: $('objectSearchSection'),
    },
    groups: { search: objectSearchGroupKeys },
    createEmptyState: runtime.createEmptyState,
    createIcon,
    builtinSearch: runtime.builtinSearch ? async query => {
      if (runtime.libraryAvailable?.()===false
        ||state.resourceCapabilities?.builtinPlaces===false||state.layerVisibility?.labels===false)
        return {records:[], truncated:false};
      const result = await runtime.builtinSearch(query);
      return {...result, records:result.records.map(record => {
        const name = result.displayNames?.[record.id];
        if (typeof name!=='string'||!name)throw new TypeError('Place search requires its accepted period display name.');
        return {...record, name};
      })};
    } : null,
    cancelBuiltinSearch: runtime.cancelBuiltinSearch,
    builtinRecordVisible: record => runtime.libraryAvailable?.()!==false
      &&state.resourceCapabilities?.builtinPlaces!==false&&state.layerVisibility?.labels!==false&&state.itemVisibility?.labels?.[record.id]!==false&&!(state.labels || []).some(label => String(label.sourcePlaceId || '') === String(record.id)),
    onSearchError: runtime.onSearchError,
    searchRuntime:runtime.searchRuntime,
    model: {
      snapshot: () => ({ projectScope:runtime.getProjectScope?.()??null,
        builtinContext:JSON.stringify([runtime.getProjectScope?.()??null, state.timelineCursor, state.layerVisibility?.labels, state.itemVisibility?.labels]),
        search: searchValue, searchActive: runtime.isSearchOpen(),
        searchSurfaceOpen: runtime.isSearchSurfaceOpen() }),
      items: listObjectSearchItems,
      catalogRevision: () => resourceKey([runtime.getProjectScope?.()??null, state.objectPresentationRevision]),
      itemRef: layerItemObjectRef,
      selectionSnapshot: () => selectionDomain.snapshot(),
      compare: compareSearchItems,
    },
    commands: {
      clearSearchHover: () => selectionDomain.setHover(null, { source: 'list' }).catch (handleHoverError),
      hoverItem: (group, id, entered) => {
        if (state.mapMoving) return;
        const ref = layerItemObjectRef(group, id);
        return selectionDomain.setHover(entered ? ref : null, { source: 'list', expectedKey: entered ? '' : ref?.key }).catch (handleHoverError);
      },
      syncCanonicalControls: runtime.syncCanonicalControls,
      syncSearchClear: () => syncSearchClearButton($('objectSearchInput'), $('objectSearchClearBtn')),
      beginHydration: () => {
        const metrics = window.__PANDOLAB_STARTUP_METRICS__;
        if (metrics && metrics.layerHydrationStartedMs == null) metrics.layerHydrationStartedMs = performance.now() - metrics.startedAt;
      },
      objectSearchRendered: () => {
        const metrics = window.__PANDOLAB_STARTUP_METRICS__;
        if (metrics) metrics.objectSearchRenderedMs = performance.now() - metrics.startedAt;
      },
      layerReady: () => {
        const metrics = window.__PANDOLAB_STARTUP_METRICS__;
        if (metrics) metrics.layerReadyMs = performance.now() - metrics.startedAt;
      },
      setSearchValue: value => {
        searchValue = value;
        syncSearchClearButton($('objectSearchInput'), $('objectSearchClearBtn'));
      },
      selectItem: ({ group, id, additive, range, orderedRefs }) => {
        const didSelect = selectObjectSearchItem(group, id, {
          mode: additive ? 'toggle' : 'replace',
          range,
          orderedRefs,
        });
        return didSelect;
      },
      focusItem: (group, id) => focusObjectRef?.(layerItemObjectRef(group, id)),
      closeAfterSingleSelection: closeSearchAfterSingleSelection,
    },
  });
}
