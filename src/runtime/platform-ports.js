export const PLATFORM_PORTS_SCHEMA = 'pandolab-platform-ports-v1';

const PLATFORM_KINDS = new Set(['browser', 'native']);
const STARTUP_MESHES = new Set(['builtin', 'project']);

function requireRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}
function rejectUnknown(record, allowed, label) {
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new TypeError(`${label} contains unsupported field ${key}.`);
}
function optionalFunction(value, label) {
  if (value !== null && value !== undefined && typeof value !== 'function') throw new TypeError(`${label} must be a function or null.`);
  return value ?? null;
}
function validateBuiltinLoader(loader) {
  if (loader == null) return null;
  requireRecord(loader, 'Platform builtin world loader');
  if (typeof loader.loadProject !== 'function') throw new TypeError('Platform builtin world loader requires loadProject.');
  return loader;
}

export function createPlatformPorts(spec = {}) {
  requireRecord(spec, 'Platform ports specification');
  rejectUnknown(spec, new Set(['kind', 'resources', 'storage', 'library', 'world']), 'Platform ports specification');
  if (!PLATFORM_KINDS.has(spec.kind)) throw new TypeError('Platform ports require kind browser or native.');

  const resources = requireRecord(spec.resources ?? {}, 'Platform resource ports');
  const storage = requireRecord(spec.storage ?? {}, 'Platform storage ports');
  const library = requireRecord(spec.library ?? {}, 'Platform library ports');
  const world = requireRecord(spec.world ?? {}, 'Platform world ports');
  rejectUnknown(resources, new Set(['builtinHydro', 'builtinPlaces', 'startupMesh']), 'Platform resource ports');
  rejectUnknown(storage, new Set(['namespace']), 'Platform storage ports');
  rejectUnknown(library, new Set(['getRepository', 'geometryContext']), 'Platform library ports');
  rejectUnknown(world, new Set(['builtinLoader']), 'Platform world ports');

  const builtinHydro = resources.builtinHydro ?? true;
  const builtinPlaces = resources.builtinPlaces ?? true;
  const startupMesh = resources.startupMesh ?? 'builtin';
  if (typeof builtinHydro !== 'boolean' || typeof builtinPlaces !== 'boolean') throw new TypeError('Platform builtin resource flags must be boolean.');
  if (!STARTUP_MESHES.has(startupMesh)) throw new TypeError('Platform startup mesh must be builtin or project.');
  const namespace = storage.namespace ?? null;
  if (namespace !== null && (typeof namespace !== 'string' || !namespace.trim())) throw new TypeError('Platform storage namespace must be a non-empty string or null.');

  return Object.freeze({
    schema: PLATFORM_PORTS_SCHEMA,
    kind: spec.kind,
    resources: Object.freeze({ builtinHydro, builtinPlaces, startupMesh }),
    storage: Object.freeze({ namespace }),
    library: Object.freeze({
      getRepository: optionalFunction(library.getRepository, 'Platform library repository provider'),
      geometryContext: library.geometryContext ?? null,
    }),
    world: Object.freeze({ builtinLoader: world.builtinLoader ?? null }),
  });
}

export function assertPlatformPorts(platform, { productMode } = {}) {
  requireRecord(platform, 'Runtime platform ports');
  rejectUnknown(platform, new Set(['schema', 'kind', 'resources', 'storage', 'library', 'world']), 'Runtime platform ports');
  if (platform.schema !== PLATFORM_PORTS_SCHEMA) throw new TypeError('Runtime platform ports use an unsupported schema.');
  if (!PLATFORM_KINDS.has(platform.kind)) throw new TypeError('Runtime platform kind is invalid.');
  if (productMode !== 'viewer') throw new TypeError('Platform validation requires viewer product mode.');
  requireRecord(platform.resources, 'Runtime platform resources');
  requireRecord(platform.storage, 'Runtime platform storage');
  requireRecord(platform.library, 'Runtime platform library');
  requireRecord(platform.world, 'Runtime platform world');
  if (typeof platform.resources.builtinHydro !== 'boolean' || typeof platform.resources.builtinPlaces !== 'boolean'
      || !STARTUP_MESHES.has(platform.resources.startupMesh)) throw new TypeError('Runtime platform resource ports are invalid.');
  if (platform.storage.namespace !== null && (typeof platform.storage.namespace !== 'string' || !platform.storage.namespace.trim())) throw new TypeError('Runtime platform storage namespace is invalid.');
  optionalFunction(platform.library.getRepository, 'Runtime platform library repository provider');
  if (platform.library.geometryContext != null) throw new TypeError('Viewer platform cannot install a library geometry context.');
  validateBuiltinLoader(platform.world.builtinLoader);
  return platform;
}
