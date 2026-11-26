import { createGlobeAssetReader } from './globe-asset-reader.js';
import { createGlobeViewerInput } from '../map/globe-viewer-input.js';
import { normalizeObjectRef } from '../document/object-ref-identity.js';
import { coordinateBounds } from '../geometry/coordinate-bounds.js';
import { geometryReferenceFor } from '../geometry/geometry-version-store.js';
import { layerStyle, territorialNamesVisible } from '../ui/layer-presentation.js';
import { createGlobePresentationInputReader, globeChangedHiddenIds } from './globe-style-state.js';
import { createGlobePaintState } from './globe-paint-state.js';
import { createGlobeLabelContent } from './globe-label-content.js';
import { PLACE_DISPLAY_ZOOM_FLOOR } from '../map/map-display-zoom.js';
import { createGlobeCamera } from './globe-camera.js';
import { COUNTRY_LABEL_MIN_ZOOM } from './three-globe-labels.js';
import { globeTerritoryKey } from './globe-mesh.js';
import { createGlobeChunkAssets, createGlobeChunkCatalog, globeViewChunkCuller, globeChunkSetContains, globeChunkPlanKey, createGlobePlanFailures } from './globe-view-mesh-assets.js';
import { createGlobeHistoryIndex, globeHistoryMonthKey } from './globe-history-index.js';
import { createGlobeTemporalPresentation } from './globe-temporal-presentation.js';
import { createGlobePacketTasks, globePacketWorkerCount } from './globe-packet-tasks.js';
import { createGlobeWorkScheduler, estimateGlobeWorkingBytes } from './globe-work-scheduler.js';
import { globeRayIntersectsBounds, globeStrokePickPredicate, createGlobePacketIndex, createGlobePickBudget, pickGlobeSlotsCooperative, pickGlobeStrokeSlotsCooperative } from './globe-picking.js';
import { createMapPresentationSession } from './map-presentation-session.js';
import { createThreeGlobeSurface } from './three-globe-surface.js';
import { createRenderingMetrics } from './rendering-metrics.js';
import { createGlobeRiverDetail } from './three-globe-rivers.js';
import { createRenderPacketCache, renderCacheBudget, createRenderResidencyBudget, createRenderLoadGate } from './render-cache-budget.js';
import { createGlobePhysicalAssets } from './three-globe-physical.js';

const copyCamera = (view, backup) => ({...backup, ...view, center:view?.center??(view?.globeRotation&&view.globeRotation.slice(0, 2).map(v => -v))??backup.center});

export function createThreeViewerRenderer(deps, {meta, initialCamera, presentMapPreparation, onMapPreparationStatus, readSafeInsets, onWorldFitChange}) {
  const {state} = deps.projectState;
  const spec = meta.globePreview, baseSlots = spec.countrySlots;
  const slots = [...baseSlots];
  const slotByKey = new Map(slots.map(({id, geometry}, slot) => [globeTerritoryKey(id, geometry), slot]));
  const labelsBySlot = baseSlots.map(row => spec.countryLabels[row.id]);
  const refs = slots.map(({id}) => normalizeObjectRef({domain:'territorial', type:'entity', id}));
  let historyIndex = createGlobeHistoryIndex({version:1, stride:32, rows:[]}, baseSlots.length);
  let historyLoaded = false, historyCatalogBytes = 0;
  const historyCatalogKey = {};
  if (!Number.isSafeInteger(spec.historySlotCount)||spec.historySlotCount<0||!spec.historyCatalog)throw Error('Missing Three.js history catalog');
  const countryCount = baseSlots.length+spec.historySlotCount;
  const baseTerritories = historyIndex.base;
  const cacheBudget = renderCacheBudget();
  const residency = createRenderResidencyBudget(cacheBudget.totalRenderBytes, {groups:{
    outline:{byteBudget:cacheBudget.outlineBytes},
    outlinePacket:{entryLimit:128},
    outlineChunk:{byteBudget:Math.floor(cacheBudget.outlineBytes/4),entryLimit:64,standbyOnly:true},
  }});
  const historyCatalogCache = createRenderPacketCache({byteBudget:Infinity, entryLimit:1});
  const loadGate = createRenderLoadGate({concurrency:cacheBudget.concurrentLoads, byteBudget:cacheBudget.pendingBytes, residency});
  const workScheduler = createGlobeWorkScheduler({maxConcurrent:globePacketWorkerCount(), residency});
  const hydroMetadataCache = createRenderPacketCache({byteBudget:16*1024*1024, entryLimit:1});
  let refreshRiverLedger = () => {}, refreshHydroLedger = () => {};
  let acceptedPick = null, drawnFrame = null, residencyDirty = true;
  const temporalInputs = createGlobeTemporalPresentation();
  let temporalStats = {};
  const pendingOutlines = new Map(), requestScopes = new Map();
  let prefetchTerritoryPlan = null, prefetchPhysical = null, visiblePhysicalPlan = null, publishedPhysical = null;
  let basePrepared = null, basePreparing = null, publishedBase = null, baseJobRequired = false, physicalJobRequired = false;
  const baseFailures = createGlobePlanFailures(), physicalFailures = createGlobePlanFailures();
  let neighborTimer = null, neighborIdleOff = null, neighborKey = null, publishedMonth = null, monthDirection = 0;
  const neighborStats = {runs:0, completed:0, cancelled:0, claimedBytes:0, idleWaits:0, pressureSkips:0};
  let fontReady = false, fontPending = null, fontFailed = false, lastLabelsNeeded = false;
  const failedLineLayers = new Set();
  const invalidate = reason => deps.domains.renderingDomain.invalidateView(reason);
  const lifetime = new AbortController();
  const metrics = createRenderingMetrics(), packetTasks = createGlobePacketTasks({scheduler:workScheduler});
  let host, canvas, surface, camera, viewport, pending, disposed = false, lost = false, loaded = false, ready = false, error;
  let generation = 0, contextRevision = 0, revision = 0, lastFrame = null, lastCamera = null, features = null;
  let territories = baseTerritories, acceptedTerritories = baseTerritories, activeSlots = new Set(baseTerritories.slots);
  let activeSlotByKey = new Map(baseTerritories.slots.map(slot => [refs[slot].key, slot]));
  let pickingRevision = 0, pickingChanged = false;
  let outlineTargets = new Map(), outlinePlanDirty = true, lastOutlineCamera = null, outlinePaintDirty = true;
  let presentationInputs = null, qualityKey = null;
  const readPresentationInputs = createGlobePresentationInputReader();
  const outlineStats = {outlinePlans:0, outlineDownloads:0};
  const outlineBySlot = new Map(), outlineFailed = new Set();
  let framePreserved = false, initialLoading = true, drawCount = 0, unsupported = false;
  let riverDetail, riverCamera = null, riverVisible = null, riverContext = null;
  let physical = null, acceptedPhysical = null;
  let acceptedRiverChunks = [], hydroMetadata = null;
  const hydroSlots = new Map();
  const paint = createGlobePaintState({
    state, refs, hydroSlots, readPalette:() => deps.preferences.mapPalette(),
    territorialColor:row => deps.colorModel.territorialEntityColor(row),
    objectRefVisible:ref => deps.objectRefVisible(ref), highlightCandidates:() => deps.highlightCandidates(),
    onPickingChanged:() => {pickingChanged = true;},
    onOutlineRolesChanged:() => {outlinePlanDirty = outlinePaintDirty = true;},
  });
  const labelContent = createGlobeLabelContent({
    state, refs, labelsBySlot, territorialName:(row, options) => deps.objectPresentation.territorialEntityName(row, options),
    readPreferences:() => deps.preferences.userPreferences, objectRefVisible:ref => deps.objectRefVisible(ref),
    isLayerItemVisible:(group, id) => deps.layerPresentation.isLayerItemVisible(group, id),
    placeLabelCandidates:options => deps.countryLabelModel.placeLabelCandidates(options),
  });
  let view = {center:[15, 12], zoom:2, bearing:0, pitch:0, roll:0};
  const readyState = () => ({mapReady:ready, status:error?'error':ready?'ready':'loading'});
  const presentation = createMapPresentationSession({getGeneration:() => generation, getContextRevision:() => contextRevision,
    isDisposed:() => disposed, getReadiness:readyState, invalidateFrame:invalidate, prepareContentKey:async(rows, isCurrent) => {
      const month = state.timelineCursor, match = await requireTerritorialGeometry(month, featureRefs(rows), lifetime.signal);
      return isCurrent()&&month===state.timelineCursor?match.key:null;
    },
    isProjectBlocked:() => Boolean(error), isRecoveryFrameAdmissible:() => !lost,
    waitForCanonicalFrame:() => presentation.waitForMapPresentation(generation), onTemporalRetired:() => {framePreserved = false;}});

  function startRequest(name) {
    const previous = requestScopes.get(name), controller = new AbortController();
    requestScopes.set(name, controller); if (previous)queueMicrotask(() => previous.abort()); return controller;
  }
  const requestCurrent = (name, controller) => requestScopes.get(name)===controller&&!controller.signal.aborted&&!disposed;
  function finishRequest(name, controller) {if (requestScopes.get(name)===controller)requestScopes.delete(name);}
  function cancelRequest(name) {
    const controller = requestScopes.get(name); requestScopes.delete(name); controller?.abort();
  }
  function cancelNeighborPrefetch() {
    if (neighborIdleOff) {neighborIdleOff(); neighborIdleOff = null; neighborKey = null;}
    if (neighborTimer!==null) {clearTimeout(neighborTimer); neighborTimer = null; neighborKey = null;}
    if (requestScopes.has('neighbor-prefetch')) {cancelRequest('neighbor-prefetch'); neighborKey = null; neighborStats.cancelled++;}
  }
  function clearPreparation() {
    cancelNeighborPrefetch();
    for (const name of ['country-prefetch','physical-prefetch','territory-apply','physical-view','base-view','neighbor-prefetch','pick-click','pick-hover'])cancelRequest(name);
    prefetchTerritoryPlan = null; prefetchPhysical = null; visiblePhysicalPlan = null; basePreparing = null; baseFailures.clear(); physicalFailures.clear();
    retainCpuResources();
  }
  function cancelOutlines() {
    for (const controller of pendingOutlines.values())controller.abort();
    pendingOutlines.clear(); outlineTargets = new Map(); outlineFailed.clear(); outlinePlanDirty = outlinePaintDirty = true; lastOutlineCamera = null;
  }
  function beginTemporalViewTransition(...args) {clearPreparation(); return presentation.beginTemporalViewTransition(...args);}
  function finishTemporalViewTransition(token) {
    const current = presentation.ticket?.token===token;
    const accepted = presentation.ticket?.presented;
    const result = presentation.finishTemporalViewTransition(token);
    if (current&&!accepted)clearPreparation();
    return result;
  }
  function notify(status, label) {
    const value = {status, label, mapReady:ready, retry:status==='error'&&loaded&&!!features&&!presentation.temporalPending()};
    presentMapPreparation(value, {retry:retryMapPreparation}); onMapPreparationStatus?.(value, generation);
  }
  function failMapPreparation(cause) {
    if (disposed)return;
    error = cause; ready = false; notify('error','지도 불러오기 실패');
    presentation.rejectMapPresentationWaiters(cause); presentation.failTemporalPresentation(cause);
    deps.feedback.reportOperationError(cause,'Three.js 지도를 표시하지 못했습니다.','PL-THREE-001');
  }
  function retryMapPreparation() {error = null; baseFailures.clear(); physicalFailures.clear(); failedLineLayers.clear(); fontFailed = false; outlineFailed.clear(); outlinePlanDirty = true; riverCamera = null; return invalidate('map-retry');}
  function setCamera(next) {cancelNeighborPrefetch(); camera = next; view = next.view; invalidate('three-camera');}
  const input = createGlobeViewerInput({
    getCamera:() => camera, getViewport:() => viewport, setCamera, invalidate,
    beforeMovement:cancelNeighborPrefetch,
    onMovementStart:() => deps.domains.renderingDomain.beginInteraction('three-move'),
    onMovementEnd:() => {
      onWorldFitChange();
      deps.domains.renderingDomain.endInteraction('three-move-end');
    },
    signal:lifetime.signal,
  });

  function attach(element) {
    host = element; canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none';
    host.appendChild(canvas); input.attach(canvas);
    const listen = (type, fn) => canvas.addEventListener(type, fn, {signal:lifetime.signal});
    listen('webglcontextlost', event => {event.preventDefault(); lost = true; ready = false; notify('loading','그래픽 연결 복구 중');});
    listen('webglcontextrestored', () => {lost = false; contextRevision++; surface?.restoreCountryPaint(); pickingChanged = true; presentation.rebaseContext(); invalidate('three-context-restored');});
  }
  const assetReader = createGlobeAssetReader({
    dataRevision:meta.dataRevision, cacheBudget, residency, loadGate, packetTasks, metrics, lifetime,
    resolveUrl:row => new URL(row.url, document.baseURI).href,
  });
  const {load, loadTerritorialStroke} = assetReader;
  const loadMesh = async(row, signal, priority = 20) => ({packet:await load(row,'mesh', {signal, priority})});
  function territorialDescriptors(catalog = null) {
    if (!catalog)return [
      ...spec.countryChunks.map((row, i) => ({...row, role:'country', key:'base-country:'+i+':'+row.spec.sha256})),
      ...spec.borderChunks.map((row, i) => ({...row, role:'border', kind:'stroke', baseBorder:true, key:'base-border:'+i+':'+row.spec.sha256})),
    ];
    return [
      ...catalog.historicalCountries.flatMap((country, i) => country.countryChunks.map((row, j) => ({...row, role:'country', historySlot:baseSlots.length+i, key:'history-country:'+i+':'+j+':'+row.spec.sha256}))),
      ...catalog.historicalBorders.flatMap((border, i) => border.chunks.map((row, j) => ({...row, role:'border', kind:'stroke', historyBorder:i, key:'history-border:'+i+':'+j+':'+row.spec.sha256}))),
    ];
  }
  const territorialAssets = createGlobeChunkAssets(territorialDescriptors(), {loadMesh, loadStroke:loadTerritorialStroke, residency, byteBudget:cacheBudget.historicalCpuBytes});
  const borderPlansByView = new WeakMap();
  function combineHistoryBorders(rows) {
    const groups = new Map(), result = [];
    for (const row of rows) {
      if (row.role!=='border'||row.baseBorder) {result.push(row); continue;}
      const cell = row.cell;
      let group = groups.get(cell); if (!group) {group = []; groups.set(cell, group);}group.push(row);
    }
    for (const group of groups.values()) {
      let sources = [], decodedBytes = 0;
      const flush = () => {
        if (sources.length===1)result.push(sources[0]);
        else if (sources.length) {
          const key = 'border-batch:'+sources.map(row => row.key).join(',');
          const compressedBytes = sources.reduce((sum, row) => sum+(Number(row.spec.compressedBytes)||0), 0);
          const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
          for (const row of sources)for (let axis = 0; axis<3; axis++) {
            bounds[axis] = Math.min(bounds[axis], row.bounds[axis]); bounds[axis+3] = Math.max(bounds[axis+3], row.bounds[axis+3]);
          }
          result.push({role:'border', kind:'stroke', key, sources, bounds, spec:{sha256:key, decodedBytes, compressedBytes, estimatedBytes:compressedBytes*3+decodedBytes*7+64*1024}});
        }
        sources = []; decodedBytes = 0;
      };
      for (const row of group) {
        const bytes = Number(row.spec.decodedBytes)||0;
        if (sources.length&&(sources.length>=32||decodedBytes+bytes>cacheBudget.borderBatchBytes))flush();
        sources.push(row); decodedBytes+=bytes;
      }
      flush();
    }
    return result;
  }
  function addOutlineDescriptors(row, slot) {
    const chunks = row.outlineChunks;
    for (let order = 0; order<chunks.length; order++) {
      const chunk = chunks[order], descriptor = {...chunk, key:'outline:'+(slot??'base')+':'+order+':'+chunk.spec.sha256, slot, order, count:chunks.length};
      for (const owner of chunk.ownerSlots) {
        let rows = outlineBySlot.get(owner); if (!rows) {rows = []; outlineBySlot.set(owner, rows);}rows.push(descriptor);
      }
    }
  }
  addOutlineDescriptors(spec, null);
  async function loadOutlines(row, signal) {
    const owners = row.owners;
    if (!owners?.length||owners.some(group => !group.length||group.some(slot => !Number.isInteger(slot)||slot<0||slot>=slots.length)))
      throw Error('Invalid globe outline owners');
    const packet = await load(row.spec,'stroke', {phase:'background', priority:6, label:'선택 윤곽선', signal, ownerCount:owners.length, outlineOwners:owners});
    return {packet, owners, preparedIndex:packet.outlineIndex};
  }
  const graticuleNeeded = () => state.backgroundSettings?.graticule!==false&&state.resourceCapabilities?.graticule!==false;
  const bordersNeeded = () => state.layerVisibility.objects!==false&&layerStyle(state.layerPresentation,'objects').boundaryVisible!==false;
  const physicalAssets = createGlobePhysicalAssets([spec.physical], {
    loadMesh, loadStroke:(row, signal, priority = 20) => load(row,'stroke', {signal, priority}), byteBudget:cacheBudget.physicalCpuBytes, residency,
  });
  let planCamera = null, planViewport = null; const cullCache = new Map(), territoryPlans = new Map(), physicalPlans = new Map(), planKeys = new WeakMap();
  function clearViewPlans() {planCamera = null; planViewport = null; cullCache.clear(); territoryPlans.clear(); physicalPlans.clear();}
  function syncViewPlans() {
    if (planCamera===camera&&planViewport===viewport)return;
    clearViewPlans(); planCamera = camera; planViewport = viewport;
  }
  const viewCull = (padding = 0) => {
    syncViewPlans(); let cull = cullCache.get(padding);
    if (!cull) {cull = globeViewChunkCuller(camera, viewport, padding); cullCache.set(padding, cull);}return cull;
  };
  const strokePadding = () => {
    const palette = paint.currentPalette();
    let width = Math.max(1, Number(palette.strokes.country.width)||1, (Number(palette.strokes.river.width)||1)*3);
    for (const row of paint.roleStyles())width = Math.max(width, row?.width??0);
    return Math.max(5, Math.ceil(width+2*(0.5/(viewport?.dpr||1))+2));
  };
  function physicalPlan(identity, padding = 0) {
    syncViewPlans(); const extra = strokePadding(), lakesVisible = state.layerVisibility.lakes!==false, riversVisible = state.layerVisibility.rivers!==false;
    const key = JSON.stringify([identity, padding, extra, lakesVisible, riversVisible, view.zoom]);
    let plan = physicalPlans.get(key);
    if (!plan) {plan = physicalAssets.plan(identity, {zoom:view.zoom, cull:viewCull(padding), strokeCull:viewCull(padding+extra), lakesVisible, riversVisible});
      if (physicalPlans.size>=8)physicalPlans.clear(); physicalPlans.set(key, plan);}
    return plan;
  }
  const territorialContext = prepared => prepared.key+'|'+Number(state.layerVisibility.objects!==false)+'|'+Number(bordersNeeded());
  function territorialPlan(prepared = territories, padding = 0) {
    syncViewPlans(); const extra = strokePadding(), key = territorialContext(prepared)+'|'+padding+'|'+extra;
    if (territoryPlans.has(key))return territoryPlans.get(key);
    if (state.layerVisibility.objects===false)return [];
    const selectedSlots = new Set(prepared.slots), hidden = new Set(prepared.view?.hiddenBorders??[]);
    const cull = viewCull(padding);
    const rows = territorialAssets.plan(viewCull(padding+extra), row => {
      if (row.role==='country')return (!row.bounds||cull(row.bounds))&&
        (row.historySlot!==undefined?selectedSlots.has(row.historySlot):!row.slots?.length||row.slots.some(slot => selectedSlots.has(slot)));
      if (!bordersNeeded())return false;
      return row.baseBorder&&(!row.slots?.length||row.slots.some(group => !hidden.has(group)));
    });
    if (bordersNeeded()&&prepared.view) {
      let index = borderPlansByView.get(prepared.view);
      if (!index) {
        const groups = new Set(prepared.view.borders);
        const all = territorialAssets.plan(() => true, row => row.role==='border'&&!row.baseBorder&&groups.has(row.historyBorder));
        index = createGlobeChunkCatalog(combineHistoryBorders(all)); borderPlansByView.set(prepared.view, index);
      }
      rows.push(...index.select(viewCull(padding+extra)));
    }
    if (territoryPlans.size>=8)territoryPlans.clear(); territoryPlans.set(key, rows); return rows;
  }
  function installHistoryCatalog(catalog) {
    if (historyLoaded)return;
    if (catalog?.version!==1||!Array.isArray(catalog.historicalCountries)||catalog.historicalCountries.length!==countryCount-baseSlots.length
      ||!Array.isArray(catalog.historicalBorders)||!Array.isArray(catalog.physicalContexts)||!Array.isArray(catalog.historyTimeline))
      throw Error('Three.js history slot count mismatch');
    const index = createGlobeHistoryIndex(catalog.history, baseSlots.length, {timeline:catalog.historyTimeline,
      physicalIdentities:[spec.physical, ...catalog.physicalContexts].map(row => row.identity)});
    const descriptors = territorialDescriptors(catalog);
    const keys = new Set(slotByKey.keys()), identities = catalog.historicalCountries.map(row => {
      const key = globeTerritoryKey(row.id, row.geometry), ref = normalizeObjectRef({domain:'territorial', type:'entity', id:row.id});
      if (keys.has(key)||!ref)throw Error('Invalid or duplicate historical territory identity');
      keys.add(key); return {row, key, ref};
    });
    territorialAssets.addDescriptors(descriptors); physicalAssets.addDescriptors(catalog.physicalContexts);
    for (const {row, key, ref} of identities) {
      const slot = slots.length; slots.push(row); slotByKey.set(key, slot);
      labelsBySlot.push(row.label); refs.push(ref); addOutlineDescriptors(row, slot);
    }
    clearViewPlans();
    historyIndex = index; historyLoaded = true;
    historyCatalogBytes = spec.historyCatalog.decodedBytes*3;
    residency.set(historyCatalogKey, {protected:true, extraBytes:historyCatalogBytes}); residencyDirty = true;
  }
  async function ensureHistoryCatalog(signal = lifetime.signal, priority = 20) {
    if (historyLoaded)return true;
    await historyCatalogCache.read('history-catalog', async(readSignal, readPriority) => {
      const catalog = await load(spec.historyCatalog,'catalog', {signal:readSignal, priority:readPriority});
      readSignal.throwIfAborted(); installHistoryCatalog(catalog); return true;
    }, signal, {priority});
    signal?.throwIfAborted(); return historyLoaded;
  }
  const basePlanKey = rows => {let key = planKeys.get(rows); if (key===undefined) {key = globeChunkPlanKey(rows); planKeys.set(rows, key);}return key;};
  function initialize() {
    if (pending)return pending;
    pending = (async() => {
      notify('loading','지도 불러오는 중');
      const context = canvas.getContext('webgl2', {alpha:false, antialias:true});
      if (!context) {unsupported = true; throw Error('Three.js requires WebGL2');}
      const threeUrl = new URL(spec.moduleUrl, document.baseURI);
      const [THREE, restored] = await Promise.all([import(threeUrl.href), initialCamera]);
      lifetime.signal.throwIfAborted();
      const palette = paint.initializePalette();
      surface = createThreeGlobeSurface(THREE, {canvas, context, palette, countryCount, baseCountryCount:baseSlots.length, hydroCount:spec.hydroCount, cacheBudget, residency, workScheduler,
        onLabelReady:() => invalidate('three-label-sdf-ready'), onLabelError:cause => deps.feedback.reportOperationError(cause,'지도 지명 SDF Worker를 사용할 수 없어 로컬 계산으로 전환했습니다.','PL-THREE-SDF-001'), packets:{
        borderGroupCount:spec.borderOwners.length,
      }});
      // Each resident detail packet has a CPU copy and one GPU copy of its arrays.
      riverDetail = createGlobeRiverDetail({byteBudget:cacheBudget.hydroBytes,
        load:physicalAssets.readDetail,
        attach:surface.attachRiverDetail, invalidate:() => {refreshRiverLedger(); residencyDirty = true; invalidate('three-river-detail');},
        onError:cause => deps.feedback.reportOperationError(cause,'상세 하천을 불러오지 못했습니다.','PL-THREE-RIVER-001'),
      });
      refreshRiverLedger = residency.register(riverDetail.memoryEntries);
      refreshHydroLedger = residency.register(() => hydroMetadata?[{protected:true, extraBytes:Math.max(0, Number(spec.hydroMetadata.decodedBytes)||0)*2+hydroSlots.size*64}]:[]);
      verifyLayout(); if (restored)syncCameraFromState(restored); else fitWorld();
      // Launch optional visible lines independently of the required land/water plan.
      // Required land, border and water reservations are made first by the
      // temporal/view plan. Graticule starts on the first eligible render.
      loaded = true; return true;
    })(); pending.catch (failMapPreparation); return pending;
  }
  function verifyLayout() {
    if (!surface)return;
    const width = host.clientWidth, height = host.clientHeight, dpr = window.devicePixelRatio||1, safe = readSafeInsets();
    if (!width||!height)return;
    const next = {width, height, dpr, ...safe};
    if (viewport&&Object.keys(next).every(key => viewport[key]===next[key]))return;
    if (!viewport||viewport.width!==width||viewport.height!==height||viewport.dpr!==dpr)surface.resize(width, height, dpr);
    viewport = next; camera = createGlobeCamera(view, viewport);
  }
  function syncCameraFromState(next = state.view) {
    if (!viewport)return;
    setCamera(createGlobeCamera(copyCamera(next, view), viewport));
    if (loaded&&!input.isMoving())deps.domains.renderingDomain.invalidateViewport('three-camera-jump');
  }
  function worldFit() {
    const {width, height, left = 0, right = 0, top = 0, bottom = 0} = viewport, focal = height*1.5;
    const radius = Math.min(width-left-right, height-top-bottom)*0.43;
    const distance = Math.hypot(1, focal/Math.max(radius,1))-1;
    return {center:[15, 12], zoom:Math.log2(2*Math.PI*focal/(512*distance)),bearing:0,pitch:0,roll:0};
  }
  function fitWorld() {if (!viewport)return false; syncCameraFromState(worldFit()); onWorldFitChange(); return true;}
  function fitMapBounds(bounds) {
    if (!viewport)return false;
    const [[west, south], [east, north]] = bounds, longitudeWidth = east>=west?east-west:east+360-west;
    const extent = Math.max(longitudeWidth, north-south);
    syncCameraFromState({center:[west+longitudeWidth/2,(south+north)/2],zoom:extent?Math.log2(Math.min(viewport.width,viewport.height)*0.65*360/(512*extent)):view.zoom});
    return true;
  }
  function fitGeometry(feature) {
    const boxes = [];
    const visit = row => {if (row?.type==='FeatureCollection')row.features.forEach(visit); else if (row?.type==='Feature')visit(row.geometry);
      else if (row?.type==='GeometryCollection')row.geometries.forEach(visit); else if (row?.coordinates)boxes.push(coordinateBounds(row.coordinates));};
    visit(feature);
    const valid = boxes.filter(box => box.every(Number.isFinite));
    return Boolean(valid.length)&&fitMapBounds([[Math.min(...valid.map(box => box[0])), Math.min(...valid.map(box => box[1]))],
      [Math.max(...valid.map(box => box[2])), Math.max(...valid.map(box => box[3]))]]);
  }
  async function requirePhysicalSource(month, identity, signal) {
    if (!physicalAssets.has(identity))await ensureHistoryCatalog(signal);
    if (!physicalAssets.has(identity))
      throw Object.assign(Error(`${month}에 준비된 Three.js 물리 지도가 없습니다.`), {code:'PL-THREE-MONTH'});
    return identity;
  }
  async function preparePhysicalContext(month, {isCurrent = () => true} = {}) {
    const controller = startRequest('physical-prefetch');
    const assertCurrent = () => {if (!requestCurrent('physical-prefetch', controller)||!isCurrent())
      throw Object.assign(new Error('Physical preparation superseded'), {name:'AbortError', cancelled:true});};
    let target;
    try {
      assertCurrent(); await initialize(); assertCurrent();
      target = physicalPlan(await requirePhysicalSource(month, deps.physicalResources.physicalSourceIdentityAtMonth(month), controller.signal));
      prefetchPhysical = target; retainCpuResources();
      await physicalAssets.prepare(target, {signal:controller.signal});
      assertCurrent(); return true;
    }catch (error) {
      if (requestCurrent('physical-prefetch', controller)&&prefetchPhysical===target) {prefetchPhysical = null; retainCpuResources();}
      throw error;
    }finally {controller.abort(); finishRequest('physical-prefetch', controller);}
  }
  async function requireTerritorialGeometry(month, references, signal = lifetime.signal) {
    const find = () => {
      const active = [];
      for (const [id, reference] of references) {
        const slot = slotByKey.get(globeTerritoryKey(id, reference));
        if (slot===undefined||!reference||(reference.contentSha256!==undefined&&reference.contentSha256!==slots[slot].geometry.contentSha256))return null;
        active.push(slot);
      }
      return historyIndex.find(active.sort((a, b) => a-b));
    };
    let match = find();
    if (!match&&!historyLoaded) {await ensureHistoryCatalog(signal); match = find();}
    if (!match)throw Object.assign(Error(`${month}에 준비된 Three.js 영토 형상이 없습니다.`), {code:'PL-THREE-IDENTITY'});
    return match;
  }
  function featureRefs(rows) {return new Map(rows.map(row => [String(row.id), geometryReferenceFor(row.geometry)]));}
  function retainCpuResources() {
    if (disposed)return;
    residencyDirty = true;
    territorialAssets.retain([prefetchTerritoryPlan, basePrepared?.plan, basePreparing, publishedBase?.plan]);
    physicalAssets.retain([prefetchPhysical, visiblePhysicalPlan, physical?.plan, publishedPhysical?.plan]);
  }
  // Warm only verified neighboring geometry/physical states after a
  // committed stable frame. No speculative result changes the active scene.
  function scheduleNeighborPrefetch(month) {
    if (disposed||lost||input.isMoving()||framePreserved||presentation.temporalPending()||!ready||basePreparing||visiblePhysicalPlan||!physical)return;
    const interval = historyLoaded?historyIndex.intervalKey(month):'catalog';
    const key = interval+'|'+Math.sign(monthDirection)+'|'+basePlanKey(basePrepared?.plan??[])+'|'+physical.plan.key;
    if (neighborKey===key||neighborTimer!==null||neighborIdleOff||requestScopes.has('neighbor-prefetch'))return;
    neighborKey = key;
    const epoch = generation;
    const valid = () => !disposed&&!lost&&!input.isMoving()&&!framePreserved&&!presentation.temporalPending()&&generation===epoch&&ready&&
      (!historyLoaded||historyIndex.intervalKey(state.timelineCursor)===interval||interval==='catalog');
    const begin = () => {
      neighborTimer = null;
      if (!valid()) {neighborKey = null; return;}
      const gate = loadGate.stats();
      if (gate.active||gate.queued) {
        neighborStats.idleWaits++;
        neighborIdleOff = loadGate.onIdle(() => {
          const off = neighborIdleOff; neighborIdleOff = null; off?.();
          if (!valid()) {neighborKey = null; return;}
          neighborTimer = setTimeout(begin, 100);
        });
        return;
      }
      const controller = startRequest('neighbor-prefetch'), signal = controller.signal;
      let remaining = Math.min(24*1024*1024, Math.floor(cacheBudget.pendingBytes/2));
      const holdBytes = cacheBudget.neighborBytes;
      const claim = (row, kind = 'mesh') => {
        if (!requestCurrent('neighbor-prefetch', controller)||!valid())return false;
        const bytes = estimateGlobeWorkingBytes(row, kind);
        if (bytes>remaining)return false;
        remaining-=bytes; neighborStats.claimedBytes+=bytes; return true;
      };
      neighborStats.runs++;
      (async() => {
        if (!historyLoaded) {
          const catalogEstimate = estimateGlobeWorkingBytes(spec.historyCatalog,'catalog');
          // Catalog acquisition is independently bounded; a large one is
          // deliberately left to a required history request.
          if (catalogEstimate>cacheBudget.pendingBytes/2)return;
          neighborStats.claimedBytes+=catalogEstimate;
          await ensureHistoryCatalog(signal, -15);
        }
        const targets = historyIndex.neighbors(state.timelineCursor, monthDirection);
        // Hold a bounded portion of each cache against ordinary local LRU,
        // but leave speculative results reclaimable by the global budget.
        const territorialHold = Math.floor(holdBytes*.65), physicalHold = holdBytes-territorialHold;
        for (const target of targets) {
          signal.throwIfAborted(); if (!valid())break;
          // The nearest state in the travel direction receives most of the
          // available transfer/work budget; cached hits require no reservation.
          await territorialAssets.warm(territorialPlan(target.territories), {signal, priority:-20, claim, holdBytes:territorialHold});
          if (physicalAssets.has(target.physicalIdentity))await physicalAssets.warm(physicalPlan(target.physicalIdentity), {signal, priority:-20, claim, holdBytes:physicalHold});
          if (remaining<=0)break;
        }
        if (requestCurrent('neighbor-prefetch', controller)) {neighborStats.completed++; residency.trim();}
      })().catch (cause => {if (cause?.memoryPressure)neighborStats.pressureSkips++;})
        .finally(() => {
          finishRequest('neighbor-prefetch', controller);
          // When the catalog was first loaded, key the completed preparation
          // by the real transition interval, not the month or bootstrap token.
          if (!signal.aborted&&valid()&&historyLoaded&&interval==='catalog') {
            neighborKey = historyIndex.intervalKey(state.timelineCursor)+'|'+Math.sign(monthDirection)+'|'+basePlanKey(basePrepared?.plan??[])+'|'+physical.plan.key;
          }
        });
    };
    neighborTimer = setTimeout(begin, 180);
  }
  async function prepareDatedTerritories(month, references, {isCurrent = () => true} = {}) {
    const controller = startRequest('country-prefetch');
    let plan;
    try {
      const prepared = await requireTerritorialGeometry(month, references, controller.signal);
      if (!requestCurrent('country-prefetch', controller)||!isCurrent())throw new DOMException('Territorial preparation superseded','AbortError');
      plan = territorialPlan(prepared); prefetchTerritoryPlan = plan; retainCpuResources();
      await territorialAssets.prepare(plan, {signal:controller.signal});
      if (!requestCurrent('country-prefetch', controller)||!isCurrent())throw new DOMException('Territorial preparation superseded','AbortError');
      return true;
    }catch (error) {
      if (requestCurrent('country-prefetch', controller)&&prefetchTerritoryPlan===plan) {prefetchTerritoryPlan = null; retainCpuResources();}
      throw error;
    }finally {controller.abort(); finishRequest('country-prefetch', controller);}
  }
  let territorialRequest = 0;
  async function setTerritorialFeatures(rows, {sourceRows = rows} = {}) {
    cancelNeighborPrefetch();
    const request = ++territorialRequest, requestGeneration = generation;
    const month = state.timelineCursor;
    const controller = startRequest('territory-apply');
    try {
      const [identity, prepared] = await Promise.all([
        requirePhysicalSource(month, deps.physicalResources.physicalSourceIdentity, controller.signal),
        requireTerritorialGeometry(month, featureRefs(rows), controller.signal),
      ]);
      if (!requestCurrent('territory-apply', controller)||requestGeneration!==generation||month!==state.timelineCursor)return false;
      const target = physicalPlan(identity), baseTarget = territorialPlan(prepared), context = territorialContext(prepared);
      const oldPhysical = requestScopes.get('physical-view'), oldBase = requestScopes.get('base-view');
      visiblePhysicalPlan = null; basePreparing = baseTarget; baseFailures.clear(); physicalFailures.clear();
      prefetchTerritoryPlan = baseTarget; prefetchPhysical = target; retainCpuResources();
      const nextBaseTask = basePrepared&&basePrepared.context===context&&basePlanKey(basePrepared.plan)===basePlanKey(baseTarget)?
        Promise.resolve(basePrepared):territorialAssets.prepare(baseTarget, {signal:controller.signal}).then(parts => ({plan:baseTarget, parts, context}));
      const nextPhysicalTask = physicalAssets.prepare(target, {signal:controller.signal});
      if (oldPhysical===requestScopes.get('physical-view'))cancelRequest('physical-view');
      if (oldBase===requestScopes.get('base-view'))cancelRequest('base-view');
      const [nextPhysical, nextBase] = await Promise.all([nextPhysicalTask, nextBaseTask]);
      if (!requestCurrent('territory-apply', controller)||request!==territorialRequest||requestGeneration!==generation||month!==state.timelineCursor)return false;
      const delta = temporalInputs.advance(sourceRows, month);
      const previousSlots = activeSlots, geometryChanged = prepared.key!==territories.key||!features;
      if (geometryChanged) {
        paint.markCountryRoles(); outlinePlanDirty = true;
        territories = prepared; activeSlots = new Set(prepared.slots);
        activeSlotByKey = new Map(prepared.slots.map(slot => [refs[slot].key, slot])); pickingChanged = true;
        for (const slot of previousSlots)if (!activeSlots.has(slot)) {paint.markCountrySlot(slot); labelContent.markCountrySlot(slot);}
        for (const slot of activeSlots)if (!previousSlots.has(slot)) {paint.markCountrySlot(slot); labelContent.markCountrySlot(slot);}
      }
      if (basePrepared!==nextBase) {basePrepared = nextBase; pickingChanged = true;}
      if (physical!==nextPhysical) {physical = nextPhysical; paint.markHydroInputs();}
      if (!features||geometryChanged)features = new Map(rows.map(row => [String(row.id), row]));
      else for (const id of delta.changedIds) {
        const row = temporalInputs.get(id);
        if (row?.properties?.entityKind==='general')features.set(id, row); else features.delete(id);
      }
      for (const id of delta.dirtyIds) {
        const key = normalizeObjectRef({domain:'territorial', type:'entity', id}).key, slot = activeSlotByKey.get(key);
        if (slot!==undefined) {paint.markCountrySlot(slot); labelContent.markCountrySlot(slot);}
      }
      if (delta.first) {paint.markCountryBase(); labelContent.invalidate({places:false});}
      if (delta.dirtyIds.size||paint.pendingCountrySlots())paint.markCountryRoles();
      paint.markHydroRoles();
      temporalStats = {examinedRows:delta.examined, receipt:delta.receipt, changedRows:delta.changedIds.size, dirtyPaintSlots:paint.pendingCountrySlots(), dirtyCountryLabels:labelContent.pendingCountrySlots()};
      labelContent.invalidate({countries:false}); return true;
    }catch (error) {
      if (controller.signal.aborted)return false;
      throw error;
    }finally {
      if (requestScopes.get('territory-apply')===controller) {
        prefetchTerritoryPlan = null; prefetchPhysical = null; basePreparing = null; retainCpuResources();
      }
      controller.abort(); finishRequest('territory-apply', controller);
    }
  }
  function ensureVisibleBase() {
    const required = territorialPlan(), context = territorialContext(territories);
    const covers = plan => !!plan&&plan.context===context&&globeChunkSetContains(plan.plan, required);
    const covered = covers(basePrepared);
    if (covered&&(!ready||framePreserved||presentation.temporalPending()))return true;
    // During motion, keep common requests and warm a margin rather than
    // waiting until the next missing chunk enters the viewport.
    const target = covered?territorialPlan(territories, 96):required, key = context+'|'+basePlanKey(target);
    if (covered&&basePlanKey(basePrepared.plan)===basePlanKey(target)) {
      if (basePreparing&&!requestScopes.has('territory-apply')) {cancelRequest('base-view'); basePreparing = null; retainCpuResources();}
      return true;
    }
    if (basePreparing&&basePlanKey(basePreparing)===basePlanKey(target)&&(!covered?baseJobRequired:true))return covered;
    if (!baseFailures.allow(key, !covered))return covered;
    const controller = startRequest('base-view'), expectedGeneration = generation, expectedTerritories = territories;
    basePreparing = target; baseJobRequired = !covered; retainCpuResources();
    territorialAssets.prepare(target, {signal:controller.signal, priority:covered?5:20}).then(parts => {
      if (!requestCurrent('base-view', controller)||generation!==expectedGeneration||territories!==expectedTerritories)return;
      basePrepared = {plan:target, parts, context}; baseFailures.clear(); pickingChanged = true; invalidate('three-territory-chunks-ready');
    }).catch (error => {
      if (!requestCurrent('base-view', controller))return;
      const now = territorialPlan(), sameRequired = context===territorialContext(territories)&&basePlanKey(now)===basePlanKey(target);
      baseFailures.fail(key, !covered&&sameRequired);
      if (!covered&&sameRequired)failMapPreparation(error);
      else if (!basePrepared||basePrepared.context!==territorialContext(territories)||!globeChunkSetContains(basePrepared.plan, now))invalidate('three-required-territory-retry');
      else deps.feedback.reportOperationError(error,'주변 영토·국경선 형상을 불러오지 못했습니다.','PL-THREE-BASE-CHUNK-001');
    }).finally(() => {
      if (requestScopes.get('base-view')===controller) {basePreparing = null; retainCpuResources();}
      controller.abort(); finishRequest('base-view', controller);
    });
    return covered;
  }
  function ensureVisiblePhysical() {
    if (!physical)return false;
    const required = physicalPlan(physical.spec.identity), covered = physicalAssets.covers(physical.plan, required);
    if (covered&&(!ready||framePreserved||presentation.temporalPending()))return true;
    const target = covered?physicalPlan(physical.spec.identity, 96):required;
    if (physical.plan.key===target.key) {
      if (visiblePhysicalPlan) {cancelRequest('physical-view'); visiblePhysicalPlan = null; retainCpuResources();}
      return true;
    }
    if (visiblePhysicalPlan?.key===target.key&&(!covered?physicalJobRequired:true))return covered;
    if (!physicalFailures.allow(target.key, !covered))return covered;
    const controller = startRequest('physical-view'), requestedGeneration = generation;
    visiblePhysicalPlan = target; physicalJobRequired = !covered; retainCpuResources();
    physicalAssets.prepare(target, {signal:controller.signal, priority:covered?5:20}).then(next => {
      if (!requestCurrent('physical-view', controller)||generation!==requestedGeneration||physical?.spec.identity!==target.spec.identity)return;
      physical = next; physicalFailures.clear(); paint.markHydroStyle(); pickingChanged = true; invalidate('three-physical-chunks-ready');
    }).catch (error => {
      if (!requestCurrent('physical-view', controller))return;
      const now = physicalPlan(target.spec.identity), sameRequired = now.key===target.key;
      physicalFailures.fail(target.key, !covered&&sameRequired);
      if (!covered&&sameRequired)failMapPreparation(error);
      else if (!physicalAssets.covers(physical.plan, now))invalidate('three-required-physical-retry');
      else deps.feedback.reportOperationError(error,'주변 수계 형상을 불러오지 못했습니다.','PL-THREE-HYDRO-TIER-001');
    }).finally(() => {
      if (requestScopes.get('physical-view')===controller) {visiblePhysicalPlan = null; retainCpuResources();}
      controller.abort(); finishRequest('physical-view', controller);
    });
    return covered;
  }
  function ensureLineLayer(name, wanted, has, install, row, label) {
    surface.setLayerVisibility(name, wanted);
    if (!wanted) {cancelRequest(name); failedLineLayers.delete(name); return true;}
    if (has())return true;
    if (failedLineLayers.has(name)||requestScopes.has(name))return false;
    const controller = startRequest(name);
    load(row,'stroke', {phase:'background', priority:ready?5:15, label, signal:controller.signal}).then(packet => {
      if (!requestCurrent(name, controller))return;
      install(packet); invalidate('three-'+name+'-ready');
    }).catch (error => {
      if (!requestCurrent(name, controller))return;
      failedLineLayers.add(name);
      if (!ready||framePreserved)failMapPreparation(error);
      else deps.feedback.reportOperationError(error, label+'을 불러오지 못했습니다.','PL-THREE-LINE-LAYER-001');
    }).finally(() => finishRequest(name, controller));
    return false;
  }
  function labelsNeeded() {
    return view.zoom>=COUNTRY_LABEL_MIN_ZOOM&&territorialNamesVisible(state)||view.zoom>=PLACE_DISPLAY_ZOOM_FLOOR&&state.layerVisibility.labels!==false;
  }
  function ensureLabelFont() {
    const wanted = labelsNeeded();
    if (wanted!==lastLabelsNeeded) {lastLabelsNeeded = wanted; labelContent.invalidate({countries:false});}
    if (!wanted||fontReady)return true;
    if (fontPending||fontFailed)return false;
    fontPending = Promise.all([document.fonts.load('800 56px "Pretendard Variable"','대한민국'), document.fonts.load('600 56px "Pretendard Variable"','대한민국')]).then(() => {
      if (disposed)return;
      fontReady = true; labelContent.invalidate({countries:false}); invalidate('three-label-font-ready');
    }).catch (error => {
      if (disposed)return;
      fontFailed = true;
      if (labelsNeeded()&&(!ready||framePreserved))failMapPreparation(error);
      else deps.feedback.reportOperationError(error,'지도 글꼴을 불러오지 못했습니다.','PL-THREE-FONT-001');
    }).finally(() => {fontPending = null;});
    return false;
  }
  function requestOutlines() {
    if (!ready||!camera||!surface)return;
    if (lastOutlineCamera!==camera||outlinePlanDirty) {
      const cull = viewCull(strokePadding()+32), targets = new Map();
      const roleStyles = paint.roleStyles();
      for (const [slot, code] of paint.countryRoles()) {
        if (!(roleStyles[code]?.width>0&&roleStyles[code]?.alpha>0))continue;
        for (const descriptor of outlineBySlot.get(slot)??[]) {
          if (descriptor.bounds&&!cull(descriptor.bounds))continue;
          let target = targets.get(descriptor.key);
          if (!target) {target = {descriptor, roles:new Map()}; targets.set(descriptor.key, target);}
          target.roles.set(slot, code);
        }
      }
      const changed = targets.size!==outlineTargets.size||[...targets].some(([key, row]) => {
        const previous = outlineTargets.get(key);
        return !previous||previous.roles.size!==row.roles.size||[...row.roles].some(([slot, code]) => previous.roles.get(slot)!==code);
      });
      if (changed) {
        for (const key of outlineFailed)if (!targets.has(key))outlineFailed.delete(key);
        outlineTargets = targets; outlinePaintDirty = true;
      }
      lastOutlineCamera = camera; outlinePlanDirty = false; outlineStats.outlinePlans++;
      for (const [key, controller] of pendingOutlines)if (!outlineTargets.has(key)) {pendingOutlines.delete(key); controller.abort();}
      for (const [key, {descriptor}] of outlineTargets) {
        if (pendingOutlines.has(key)||surface.hasOutlines(key)||outlineFailed.has(key))continue;
        const controller = new AbortController(); pendingOutlines.set(key, controller); outlineStats.outlineDownloads++;
        loadOutlines(descriptor, controller.signal).then(data => {
          if (disposed||controller.signal.aborted||pendingOutlines.get(key)!==controller||!outlineTargets.has(key))return;
          surface.installOutlines(key, data, descriptor); outlinePaintDirty = true; invalidate('three-outlines-ready');
        }).catch (cause => {
          if (disposed||controller.signal.aborted)return;
          outlineFailed.add(key);
          if (!cause?.memoryPressure)deps.feedback.reportOperationError(cause,'선택 윤곽선을 불러오지 못했습니다.','PL-THREE-OUTLINE-001');
        }).finally(() => {if (pendingOutlines.get(key)===controller)pendingOutlines.delete(key);});
      }
    }
    if (outlinePaintDirty) {
      surface.setOutlinePaint(new Map([...outlineTargets].map(([key, row]) => [key, row.roles])), paint.roleStyles(), paint.outlineColor());
      outlinePaintDirty = false;
    }
  }
  function syncPresentationInputs(force = false) {
    const next = readPresentationInputs(state, deps.preferences.userPreferences, {force}), old = presentationInputs;
    presentationInputs = next;
    if (!old||old.objects!==next.objects||old.colors!==next.colors||old.objectStyles!==next.objectStyles) {
      paint.markCountryInputs(); labelContent.invalidate({places:false});
    }else if (old.objectItems!==next.objectItems) {
      for (const id of globeChangedHiddenIds(old.objectItems, next.objectItems)) {
        const slot = activeSlotByKey.get(normalizeObjectRef({domain:'territorial', type:'entity', id})?.key);
        if (slot!==undefined) {paint.markCountrySlot(slot); labelContent.markCountrySlot(slot);}
      }
      paint.markCountryRoles(); labelContent.invalidate({countries:false, places:false});
    }
    if (!old||old.lakes!==next.lakes||old.rivers!==next.rivers||old.hydroItems!==next.hydroItems||old.hydroLayers!==next.hydroLayers||old.builtinHydro!==next.builtinHydro)paint.markHydroInputs();
    if (!old||old.borders!==next.borders||old.lakes!==next.lakes||old.rivers!==next.rivers||old.objects!==next.objects) {
      paint.markLayers(); paint.markPalette();
    }
    if (!old||old.names!==next.names||old.nameItems!==next.nameItems||old.countryLabelSettings!==next.countryLabelSettings||old.nativeNames!==next.nativeNames)
      labelContent.invalidate({places:false});
    const placesChanged = !old||old.places!==next.places||old.placeItems!==next.placeItems||old.builtinPlaces!==next.builtinPlaces||old.nativeNames!==next.nativeNames||old.placeLabelSettings!==next.placeLabelSettings;
    if (placesChanged)labelContent.invalidate({countries:false});
    return placesChanged;
  }
  function renderFrame(frame) {
    const base = {frameId:frame.frameId, viewRevision:frame.viewRevision, projectionRevision:frame.projectionRevision};
    if (!features||lost||error||frame.projectGeneration!==generation||requestScopes.has('territory-apply')||!presentation.countrySourceAdmitted(territories.key))return {...base, deferred:true};
    syncPresentationInputs(); paint.refreshPalette(surface);
    const baseReady = ensureVisibleBase(), physicalReady = ensureVisiblePhysical(), fontAvailable = ensureLabelFont();
    const graticuleReady = ensureLineLayer('graticule', graticuleNeeded(), surface.hasGraticule, surface.installGraticule, spec.graticule,'경위선');
    if (!baseReady||!physicalReady)return {...base, deferred:true};
    const strict = !ready||framePreserved||presentation.temporalPending();
    if (strict&&(!graticuleReady||!fontAvailable))return {...base, deferred:true};
    if (labelContent.needsUpdate())metrics.run('three.label-content', () => labelContent.update({surface, camera, view, features, activeSlots, fontReady, needed:labelsNeeded()}));
    if (!surface.prepareLabels(camera, viewport.width, viewport.height, strict)&&strict)return {...base, deferred:true};
    presentation.markTemporalFrame(frame);
    if (!presentation.canPresentVisualFrame(frame))return {...base, deferred:true};
    surface.activateTerritorialChunks(territories.view, basePrepared.parts);
    surface.activatePhysicalContext(physical);
    pickingChanged||=lastCamera!==camera||acceptedTerritories!==territories||acceptedPhysical!==physical;
    if (paint.needsUpdate())metrics.run('three.paint', () => paint.updatePaint(surface, {activeSlots, activeSlotByKey, features, bordersNeeded}));
    requestOutlines();
    const showRivers = state.layerVisibility.rivers!==false;
    if (riverCamera!==camera||riverVisible!==showRivers||riverContext!==physical) {
      riverCamera = camera; riverVisible = showRivers; riverContext = physical;
      if (riverDetail.update(showRivers?physicalAssets.detailPlan(physical.spec.identity, {zoom:view.zoom, strokeCull:viewCull(strokePadding())}):[])) {refreshRiverLedger(); residencyDirty = true;}
    }
    const submitted = metrics.run('three.submit-frame', () => surface.draw(camera, viewport.width, viewport.height));
    if (!submitted)return {...base, deferred:true};
    drawCount++;
    drawnFrame = {frame, camera, viewport, territories, basePrepared, physical, visibleSlots:paint.visibleSlots(), riverChunks:riverDetail.activeEntries(),
      labelHit:surface.labels.hitSnapshot(), lakesVisible:state.layerVisibility.lakes!==false, riversVisible:showRivers, generation};
    input.advanceInertia();
    return {...base, succeeded:true, presentationReady:true};
  }
  function publishPickSnapshot(draw) {
    const previous = acceptedPick, riverChunks = draw.riverChunks;
    const sameRivers = previous&&riverChunks.length===previous.riverChunks.length&&riverChunks.every((row, i) => row.packet===previous.riverChunks[i].packet);
    const sameCountries = previous&&draw.basePrepared===previous.basePrepared;
    const samePhysical = previous&&draw.physical===previous.physical;
    if (!pickingChanged&&previous&&previous.generation===draw.generation&&previous.camera===draw.camera&&sameCountries&&samePhysical&&sameRivers&&
        previous.visibleSlots===draw.visibleSlots&&previous.labelHit===draw.labelHit&&previous.lakesVisible===draw.lakesVisible&&previous.riversVisible===draw.riversVisible)return;
    const active = draw.physical;
    cancelRequest('pick-click'); cancelRequest('pick-hover');
    acceptedPick = {...draw,
      countryIndex:sameCountries?previous.countryIndex:createGlobePacketIndex(draw.basePrepared.parts.filter(row => row.role==='country').map(row => row.mesh), row => row.packet.spatialBounds),
      waterIndex:samePhysical?previous.waterIndex:createGlobePacketIndex(active.waters, row => row.mesh.packet.spatialBounds),
      lakeIndex:samePhysical?previous.lakeIndex:createGlobePacketIndex(active.lakes, row => row.mesh.packet.spatialBounds),
      riverIndex:samePhysical&&sameRivers?previous.riverIndex:createGlobePacketIndex([
        ...active.riverChunks.map(row => ({packet:row.packet, minZoom:row.minZoom})),
        ...riverChunks.map(row => ({packet:row.packet, minZoom:row.row.minZoom})),
      ].flatMap(row => row.packet.spatialParts.map(part => ({...part, minZoom:row.minZoom}))), row => row.index.rootBounds),
    };
    pickingRevision++; pickingChanged = false;
  }
  function commitVisualFrame(frame) {
    const draw = drawnFrame;
    if (!draw||draw.frame!==frame)return false;
    const first = !ready;
    if (!presentation.commitVisualFrame(frame, () => {
      ready = true; lastFrame = frame; lastCamera = draw.camera;
      acceptedTerritories = draw.territories; acceptedPhysical = draw.physical; acceptedRiverChunks = draw.riverChunks;
      publishPickSnapshot(draw); drawnFrame = null;
      if (publishedPhysical!==draw.physical||publishedBase!==draw.basePrepared||first) {
        publishedPhysical = draw.physical; publishedBase = draw.basePrepared;
        prefetchTerritoryPlan = null;
        if (prefetchPhysical?.key===publishedPhysical?.plan.key)prefetchPhysical = null;
        retainCpuResources();
      }
    })) {drawnFrame = null; return false;}
    const riverChanged = riverDetail.commit(acceptedRiverChunks), surfaceChanged = surface.trimResidency();
    if (riverChanged)refreshRiverLedger();
    if (first||residencyDirty||riverChanged||surfaceChanged) {residencyDirty = false; residency.trim();}
    if (first) {metrics.publish(); notify('ready','지도 표시 준비 완료'); requestOutlines(); invalidate('three-adjacent-viewport-chunks');}
    const month = state.timelineCursor, monthChanged = publishedMonth!==null&&month!==publishedMonth;
    if (monthChanged)monthDirection = Math.sign(globeHistoryMonthKey(month)-globeHistoryMonthKey(publishedMonth));
    publishedMonth = month;
    if (monthChanged)invalidate('three-adjacent-viewport-chunks');
    scheduleNeighborPrefetch(month);
    revision++; input.emit('render'); return true;
  }
  async function hydroFeaturesForSlots(slots, waterFeatures, signal) {
    if (!slots.size)return waterFeatures;
    const items = hydroMetadata??await hydroMetadataCache.read('hydro-metadata', async readSignal => {
      const rows = await load(spec.hydroMetadata,'hydro', {phase:'background', priority:30, identityCount:spec.hydroCount, signal:readSignal});
      readSignal.throwIfAborted();
      hydroMetadata = rows; rows.forEach((row, slot) => hydroSlots.set(row.id, slot)); refreshHydroLedger(); paint.markHydroRoles(); residencyDirty = true; invalidate('three-hydro-identities');
      return rows;
    }, signal);
    signal?.throwIfAborted();
    return [...waterFeatures, ...[...slots].map(slot => items[slot]).filter(Boolean)];
  }
  async function queryObjectRefs(point, {includeHydro = true, includeLabels = true, signal:consumerSignal} = {}) {
    if (includeHydro||includeLabels)cancelNeighborPrefetch();
    const sample = acceptedPick;
    if (!canPickFrame()||!sample)throw new DOMException('Picking frame unavailable','AbortError');
    const controller = startRequest(includeHydro||includeLabels?'pick-click':'pick-hover');
    const abort = () => controller.abort(consumerSignal?.reason);
    consumerSignal?.addEventListener('abort', abort, {once:true}); if (consumerSignal?.aborted)abort();
    const {signal} = controller;
    const isCurrent = () => !signal.aborted&&canPickFrame()&&acceptedPick===sample;
    const assertCurrent = () => {signal.throwIfAborted(); if (!isCurrent())throw new DOMException('Picking frame superseded','AbortError');};
    try {
      assertCurrent();
      const label = includeLabels?sample.labelHit(point):null;
      if (label)return [label];
      const sampledCamera = sample.camera, ray = sampledCamera.worldRay(point);
      if (!ray)return [];
      const budget = createGlobePickBudget({signal, isCurrent});
      const intersect = bounds => globeRayIntersectsBounds(ray, bounds), waterFeatures = [], lakeSlots = new Set();
      for (const row of await sample.waterIndex.queryCooperative(intersect, budget)) {
        const packet = row.mesh.packet;
        if ((await pickGlobeSlotsCooperative(packet, packet.spatial, ray, undefined, {firstHit:true, budget})).length) {
          if (!includeHydro)return [];
          waterFeatures.push(row.feature);
        }
      }
      if (sample.lakesVisible)for (const row of await sample.lakeIndex.queryCooperative(intersect, budget)) {
        if (sampledCamera.view.zoom<row.minZoom)continue;
        const packet = row.mesh.packet, hits = await pickGlobeSlotsCooperative(packet, packet.spatial, ray, undefined, {firstHit:!includeHydro, budget});
        if (hits.length&&!includeHydro)return [];
        for (const slot of hits)lakeSlots.add(slot);
      }
      let hydroRefs = [];
      if (includeHydro) {
        const slots = new Set(lakeSlots);
        if (sample.riversVisible&&sampledCamera.view.zoom>=sample.physical.spec.riverMinZoom) {
          const predicate = globeStrokePickPredicate(sampledCamera, point, 5);
          for (const row of await sample.riverIndex.queryCooperative(predicate, budget)) {
            if (sampledCamera.view.zoom<row.minZoom)continue;
            for (const slot of await pickGlobeStrokeSlotsCooperative(row.packet, row.index, sampledCamera, point, 5, {predicate, budget}))slots.add(slot);
          }
        }
        const candidates = await hydroFeaturesForSlots(slots, waterFeatures, signal); assertCurrent();
        const visible = [...new Map(candidates.filter(feature => deps.physicalServices.isHydroFeatureVisible(feature)).map(feature => [feature.id, feature])).values()];
        const missing = visible.filter(feature => {const existing = deps.hydroModel.hydroFeatureById(feature.id); return !existing||existing.__awBounds!==feature.__awBounds;});
        if (missing.length)await deps.physicalResources.admitHydroFeatures(missing, {isCurrent});
        assertCurrent(); hydroRefs = visible.map(feature => normalizeObjectRef({domain:'hydro', type:feature.properties.category, id:feature.id}));
      }
      if (waterFeatures.length||lakeSlots.size)return hydroRefs;
      const hits = [];
      for (const {packet} of await sample.countryIndex.queryCooperative(intersect, budget))hits.push(...await pickGlobeSlotsCooperative(packet, packet.spatial, ray, slot => sample.visibleSlots.has(slot), {budget}));
      assertCurrent(); return [...hydroRefs, ...hits.map(slot => refs[slot])];
    }finally {consumerSignal?.removeEventListener('abort', abort); finishRequest(includeHydro||includeLabels?'pick-click':'pick-hover', controller);}
  }
  function invalidateCountryColors() {paint.markCountryInputs(); syncPresentationInputs(true); invalidate('three-country-colors');}
  function invalidatePalette() {paint.markPalette(); invalidate('three-palette');}
  function invalidatePhysicalStyle() {paint.markPhysicalStyle(); invalidate('three-physical-style');}
  function invalidateHydroVisibility() {paint.markHydroInputs(); syncPresentationInputs(true); paint.markLayers(); invalidate('three-hydro-visibility');}
  function invalidatePresentationStyle() {const placesChanged = syncPresentationInputs(true); paint.markPalette(); invalidate('three-presentation-style'); return placesChanged;}
  function setRenderQuality(value) {const key = JSON.stringify([value?.tier, value?.phase, value?.revision]); if (key===qualityKey)return; qualityKey = key; invalidate('three-quality');}
  const canPickFrame = () => !!acceptedPick&&ready&&!disposed&&!lost&&!framePreserved&&acceptedPick.generation===generation&&acceptedPick.viewport===viewport;
  const displayCamera = () => acceptedPick?.generation===generation?acceptedPick.camera:camera;
  const projection = Object.freeze({projectCoordinate:coord => displayCamera()?.projectCoordinate(coord)??null,
    projectVisibleCoordinate:(coord, options) => displayCamera()?.projectVisibleCoordinate(coord, options)??null,
    screenToGeo:point => canPickFrame()?acceptedPick.camera.screenToGeo(point):null, geographicBounds:() => camera?.geographicBounds()??null});
  const getRuntimeState = () => ({renderer:unsupported?'failed':'three', mapReady:ready, webglContextLost:lost, projectRenderBlocked:Boolean(error), moving:input.isMoving(),
    temporalPresentationPending:presentation.temporalPending(), temporalSourceAdmitted:presentation.ticket?.sourceAdmitted!==false});
  return Object.freeze({kind:'three', projection, get loaded() {return loaded;}, inputElement:() => canvas, subscribeInput:input.subscribeInput, isMoving:input.isMoving, attach, initialize,
    cameraSnapshot:() => camera?.view??null, getRenderPixelRatio:() => window.devicePixelRatio||1, verifyLayout, syncCameraFromState, fitWorld, fitMapBounds, fitGeometry,
    isAtWorldView:() => Boolean(viewport&&Math.abs(view.zoom-worldFit().zoom)<0.01&&Math.abs(view.center[0]-15)<0.1&&Math.abs(view.center[1]-12)<0.1),
    panBy:input.panBy,
    setTerritorialFeatures, preparePhysicalContext, prepareDatedTerritories,
    setSelection(value) {labelContent.setSelection(value); paint.setSelection(value);},
    setInteractionStyle(value) {paint.setInteractionStyle(value); invalidate('three-interaction-style');},
    invalidateCountryColors, invalidateCountryPalette:invalidatePalette, invalidatePhysicalStyle, invalidateHydroVisibility, invalidatePresentationStyle, setRenderQuality,
    labelZoomVisibility:() => ({country:Boolean(camera&&camera.view.zoom>=COUNTRY_LABEL_MIN_ZOOM),
      places:Boolean(camera&&camera.view.zoom>=PLACE_DISPLAY_ZOOM_FLOOR)}),
    invalidateLabelContent:labelContent.invalidate, getPickingRevision:() => pickingRevision, canPickFrame, queryObjectRefs,
    setInitialMapLoading(value) {initialLoading = value;}, isStyleReady:() => loaded, renderFrame, commitVisualFrame,
    canPresentVisualFrame:presentation.canPresentVisualFrame, prepareTemporalCountrySource:presentation.prepareTemporalCountrySource,
    beginTemporalViewTransition, admitTemporalViewTransition:presentation.admitTemporalViewTransition,
    finishTemporalViewTransition, waitForMapPresentation:presentation.waitForMapPresentation,
    waitForTemporalPresentation:presentation.waitForTemporalPresentation, getProjectGeneration:() => generation,
    preserveTemporalFrame() {cancelNeighborPrefetch(); framePreserved = true;}, isFramePreserved:() => framePreserved,
    resetProjectRenderState(options) {generation = options.generation; features = null; ready = false; error = null;
        drawnFrame = null; surface?.labels.cancelPending(); clearPreparation(); neighborKey = null; publishedMonth = null; monthDirection = 0; cancelOutlines(); territorialAssets.releaseWarm(); physicalAssets.releaseWarm(); temporalInputs.reset(); paint.resetProject(); labelContent.resetProject(); presentationInputs = null; clearViewPlans(); presentation.resetForProject(options);},
    measureWork:metrics.track, measureSyncWork:metrics.run, failMapPreparation, retryMapPreparation, getRuntimeState,
    getStats:() => ({...getRuntimeState(), mapReadiness:readyState(), displayedRevision:ready?revision:0, sourceRevision:revision,
      generation, certifiedRevision:ready&&!lost&&!presentation.temporalPending()?revision:null,
      frameId:lastFrame?.frameId, drawCount, drawCalls:surface?.drawCalls()??0, spatialRendering:surface?.spatialStats()??null, performance:metrics.snapshot(),
      countrySlotCount:acceptedTerritories.slots.length, activeHistoricalTerritories:acceptedTerritories.slots.filter(slot => slot>=baseSlots.length).length,
      physicalWaterIds:acceptedPhysical?.spec.waters.map(row => row.id)??[], visibleWaterChunks:acceptedPhysical?.waters.length??0,
      baseChunks:publishedBase?.parts.filter(row => row.role==='country'&&row.historySlot===undefined).length??0, territorialChunks:publishedBase?.parts.length??0, neighborPrefetch:{...neighborStats},
      countryLabelCount:surface?.labels.visibleCount(false)??0,
      placeLabelCount:surface?.labels.visibleCount(true)??0, riverDetail:riverDetail?.stats()??null,
      labelAtlasEntries:surface?.labels.atlasEntryCount()??0,
      territorialChunkCache:territorialAssets.stats(), historyCatalog:{loaded:historyLoaded, estimatedBytes:historyCatalogBytes}, historicalMetadata:historyIndex.stats(), temporalPresentation:temporalStats, paintWork:{...paint.stats(), ...outlineStats, ...labelContent.stats()}, physicalCache:physicalAssets.stats(), residentCache:surface?.cacheStats()??null,
      labelAtlas:surface?.labels.cacheStats()??null, hydroTextureUploads:surface?.hydroUploadStats()??null, packetWorker:packetTasks.stats(), workScheduler:workScheduler.stats(), residency:residency.stats(), persistence:assetReader.stats(), loadGate:loadGate.stats(), errorMessage:error?.message??null, initialLoading}),
    dispose() {cancelNeighborPrefetch(); disposed = true; input.dispose(); lifetime.abort(); for (const name of requestScopes.keys())cancelRequest(name); cancelOutlines(); presentation.dispose(); historyCatalogCache.dispose(); territorialAssets.dispose(); physicalAssets.dispose(); hydroMetadataCache.dispose(); riverDetail?.dispose(); loadGate.dispose(); packetTasks.dispose(); surface?.dispose(); workScheduler.dispose(); residency.dispose(); canvas?.remove();
      acceptedPick = drawnFrame = features = basePrepared = publishedBase = basePreparing = physical = acceptedPhysical = publishedPhysical = hydroMetadata = null;
      acceptedRiverChunks = []; hydroSlots.clear(); paint.dispose(); temporalInputs.reset(); labelContent.dispose(); outlineBySlot.clear(); clearViewPlans(); surface = riverDetail = null;},
  });
}
