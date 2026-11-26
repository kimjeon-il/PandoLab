// One dependency contract for the common owners; no project state is stored here.
// Each owner declares its capability groups once. '?' marks an optional port.
const MAP_OWNER_PORT_CONTRACTS = Object.freeze({
  projectResourcePorts:Object.freeze(["domains","runtimeConfiguration","territorialObjectModel","layerStyleServices","countries?","layerPresentation","objectDefinitions","platform?","projectState","rendering","territorialModel"]),
  workspaceSurfaces:Object.freeze(["mapHostView","platform","uiControlServices","projectState","surfaceFactories","domains"]),
  projectSession:Object.freeze(["domains","applicationConstants","modelValidation","physicalConfig","runtimeConfiguration?","mapFactories"]),
  renderQuality:Object.freeze(["domains","mapFactories","preferences","projectState","rendering"]),
  pointerTargets:Object.freeze(["domains","feedback","hydroPresentation","landRelations","layerPresentation","mapLayout","mapView","objectPicking","physicalResources","physicalServices","platform","projectState","rendering","surfaces"]),
  cameraNavigation:Object.freeze(["countries","domains","feedback?","mapView","objectLookup","physicalData","platform","projectState","rendering","surfaces"]),
  countryIndex:Object.freeze(["countries","domains","geometryModel?","objectDisplay","mapView","platform","projectState","spatialQuery?"]),
  spatialIndex:Object.freeze(["geometryBounds","domains","mapView","projectState","rendering","spatialFactories","surfaces","territorialModel"]),
  mapProjection:Object.freeze(["mapLayout","platform","projectState","surfaces"]),
  objectPresentation:Object.freeze(["colorModel","countries?","geometryBounds?","domains","objectDefinitions","objectPresentation","platform?","projectState","spatialQuery?","territorialModel","preferences","projectSession?","hydroModel?","labelPresentation?","hydroPresentation?","distributionPresentation?","distributionServices?","selectionServices?","objectLookup?","layerPresentation?"]),
  hydroSettings:Object.freeze(["physicalResources","colorModel?","hydroPresentation","layerPresentation","mapLayout","objectPresentation","physicalConfig","platform","preferences","projectState","surfaces?"]),
  objectCatalog:Object.freeze(["projectSession","colorModel","countries?","distributionPresentation","domains","hydroPresentation","labelPresentation","layerPresentation","objectDefinitions","objectPresentation","platform?","projectState","rendering?","territorialModel","preferences?","hydroModel?","distributionServices?","selectionServices?","objectLookup?"]),
  territorialLabels:Object.freeze(["territorialObjectModel","countries","domains","feedback","labelPresentation","layerPresentation","mapHostView","objectPresentation","platform","preferences","projectState","renderScene","rendering","spatialQuery","territorialModel"]),
  physicalResources:Object.freeze(["geometryBounds","domains","feedback","hydroPresentation","layerPresentation","operationFeedback","physicalConfig","physicalServices","platform","projectState","rendering"]),
  mapHost:Object.freeze(["domains","mapLayout","mapView","platform","projectState","projectionView","renderFactories","rendering","workspaceUi"]),
  objectPicking:Object.freeze(["countries","territorialObjectModel","domains","feedback","hydroPresentation","landRelations","layerPresentation","mapLayout","mapView","objectOperations","physicalServices","platform","projectState","renderScene","rendering","selectionServices","surfaces","territorialModel"]),
});
// The existing object-presentation diagnostics check preferences before state.
const REQUIRED_PORT_ORDER = Object.freeze({
  objectPresentation:Object.freeze(["colorModel","domains","objectDefinitions","objectPresentation","preferences","projectState","territorialModel"]),
});
const portTable = select => Object.freeze(Object.fromEntries(
  Object.entries(MAP_OWNER_PORT_CONTRACTS).map(([owner, entries]) => [owner, Object.freeze(select(entries, owner))])
));
export const MAP_OWNER_PORTS = portTable(entries => entries.map(name => name.replace(/\?$/,'')));
export const MAP_OWNER_REQUIRED_PORTS = portTable((entries, owner) => REQUIRED_PORT_ORDER[owner]??entries.filter(name => !name.endsWith('?')));

export function connectMapOwner(name, owner, ports, ...overrides) {
  const allowed = MAP_OWNER_PORTS[name];
  if (!allowed||typeof owner?.connect!=='function')throw new TypeError('Unknown map owner: '+name);
  // Merge only admitted capability groups; unrelated getters stay untouched.
  if (overrides.length)ports = mergePorts([ports, ...overrides], new Set(allowed));
  for (const port of MAP_OWNER_REQUIRED_PORTS[name]) {
    const descriptor = Object.getOwnPropertyDescriptor(ports, port);
    if (!descriptor||(!descriptor.get&&descriptor.value==null))throw new TypeError(name+' requires '+port);
  }
  if (name==='objectPicking') {
    const scope = Object.getOwnPropertyDescriptor(ports.territorialObjectModel,'territorialScope');
    if (!scope||(!scope.get&&typeof scope.value?.displayFeature!=='function'))throw new TypeError('objectPicking requires the canonical territorialScope');
  }
  const selected = Object.freeze(Object.defineProperties({}, Object.fromEntries(allowed.map(key => [key, {enumerable:true, get:() => ports[key]}]))));
  owner.connect(selected);
  return owner;
}

// One explicit source mapping for shared map owners; getters stay live.
const MAP_READ_PORT_SPECS = Object.freeze({
  builtinCountries:Object.freeze([["syncBuiltinPalette","territorialSceneRuntime"]]),
  colorModel:Object.freeze([["genericFeatureColor","objectPresentation"], ["territorialEntityColor","objectPresentation"]]),
  countries:Object.freeze([["builtinTerritorialScene","territorialSceneRuntime"], ["territorialLabelFeatureById","territorialSceneRuntime"], ["countryLandRevision","countryIndex"], ["scheduleCountryLabelAnchors","countryIndex"], ["validLabelAnchor","countryIndex"]]),
  countryLabelModel:Object.freeze([["builtinPlaces","territorialLabels"], ["builtinPlaceSelectionReferences","territorialLabels"], ["preparePlaces","territorialLabels"], ["disposePlaces","territorialLabels"], ["labelById","territorialLabels"], ["placeLabelCandidates","territorialLabels"]]),
  distributionPresentation:Object.freeze([["distributionColor","objectPresentation"]]),
  hydroPresentation:Object.freeze([["allBuiltInHydroFeatures","hydroSettings"], ["hydroCategoryKey","objectPresentation"], ["hydroCategoryLabel","objectPresentation"], ["hydroDisplayColor","hydroSettings"], ["projectHydroById","hydroSettings"], ["hydroDisplayName","objectPresentation"], ["hydroFallbackName","objectPresentation"], ["hydroLayerVisible","hydroSettings"], ["hydroLineParts","hydroSettings"]]),
  labelPresentation:Object.freeze([["labelById","territorialLabels"], ["builtinPlaces","territorialLabels"], ["countryLabelAnchors","countryIndex"], ["pendingCountryLabelAnchors","countryIndex"]]),
  layerPresentation:Object.freeze([["isCountryVisibleById","objectCatalog"], ["isLayerItemVisible","objectCatalog"], ["LAYER_GROUP_KEYS","objectPresentation"], ["layerGroupNames","objectPresentation"], ["invalidateObjectPresentation","objectCatalog"]]),
  layerResources:Object.freeze([["loadHydroData","physicalResources"], ["preparePlaces","territorialLabels"]]),
  mapLayout:Object.freeze([["mapLayoutMetricsSnapshot","mapProjection"], ["projectVisibleCoordinate","mapProjection"], ["viewRevision","mapHost"]]),
  mapView:Object.freeze([["activeProjection","mapProjection"], ["isCoordVisible","mapProjection"], ["projectionLayoutMetrics","mapProjection"], ["ringRepresentativePoint","mapProjection"], ["screenToGeo","mapProjection"], ["syncMapHostFromState","mapHost"], ]),
  objectDisplay:Object.freeze([["invalidateObjectPresentation","objectCatalog"]]),
  territorialObjectModel:Object.freeze([["territorialScope","objectPresentation"], ["territorialStyleColor","objectPresentation"]]),
  objectPresentation:Object.freeze([["genericFeatureName","objectPresentation"], ["genericFeatureRoleLabel","objectPresentation"], ["territorialEntitySearchText","objectPresentation"], ["territorialEntityName","objectPresentation"]]),
  physicalResources:Object.freeze([["isHydroObjectActive","physicalResources"], ["admitHydroFeatures","physicalResources"], ["builtinHydroSelectionReferences","physicalResources"]]),
  physicalServices:Object.freeze([["isHydroFeatureVisible","hydroSettings"]]),
  projectState:Object.freeze([["mapWorkScheduler","projectSession"], ["state","projectSession"]]),
  projectionView:Object.freeze([["currentMapSafeInsets","mapProjection"], ["mapLayoutMetricsRefreshCount","mapProjection"], ["refreshMapLayoutMetrics","mapProjection"]]),
  renderQuality:Object.freeze([["applyAdaptiveRenderQuality","renderQuality"], ["queueAdaptiveRenderQualityRefresh","renderQuality"], ["renderQualityController","renderQuality"]]),
  renderScene:Object.freeze([["currentRenderQuality","renderQuality"]]),
  spatialQuery:Object.freeze([["geometryBounds","spatialIndex"], ["mapObjectGeometryRevisions","spatialIndex"], ["rebuildSpatialIndex","spatialIndex"], ["viewportCullingMetrics","spatialIndex"], ["visibleMapObjectCandidates","spatialIndex"]]),
  surfaces:Object.freeze([["isMobile","workspaceSurfaces"], ["layoutMode","workspaceSurfaces"], ["uid","workspaceSurfaces"]]),
});

export function createMapReadPorts(owners) {return createReadPorts(owners, MAP_READ_PORT_SPECS);}

export function createReadPorts(providers, specs) {
  return Object.freeze(Object.fromEntries(Object.entries(specs).map(([name, entries]) => {
    const descriptors = Object.fromEntries(entries.map(([alias, provider, field = alias]) => [alias, { enumerable: true, get: () => providers[provider][field] }]));
    return [name, Object.freeze(Object.defineProperties({}, descriptors))];
  })));
}

function mergePorts(registries, allowed = null) {
  const descriptorsByPort = new Map();
  for (const registry of registries) {
    for (const portName of Object.keys(registry)) {
      if (allowed&&!allowed.has(portName))continue;
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

export function mergeCapabilityPorts(...registries) {
  return mergePorts(registries);
}
