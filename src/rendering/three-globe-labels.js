import { globeBufferCapacity } from './globe-draw-compaction.js';
import { createGlobeDataTexture, createGlobeMesh, gpuResourceFootprint, createGlobeGpuResidency, disposeGlobeGpuResources, createGlobeTextureCopier } from './globe-gpu-resources.js';
import { touchLruEntry, trimLruCount } from '../runtime/lru-cache.js';
import { referenceZoomPixelsPerDegree } from '../map/map-display-zoom.js';
import { globeVector } from './globe-camera.js';
import { territorialLabelPixelSize } from './label-layout.js';
import { renderCacheBudget } from './render-cache-budget.js';
import { createGlobePacketIndex } from './globe-picking.js';
import { createGlobeRangeCuller } from './globe-spatial-partition.js';
import { createGlobeDistanceWorkspace } from './globe-label-sdf.js';
import { createGlobeLabelRaster, globeLabelFont, globeLabelLineMetrics, globeLabelRasterRow, GLOBE_LABEL_FONT_PATH, GLOBE_LABEL_FONT_SIZE, GLOBE_LABEL_OUTLINE_RANGE, GLOBE_LABEL_PADDING } from './globe-label-raster.js';
import { createGlobeLabelSdfTasks } from './globe-label-sdf-tasks.js';

export const COUNTRY_LABEL_MIN_ZOOM = 3;
const fontSize = GLOBE_LABEL_FONT_SIZE, outlineRange = GLOBE_LABEL_OUTLINE_RANGE, padding = GLOBE_LABEL_PADDING, atlasSize = 2048;

// One Worker failure switches to local calculation; two consecutive local
// failures stop automatic attempts until an explicit retry or project reset.
export function createGlobeLabelSdfRecovery() {
  let fallback = false, localFailures = 0, error = null;
  return Object.freeze({
    get fallback() {return fallback;},
    get localFailures() {return localFailures;},
    get error() {return error;},
    fail(cause) {
      if (error)return 'terminal';
      if (!fallback) {fallback = true; return 'fallback';}
      if (++localFailures<2)return 'retry';
      error = cause instanceof Error?cause:new Error('Label SDF calculation failed', {cause});
      return 'terminal';
    },
    succeed() {localFailures = 0;},
    reset() {fallback = false; localFailures = 0; error = null;},
  });
}

export function placeGlobeLabels(candidates, camera, viewport, previous, onGrid = null, measureLabel = null, stats = null, pixelBudget = Infinity) {
  const placed = [], cells = new Map(), checked = new Uint32Array(candidates.length);
  let stamp = 0,usedPixels=0;
  // Preserve greedy priority and hysteresis. Each pair is compared at most
  // once, even when both labels cross several screen cells.
  const cellSize = 64, columns = Math.floor(viewport.width/cellSize)+1;
  function cellRange(left, top, right, bottom, visit) {
    const x0 = Math.max(0, Math.floor(left/cellSize)),y0=Math.max(0,Math.floor(top/cellSize));
    const x1 = Math.min(columns-1, Math.floor(right/cellSize));
    const y1 = Math.min(Math.floor(viewport.height/cellSize),Math.floor(bottom/cellSize));
    for (let y = y0; y<=y1; y++)for (let x = x0; x<=x1; x++)if (visit(y*columns+x))return true;
    return false;
  }
  const scale = referenceZoomPixelsPerDegree(camera.view.zoom)*180/Math.PI;
  const eye = camera.frame.eye;
  for (const label of candidates) {
    if (label.visible===false||camera.view.zoom<(label.minZoom??-Infinity)||camera.view.zoom>(label.maxZoom??Infinity))continue;
    const normal = label.vector??globeVector(label.coordinate);
    const point = camera.projectVisibleVector?camera.projectVisibleVector(normal):camera.projectVisibleCoordinate(label.coordinate);
    if (stats)stats.projectedCandidates++;
    if (!point)continue;
    const facing = (-1+normal[0]*eye[0]+normal[1]*eye[1]+normal[2]*eye[2])
      /Math.hypot(eye[0]-normal[0],eye[1]-normal[1],eye[2]-normal[2]);
    const retained = previous.has(label.key);
    if (facing<(retained ? .14 : .20))continue;
    const diameter = label.place?0:Math.sqrt(label.area)*scale;
    if (!label.place&&diameter<(retained?5:7))continue;
    const pixelSize = label.place?Math.min(20, 12+Math.max(0, camera.view.zoom-4)*1.25)
      :territorialLabelPixelSize(label.shortSide, camera.view.zoom);
    const size = pixelSize/fontSize;
    // Font measurement is cheap and cached independently of SDF pixels.
    // Never rasterize a rejected, hidden or off-screen candidate.
    const measured = measureLabel?measureLabel(label):label;
    const [x, y] = point, left = x-(measured.anchorX??measured.width/2)*size,top=y-(measured.anchorY??measured.height/2)*size;
    const right = left+measured.width*size, bottom = top+measured.height*size;
    if (left<0||top<0||right>viewport.width||bottom>viewport.height)continue;
    const gap = retained?0:3;
    stamp++;
    if (cellRange(left-gap, top-gap, right+gap, bottom+gap, key => {
      for (const row of cells.get(key)??[]) {
        if (checked[row.collisionIndex]===stamp) {if (stats)stats.duplicateCollisionSkips++; continue;}
        checked[row.collisionIndex] = stamp; if (stats)stats.collisionComparisons++;
        if (row.left<right+gap&&row.right>left-gap&&row.top<bottom+gap&&row.bottom>top-gap)return true;
      }
      return false;
    }))continue;
    const pixels=measured.width*measured.height;
    if (usedPixels+pixels>pixelBudget) {if (stats)stats.pixelBudgetOmitted=(stats.pixelBudgetOmitted??0)+1;continue;}
    usedPixels+=pixels;
    const row = {...label, ...measured, left, right, top, bottom, collisionIndex:placed.length};
    placed.push(row);
    cellRange(left, top, right, bottom, key => {
      let bucket = cells.get(key);
      if (!bucket) {bucket = []; cells.set(key, bucket);}
      bucket.push(row); return false;
    });
  }
  if (stats)stats.layoutPixels=usedPixels;
  onGrid?.(cells, columns, cellSize);
  return placed;
}

export function createGlobeLabelSpatialIndex(rows) {
  const indexed = rows.filter(row => row.visible!==false&&Array.isArray(row.coordinate)&&row.coordinate.length===2&&
    row.coordinate.every(Number.isFinite)&&Math.abs(row.coordinate[1])<=90).map(row => {
      const vector = row.vector??globeVector(row.coordinate);
      return row.vector===vector&&row.bounds?row:{...row, vector, bounds:[...vector, ...vector]};
    });
  const index = createGlobePacketIndex(indexed, row => row.bounds);
  return {rows:indexed, query:index.query};
}

const vertexShader=`
  attribute float instanceRow;
  uniform sampler2D boxes;
  uniform vec2 viewport;
  uniform float capacity, atlasSize;
  varying vec2 texCoord;
  varying float texelsPerCssPixel;
  void main(){
    float row = (instanceRow + 0.5) / capacity;
    vec4 box = texture2D(boxes, vec2(0.25, row));
    vec4 uvRect = texture2D(boxes, vec2(0.75, row));
    vec2 pixel = mix(box.xy, box.zw, position.xy);
    texCoord = mix(uvRect.xy, uvRect.zw, position.xy);
    texelsPerCssPixel = (uvRect.z - uvRect.x) * atlasSize / (box.z - box.x);
    gl_Position = vec4(2.0 * pixel.x / viewport.x - 1.0, 1.0 - 2.0 * pixel.y / viewport.y, 0.0, 1.0);
  }
`;
const fragmentShader=`
  uniform sampler2D atlas;
  uniform vec3 textColor, haloColor;
  uniform float atlasSize;
  varying vec2 texCoord;
  varying float texelsPerCssPixel;
  void main(){
    float distanceCss = (texture2D(atlas,texCoord).r - 0.5) * ${(2*outlineRange).toFixed(1)} / texelsPerCssPixel;
    // The quad supplies a stable footprint independent of the glyph gradient.
    float pixelWidth = max(abs(dFdx(texCoord.x)), abs(dFdy(texCoord.y))) * atlasSize / texelsPerCssPixel;
    float fillEdge = 0.5 * pixelWidth;
    // Leave the outer texel transparent so linear filtering stays inside this atlas entry.
    float haloEdge = min(fillEdge + 0.35, ${(padding - 0.5).toFixed(1)} / texelsPerCssPixel - 1.0);
    float ink = smoothstep(-fillEdge, fillEdge, distanceCss);
    float halo = smoothstep(-haloEdge, haloEdge, distanceCss + 1.0);
    float coverage = max(ink, halo);
    if (coverage <= 0.0) discard;
    gl_FragColor = vec4(mix(haloColor,textColor,ink/coverage),coverage);
    #include <colorspace_fragment>
  }
`;

export function orderGlobeLabels(rows) {
  return [...rows].sort((a, b) => Number(Boolean(a.place))-Number(Boolean(b.place))||
    (a.place?Number(Boolean(b.selected))-Number(Boolean(a.selected))||b.priority-a.priority:b.area-a.area)||a.key.localeCompare(b.key));
}

// Shelf-pack current cached runs without changing their SDF bitmap or metrics.
export function planGlobeAtlasPages(runs, size = atlasSize) {
 const pages = [];
 for (const place of [false, true]) {
  const ordered = runs.filter(run => run.page.place===place).sort((a, b) => b.height-a.height||b.width-a.width);
  let page = null;
  for (const run of ordered) {
   if (run.width>size||run.height>size)return null;
   if (page&&page.x+run.width>size) {page.y+=page.rowHeight; page.x = 0; page.rowHeight = 0;}
   if (!page||page.y+run.height>size) {
    page = {place, x:0, y:0, rowHeight:0, placements:[]}; pages.push(page);
   }
   page.placements.push({run, x:page.x, y:page.y});
   page.x+=run.width; page.rowHeight = Math.max(page.rowHeight, run.height);
  }
 }
 return pages;
}

// Rectangles refer to texels, not RGBA components. The renderer's
// copyTextureToTexture CPU path supports both RedFormat and FloatType.
export function mergeLabelTextureRects(rects) {
  const ordered = rects.map(row => ({...row})).sort((a, b) => a.y-b.y||a.x-b.x);
  const merged = [];
  for (const rect of ordered) {
    const previous = merged.at(-1);
    if (previous) {
      const left = Math.min(previous.x, rect.x), top = Math.min(previous.y, rect.y);
      const right = Math.max(previous.x+previous.width, rect.x+rect.width), bottom = Math.max(previous.y+previous.height, rect.y+rect.height);
      const near = rect.y<=previous.y+previous.height+1&&rect.x<=previous.x+previous.width+1&&rect.x+rect.width>=previous.x-1;
      const area = (right-left)*(bottom-top);
      if (near&&area<=1.25*(previous.width*previous.height+rect.width*rect.height)) {
        Object.assign(previous, {x:left, y:top, width:right-left, height:bottom-top}); continue;
      }
    }
    merged.push(rect);
  }
  return merged;
}

export function labelInstanceCapacity(current, needed, limit) {
  if (needed>limit)throw Error('Label batch exceeds texture capacity');
  return globeBufferCapacity(current, needed, limit, 16);
}
const labelFields = ['key','area','shortSide','place','selected','priority','marker','minZoom','maxZoom','visible'];
const equalCoordinate = (a, b) => a?.[0]===b?.[0]&&a?.[1]===b?.[1];
const sameLabel = (a, b) => a&&b&&labelFields.every(key => a[key]===b[key])&&a.ref?.key===b.ref?.key&&
  equalCoordinate(a.coordinate, b.coordinate)&&a.lines.length===b.lines.length&&a.lines.every((line, i) => line===b.lines[i]);

export function createThreeGlobeLabels(THREE,{scene,renderer,palette,capacity,viewport,maxTextureSize=2048,byteBudget=renderCacheBudget().labelAtlasBytes,onReady=()=>{},onError=()=>{},createSdfTasks=createGlobeLabelSdfTasks,residency=null,workScheduler=null,gpuFrameBudget=null,prepareGpuMesh=null}) {
  const rasterOwner = createGlobeLabelRaster(), {canvas:raster, context} = rasterOwner;
  const fontUrl = new URL(GLOBE_LABEL_FONT_PATH, document.baseURI).href;
  let probes = null, workerRaster = true;
  const maskOnlyKeys = new Set();
  const size = Math.min(atlasSize, maxTextureSize), maxRows = Math.max(1, Math.min(maxTextureSize, capacity));
  const pages = [], cache = new Map(), metricsCache = new Map();
  const pageLedger = createGlobeGpuResidency(residency), dirtyBatchPages = new Set(), retiredPages = new Set();
  let protectedPages = new Set(), metadataBytes = -1, ledgerChanged = false;
  const metricsLimit = 4096;
  const textColor = new THREE.Color(palette.text), haloColor = new THREE.Color(0xffffff);
  // This source is never uploaded itself. It borrows the existing CPU data
  // for the rectangular copy and releases that reference immediately.
  const textureCopier = createGlobeTextureCopier(THREE, renderer);
  const candidateGroups = [{source:null, rows:[], index:createGlobeLabelSpatialIndex([])}, {source:null, rows:[], index:createGlobeLabelSpatialIndex([])}];
  const sdfTasks = createSdfTasks({scheduler:workScheduler});
  let placed = [], previous = new Set(), lastCamera = null, cacheDirty = true, lastComplete = true, lastStrict = false, lastCandidateLimit=Infinity,disposed = false;
  let layoutCache = null, candidateRevision = 0;
  let pendingSdf = null, desiredKeys = new Set(), pendingMaskBytes = 0;
  const sdfRecovery = createGlobeLabelSdfRecovery();
  let activePages = new Set(), hitSnapshot = () => null, layoutStats = {};
  const counters = {rasterizedRuns:0, textMeasurements:0, fullUploadBytes:0, partialUploadBytes:0, partialUploads:0, fullUploads:0, evictedPages:0, compactedPages:0, shrunkBatches:0, workerRasterRuns:0, documentRasterRuns:0, rasterFallbacks:0, reusedRects:0, reclaimedRuns:0, compactionDeferrals:0};

  function textureState(texture) {
    const state={texture,uploaded:false,pendingFull:true,rects:[]};
    texture.onUpdate=()=>{state.uploaded=true;state.pendingFull=false;counters.fullUploads++;counters.fullUploadBytes+=texture.image.data.byteLength;};
    return state;
  }
  function restoreTexture(state) {
    state.uploaded=false;state.pendingFull=true;state.rects.length=0;state.texture.clearUpdateRanges();
  }
  function uploadFull(state) {
    if (state.uploaded)return true;
    if (!state.pendingFull)return false;
    const bytes=state.texture.image?.data?.byteLength??0;
    if (gpuFrameBudget&&!gpuFrameBudget.admitUpload(bytes,1))return false;
    state.texture.needsUpdate=true;renderer.initTexture(state.texture);
    return state.uploaded;
  }
  function dirty(state, x, y, width, height) {
    if (state.uploaded&&width>0&&height>0)state.rects.push({x, y, width, height});
  }
  function flush(state) {
    if (!state.rects.length)return true;
    const texture=state.texture,{width,height,data}=texture.image,rects=mergeLabelTextureRects(state.rects);
    if (!state.uploaded)return false;
    const area=rects.reduce((sum,row)=>sum+row.width*row.height,0);
    if (!renderer?.copyTextureToTexture||area>=width*height*.6||rects.length>64) {restoreTexture(state);return false;}
    const bytesPerTexel=data.byteLength/(width*height),bytes=area*bytesPerTexel;
    if (gpuFrameBudget&&!gpuFrameBudget.admitUpload(bytes,rects.length))return false;
    state.rects.length=0;
    textureCopier.copy(texture,rects,pixels=>{counters.partialUploads++;counters.partialUploadBytes+=pixels*bytesPerTexel;});
    return true;
  }
  function addPage(place) {
    const pixels = new Uint8Array(size*size);
    const atlas = createGlobeDataTexture(THREE, pixels, size, size, {format:THREE.RedFormat, filter:THREE.LinearFilter});
    const page = {pixels, atlas, upload:textureState(atlas), batches:[], place, x:0, y:0, rowHeight:0, count:0, keys:new Set(), freeRects:[], lastUsed:performance.now(), retired:false};
    pages.push(page); pageLedger.track(page, () => pageFootprint(page), {evict:() => evictPage(page)}); cacheDirty = true; return page;
  }
  function measureLabel(label) {
    const key = label.atlasKey, run = cache.get(key);
    if (run&&!run.page.retired)return run.metrics;
    let measured = touchLruEntry(metricsCache, key);
    if (measured)return measured;
    const place = Boolean(label.place), marker = label.marker??'';
    const font = globeLabelFont(place), lineMetrics = globeLabelLineMetrics(context, label.lines, font);
    const markerWidth = marker?36:0;
    const width = Math.min(size, Math.ceil(Math.max(...lineMetrics.map(row => row[0])))+padding*2+markerWidth);
    const lineHeight = Math.ceil(fontSize*1.26), height = lineHeight*label.lines.length+padding*2;
    if (height>size)throw Error('Label exceeds SDF atlas height');
    measured = {width, height, font, lineHeight, markerWidth, lineMetrics, textX:place?padding+markerWidth:width/2,
      anchorX:place?padding+markerWidth/3:width/2,anchorY:place?padding+lineHeight/2:height/2};
    metricsCache.set(key, measured); counters.textMeasurements++;
    trimLruCount(metricsCache, metricsLimit);
    return measured;
  }
  function cachedRun(key) {
    const run = cache.get(key); return run&&!run.page.retired?run:null;
  }
  function rasterMask(label) {
    const row = globeLabelRasterRow(label);
    counters.documentRasterRuns++; return {...row, mask:rasterOwner.mask(row)};
  }
  function fontProbes() {
    if (probes)return probes;
    probes = [false, true].map(place => {
      const label = {atlasKey:'font-probe:'+place, place, marker:place?'capital':'', lines:['대한민국 Aa 123']};
      return rasterMask({...label, ...measureLabel(label)});
    });
    rasterOwner.reset(); return probes;
  }
  function takeFreeRect(page, width, height) {
    let best = -1, area = Infinity;
    for (let i = 0; i<page.freeRects.length; i++) {
      const row = page.freeRects[i], size = row.width*row.height;
      if (row.width>=width&&row.height>=height&&size<area) {best = i; area = size;}
    }
    if (best<0)return null;
    const [row] = page.freeRects.splice(best, 1);
    if (row.width>width)page.freeRects.push({x:row.x+width, y:row.y, width:row.width-width, height});
    if (row.height>height)page.freeRects.push({x:row.x, y:row.y+height, width:row.width, height:row.height-height});
    if (page.freeRects.length>128)page.freeRects.sort((a, b) => b.width*b.height-a.width*a.height).length = 128;
    counters.reusedRects++; return {page, x:row.x, y:row.y};
  }
  function takeShelf(page, width, height) {
    let x = page.x, y = page.y, rowHeight = page.rowHeight;
    if (x+width>size) {x = 0; y+=rowHeight; rowHeight = 0;}
    if (y+height>size)return null;
    page.x = x+width; page.y = y; page.rowHeight = Math.max(rowHeight, height);
    return {page, x, y};
  }
  function allocateRun(place, width, height) {
    const compatible = pages.filter(page => page.place===place&&!page.retired);
    for (let i = compatible.length-1; i>=0; i--) {
      const page = compatible[i], hole = takeFreeRect(page, width, height);
      if (hole)return hole;
      const shelf = takeShelf(page, width, height); if (shelf)return shelf;
    }
    // Never recycle a rectangle referenced by the approved or preparing
    // label placement. Only inspect a bounded number of stale runs.
    let examined = 0;
    for (const page of compatible) {
      if (activePages.has(page))continue;
      for (const key of page.keys) {
        if (++examined>256)break;
        const run = cache.get(key);
        if (!run||run.page!==page||desiredKeys.has(key)||run.width<width||run.height<height)continue;
        cache.delete(key); page.keys.delete(key);
        page.freeRects.push({x:Math.round(run.uv[0]*size), y:Math.round(run.uv[1]*size), width:run.width, height:run.height});
        counters.reclaimedRuns++; return takeFreeRect(page, width, height);
      }
      if (examined>256)break;
    }
    return takeShelf(addPage(place), width, height);
  }
  function installText(label, field) {
    const key = label.atlasKey, existing = cachedRun(key);
    if (existing)return existing;
    const {width, height, font, lineHeight, markerWidth, textX, anchorX, anchorY, lineMetrics} = label;
    const metrics = {width, height, font, lineHeight, markerWidth, textX, anchorX, anchorY, lineMetrics};
    if (!(field instanceof Uint8Array)||field.length!==width*height)throw Error('Invalid SDF worker result');
    const {page, x, y} = allocateRun(Boolean(label.place), width, height);
    for (let row = 0; row<height; row++)page.pixels.set(field.subarray(row*width, (row+1)*width), (y+row)*size+x);
    const uv = [x/size,y/size,(x+width)/size,(y+height)/size];
    const run = {page, width, height, uv, metrics, atlasKey:key};
    cache.set(key, run); page.keys.add(key); dirty(page.upload, x, y, width, height);
    counters.rasterizedRuns++; cacheDirty = true;
    return run;
  }
  function cancelSdf() {
    if (!pendingSdf)return;
    const old = pendingSdf; pendingSdf = null; pendingMaskBytes = 0;
    old.controller.abort(); cacheDirty = true;
  }
  function prepareMissing(layout) {
    desiredKeys = new Set(layout.map(row => row.atlasKey));
    if (pendingSdf&&![...pendingSdf.labels.keys()].some(key => desiredKeys.has(key)))cancelSdf();
    const missing = new Map();
    for (const row of layout)if (!cachedRun(row.atlasKey))missing.set(row.atlasKey, row);
    if (!missing.size)return true;
    if (pendingSdf||sdfRecovery.error)return false;
    const labels = new Map(); let bytes = 0;
    for (const label of missing.values()) {
      const estimate = label.width*label.height;
      if (labels.size&&(labels.size>=24||bytes+estimate>512*1024))break;
      labels.set(label.atlasKey, label); bytes+=estimate;
    }
    const controller = new AbortController(), job = {controller, labels};
    pendingSdf = job; pendingMaskBytes = bytes; cacheDirty = true;
    // Reserve before rasterization; include RGBA readback, alpha mask,
    // two distance arrays, result and possible atlas page allocation.
    const release = residency?.reserve(bytes*14+2*size*size, {kind:'label-sdf', trimFirst:false})??(() => {});
    const yieldTask = () => new Promise(resolve => setTimeout(resolve, 0));
    async function masksFor(list) {
      const rows = [];
      for (const label of list) {controller.signal.throwIfAborted(); rows.push(rasterMask(label)); await yieldTask();}
      rasterOwner.reset(); return rows;
    }
    const execute = async() => {
      const priority = lastStrict?25:8;
      if (sdfRecovery.fallback) {
        const workspace = createGlobeDistanceWorkspace(), result = [];
        // Bound local fallback to one label at a time and yield to input.
        for (const label of labels.values()) {
          controller.signal.throwIfAborted(); const row = rasterMask(label);
          result.push({key:row.key, width:row.width, height:row.height, pixels:workspace.transform(row.mask, row.width, row.height, row.outlineRange)});
          await yieldTask();
        }
        rasterOwner.reset(); return result;
      }
      const rows = [], local = [];
      for (const label of labels.values()) {
        if (workerRaster&&!maskOnlyKeys.has(label.atlasKey))rows.push(globeLabelRasterRow(label));
        else local.push(label);
      }
      const results = [];
      if (rows.length) {
        const response = await sdfTasks.run(rows, controller.signal, {priority, fontUrl, probes:fontProbes()});
        if (!Array.isArray(response)||response.length!==rows.length)throw Error('Incomplete worker raster response');
        for (const row of response) {
          if (row.needMask) {
            if (row.workerRasterCompatible===false)workerRaster = false;
            else {maskOnlyKeys.add(row.key); while (maskOnlyKeys.size>256)maskOnlyKeys.delete(maskOnlyKeys.values().next().value);}
            const label = labels.get(row.key); if (!label)throw Error('Unknown label raster response');
            local.push(label); counters.rasterFallbacks++;
          }else {results.push(row); counters.workerRasterRuns++;}
        }
      }
      if (local.length) {
        const masks = await masksFor(local);
        results.push(...await sdfTasks.run(masks, controller.signal, {priority}));
      }
      return results;
    };
    Promise.resolve().then(execute).then(result => {
      if (disposed||pendingSdf!==job||controller.signal.aborted)return;
      if (!Array.isArray(result)||result.length!==labels.size||new Set(result.map(row => row.key)).size!==labels.size)
        throw Error('Incomplete label SDF response');
      for (const row of result) {
        const label = labels.get(row.key);
        if (!label||label.width!==row.width||label.height!==row.height)throw Error('Unexpected SDF response');
        if (desiredKeys.has(row.key))installText(label, row.pixels);
      }
      sdfRecovery.succeed();
    }).catch (error => {
      if (disposed||pendingSdf!==job||controller.signal.aborted)return;
      const outcome = sdfRecovery.fail(error);
      if (outcome==='fallback'||outcome==='terminal')onError(error, {terminal:outcome==='terminal'});
    }).finally(() => {
      try {rasterOwner.reset(); if (!disposed)syncLabelMemory();}
      finally {
        release();
        if (!disposed&&pendingSdf===job) {
          pendingSdf = null; pendingMaskBytes = 0; lastCamera = null; cacheDirty = true; onReady();
        }
      }
    });
    return false;
  }
  function disposeBatch(batch) {
    disposeGlobeGpuResources(scene, [batch.mesh], {textures:[batch.boxes]});
  }
  function createBatch(page, needed, old) {
    const allocated = labelInstanceCapacity(old?.capacity??0, needed, maxRows);
    if (old&&allocated===old.capacity)return old;
    if (old) {if (allocated<old.capacity)counters.shrunkBatches++; disposeBatch(old);}
    const values = new Float32Array(allocated*8), boxes = createGlobeDataTexture(THREE, values, 2, allocated, {format:THREE.RGBAFormat, type:THREE.FloatType});
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0), 3));
    geometry.setAttribute('instanceRow', new THREE.InstancedBufferAttribute(Float32Array.from({length:allocated}, (_, i) => i), 1));
    geometry.setIndex([0, 2, 1, 2, 3, 1]);
    const material = new THREE.ShaderMaterial({vertexShader, fragmentShader, depthTest:false, depthWrite:false, transparent:true,
      uniforms:{atlas:{value:page.atlas}, atlasSize:{value:size}, boxes:{value:boxes}, capacity:{value:allocated}, viewport, textColor:{value:textColor}, haloColor:{value:haloColor}}});
    const mesh = createGlobeMesh(THREE, geometry, material, 7);
    geometry.instanceCount=0;mesh.visible=false;scene.add(mesh);
    cacheDirty=true;dirtyBatchPages.add(page);pageLedger.mark(page);return {values,boxes,upload:textureState(boxes),mesh,capacity:allocated,count:0,gpuReady:false};
  }
  function updateBatch(batch, rows, first, count) {
    let dirtyStart = -1;
    for (let i = 0; i<count; i++) {
      const {uv, left, top, right, bottom} = rows[first+i];
      const offset = i*8, values = batch.values;
      let changed = false;
      for (let component = 0; component<8; component++) {
        const value = Math.fround(component===0?left:component===1?top:component===2?right:component===3?bottom:uv[component-4]);
        if (values[offset+component]!==value) {values[offset+component] = value; changed = true;}
      }
      if (changed&&dirtyStart<0)dirtyStart = i;
      if (!changed&&dirtyStart>=0) {dirty(batch.upload, 0, dirtyStart, 2, i-dirtyStart); dirtyStart = -1;}
    }
    if (dirtyStart>=0)dirty(batch.upload, 0, dirtyStart, 2, count-dirtyStart);
    if (batch.count!==count)cacheDirty = true;
    batch.count=count;batch.mesh.geometry.instanceCount=count;
    batch.mesh.visible=count>0&&batch.gpuReady&&page.upload.uploaded&&batch.upload.uploaded;
  }
  function hideBatches(page, first = 0) {
    for (let i = first; i<page.batches.length; i++) {
      const batch = page.batches[i];
      if (batch.count) {batch.count = 0; batch.mesh.geometry.instanceCount = 0; batch.mesh.visible = false; cacheDirty = true; dirtyBatchPages.add(page);}
    }
  }
  function pageFootprint(page) {
    return gpuResourceFootprint(page.batches.map(batch => batch.mesh.geometry), [page.atlas, ...page.batches.map(batch => batch.boxes)]);
  }
  function disposePage(page) {
    pageLedger.remove(page); dirtyBatchPages.delete(page); retiredPages.delete(page); protectedPages.delete(page);
    for (const batch of page.batches)disposeBatch(batch);
    page.batches.length = 0; page.atlas.dispose();
    for (const key of page.keys)if (cache.get(key)?.page===page)cache.delete(key);
    page.keys.clear(); page.upload.rects.length = 0;
  }
  function evictPage(page) {
    const i = pages.indexOf(page);
    if (i<0)return;
    disposePage(page); pages.splice(i, 1); counters.evictedPages++;
  }
  function compactActivePages(renderRows) {
    const current = new Set(renderRows.map(row => row.page)), keys = new Set(renderRows.map(row => row.atlasKey));
    if (current.size<2||current.size*size*size*2<=byteBudget)return renderRows;
    // Compact one compatible pair per pass, not the complete active atlas.
    // If the temporary overlap cannot be reserved, keep the existing pages.
    const liveByPage = new Map();
    for (const key of keys) {
      const run = cachedRun(key); if (!run)continue;
      let rows = liveByPage.get(run.page); if (!rows) {rows = []; liveByPage.set(run.page, rows);}rows.push(run);
    }
    for (const place of [false, true]) {
      const candidates = [...current].filter(page => page.place===place).map(page => ({page, runs:liveByPage.get(page)??[]}));
      candidates.sort((a, b) => a.runs.reduce((n, r) => n+r.width*r.height, 0)-b.runs.reduce((n, r) => n+r.width*r.height, 0));
      if (candidates.length<2)continue;
      const pair = candidates.slice(0, 2), plan = planGlobeAtlasPages(pair.flatMap(row => row.runs), size);
      if (!plan||plan.length!==1)continue;
      const release = residency?residency.reserve(size*size*2, {kind:'atlas-compaction', optional:true, trimFirst:false}):() => {};
      if (!release) {counters.compactionDeferrals++; return renderRows;}
      try {
        const layout = plan[0], page = addPage(layout.place);
        for (const {run, x, y} of layout.placements) {
          const sourceX = Math.round(run.uv[0]*size), sourceY = Math.round(run.uv[1]*size);
          for (let row = 0; row<run.height; row++) {
            const offset = (sourceY+row)*size+sourceX;
            page.pixels.set(run.page.pixels.subarray(offset, offset+run.width), (y+row)*size+x);
          }
          const uv = [x/size,y/size,(x+run.width)/size,(y+run.height)/size];
          cache.set(run.atlasKey, {...run, page, uv}); page.keys.add(run.atlasKey);
        }
        page.x = layout.x; page.y = layout.y; page.rowHeight = layout.rowHeight;
        for (const row of pair) {row.page.retired = true; retiredPages.add(row.page);}
        counters.compactedPages++; cacheDirty = true;
        return renderRows.map(row => ({...row, ...cache.get(row.atlasKey)}));
      }finally {release();}
    }
    return renderRows;
  }
  function setGroup(group, rows) {
    if (rows===group.source)return false;
    const ordered = orderGlobeLabels(rows);
    group.source = rows;
    if (ordered.length===group.rows.length&&ordered.every((row, index) => sameLabel(row, group.rows[index])))return false;
    const prior = new Map(group.rows.map(row => [row.key, row]));
    group.rows = ordered.map(row => {
      const old = prior.get(row.key);
      if (sameLabel(row, old))return old;
      const vector = equalCoordinate(old?.coordinate, row.coordinate)?old?.vector:undefined;
      const valid = Array.isArray(row.coordinate)&&row.coordinate.length===2&&row.coordinate.every(Number.isFinite)&&Math.abs(row.coordinate[1])<=90;
      const point = valid?(vector??globeVector(row.coordinate)):null;
      return {...row, vector:point, bounds:point?[...point, ...point]:null, atlasKey:JSON.stringify([Boolean(row.place), row.marker??'', row.lines])};
    });
    group.index = createGlobeLabelSpatialIndex(group.rows); candidateRevision++; layoutCache = null; lastCamera = null; cacheDirty = true; return true;
  }
  function setCandidateGroups(countries, places) {
    const changedCountries = setGroup(candidateGroups[0], countries), changedPlaces = setGroup(candidateGroups[1], places);
    return changedCountries||changedPlaces;
  }
  function setCandidates(rows) {return setCandidateGroups(rows.filter(row => !row.place), rows.filter(row => row.place));}
  function trim() {
    if (!cacheDirty&&!ledgerChanged)return false;
    cacheDirty = false; ledgerChanged = false;
    for (const page of dirtyBatchPages) {
      const before = page.batches.length;
      while (page.batches.length&&page.batches.at(-1).count===0)disposeBatch(page.batches.pop());
      if (before!==page.batches.length)pageLedger.mark(page);
    }
    dirtyBatchPages.clear();
    // The layout/SDF owner already reconciled protection and metadata.
    // Trimming only changes GPU buffers on the affected pages.
    pageLedger.flush();
    if (pageLedger.stats().bytes>byteBudget||retiredPages.size) {
      const inactive = pages.filter(page => !protectedPages.has(page)).sort((a, b) => Number(b.retired)-Number(a.retired)||a.lastUsed-b.lastUsed);
      for (const page of inactive) {
        if (!page.retired&&pageLedger.stats().bytes<=byteBudget)break;
        evictPage(page);
      }
    }
    return true;
  }
  function update(camera, width, height, cull = createGlobeRangeCuller(camera.frame, width, height), requireComplete = false, candidateLimit = Infinity) {
    if (camera===lastCamera&&lastStrict===requireComplete&&lastCandidateLimit===candidateLimit)return lastComplete;
    lastCamera = camera; lastStrict = requireComplete;lastCandidateLimit=candidateLimit;
    if (!layoutCache||layoutCache.camera!==camera||layoutCache.width!==width||layoutCache.height!==height||layoutCache.revision!==candidateRevision||layoutCache.candidateLimit!==candidateLimit) {
      const visible = camera.view.zoom>=COUNTRY_LABEL_MIN_ZOOM?candidateGroups.flatMap(group => group.index.query(cull)).filter(row =>
        camera.view.zoom>=(row.minZoom??-Infinity)&&camera.view.zoom<=(row.maxZoom??Infinity)):[];
      const stats = {candidates:candidateGroups.reduce((sum, group) => sum+group.rows.length, 0), spatialCandidates:visible.length, projectedCandidates:0, collisionComparisons:0, duplicateCollisionSkips:0};
      let hitGrid = null;
      stats.budgetCandidates=Math.min(visible.length,candidateLimit);stats.budgetOmitted=visible.length-stats.budgetCandidates;
      const layout = placeGlobeLabels(visible.slice(0,candidateLimit), camera, {width, height}, previous, (cells, columns, cellSize) => {hitGrid = {cells, columns, cellSize};}, measureLabel, stats,Math.floor(byteBudget/4));
      layoutCache = {camera, width, height,revision:candidateRevision,candidateLimit,layout,hitGrid,stats};
    }
    const {layout, hitGrid, stats} = layoutCache; layoutStats = {...stats};
    lastComplete = prepareMissing(layout);
    layoutStats.pending = layout.filter(row => !cachedRun(row.atlasKey)).length;
    // Initial/temporal frames retain the previous label buffers until the
    // entire exact placement has a ready SDF. Moving frames may display
    // only ready runs; missing rows are not exposed to picking.
    if (requireComplete&&!lastComplete) {syncLabelMemory(); return false;}
    placed = layout.filter(row => cachedRun(row.atlasKey));
    previous = new Set(placed.map(row => row.key));
    const readyKeys = new Set(placed.map(row => row.key)), hitCells = new Map();
    if (hitGrid) {
      const {cells, columns, cellSize} = hitGrid;
      for (const [key, rows] of cells) {
        const hits = rows.filter(row => readyKeys.has(row.key)).map(({ref, left, right, top, bottom}) => ({ref, left, right, top, bottom}));
        if (hits.length)hitCells.set(key, hits);
      }
      hitSnapshot = ([x, y]) => x<0||y<0||x>width||y>height?null:(hitCells.get(Math.floor(y/cellSize)*columns+Math.floor(x/cellSize))??[]).find(row=>x>=row.left&&x<=row.right&&y>=row.top&&y<=row.bottom)?.ref??null;
    }else hitSnapshot = () => null;
    const renderRows = compactActivePages(placed.map(row => ({...row, ...cachedRun(row.atlasKey)})));
    const byPage = new Map();
    for (const row of renderRows) {
      let rows = byPage.get(row.page); if (!rows) {rows = []; byPage.set(row.page, rows);}rows.push(row);
    }
    for (const page of activePages)if (!byPage.has(page)) {page.count = 0; hideBatches(page); cacheDirty = true;}
    for (const [page, rows] of byPage) {
      if (!activePages.has(page))cacheDirty = true;
      page.count = rows.length; page.lastUsed = performance.now();
      let batchIndex = 0;
      for (let first = 0; first<rows.length; first+=maxRows) {
        const count = Math.min(maxRows, rows.length-first);
        const batch=createBatch(page,count,page.batches[batchIndex]);
        page.batches[batchIndex++]=batch;updateBatch(batch,rows,first,count);
      }
      hideBatches(page,batchIndex);
    }
    activePages = new Set(byPage.keys()); layoutStats.placed = placed.length;
    syncLabelMemory(); return lastComplete;
  }
  function cancelPending() {desiredKeys.clear(); cancelSdf(); sdfRecovery.reset(); layoutCache = null; lastCamera = null; cacheDirty = true; syncLabelMemory();}
  function setPalette(next) {
    if (next.text)textColor.set(next.text);
    if (next.halo) {const color = String(next.halo).replace(/^rgba\(([^,]+,[^,]+,[^,]+),[^)]+\)$/,'rgb($1)');haloColor.set(color);}
  }
  function restoreTextures() {
    for (const page of pages) {restoreTexture(page.upload);for (const batch of page.batches){restoreTexture(batch.upload);batch.gpuReady=false;batch.mesh.visible=false;}}
  }
  function flushUploads() {
    let complete=true;
    for (const page of activePages) {
      if (!uploadFull(page.upload)) {complete=false;for (const batch of page.batches)batch.mesh.visible=false;continue;}
      for (const batch of page.batches) {
        if (batch.upload.pendingFull&&!uploadFull(batch.upload)) {complete=false;batch.mesh.visible=false;continue;}
        if (batch.upload.rects.length&&!flush(batch.upload)) {complete=false;batch.mesh.visible=false;continue;}
        if (!batch.gpuReady) {
          if (prepareGpuMesh&&!prepareGpuMesh(batch.mesh)) {complete=false;batch.mesh.visible=false;continue;}
          batch.gpuReady=true;
        }
        batch.mesh.visible=batch.count>0;
      }
    }
    return complete;
  }
  function syncLabelMemory() {
    const next = new Set(activePages);
    for (const key of desiredKeys) {const page = cachedRun(key)?.page; if (page)next.add(page);}
    for (const page of protectedPages)if (!next.has(page))pageLedger.protect(page, false);
    for (const page of next)if (!protectedPages.has(page))pageLedger.protect(page, true);
    protectedPages = next;
    if (pageLedger.flush())ledgerChanged = true;
    const bytes = raster.width*raster.height*4+(probes?.reduce((sum, row) => sum+row.mask.byteLength, 0)??0)+metricsCache.size*224+
      candidateGroups.reduce((sum, group) => sum+group.rows.length*192+group.index.rows.length*160, 0)+placed.length*128;
    if (bytes!==metadataBytes) {metadataBytes = bytes; ledgerChanged = true; residency?.set(raster, {protected:true, extraBytes:bytes});}
  }
  function dispose() {
    disposed = true; cancelSdf(); sdfTasks.dispose(); desiredKeys.clear();
    for (const page of pages)disposePage(page);
    residency?.remove(raster); textureCopier.dispose(); pages.length = 0; cache.clear(); metricsCache.clear(); probes = null; maskOnlyKeys.clear();
    for (const group of candidateGroups) {group.source = null; group.rows = []; group.index = createGlobeLabelSpatialIndex([]);}
    placed = []; previous.clear(); activePages.clear(); lastCamera = null; layoutCache = null; hitSnapshot = () => null;
    rasterOwner.reset();
  }
  function cacheStats() {
    return {pages:pages.length, visiblePages:activePages.size, residentBytes:pageLedger.stats().bytes, pageLedger:pageLedger.stats(),
      batchCapacity:pages.reduce((sum, page) => sum+page.batches.reduce((n, batch) => n+batch.capacity, 0), 0),
      measuredTexts:metricsCache.size, ...counters, sdfWorker:{...sdfTasks.stats(), workerRaster, fallback:sdfRecovery.fallback, localFailures:sdfRecovery.localFailures, failed:!!sdfRecovery.error, pendingMaskBytes}, layout:{...layoutStats}};
  }
  return Object.freeze({setCandidates,setCandidateGroups,update,trim,flushUploads,dispose,cancelPending,restoreTextures,setPalette, sdfError:() => sdfRecovery.error, hitSnapshot:() => hitSnapshot, cacheStats,
    visibleCount:place => placed.filter(row => Boolean(row.place)===place).length,
    drawCalls:() => [...activePages].reduce((count,page)=>count+page.batches.filter(batch=>batch.count>0).length,0),atlasEntryCount:() => cache.size, hitTest:point => hitSnapshot(point)});
}
