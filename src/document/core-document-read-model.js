import { createCanonicalGeometryVersionStore as createGeometryVersionStore } from '../geometry/geometry-version-store.js';
import { fields, invalid, freeze } from './core-read-contract.js';
import { loadAcceptedStorage, candidateForDelta, candidateForGeometryAdmission } from './core-document-storage.js';
import { createCoreWorldProjection } from './core-world-projection.js';

/** Publishes immutable storage and world projections from the same accepted Core responses. */
export function createCoreDocumentReadModel(initialProject) {
  const {geometries:initialGeometries, ...initialProperties} = initialProject;
  const initial = structuredClone(initialProperties);
  let geometries = createGeometryVersionStore(initialGeometries);
  let project = freeze({...initial, geometries:geometries.snapshot()});
  let provenance = null;
  const projection = createCoreWorldProjection({readProject:() => project, readGeometries:() => geometries});

  function acceptLoadedProject(value) {
    const next = loadAcceptedStorage(value, geometries);
    project = next.project;
    geometries = next.geometries;
    provenance = null;
    projection.reset();
    return project;
  }
  function list(domain) {
    const field = fields[domain];
    if (!field) invalid(`Unsupported C++ document domain: ${String(domain)}`);
    if (domain==='hydro' && projection.world())return projection.hydroViews();
    return project[field];
  }
  function get(ref) {
    if (!ref || typeof ref.id !== 'string') invalid('An explicit C++ document object reference is required.');
    return projection.getIdentity(list(ref.domain), ref.id);
  }
  function applyGeometryAdmission(delta, verified) {
    const next = candidateForGeometryAdmission(project, geometries, delta, verified);
    if (!next)return;
    const previousProject = project;
    project = next.project;
    geometries = next.geometries;
    projection.rebaseGeometrySource(previousProject);
  }
  function acceptTransition(result,operation,verifiedResources) {
    if(operation==='core.document-temporal-candidate-adopt') {
      const complete=Object.hasOwn(result||{},'project'),delta=result?.delta!=null;
      if(complete===delta)invalid('Core adoption requires exactly one complete project or temporal delta.');
      if(delta&&(!result.worldDelta||result.world))invalid('Core delta adoption requires its authoritative world delta.');
      if(complete)acceptLoadedProject(result.project);
    }
    if (['core.document-load','core.document-load-baseline','core.document-initialize',
      'core.document-replacement-rollback'].includes(operation))
      acceptLoadedProject(result.project);
    if(operation==='core.document-geometry-admit'||operation==='core.document-timeline-cursor'){
      if(!result?.geometryDelta)invalid('Core resource transition requires a geometry receipt.');
      applyGeometryAdmission(result.geometryDelta,verifiedResources);
    }
    if (result?.delta) apply(result.delta,verifiedResources);
    if(operation==='core.document-timeline-cursor'||(operation==='core.document-temporal-candidate-adopt'&&result.delta!=null)) {
      if(!result?.worldDelta)invalid('A temporal transition requires a Core world delta.');
      projection.acceptWorldDelta(result.worldDelta,result.state);
    }
    else if (result?.world) projection.acceptWorld(result.world,result.state.epoch);
    else if (result?.state && projection.world() && result.state.epoch!==projection.world().sourceEpoch) {
      if (result.delta && result.delta.timelineRecords!==null)
        invalid('A changed C++ timeline requires its authoritative resolved world acknowledgement.');
      projection.rebaseWorld(result.state.epoch);
    }
    return project;
  }
  function apply(delta, verifiedResources) {
    const next = candidateForDelta(project, geometries, provenance, delta, verifiedResources);
    project = next.project;
    geometries = next.geometries;
    provenance = next.provenance;
    return project;
  }
  return Object.freeze({
    snapshot:() => project, get, list, geometry:ref => geometries.get(ref), provenance:() => provenance,
    acceptLoadedProject, apply, projectWorld:projection.projectWorld, acceptWorld:projection.acceptWorld,
    acceptTransition, world:projection.world, territorialViews:projection.territorialViews,
  });
}
