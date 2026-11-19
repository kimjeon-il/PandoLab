import {layerStyle} from '../ui/layer-presentation.js';
import {normalizeObjectRef} from '../document/object-ref-identity.js';
import {automaticLabelSettings,labelKey} from './label-layout.js';
import {buildRenderableStrokeFeature} from '../geometry/geographic-boundary.js';
import {DISTRIBUTION_MODES,DISTRIBUTION_RENDER_MODES} from '../document/distribution-model.js';
import {admittedGeometryKey} from '../geometry/geometry-version-store.js';

/** Source preparation ports for the single MapLibre scene; no SVG layer refresh. */
export function createMapRenderingResources({ports,session}) {
  if(!session?.selectionDomain)throw new TypeError('Map rendering resources require the canonical selection session.');
  const common={
    getState:()=>ports.projectState.state,
    layerStyle,
    visibleMapObjectCandidates:ports.spatialQuery.visibleMapObjectCandidates,
    geometryMayIntersectViewport:ports.spatialRecords.geometryMayIntersectViewport,
    normalizeObjectRef,
    selectionHas:ref=>session.selectionDomain.has(ref),
    viewportCullingMetrics:ports.spatialQuery.viewportCullingMetrics,
    buildRenderableStrokeFeature,
  };
  return {
    labelResources:{
      getState:()=>ports.projectState.state,
      preparePlaces:ports.countryLabelModel.preparePlaces,
      beginPlaceInteraction:()=>{
        ports.countryLabelModel.builtinPlaces.beginInteraction();
        session.objectSearchController.cancelSearch();
      },
      disposePlaces:()=>ports.countryLabelModel.disposePlaces(),
      getTerritorialLabelRef:ports.objectPicking.getTerritorialLabelRef,
      mapPalette:ports.preferences.mapPalette,
      automaticLabelSettings,
      labelSettings:(state,domain,id)=>state.labelSettings?.[labelKey(domain,id)]||{},
      countryLabelAnchors:()=>ports.labelPresentation.countryLabelAnchors,
      normalizeObjectRef,
      selectionHas:ref=>session.selectionDomain.has(ref),
    },
    countryResources:{
      getState:()=>ports.projectState.state,
      getViewRevision:()=>ports.mapLayout.viewRevision,
      countryOutlineFeature:ports.countryLabelModel.countryOutlineFeature,
      getEntity:ports.territorialModel.entityRepository.get,
      isLayerItemVisible:ports.layerPresentation.isLayerItemVisible,
      selectionGeometryRevision:ports.renderScene.selectionGeometryRevision,
      mapPalette:ports.preferences.mapPalette,
      resolvedInteractionStyle:()=>ports.preferences.resolvedInteractionStyle,
      replaceGpuSceneDomain:ports.gpuSceneServices.replaceGpuSceneDomain,
      syncGpuRenderScene:ports.gpuSceneServices.syncGpuRenderScene,
    },
    territorialResources:{
      ...common,
      displayEntities:()=>ports.territorialObjectModel.territorialScope.displayEntities(),
      entityRepository:ports.territorialModel.entityRepository,
      isNativeBuiltinSubunit:ports.builtinCountries.isNativeBuiltinSubunit,
      syncBuiltinPalette:ports.builtinCountries.syncBuiltinPalette,
      isLayerItemVisible:ports.layerPresentation.isLayerItemVisible,
      territorialStyleColor:ports.territorialObjectModel.territorialStyleColor,
      territorialEntityColor:ports.colorModel.territorialEntityColor,
      selectionGeometryRevision:ports.renderScene.selectionGeometryRevision,
      gpuSceneOrder:ports.gpuSceneServices.gpuSceneOrder,
      resolvedInteractionStyle:()=>ports.preferences.resolvedInteractionStyle,
      replaceGpuSceneDomain:ports.gpuSceneServices.replaceGpuSceneDomain,
    },
    genericResources:{
      ...common,
      genericFeatureColor:ports.colorModel.genericFeatureColor,
      isLayerItemVisible:ports.layerPresentation.isLayerItemVisible,
      selectionSnapshot:()=>session.selectionDomain.snapshot().selection,
      selectionGeometryRevision:ports.renderScene.selectionGeometryRevision,
      gpuSceneOrder:ports.gpuSceneServices.gpuSceneOrder,
      resolvedInteractionStyle:()=>ports.preferences.resolvedInteractionStyle,
      replaceGpuSceneDomain:ports.gpuSceneServices.replaceGpuSceneDomain,
    },
    distributionResources:{
      ...common,
      distributionEntriesForLayer:ports.distributionServices.distributionEntriesForLayer,
      territorialEntityRepository:ports.territorialModel.entityRepository,
      featureFromGeometry:ports.renderScene.featureFromGeometry,
      geometryBounds:ports.spatialQuery.geometryBounds,
      distributionColor:ports.distributionPresentation.distributionColor,
      DISTRIBUTION_MODES,DISTRIBUTION_RENDER_MODES,
      isLayerItemVisible:ports.layerPresentation.isLayerItemVisible,
      selectionGeometryRevision:ports.renderScene.selectionGeometryRevision,
      gpuSceneOrder:ports.gpuSceneServices.gpuSceneOrder,
      replaceGpuSceneDomain:ports.gpuSceneServices.replaceGpuSceneDomain,
      getCountryGeometryRevision:()=>ports.countries.countryLandRevision,
      getDistributionVisibilityRevision:()=>ports.mapDisplayModel.distributionVisibilityRevision,
    },
    territorialBoundaryResources:{
      getState:()=>ports.projectState.state,
      getCountryLandRevision:()=>ports.countries.countryLandRevision,
      getTerritorialGeometryRevision:()=>ports.spatialQuery.mapObjectGeometryRevisions.territorial,
      geometryToken:admittedGeometryKey,
      territorialEntityColor:ports.colorModel.territorialEntityColor,
      layerStyle,
      mapPalette:ports.preferences.mapPalette,
      replaceGpuSceneDomain:ports.gpuSceneServices.replaceGpuSceneDomain,
      gpuSceneOrder:ports.gpuSceneServices.gpuSceneOrder,
    },
    baseResources:{
      getState:()=>ports.projectState.state,
      graticule:ports.projectionView.graticule,
      replaceGpuSceneDomain:ports.gpuSceneServices.replaceGpuSceneDomain,
      isLightTheme:()=>true,
    },
  };
}
