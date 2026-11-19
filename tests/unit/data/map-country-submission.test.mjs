import test from 'node:test';
import assert from 'node:assert/strict';
import {createMapContentPresentation} from '../../../src/ui/map-content-presentation.js';

test('country preparation does not submit a map frame',()=>{
 let submissions=0,prepared=0;
 const content=createMapContentPresentation({active(){},isDisposed:()=>false,countries:{
  getState:()=>({layerVisibility:{objects:true}}),
  replaceGpuSceneDomain(){prepared++;},syncGpuRenderScene(){},
  gpuMapRenderer:{renderFrame(){submissions++;}},
 }});
 content.renderCountries({__mapVisualFrame:true});
 assert.equal(prepared,1);assert.equal(submissions,0);
});
