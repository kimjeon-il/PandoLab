import '../../runtime/workers/worker-rpc-host.js';
import { createGlobeDistanceWorkspace } from '../globe-label-sdf.js';
import { createGlobeLabelRaster, globeLabelLineMetrics, globeLabelMetricsMatch } from '../globe-label-raster.js';

const rpc = self.PandoLabWorkerRpc;
let fontUrl = null, fontCompatible = false, face = null;
async function prepareFont(url, probes, raster) {
  if (fontUrl===url)return fontCompatible;
  fontUrl = url; fontCompatible = false;
  if (!self.fonts||typeof FontFace!=='function'||!url||!probes?.length)return false;
  try {
    if (face)self.fonts.delete(face);
    // The URL is resolved against the document, not the immutable Worker
    // directory. Load exactly the existing bundled variable font.
  face=await new FontFace('Pretendard Variable',`url("${url}")`,{weight:'100 900'}).load();
    self.fonts.add(face);
    for (const row of probes) {
      if (!globeLabelMetricsMatch(row.lineMetrics, globeLabelLineMetrics(raster.context, row.lines, row.font)))return false;
      const mask = raster.mask(row);
      if (mask.length!==row.mask.length||mask.some((value, i) => value!==row.mask[i]))return false;
    }
    fontCompatible = true; return true;
  }catch{return false;}
}
rpc.install({handlers:{
  'globe.label-sdf':async({rows, fontUrl:requestedFont, probes}, context) => {
    const results = [], transfer = [], workspace = createGlobeDistanceWorkspace();
    let raster = null;
    if (rows.some(row => !row.mask)&&typeof OffscreenCanvas==='function')try {raster = createGlobeLabelRaster();}catch{}
    const compatible = raster?await prepareFont(requestedFont, probes, raster):false;
    try {
      for (const row of rows) {
        context.throwIfCancelled();
        const {key, width, height, outlineRange} = row;
        if (!Number.isInteger(width)||!Number.isInteger(height)||width<=0||height<=0||width*height>2048**2)throw Error('Invalid label mask dimensions');
        let mask = row.mask;
        if (!mask) {
          if (!compatible||!globeLabelMetricsMatch(row.lineMetrics, globeLabelLineMetrics(raster.context, row.lines, row.font))) {
            results.push({key, width, height, needMask:true, workerRasterCompatible:compatible}); continue;
          }
          mask = raster.mask(row);
        }
        if (!(mask instanceof Uint8Array)||mask.length!==width*height)throw Error('Invalid label mask');
        const pixels = workspace.transform(mask, width, height, outlineRange);
        results.push({key, width, height, pixels}); transfer.push(pixels.buffer);
      }
      context.throwIfCancelled(); return rpc.transferResult(results, transfer);
    }finally {raster?.reset();}
  }
}});
