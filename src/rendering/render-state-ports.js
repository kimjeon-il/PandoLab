// The application owns project state. Each rendering owner receives only
// its presentation inputs and explicit acknowledgement port.
export function createRenderStatePorts(state){
 const visibility=()=>state.layerVisibility,presentation=()=>state.layerPresentation;
 return Object.freeze({
  scene:Object.freeze({readLayerVisibility:visibility,readLayerPresentation:presentation}),
  country:Object.freeze({readCountryPresentation:()=>({
   layerVisibility:visibility(),layerPresentation:presentation(),itemVisibility:state.itemVisibility,
  })}),
  hydro:Object.freeze({readHydroPresentation:()=>({
   layerVisibility:visibility(),hydroEdits:state.hydroEdits,hydroFeatureCatalogRevision:state.hydroFeatureCatalogRevision,
   itemVisibility:state.itemVisibility,physicalSettings:state.physicalSettings,
  })}),
  polar:Object.freeze({readPolarPresentation:()=>({
   graticule:state.backgroundSettings?.graticule,graticuleAvailable:state.resourceCapabilities?.graticule,
   rivers:visibility().rivers,hydroEdits:state.hydroEdits,
  })}),
  frame:Object.freeze({isProjectReplacing:()=>!!state.projectReplacing,
   markCanonicalFrame:()=>{state.countryVisualPhase='canonical';}}),
  selection:Object.freeze({
   getGeneric:id=>state.genericFeatures.find(value=>String(value.id)===id),
   getLabel:id=>state.labels.find(value=>String(value.id)===id),
   readDistributionEntries:()=>state.distributionEntries,
  }),
 });
}
