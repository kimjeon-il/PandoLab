export const hydroStyleLookup=`
  uniform sampler2D hydroRoles;
  uniform vec2 hydroSize;
  uniform vec3 hydroStyles[5];
  uniform vec3 hydroTint;
  uniform bool hasHydroHighlight;
  vec3 hydroStyle(float slot){
    if (!hasHydroHighlight) return vec3(0.0);
    vec2 pixel = vec2(mod(slot, hydroSize.x), floor(slot / hydroSize.x));
    float code = texture2D(hydroRoles, (pixel + 0.5) / hydroSize).r;
    return hydroStyles[int(code * 255.0 + 0.5)];
  }
`;

const vertexShader = `
  #ifdef DIRECT_ENDPOINTS
    attribute vec3 start,startLow,end,endLow;
  #else
    attribute uvec2 endpointIndices;
    uniform sampler2D pointCoordinates;
    uniform int pointTextureMask,pointTextureShift;
    vec4 pointTexel(uint texel){
      return texelFetch(pointCoordinates,ivec2(int(texel & uint(pointTextureMask)),int(texel >> uint(pointTextureShift))),0);
    }
    // Exact six-word packing, two fetches per point. Power-of-two rows
    // replace division/modulo with shifts/masks, and avoid parity branches.
    void readEndpoint(uint index,out vec3 high,out vec3 low){
      uint first=(index*3u)>>1u;
      vec4 a=pointTexel(first),b=pointTexel(first+1u);
      bool even=(index&1u)==0u;
      high=even?a.xyz:vec3(a.zw,b.x);
      low=even?vec3(a.w,b.xy):b.yzw;
    }
  #endif
  uniform vec3 eyeHigh, eyeLow;
  uniform mat3 viewRotation;
  uniform vec2 viewport;
  uniform float radius, margin, zoom, minZoom;
  #ifdef WIDTH_PROFILE
    attribute float sourceWidth;
  #endif
  #ifdef OUTLINE_OWNERS
    attribute float ownerGroup;
    uniform vec2 outlineStyles[5];
    varying float strokeAlpha;
  #endif
  #ifdef RIVER_PALETTE
    attribute float ownerGroup;
    uniform vec3 strokeColor;
    varying vec3 riverPaint;
    ${hydroStyleLookup}
  #endif
  varying vec2 strokePoint;
  varying float strokeLength;
  varying float strokeRadius;
  void main() {
    strokePoint = vec2(0.0);
    strokeLength = 0.0;
    strokeRadius = radius;
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    if (zoom < minZoom) return;
    #ifdef WIDTH_PROFILE
      strokeRadius *= mix(sourceWidth, max(1.5, sourceWidth), clamp(4.0 - zoom, 0.0, 1.0));
    #endif
    #ifdef OUTLINE_OWNERS
      vec2 style = outlineStyles[int(ownerGroup + 0.5)];
      strokeRadius = style.x;
      strokeAlpha = style.y;
      if (strokeRadius <= 0.0 || strokeAlpha <= 0.0) return;
    #endif
    #ifdef RIVER_PALETTE
      vec3 hydro = hydroStyle(ownerGroup);
      strokeRadius = max(strokeRadius, hydro.x * 0.5 * step(0.001, hydro.y));
      riverPaint = mix(strokeColor, hydroTint, hydro.y);
    #endif
    #ifndef DIRECT_ENDPOINTS
      vec3 start,startLow,end,endLow;
      readEndpoint(endpointIndices.x,start,startLow);
      readEndpoint(endpointIndices.y,end,endLow);
    #endif
    vec3 a = (start - eyeHigh) + (startLow - eyeLow);
    vec3 b = (end - eyeHigh) + (endLow - eyeLow);
    float facingA = dot(start, a), facingB = dot(end, b);
    if (facingA >= 0.0 && facingB >= 0.0) return;
    if (facingA >= 0.0) a = mix(a, b, facingA / (facingA - facingB));
    if (facingB >= 0.0) b = mix(b, a, facingB / (facingB - facingA));
    vec4 p = projectionMatrix * vec4(viewRotation * a, 1.0);
    vec4 q = projectionMatrix * vec4(viewRotation * b, 1.0);
    if (p.w <= 0.0 || q.w <= 0.0) return;
    vec2 origin = p.xy / p.w * viewport * 0.5;
    vec2 delta = q.xy / q.w * viewport * 0.5 - origin;
    strokeLength = length(delta);
    if (strokeLength < 0.0001) return;
    vec2 axis = delta / strokeLength;
    float extent = strokeRadius + margin;
    strokePoint = vec2(mix(-extent, strokeLength + extent, position.x), position.y * extent);
    vec2 pixel = origin + axis * strokePoint.x + vec2(-axis.y, axis.x) * strokePoint.y;
    gl_Position = vec4(pixel * 2.0 / viewport, 0.0, 1.0);
  }
`;

const fragmentShader = `
  uniform vec3 strokeColor;
  uniform float strokeOpacity;
  uniform float margin;
  varying vec2 strokePoint;
  varying float strokeLength;
  varying float strokeRadius;
  #ifdef OUTLINE_OWNERS
    varying float strokeAlpha;
  #endif
  #ifdef RIVER_PALETTE
    varying vec3 riverPaint;
  #endif
  void main() {
    float past = max(0.0, max(-strokePoint.x, strokePoint.x - strokeLength));
    float distance = length(vec2(past, strokePoint.y));
    float coverage = 1.0 - smoothstep(max(0.0, strokeRadius - margin), strokeRadius + margin, distance);
    #ifdef OUTLINE_OWNERS
      coverage *= strokeAlpha;
    #endif
    if (coverage <= 0.0) discard;
    #ifdef RIVER_PALETTE
      gl_FragColor = vec4(riverPaint, coverage);
    #else
      gl_FragColor = vec4(strokeColor, coverage * strokeOpacity);
    #endif
    #include <colorspace_fragment>
  }
`;

/** Keep the exact six-word CPU layout; only texture-row padding is added. */
export function createGlobeStrokePointTexture(THREE,points,maxTextureSize){
  const texels=Math.max(1,Math.ceil(points.length/4));
  const shift=Math.min(Math.floor(Math.log2(maxTextureSize)),Math.ceil(Math.log2(Math.max(1,Math.sqrt(texels)))));
  const width=2**shift,height=Math.ceil(texels/width);
  if(height>maxTextureSize)throw Error('Globe stroke point texture capacity exceeded');
  const data=points.length===width*height*4?points:new Float32Array(width*height*4);
  if(data!==points)data.set(points);
  const texture=new THREE.DataTexture(data,width,height,THREE.RGBAFormat,THREE.FloatType);
  texture.minFilter=texture.magFilter=THREE.NearestFilter;
  texture.generateMipmaps=false;texture.needsUpdate=true;
  return {texture,bytes:data.byteLength,uniforms:{pointCoordinates:{value:texture},pointTextureWidth:{value:width},pointTextureMask:{value:width-1},pointTextureShift:{value:shift}}};
}

export function createThreeGlobeStrokes(THREE, { packet, style, cameraUniforms, viewport, margin, multisampling, order, minZoom = -2, outlineUniforms, hydroUniforms, pointUniforms, sharedMaterial }) {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(Float32Array.of(0, -1, 0, 1, -1, 0, 0, 1, 0, 1, 1, 0), 3));
  geometry.setIndex([0, 1, 2, 2, 1, 3]);
  const direct=Boolean(packet.start);
  if(direct){
    for(const name of ['start','startLow','end','endLow'])geometry.setAttribute(name,new THREE.InstancedBufferAttribute(packet[name],3));
  }else{
    const endpoints=new THREE.InstancedBufferAttribute(packet.endpointIndices,2);
    endpoints.gpuType=THREE.IntType;
    geometry.setAttribute('endpointIndices',endpoints);
  }
  if (packet.widths.length) geometry.setAttribute('sourceWidth', new THREE.InstancedBufferAttribute(packet.widths, 1));
  if (outlineUniforms||hydroUniforms) geometry.setAttribute('ownerGroup', new THREE.InstancedBufferAttribute(packet.ownerGroups, 1));
  geometry.instanceCount = packet.count;
  const material = sharedMaterial??new THREE.ShaderMaterial({ vertexShader, fragmentShader,
    depthTest: false, depthWrite: false, alphaToCoverage: multisampling, transparent: !multisampling,
    defines: { ...(direct?{DIRECT_ENDPOINTS:1}:{}),...(packet.widths.length?{WIDTH_PROFILE:1}:{}),...(outlineUniforms?{OUTLINE_OWNERS:1}:{}),
      ...(hydroUniforms?{RIVER_PALETTE:1}:{}) },
    uniforms: { ...cameraUniforms, viewport, margin, minZoom: { value: minZoom },
      radius: { value: style.width / 2 }, strokeColor: { value: new THREE.Color(style.color) },
      strokeOpacity:{value:style.opacity??1},...pointUniforms,...outlineUniforms,...hydroUniforms } });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = order;
  return mesh;
}
