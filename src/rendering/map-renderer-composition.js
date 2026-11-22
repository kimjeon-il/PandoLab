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
    normalizeObjectRef,
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
    mapPalette:ports.preferences.mapPalette,
    syncMapScene:ports.mapSceneServices.syncMapScene,
    territorialResources:{
      ...common,
      displayEntities:()=>ports.territorialObjectModel.territorialScope.displayEntities(),
      entityRepository:ports.territorialModel.entityRepository,
      syncBuiltinPalette:ports.builtinCountries.syncBuiltinPalette,
      isLayerItemVisible:ports.layerPresentation.isLayerItemVisible,
      selectionGeometryRevision:ports.renderScene.selectionGeometryRevision,
      sceneOrder:ports.mapSceneServices.sceneOrder,
      replaceSceneDomain:ports.mapSceneServices.replaceSceneDomain,
    },
    genericResources:{
      ...common,
      genericFeatureColor:ports.colorModel.genericFeatureColor,
      isLayerItemVisible:ports.layerPresentation.isLayerItemVisible,
      selectionGeometryRevision:ports.renderScene.selectionGeometryRevision,
      sceneOrder:ports.mapSceneServices.sceneOrder,
      replaceSceneDomain:ports.mapSceneServices.replaceSceneDomain,
    },
    distributionResources:{
      ...common,
      territorialEntityRepository:ports.territorialModel.entityRepository,
      featureFromGeometry:ports.renderScene.featureFromGeometry,
      geometryBounds:ports.spatialQuery.geometryBounds,
      distributionColor:ports.distributionPresentation.distributionColor,
      DISTRIBUTION_MODES,DISTRIBUTION_RENDER_MODES,
      isLayerItemVisible:ports.layerPresentation.isLayerItemVisible,
      selectionGeometryRevision:ports.renderScene.selectionGeometryRevision,
      sceneOrder:ports.mapSceneServices.sceneOrder,
      replaceSceneDomain:ports.mapSceneServices.replaceSceneDomain,
      getCountryGeometryRevision:()=>ports.countries.countryLandRevision,
      getDistributionVisibilityRevision:()=>ports.mapDisplayModel.distributionVisibilityRevision,
    },
    territorialBoundaryResources:{
      geometryToken:admittedGeometryKey,
      layerStyle,
      replaceSceneDomain:ports.mapSceneServices.replaceSceneDomain,
      sceneOrder:ports.mapSceneServices.sceneOrder,
    },
    baseResources:{
      getState:()=>ports.projectState.state,
      graticule:ports.projectionView.graticule,
      replaceSceneDomain:ports.mapSceneServices.replaceSceneDomain,
      isLightTheme:()=>true,
    },
  };
}
