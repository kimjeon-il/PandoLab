import { VIEWER_RESOURCE_CAPABILITIES } from '../runtime/resource-capabilities.js';
import { createProjectSourceRuntime } from '../document/project-source-runtime.js';
import { createTerritorialSceneRuntime } from '../rendering/territorial-scene-runtime.js';
import { createWorkspaceSurfaces } from '../ui/workspace-surfaces.js';
import { createProjectSession } from '../document/project-session.js';
import { createRenderQuality } from '../rendering/render-quality.js';
import { createPointerTargets } from '../map/pointer-targets.js';
import { createCameraNavigation } from '../map/camera-navigation.js';
import { createCountryIndex } from '../map/country-index.js';
import { createSpatialIndex } from '../geometry/spatial-index.js';
import { createMapProjection } from '../map/map-projection.js';
import { createObjectPresentation } from '../ui/object-presentation.js';
import { createHydroSettings } from '../ui/physical-settings.js';
import { createObjectCatalog } from '../document/object-catalog.js';
import { createTerritorialLabels } from '../rendering/territorial-labels.js';
import { createPhysicalResources } from '../rendering/physical-map-controller.js';
import { createMapHost } from '../ui/map-workspace-host.js';
import { createObjectPicking } from '../map/object-picking.js';
import { mapProjectResourcePath } from '../data/map-project-manifest.js';

/** One read-only map owner graph for the Web Viewer. */
export function createMapOwners({buildMeta, isObjectVisible, resolveVisibilityGroup, closeActiveOverlay = null, onViewingChange = null}) {
  const capabilities = VIEWER_RESOURCE_CAPABILITIES;
  // One read-port admission, two existing responsibility owners. No combined
  // builtin session, second document model or duplicated mutable cache.
  let projectResourceDependencies = null;
  const projectResourcePorts = Object.freeze({connect(ports) {
    if (projectResourceDependencies)throw new Error('Project resource ports already connected');
    projectResourceDependencies = ports;
  }});
  const getDependencies = () => projectResourceDependencies;
  const projectSourceRuntime = createProjectSourceRuntime({
    buildMeta, getDependencies,
  });
  const territorialSceneRuntime = createTerritorialSceneRuntime({getDependencies});
  const workspaceSurfaces = createWorkspaceSurfaces();
  const projectSession = createProjectSession({resolveVisibilityGroup, onViewingChange});
  const renderQuality = createRenderQuality();
  const pointerTargets = createPointerTargets();
  const cameraNavigation = createCameraNavigation();
  const countryIndex = createCountryIndex();
  const spatialIndex = createSpatialIndex();
  const mapProjection = createMapProjection({capabilities});
  const objectPresentation = createObjectPresentation();
  const hydroSettings = createHydroSettings();
  const objectCatalog = createObjectCatalog({isObjectVisible});
  const territorialLabels = createTerritorialLabels({capabilities,
    placeCatalog:buildMeta?.mapProject?mapProjectResourcePath(buildMeta.mapProject,'places'):null,
    placeLifetimesCatalog:buildMeta?.mapProject?mapProjectResourcePath(buildMeta.mapProject,'placeLifetimes'):null});
  const physicalResources = createPhysicalResources({capabilities, buildMeta});
  const mapHost = createMapHost();
  const objectPicking = createObjectPicking({closeActiveOverlay});
  return Object.freeze({capabilities, projectResourcePorts, projectSourceRuntime, territorialSceneRuntime, workspaceSurfaces, projectSession, renderQuality, pointerTargets, cameraNavigation, countryIndex, spatialIndex, mapProjection, objectPresentation, hydroSettings, objectCatalog, territorialLabels, physicalResources, mapHost, objectPicking});
}
