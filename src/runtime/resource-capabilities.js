/** Product entrypoints determine support; background preferences never grant it. */
export function resourceCapabilities(productMode,platform=null,{projection='globe'}={}) {
  if(productMode!=='viewer')throw new TypeError('Viewer product mode is required.');
  const resources=platform?.resources??null;
  if(platform!==null&&(!resources||typeof resources.builtinHydro!=='boolean'||typeof resources.builtinPlaces!=='boolean'))throw new TypeError('Resource capabilities require explicit platform resource ports.');
  if(projection!=='globe')throw new TypeError('Invalid product projection capability.');
  return Object.freeze({globe:true,graticule:true,globeShadow:true,
    builtinHydro:resources?.builtinHydro??true,
    builtinPlaces:resources?.builtinPlaces??true,
    eagerBuiltinHydro:productMode==='viewer',eagerBuiltinPlaces:productMode==='viewer'});
}
