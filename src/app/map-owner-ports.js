// One dependency contract for the common owners; no project state is stored here.
// Each owner declares its capability groups once. '?' marks an optional port.
const MAP_OWNER_PORT_CONTRACTS = Object.freeze({
  projectSession: Object.freeze(['domains', 'applicationConstants', 'modelValidation', 'physicalConfig', 'runtimeConfiguration?', 'mapFactories']),
  renderQuality: Object.freeze(['domains', 'mapFactories', 'preferences', 'projectState', 'rendering']),
  pointerTargets: Object.freeze(['domains', 'feedback', 'mapLayout', 'objectPicking', 'platform', 'projectState', 'rendering']),
  cameraNavigation: Object.freeze(['countries', 'domains', 'feedback', 'mapView', 'objectLookup', 'physicalData', 'projectState', 'rendering']),
  countryIndex: Object.freeze(['countries', 'domains', 'objectDisplay', 'mapView', 'platform', 'projectState', 'spatialQuery']),
  spatialIndex: Object.freeze(['geometryBounds', 'domains', 'mapView', 'projectState', 'rendering', 'spatialFactories', 'surfaces', 'territorialModel']),
  mapProjection: Object.freeze(['mapLayout', 'platform', 'projectState', 'surfaces']),
  objectPresentation: Object.freeze(['colorModel', 'objectDefinitions', 'preferences', 'territorialModel', 'platform']),
  hydroSettings: Object.freeze(['physicalResources', 'hydroPresentation', 'layerPresentation', 'mapLayout', 'platform', 'preferences', 'projectState', 'surfaces']),
  objectCatalog: Object.freeze(['projectSession', 'colorModel', 'countries', 'distributionPresentation', 'domains', 'hydroPresentation', 'labelPresentation', 'layerPresentation', 'objectPresentation', 'projectState', 'territorialModel']),
  territorialLabels: Object.freeze(['domains', 'feedback', 'labelPresentation', 'mapHostView', 'platform', 'preferences', 'projectState', 'renderScene', 'rendering']),
  physicalResources: Object.freeze(['domains', 'feedback', 'hydroPresentation', 'layerPresentation', 'operationFeedback', 'physicalConfig', 'physicalServices', 'projectState', 'rendering']),
  mapHost: Object.freeze(['domains', 'mapLayout', 'mapView', 'platform', 'projectState', 'projectionView', 'renderFactories', 'rendering', 'workspaceUi']),
  objectPicking: Object.freeze(['countries', 'domains', 'feedback', 'landRelations', 'layerPresentation', 'mapLayout', 'mapView', 'objectOperations', 'platform', 'projectState', 'renderScene', 'rendering', 'selectionServices', 'surfaces', 'territorialModel']),
});

export function connectMapOwner(name, owner, commonPorts) {
  const contract = MAP_OWNER_PORT_CONTRACTS[name];
  if (!contract || typeof owner?.connect !== 'function')throw new TypeError('Unknown map owner: ' + name);
  const ports = {};
  for (const entry of contract) {
    const optional = entry.endsWith('?');
    const group = optional ? entry.slice(0, -1) : entry;
    const value = Object.hasOwn(commonPorts, group) ? commonPorts[group] : null;
    if (value == null) {
      if (!optional)throw new TypeError(name + ' requires ' + entry);
      continue;
    }
    ports[group] = value;
  }
  owner.connect(Object.freeze(ports));
  return owner;
}

// One explicit source mapping for shared map owners; getters stay live.
const MAP_READ_PORT_SPECS = Object.freeze({
  builtinCountries:Object.freeze([["syncBuiltinPalette","territorialSceneRuntime"]]),
  colorModel:Object.freeze([["genericFeatureColor","objectPresentation"], ["territorialEntityColor","objectPresentation"]]),
  countries:Object.freeze([["builtinTerritorialScene","territorialSceneRuntime"], ["territorialLabelFeatureById","territorialSceneRuntime"], ["countryLandRevision","countryIndex"], ["scheduleCountryLabelAnchors","countryIndex"], ["validLabelAnchor","countryIndex"]]),
  countryLabelModel:Object.freeze([["builtinPlaces","territorialLabels"], ["builtinPlaceSelectionReferences","territorialLabels"], ["preparePlaces","territorialLabels"], ["disposePlaces","territorialLabels"], ["labelById","territorialLabels"], ["placeLabelCandidates","territorialLabels"]]),
  distributionPresentation:Object.freeze([["distributionColor","objectPresentation"]]),
  hydroModel:Object.freeze([["hydroFeatureById","hydroSettings"]]),
  hydroPresentation:Object.freeze([["allBuiltInHydroFeatures","hydroSettings"], ["hydroCategoryKey","objectPresentation"], ["hydroCategoryLabel","objectPresentation"], ["hydroDisplayColor","hydroSettings"], ["projectHydroById","hydroSettings"], ["hydroDisplayName","objectPresentation"], ["hydroFallbackName","objectPresentation"], ["hydroLayerVisible","hydroSettings"], ["hydroLineParts","hydroSettings"]]),
  labelPresentation:Object.freeze([["labelById","territorialLabels"], ["builtinPlaces","territorialLabels"], ["countryLabelAnchors","countryIndex"], ["pendingCountryLabelAnchors","countryIndex"]]),
  layerPresentation:Object.freeze([["isCountryVisibleById","objectCatalog"], ["isLayerItemVisible","objectCatalog"], ["LAYER_GROUP_KEYS","objectPresentation"], ["layerGroupNames","objectPresentation"], ["invalidateObjectPresentation","objectCatalog"]]),
  layerResources:Object.freeze([["loadHydroData","physicalResources"], ["preparePlaces","territorialLabels"]]),
  mapHostView:Object.freeze([["projectionViewSnapshot","mapHost"]]),
  mapLayout:Object.freeze([["mapLayoutMetricsSnapshot","mapProjection"], ["projectVisibleCoordinate","mapProjection"], ["viewRevision","mapHost"]]),
  mapView:Object.freeze([["activeProjection","mapProjection"], ["isCoordVisible","mapProjection"], ["projectionLayoutMetrics","mapProjection"], ["ringRepresentativePoint","mapProjection"], ["screenToGeo","mapProjection"], ["syncMapHostFromState","mapHost"], ]),
  navigation:Object.freeze([["focusCoordinate","cameraNavigation"], ["fitMapToFeature","cameraNavigation"]]),
  objectPicking:Object.freeze([["selectableObjectsAt","objectPicking"], ["closeObjectChooser","objectPicking"], ["handleObjectSelectionAt","objectPicking"]]),
  pointerInteraction:Object.freeze([["cancelCountryHoverPick","pointerTargets"], ["mapClickBlocked","pointerTargets"], ["queueCountryHoverPick","pointerTargets"]]),
  objectDisplay:Object.freeze([["invalidateObjectPresentation","objectCatalog"]]),
  territorialObjectModel:Object.freeze([["territorialScope","objectPresentation"], ["territorialStyleColor","objectPresentation"]]),
  objectPresentation:Object.freeze([["genericFeatureName","objectPresentation"], ["genericFeatureRoleLabel","objectPresentation"], ["territorialEntitySearchText","objectPresentation"], ["territorialEntityName","objectPresentation"]]),
  physicalData:Object.freeze([["loadHydroData","physicalResources"]]),
  physicalResources:Object.freeze([["isHydroObjectActive","physicalResources"], ["admitHydroFeatures","physicalResources"], ["builtinHydroSelectionReferences","physicalResources"]]),
  physicalServices:Object.freeze([["isHydroFeatureVisible","hydroSettings"]]),
  projectState:Object.freeze([["mapWorkScheduler","projectSession"], ["state","projectSession"]]),
  projectionView:Object.freeze([["currentMapSafeInsets","mapProjection"], ["mapLayoutMetricsRefreshCount","mapProjection"], ["refreshMapLayoutMetrics","mapProjection"]]),
  renderQuality:Object.freeze([["applyAdaptiveRenderQuality","renderQuality"], ["queueAdaptiveRenderQualityRefresh","renderQuality"], ["renderQualityController","renderQuality"]]),
  renderScene:Object.freeze([["currentRenderQuality","renderQuality"]]),
  spatialQuery:Object.freeze([["geometryBounds","spatialIndex"], ["mapObjectGeometryRevisions","spatialIndex"], ["rebuildSpatialIndex","spatialIndex"], ["viewportCullingMetrics","spatialIndex"], ["visibleMapObjectCandidates","spatialIndex"]]),
  surfaces:Object.freeze([["isMobile","workspaceSurfaces"], ["layoutMode","workspaceSurfaces"], ["uid","workspaceSurfaces"]]),
  workspaceUi:Object.freeze([["refreshMapSheetMetrics","workspaceSurfaces"]]),
});

export function createMapReadPorts(owners) {
  return Object.freeze(Object.fromEntries(Object.entries(MAP_READ_PORT_SPECS).map(([name, entries]) => {
    const descriptors = Object.fromEntries(entries.map(([alias, provider, field = alias]) => [
      alias, {enumerable:true, get:() => owners[provider][field]},
    ]));
    return [name, Object.freeze(Object.defineProperties({}, descriptors))];
  })));
}

export function mergeMapPorts(common, additions) {
  const descriptorsByPort = new Map();
  for (const registry of [common, additions]) {
    for (const portName of Object.keys(registry)) {
      const descriptors = descriptorsByPort.get(portName) || {};
      Object.assign(descriptors, Object.getOwnPropertyDescriptors(registry[portName]));
      descriptorsByPort.set(portName, descriptors);
    }
  }
  return Object.freeze(Object.fromEntries([...descriptorsByPort].map(([portName, descriptors]) => [
    portName,
    Object.freeze(Object.defineProperties({}, descriptors)),
  ])));
}
