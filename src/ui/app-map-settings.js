import { distributionValueRange } from "../document/distribution-model.js";

/** The single viewing-presentation adapter for settings.
 * DOM/keyboard behavior belongs exclusively to preferences-dialog.
 */
export function createMapSettings({ capabilities, viewPresentation } = {}) {
  if (!capabilities || ['builtinHydro', 'builtinPlaces'].some(key => typeof capabilities[key] !== 'boolean'))
    throw new TypeError('Map settings require resource capabilities.');
  if (typeof viewPresentation?.applyPresentation !== 'function')
    throw new TypeError('Map settings require viewing presentation.');
  let ports;
  const state = () => ports.projectState.state;

  function connect(dependencies) {
    if (ports) throw new Error('map-settings already connected');
    if (typeof dependencies?.feedback?.reportOperationError !== 'function')
      throw new TypeError('Map settings require an error reporter.');
    for (const method of ['loadHydroData', 'preparePlaces'])
      if (typeof dependencies.layerResources?.[method] !== 'function')
        throw new TypeError('Map settings require layerResources.' + method);
    ports = dependencies;
  }

  async function setLayerVisibility(key, visible) {
    if (state().layerVisibility?.[key] === visible) return false;
    const result = await viewPresentation.applyPresentation({ action: 'visibility', key, visible });
    if (!result) throw new Error('Layer visibility command rejected: ' + key);
    ports.objectDisplay.invalidateObjectPresentation();
    ports.domains.objectSearchController?.render();
    if (key === 'distributions') ports.distributionPresentation.bumpVisibilityRevision();
    if (key === 'objects') ports.rendering.gpuMapRenderer.invalidateCountryPalette({base:true,emphasis:true},'country-layer-visibility');
    if (key === 'rivers' || key === 'lakes') ports.rendering.gpuMapRenderer.invalidateHydroVisibility();
    if (key === 'labels' || key === 'objectNames' || key === 'objectFlags')
      ports.domains.renderingDomain.invalidateLabels('label-visibility');
    else {
      ports.domains.renderingDomain.invalidateBaseScene('layer-visibility');
      if (key === 'objects') ports.domains.renderingDomain.invalidateLabels('layer-visibility');
    }
    if (visible && (key === 'rivers' || key === 'lakes')) await ports.layerResources.loadHydroData(true);
    if (visible && key === 'labels') await ports.layerResources.preparePlaces({force:true});
    return true;
  }

  async function updateLayerPresentationStyle(group, patch) {
    const current = ports.layerStyleServices.layerStyle(state().layerPresentation, group);
    if (Object.entries(patch).every(([key,value]) => current[key] === value)) return false;
    const result = await viewPresentation.applyPresentation({ action: 'groupStyle', group, patch });
    if (!result) throw new Error('Layer style command rejected: ' + group);
    if (group === 'objects')
      ports.rendering.gpuMapRenderer.invalidateCountryPalette({base:true,emphasis:true},'country-presentation');
    if (group === 'rivers' || group === 'lakes')
      ports.rendering.gpuMapRenderer.invalidatePhysicalStyle('hydro-presentation');
    ports.domains.renderingDomain.invalidateOverlayStyle('layer-presentation-style');
    return true;
  }

  async function setNativeNameOverlay(enabled) {
    const current = ports.preferences.userPreferences;
    if (current.labels.place.showNativeNames === enabled) return false;
    const next = ports.preferences.saveUserPreferences({...current,labels:{
      ...current.labels,place:{...current.labels.place,showNativeNames:enabled},
    }});
    ports.preferences.setUserPreferences(next);
    ports.domains.renderingDomain.invalidateLabels('native-name-visibility');
    return true;
  }
  async function setBackgroundSetting(key, visible) {
    if (key !== 'graticule') throw new TypeError('Unsupported background setting: ' + key);
    if (state().backgroundSettings?.[key] === visible) return false;
    state().backgroundSettings[key] = visible;
    const current = ports.preferences.userPreferences;
    const next = ports.preferences.saveUserPreferences({...current,backgrounds:{
      ...current.backgrounds,viewer:{...current.backgrounds.viewer,[key]:visible},
    }});
    ports.preferences.setUserPreferences(next);
    ports.domains.renderingDomain.invalidateBaseScene('background-preference');
    return true;
  }
  async function setDistributionControl(action,value) {
    const current = state().distributionSettings;
    const property = {distributionRenderMode:'renderMode',distributionActiveLayer:'activeLayerId',
      distributionBoundaryVisible:'boundaryVisible'}[action];
    if (!property) throw new TypeError('Unknown distribution setting: ' + action);
    if (current[property] === value) return false;
    const result = await viewPresentation.applyPresentation({action,value});
    if (!result) throw new Error('Distribution setting command rejected: ' + action);
    if (action === 'distributionActiveLayer') ports.distributionPresentation.bumpVisibilityRevision();
    ports.domains.renderingDomain.invalidateOverlayStyle('distribution-setting');
    return true;
  }

  return Object.freeze({connect,dispose(){ports=null;},setLayerVisibility,
    updateLayerPresentationStyle,setNativeNameOverlay,setBackgroundSetting,setDistributionControl,
    distributionValueRange});
}
