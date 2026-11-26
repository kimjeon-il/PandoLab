/** Immutable execution configuration; project and resource state remain elsewhere. */
export function validateBuildMetadata(meta) {
  for (const key of ['appVersion','buildId','assetRevision','dataRevision']) {
    if (typeof meta?.[key]!=='string'||!meta[key].trim())throw new TypeError('Build metadata requires '+key);
  }
  return Object.freeze(meta);
}

export function versionedAssetUrl(relative, assetBaseUrl, assetRevision) {
  if (typeof assetRevision!=='string'||!assetRevision)throw new TypeError('Asset revision is required.');
  const url = new URL(relative, assetBaseUrl); url.searchParams.set('v', assetRevision); return url;
}

export function createRuntimeContext({meta, assetBaseUrl} = {}) {
  const receipt = validateBuildMetadata(meta);
  const base = new URL(assetBaseUrl).href;
  return Object.freeze({meta:receipt, assetBaseUrl:base,
    assetUrl:relative => versionedAssetUrl(relative, base, meta.assetRevision)});
}
