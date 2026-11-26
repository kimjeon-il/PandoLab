import {DISTRIBUTION_MODES,DISTRIBUTION_RENDER_MODES} from '../document/distribution-model.js';
import {createDistributionRenderRows} from '../ui/map-content-presentation.js';

export function createMapRenderingResources({ports,session}) {
  const getState=()=>ports.projectState.state;
  return {
    labelResources:{
      getState,
      preparePlaces:ports.countryLabelModel.preparePlaces,
      beginPlaceInteraction:()=>{
        ports.countryLabelModel.builtinPlaces.beginInteraction();
        session.objectSearchController.cancelSearch();
      },
      disposePlaces:ports.countryLabelModel.disposePlaces,
    },
    getDistributionRenderRows:createDistributionRenderRows({
      getState,territorialEntityRepository:ports.territorialModel.entityRepository,
      geometryBounds:ports.spatialQuery.geometryBounds,DISTRIBUTION_MODES,DISTRIBUTION_RENDER_MODES,
      isLayerItemVisible:ports.layerPresentation.isLayerItemVisible,
      getCountryGeometryRevision:()=>ports.countries.countryLandRevision,
      getDistributionVisibilityRevision:()=>ports.mapDisplayModel.distributionVisibilityRevision,
    }),
  };
}
