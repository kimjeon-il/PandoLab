import test from 'node:test';
import assert from 'node:assert/strict';
import {createViewerRenderingDomain} from '../../../src/rendering/viewer-rendering-domain.js';

function harness() {
  const frames = [], events = [], place = Promise.withResolvers();
  const renderer = {
    loaded:true,
    getRuntimeState:() => ({webglContextLost:false,mapReady:true}),
    labelZoomVisibility:() => ({places:true}),
    isFramePreserved:() => true,
    invalidateLabelContent:options => events.push(['labels-invalidated',options]),
    renderFrame:frame => {events.push(['render',frame.frameId]); return {succeeded:true};},
    canPresentVisualFrame:() => true,
    commitVisualFrame:() => {events.push(['commit']); return true;},
    reportAncillaryError:(error,message,code) => events.push(['ancillary-error',error,message,code]),
    failMapPreparation:error => events.push(['fatal-error',error]),
  };
  const domain=createViewerRenderingDomain({mapRenderer:renderer,selectionDomain:{snapshot:()=>({})},
    prepareView:({frameId})=>({frameId}),labelResources:{preparePlaces:()=>place.promise,
      beginPlaceInteraction(){},disposePlaces(){}},getDistributionRenderRows:()=>[]});
  return {domain,frames,events,place};
}
test('a temporal map frame commits while place data is pending, then redraws when labels arrive',async()=>{
  const previous=globalThis.requestAnimationFrame, queued=[];
  globalThis.requestAnimationFrame=callback=>{queued.push(callback);return queued.length;};
  const {domain,events,place}=harness();
  try {
    domain.invalidateLabels('document-month-labels');
    assert.equal(events.some(row=>row[0]==='labels-invalidated'),true);
    assert.equal(queued.length,1);
    queued.shift()(16);
    assert.deepEqual(events.filter(row=>row[0]==='commit').length,1);
    place.resolve(true); await Promise.resolve(); await Promise.resolve();
    assert.equal(queued.length,1);
    queued.shift()(32);
    assert.equal(events.filter(row=>row[0]==='commit').length,2);
    assert.equal(events.some(row=>row[0]==='fatal-error'),false);
  } finally {domain.dispose();globalThis.requestAnimationFrame=previous;}
});
test('a failed optional place refresh is reported without failing an already-ready map',async()=>{
  const previous=globalThis.requestAnimationFrame, queued=[];
  globalThis.requestAnimationFrame=callback=>{queued.push(callback);return queued.length;};
  const {domain,events,place}=harness(), failure=Error('place worker failed');
  try {
    domain.invalidateLabels('document-month-labels');
    queued.shift()(16);
    assert.equal(events.filter(row=>row[0]==='commit').length,1);
    place.reject(failure); await Promise.resolve(); await Promise.resolve();
    assert.equal(events.some(row=>row[0]==='ancillary-error'&&row[1]===failure),true);
    assert.equal(events.some(row=>row[0]==='fatal-error'),false);
  } finally {domain.dispose();globalThis.requestAnimationFrame=previous;}
});
