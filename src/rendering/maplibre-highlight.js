import {mapLibreGeoJsonSource} from './maplibre-source-spec.js';
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
const globeLineGrid = 512;
const lineVertexBudget = 6000;
const phaseTimeoutMs = 10_000;
const mercatorY = latitude => (1 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / Math.PI) / 2;

export function partitionHighlightLines(geometry) {
  const coordinates = [];
  for (const line of geometry.coordinates) {
    let start = 0, estimatedVertices = 1;
    let previousY = line.length ? mercatorY(line[0][1]) : 0;
    let previousDx = 0, previousDy = 0;
    let splitIndex = -1, splitCost = 0, splitAlignment = -2;
    for (let index = 1; index < line.length; index++) {
      const [longitude, latitude] = line[index];
      const y = mercatorY(latitude);
      const dx = (longitude - line[index - 1][0]) / 360, dy = y - previousY;
      // The world-space grid bounds globe subdivisions across tile zooms.
      // Allow for clipped endpoints and conversion to integer tile coordinates.
      const edgeCost = 4 + Math.ceil(globeLineGrid * Math.abs(dx)) + Math.ceil(globeLineGrid * Math.abs(dy));
      // Keep round caps off corners when cutting a long outline.
      if (estimatedVertices >= lineVertexBudget * 0.75) {
        const lengthProduct = Math.hypot(previousDx,previousDy) * Math.hypot(dx,dy);
        const alignment = lengthProduct ? (previousDx*dx+previousDy*dy)/lengthProduct : -2;
        if (alignment >= splitAlignment) {
          splitIndex = index - 1;
          splitCost = estimatedVertices;
          splitAlignment = alignment;
        }
      }
      if (estimatedVertices + edgeCost > lineVertexBudget && index - start > 1) {
        const split = splitIndex < 0 ? index - 1 : splitIndex;
        coordinates.push(line.slice(start, split + 1));
        estimatedVertices = splitIndex < 0 ? 1 : estimatedVertices - splitCost + 1;
        start = split;
        splitIndex = -1;
        splitAlignment = -2;
      }
      estimatedVertices += edgeCost;
      previousY = y;
      previousDx = dx;
      previousDy = dy;
    }
    coordinates.push(start === 0 ? line : line.slice(start));
  }
  return coordinates.length === geometry.coordinates.length ? geometry : {...geometry, coordinates};
}

export function createMapLibreHighlight({map, write, preparePolar, clearPolar, onShown, onError, onRestoreSelection, onStructure=()=>{}}) {
  let active = null;
  let pending = null;
  let disposed = false;
  let version = 0;
  let applied = null;
  let drawn = null;
  const used = new Map();
  const slotLayers = slot => used.get(slot) ?? layers;
  const alive = request => !disposed && pending === request && request.style === map.style;

  function setVisible(slot, visible) {
    for (const {id, type, opacity = 1} of slotLayers(slot)) {
      const key = layerId(slot,id);
      if (!map.getLayer(key)) continue;
      const prop = type === 'circle' ? 'circle-opacity' : type + '-layer-opacity';
      map.setPaintProperty(key, prop, visible ? opacity : 0);
    }
  }

  function setUsed(slot, value) {
    for (const {id} of slotLayers(slot)) {
      const key = layerId(slot,id);
      if (map.getLayer(key)) map.setLayoutProperty(key,'visibility',value ? 'visible' : 'none');
    }
  }

  function ensure(slot, features) {
    const source = sourceId(slot);
    const before = map.getLayer('viewer-label-dot') ? 'viewer-label-dot' : undefined;
    if (!map.getSource(source)) map.addSource(source, mapLibreGeoJsonSource('highlight',empty()));
    const opacities = [...new Set(features.map(feature => feature.properties?.splitOpacity).filter(Number.isFinite))];
    const nextLayers = layers.flatMap(layer => layer.type !== 'line' ? [layer] : [
      {...layer, filter:['!', ['has','splitOpacity']]},
      // Composite the complete stroke before applying its opacity so the
      // round ends of adjacent pieces do not darken their shared pixel.
      ...opacities.map(opacity => ({...layer, id:layer.id+'-opacity-'+opacity,
        paint:{...layer.paint,'line-opacity':1}, opacity, filter:['==',['get','splitOpacity'],opacity]})),
    ]);
    let changed = false;
    const wanted = new Set(nextLayers.map(layer=>layer.id));
    for (const {id} of slotLayers(slot)) {
      const key = layerId(slot,id);
      if (!wanted.has(id) && map.getLayer(key)) {map.removeLayer(key);changed=true;}
    }
    for (const {id, geometry, layout, type, paint, filter} of nextLayers) {
      const key = layerId(slot,id);
      if (map.getLayer(key)) continue;
      const opacity = type === 'circle' ? 'circle-opacity' : type + '-layer-opacity';
      const shape = ['==',['geometry-type'],geometry];
      map.addLayer({id:key, source, type, layout:{...layout, visibility:'none'},
        filter:filter?['all',shape,filter]:shape,
        paint:{...paint,[opacity]:0,[opacity+'-transition']:{duration:0,delay:0}}}, before);
      changed = true;
    }
    used.set(slot,nextLayers);
    if (changed) onStructure();
  }

  function clearTimers(request) {
    if (!request) return;
    for (const timer of request.timers.values()) clearTimeout(timer);
    request.timers.clear();
  }

  function clearTimer(request, phase) {
    clearTimeout(request.timers.get(phase));
    request.timers.delete(phase);
  }

  function fail(request, phase, error, timedOut = false) {
    if (!alive(request)) return;
    clearTimer(request, phase);
    clearTimer(request, 'tile-render');
    if (request.attempt++ === 0) {
      const retryPhase = phase === 'tile-render' && !request.reuseNative ? 'source-write' : phase;
      if (retryPhase === 'source-write' && timedOut && !request.reuseNative) {
        // A stalled write or tile belongs to the hidden slot only.
        const source = sourceId(request.slot);
        for (const {id} of slotLayers(request.slot)) {
          const key = layerId(request.slot,id);
          if (map.getLayer(key)) map.removeLayer(key);
        }
        if (map.getSource(source)) map.removeSource(source);
        ensure(request.slot,request.features);
        request.source = map.getSource(source);
        setUsed(request.slot,true);
      }
      if (retryPhase === 'source-write') request.nativeReady = false;
      if (retryPhase === 'polar-prepare') request.commitPolar = null;
      request.timers.set('retry', setTimeout(() => {
        request.timers.delete('retry');
        if (retryPhase === 'tile-render') {
          armRenderDeadline(request);
          map.triggerRepaint();
        } else stage(request, retryPhase);
      }, 125));
      return;
    }
    clearTimers(request);
    pending = null;
    if (request.slot !== active) setUsed(request.slot,false);
    const selectionChanged = request.selectionKey !== (applied?.selectionKey ?? '[]');
    const staleHover = applied && applied.key !== applied.selectionKey;
    if (selectionChanged || staleHover) reset();
    const id = sourceId(request.slot);
    const objectKeys = [...new Set(request.features.map(feature => feature.properties?.objectKey).filter(Boolean))];
    const failure = new Error(`Highlight ${phase} failed (${id}, attempts ${request.attempt}, objects ${JSON.stringify(objectKeys)}): ${error.message}`, {cause:error});
    Object.assign(failure,{name:error.name,phase,sourceId:id,objectKeys,attempts:request.attempt});
    onError(failure);
    if (staleHover && !selectionChanged && request.selectionKey !== '[]') {
      onRestoreSelection(request.selectionKey);
    }
  }

  function armRenderDeadline(request) {
    if (!alive(request) || !request.nativeReady || !request.commitPolar || request.timers.has('retry')) return;
    if (map.isMoving()) {
      clearTimer(request, 'tile-render');
    } else if (!request.timers.has('tile-render')) {
      request.timers.set('tile-render', setTimeout(() => {
        fail(request, 'tile-render', Error('The current highlight tiles were not rendered.'), true);
      }, phaseTimeoutMs));
    }
  }

  function stage(request, phase) {
    if (!alive(request)) return;
    const id = sourceId(request.slot);
    const source = request.source;
    const native = phase === 'source-write';
    const current = () => alive(request) && request.timers.get(phase) === deadline
      && (!native || source === map.getSource(id));
    const deadline = setTimeout(() => {
      if (current()) fail(request, phase, Error('Preparation timed out.'), true);
    }, phaseTimeoutMs);
    request.timers.set(phase, deadline);
    Promise.resolve()
      .then(() => {
        if (!current()) return false;
        return native ? write(id, collection(request.features), current) : preparePolar(request.polar);
      })
      .then(result => {
        if (!current()) return;
        if (!result) throw new DOMException('Highlight superseded','AbortError');
        clearTimer(request, phase);
        if (native) request.nativeReady = true;
        else request.commitPolar = result;
        armRenderDeadline(request);
        map.triggerRepaint();
      }).catch(error => {
        if (current()) fail(request,phase,error);
      });
  }

  function submit(key, features, polar, selectionKey, nativeKey=key) {
    if (disposed || key === pending?.key || (!pending && key === applied?.key)) return;
    // Leaving a hovered object can coincide with the first camera frame.
    // Hide the existing highlight without submitting an empty tile source.
    if (!features.length && !polar.length) {
      if (active !== null || pending) {
        reset();
        map.triggerRepaint();
      }
      return;
    }
    clearTimers(pending);
    const reuseNative=active!==null&&applied?.nativeKey===nativeKey;
    const slot = reuseNative?active:active===0?1:0;
    if(!reuseNative){
      ensure(slot,features);
      setVisible(slot,false);
      setUsed(slot,true);
    }else if(pending&&pending.slot!==active)setUsed(pending.slot,false);
    pending = {key, selectionKey, nativeKey, reuseNative, features, polar, slot, style:map.style,
      source:map.getSource(sourceId(slot)), revision:++version, startedAt:performance.now(), attempt:0,
      nativeReady:reuseNative, commitPolar:null, timers:new Map()};
    if (!reuseNative) stage(pending,'source-write');
    stage(pending,'polar-prepare');
  }

  function onRender() {
    if (applied && applied !== drawn) {
      drawn = applied;
      drawn.shownAt = performance.now();
      onShown(drawn);
    }
    const next = pending;
    if (!next || !alive(next) || !next.nativeReady || !next.commitPolar || next.source !== map.getSource(sourceId(next.slot))
      || !next.reuseNative&&!map.isSourceLoaded(sourceId(next.slot))) return;
    clearTimers(next);
    if (next.commitPolar() === false) {
      fail(next, 'polar-prepare', new DOMException('Highlight projection superseded','AbortError'));
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
    clearTimers(pending);
    pending = applied = drawn = null;
    for (const slot of used.keys()) {
      setVisible(slot,false);
      setUsed(slot,false);
    }
    active = null;
    clearPolar();
  }

  return {submit, onRender, reset, onCameraChange(){if(pending)armRenderDeadline(pending);},
    ids:()=>[...used].flatMap(([slot,rows])=>rows.map(({id})=>layerId(slot,id))),
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
