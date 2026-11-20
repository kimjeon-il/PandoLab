const paintAlpha = ['get', 'alpha'];
const layers = [
  {id: 'interaction-fill', type: 'fill', geometry: 'Polygon', paint: {
    'fill-antialias': false, 'fill-color': ['get', 'color'], 'fill-opacity': paintAlpha,
  }},
  {id: 'interaction-line', type: 'line', geometry: 'LineString',
    layout: {'line-join': 'round', 'line-cap': 'round'}, paint: {
      'line-color': ['get', 'color'], 'line-width': ['get', 'width'], 'line-opacity': paintAlpha,
    }},
  {id: 'interaction-point', type: 'circle', geometry: 'Point', paint: {
    'circle-color': ['get', 'color'], 'circle-radius': 7,
  }},
];
const collection = features => ({type: 'FeatureCollection', features});
const layerId = (slot, id) => slot ? id + '-standby' : id;
const sourceId = slot => slot ? 'interaction-standby' : 'interaction';
const empty = () => collection([]);

export function createMapLibreHighlight({map, write, preparePolar, clearPolar, isTemporal, onShown, onError, onStructure=()=>{}}) {
  let active = null;
  let pending = null;
  let disposed = false;
  let version = 0;
  let applied = null;
  let drawn = null;
  const used = new Set();
  const alive = request => !disposed && pending === request && request.style === map.style;

  function setVisible(slot, visible) {
    for (const {id, type} of layers) {
      const key = layerId(slot,id);
      if (!map.getLayer(key)) continue;
      const prop = type === 'circle' ? 'circle-opacity' : type + '-layer-opacity';
      map.setPaintProperty(key, prop, visible ? 1 : 0);
    }
  }

  function setUsed(slot, value) {
    for (const {id} of layers) {
      const key = layerId(slot,id);
      if (map.getLayer(key)) map.setLayoutProperty(key,'visibility',value ? 'visible' : 'none');
    }
  }

  function ensure(slot) {
    const source = sourceId(slot);
    const before = map.getLayer('viewer-label-dot') ? 'viewer-label-dot' : undefined;
    if (!map.getSource(source)) map.addSource(source, {type: 'geojson', data: empty(), tolerance: 0});
    let added = false;
    for (const {id, geometry, layout, type, paint} of layers) {
      const key = layerId(slot,id);
      if (map.getLayer(key)) continue;
      const opacity = type === 'circle' ? 'circle-opacity' : type + '-layer-opacity';
      map.addLayer({id:key, source, type, layout:{...layout, visibility:'none'},
        filter:['==',['geometry-type'],geometry],
        paint:{...paint,[opacity]:0,[opacity+'-transition']:{duration:0,delay:0}}}, before);
      added = true;
    }
    used.add(slot);
    if (added) onStructure();
  }

  function fail(request, error, timedOut=false) {
    if (!alive(request)) return;
    request.ready = false;
    if (request.attempt++ === 0) {
      if (timedOut&&!request.reuseNative) {
        // A stuck write still owns the previous source queue. Retire only the
        // hidden slot so its unresolved work cannot strand the next retry.
        const source = sourceId(request.slot);
        for (const {id} of layers) {
          const key = layerId(request.slot,id);
          if (map.getLayer(key)) map.removeLayer(key);
        }
        if (map.getSource(source)) map.removeSource(source);
        ensure(request.slot);
        request.source = map.getSource(source);
        setUsed(request.slot,true);
      }
      request.timeout = setTimeout(() => stage(request), 125);
      return;
    }
    pending = null;
    if (request.slot !== active) setUsed(request.slot,false);
    if (isTemporal() && request.selectionKey !== drawn?.selectionKey) reset();
    onError(error);
  }

  function stage(request) {
    if (!alive(request)) return;
    const id = sourceId(request.slot);
    const source = request.source;
    const current = () => alive(request) && source === map.getSource(id);
    const deadline = setTimeout(() => fail(request,Error('Highlight source did not become ready.'),true), 10_000);
    request.timeout = deadline;
    request.ready = false;
    const attempt = request.attempt;
    const written = request.reuseNative ? true : write(id, collection(request.features), current);
    Promise.all([written, preparePolar(request.polar)])
      .then(([written, commitPolar]) => {
        if (!current() || attempt !== request.attempt) return;
        if (!written) throw new DOMException('Highlight superseded','AbortError');
        request.commitPolar = commitPolar;
        request.ready = true;
        map.triggerRepaint();
      }).catch(error => {
        if (attempt !== request.attempt) return;
        clearTimeout(deadline);
        fail(request,error);
      });
  }

  function submit(key, features, polar, selectionKey, nativeKey=key) {
    if (disposed || key === pending?.key || (!pending && key === applied?.key)) return;
    clearTimeout(pending?.timeout);
    const reuseNative=active!==null&&applied?.nativeKey===nativeKey;
    const slot = reuseNative?active:active===0?1:0;
    if(!reuseNative){
      ensure(slot);
      setVisible(slot,false);
      setUsed(slot,true);
    }else if(pending&&pending.slot!==active)setUsed(pending.slot,false);
    pending = {key, selectionKey, nativeKey, reuseNative, features, polar, slot, style:map.style,
      source:map.getSource(sourceId(slot)), revision:++version, startedAt:performance.now(), attempt:0};
    stage(pending);
  }

  function onRender() {
    if (applied && applied !== drawn) {
      drawn = applied;
      drawn.shownAt = performance.now();
      onShown(drawn);
    }
    const next = pending;
    if (!next || !alive(next) || !next.ready || next.source !== map.getSource(sourceId(next.slot))
      || !next.reuseNative&&!map.isSourceLoaded(sourceId(next.slot))) return;
    clearTimeout(next.timeout);
    if (next.commitPolar() === false) {
      fail(next, new DOMException('Highlight projection superseded','AbortError'));
      return;
    }
    if (!next.reuseNative) {
      if (active !== null) {
        setVisible(active,false);
        setUsed(active,false);
      }
      setVisible(next.slot,true);
    }
    active = next.slot;
    applied = {key:next.key, selectionKey:next.selectionKey, nativeKey:next.nativeKey, revision:next.revision,
      sourceId:sourceId(active), startedAt:next.startedAt};
    pending = null;
    map.triggerRepaint();
  }

  function reset() {
    clearTimeout(pending?.timeout);
    pending = applied = drawn = null;
    for (const slot of used) {
      setVisible(slot,false);
      setUsed(slot,false);
    }
    active = null;
    clearPolar();
  }

  return {submit, onRender, reset,
    ids:()=>[...used].flatMap(slot=>layers.map(({id})=>layerId(slot,id))),
    owns:id=>id === sourceId(0) || id === sourceId(1),
    hasHover:()=>[applied,pending].some(request=>request&&request.key!==request.selectionKey),
    selectionPending(){
      const displayedSelection = drawn?.selectionKey ?? '[]';
      return !!(pending && pending.selectionKey !== displayedSelection
        || applied && applied.selectionKey !== displayedSelection);
    },
    stats:()=>({revision:drawn?.revision ?? 0, sourceId:drawn?.sourceId ?? null,
      startedAt:drawn?.startedAt ?? null, shownAt:drawn?.shownAt ?? null, pending:!!pending}),
    dispose(){disposed=true;reset();},
  };
}
