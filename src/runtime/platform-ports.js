// Only the browser Viewer is a product. Native GIS tools use their own ports.
export const PLATFORM_PORTS_SCHEMA = 'pandolab-platform-ports-v1';

const resourceKeys = new Set(['builtinHydro', 'builtinPlaces']);
const worldKeys = new Set(['builtinLoader']);

function requireRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}
function rejectUnknown(record, allowed, label) {
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new TypeError(`${label} contains unsupported field ${key}.`);
}
function validateBuiltinLoader(loader) {
  if (loader == null) return null;
  requireRecord(loader, 'Platform builtin world loader');
  if (typeof loader.loadProject !== 'function') throw new TypeError('Platform builtin world loader requires loadProject.');
  return loader;
}

export function createPlatformPorts(spec = {}) {
  requireRecord(spec, 'Platform ports specification');
  rejectUnknown(spec, new Set(['kind', 'resources', 'world']), 'Platform ports specification');
  if (spec.kind !== 'browser') throw new TypeError('Viewer platform requires kind browser.');
  const resources = requireRecord(spec.resources ?? {}, 'Platform resource ports');
  const world = requireRecord(spec.world ?? {}, 'Platform world ports');
  rejectUnknown(resources, resourceKeys, 'Platform resource ports');
  rejectUnknown(world, worldKeys, 'Platform world ports');

  const platform = Object.freeze({
    schema: PLATFORM_PORTS_SCHEMA,
    kind: 'browser',
    resources: Object.freeze({
      builtinHydro: resources.builtinHydro ?? true,
      builtinPlaces: resources.builtinPlaces ?? true,
    }),
    world: Object.freeze({ builtinLoader: world.builtinLoader ?? null }),
  });
  return assertPlatformPorts(platform, { productMode: 'viewer' });
}

export function assertPlatformPorts(platform, { productMode } = {}) {
  requireRecord(platform, 'Runtime platform ports');
  rejectUnknown(platform, new Set(['schema', 'kind', 'resources', 'world']), 'Runtime platform ports');
  if (platform.schema !== PLATFORM_PORTS_SCHEMA) throw new TypeError('Runtime platform ports use an unsupported schema.');
  if (platform.kind !== 'browser') throw new TypeError('Viewer platform requires kind browser.');
  if (productMode !== 'viewer') throw new TypeError('Platform validation requires viewer product mode.');
  requireRecord(platform.resources, 'Runtime platform resources');
  requireRecord(platform.world, 'Runtime platform world');
  rejectUnknown(platform.resources, resourceKeys, 'Runtime platform resources');
  rejectUnknown(platform.world, worldKeys, 'Runtime platform world');
  if (typeof platform.resources.builtinHydro !== 'boolean' || typeof platform.resources.builtinPlaces !== 'boolean')
    throw new TypeError('Runtime platform resource ports are invalid.');
  validateBuiltinLoader(platform.world.builtinLoader);
  return platform;
}
