import { referenceZoomPixelsPerDegree } from '../map/map-display-zoom.js';

const radians = Math.PI / 180;
export const GLOBE_FIELD_OF_VIEW = 2 * Math.atan(1 / 3) / radians;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (vector, amount) => vector.map(value => value * amount);
const add = (a, b) => a.map((value, index) => value + b[index]);
const subtract = (a, b) => a.map((value, index) => value - b[index]);
const length = vector => Math.hypot(...vector);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const wrap = longitude => longitude >= -180 && longitude < 180 ? longitude : ((longitude + 180) % 360 + 360) % 360 - 180;

export function globeVector([longitude, latitude]) {
  const lon = longitude * radians, lat = latitude * radians;
  const cosLat = Math.cos(lat);
  return [cosLat * Math.cos(lon), cosLat * Math.sin(lon), Math.sin(lat)];
}

function mapCoordinate(vector) {
  return [wrap(Math.atan2(vector[1], vector[0]) / radians),
    Math.atan2(vector[2], Math.hypot(vector[0], vector[1])) / radians];
}

function createFrame(view, viewport) {
  const [lon, lat] = view.center.map(value => value * radians);
  const bearing = view.bearing * radians, pitch = view.pitch * radians, roll = view.roll * radians;
  const radial = globeVector(view.center);
  const east = [-Math.sin(lon), Math.cos(lon), 0];
  const north = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)];
  const horizontal = add(scale(east, Math.cos(bearing)), scale(north, -Math.sin(bearing)));
  const vertical = add(scale(east, Math.sin(bearing)), scale(north, Math.cos(bearing)));
  const tilt = add(scale(radial, Math.cos(pitch)), scale(vertical, -Math.sin(pitch)));
  const tiltedUp = add(scale(vertical, Math.cos(pitch)), scale(radial, Math.sin(pitch)));
  const right = add(scale(horizontal, Math.cos(roll)), scale(tiltedUp, -Math.sin(roll)));
  const up = add(scale(horizontal, Math.sin(roll)), scale(tiltedUp, Math.cos(roll)));
  const focal = viewport.height * 1.5;
  const distance = focal * radians / referenceZoomPixelsPerDegree(view.zoom);
  const eye = add(radial, scale(tilt, distance));
  const center = [
    (viewport.width + (viewport.left || 0) - (viewport.right || 0)) / 2,
    (viewport.height + (viewport.top || 0) - (viewport.bottom || 0)) / 2,
  ];
  return { right, up, forward: scale(tilt, -1), eye, focal, distance, center };
}

function projectVector(vector, frame) {
  const ray = subtract(vector, frame.eye);
  const depth = dot(ray, frame.forward);
  if (depth <= 0) return null;
  return [frame.center[0] + frame.focal * dot(ray, frame.right) / depth,
    frame.center[1] - frame.focal * dot(ray, frame.up) / depth];
}

function alignAnchor(view, viewport, anchor, point) {
  // Solve the two screen coordinates against longitude and latitude. An
  // analytic ray supplies the anchor, so camera input never reads a mesh.
  const step = 0.0001;
  let [longitude, latitude] = view.center;
  const project = (lon, lat) => projectVector(anchor, createFrame({ ...view, center: [lon, lat] }, viewport));
  for (let iteration = 0; iteration < 6; iteration++) {
    const start = project(longitude, latitude);
    if (!start || Math.hypot(point[0] - start[0], point[1] - start[1]) < 0.025) break;
    const lon = project(longitude + step, latitude), lat = project(longitude, latitude + step);
    if (!lon || !lat) break;
    const a = lon[0] - start[0], b = lat[0] - start[0];
    const c = lon[1] - start[1], d = lat[1] - start[1], determinant = a * d - b * c;
    if (Math.abs(determinant) < 1e-10) break;
    const x = point[0] - start[0], y = point[1] - start[1];
    longitude += clamp(step * (d * x - b * y) / determinant, -45, 45);
    latitude = clamp(latitude + clamp(step * (a * y - c * x) / determinant, -35, 35), -90, 90);
  }
  return { ...view, center: [longitude, latitude] };
}

export function createGlobeCamera(view, viewport) {
  const { center, zoom, bearing = 0, pitch = 0, roll = 0 } = view;
  if (!Array.isArray(center) || center.length !== 2 || ![...center, zoom, bearing, pitch, roll, viewport.width,
    viewport.height].every(Number.isFinite) || viewport.width <= 0 || viewport.height <= 0) {
    throw new TypeError('The globe camera requires a finite view and CSS viewport.');
  }
  const snapshot = Object.freeze({ projection: 'globe', center: Object.freeze([wrap(center[0]), clamp(center[1], -90, 90)]),
    zoom: clamp(zoom, -2, 22), bearing: wrap(bearing), pitch: clamp(pitch, 0, 60), roll: wrap(roll) });
  const frame = createFrame(snapshot, viewport);
  const inside = ([x, y]) => x >= 0 && y >= 0 && x <= viewport.width && y <= viewport.height;

  function rayDirection(point) {
    const x = (point[0] - frame.center[0]) / frame.focal, y = (frame.center[1] - point[1]) / frame.focal;
    const ray = add(frame.forward, add(scale(frame.right, x), scale(frame.up, y)));
    return scale(ray, 1 / length(ray));
  }

  function worldRay(point) {
    if (!inside(point)) return null;
    const unit = rayDirection(point);
    const b = dot(frame.eye, unit), c = dot(frame.eye, frame.eye) - 1;
    const discriminant = b * b - c;
    if (b >= 0 || discriminant < 0) return null;
    // Near hit to tangent plane is the portion of the sphere drawn by the shader.
    return {origin:frame.eye, direction:unit, start:c/(-b+Math.sqrt(discriminant)),end:-b};
  }

  let bounds = null;
  function geographicBounds() {
    if (bounds)return bounds;
    // Enclose the viewport cone in a circle about the eye-to-globe-center
    // ray. Its rim meets the near surface or the horizon, whichever is closer.
    const distance = length(frame.eye), radial = scale(frame.eye, 1/distance), axis=scale(radial,-1);
    const corners = [[0, 0], [viewport.width, 0], [0, viewport.height], [viewport.width, viewport.height]];
    const cone = Math.acos(clamp(Math.min(...corners.map(point => dot(axis, rayDirection(point)))), -1, 1));
    const radius = Math.min(Math.acos(1/distance),cone>=Math.asin(1/distance)
      ?Math.PI/2:Math.asin(clamp(distance*Math.sin(cone),0,1))-cone)+1e-9;
    const [lon, lat] = mapCoordinate(radial), extent = radius/radians;
    const south = Math.max(-90, lat-extent), north = Math.min(90, lat+extent);
    const longExtent = Math.asin(clamp(Math.sin(radius)/Math.cos(lat*radians),0,1))/radians;
    bounds = Object.freeze(south<=-90||north>=90?[-180, south, 180, north]:[lon-longExtent, south, lon+longExtent, north]);
    return bounds;
  }

  function projectVisibleVector(vector, {allowOutsideViewport = false} = {}) {
    if (dot(vector, frame.eye)<1)return null;
    const point = projectVector(vector, frame);
    return point&&(allowOutsideViewport||inside(point))?point:null;
  }
  function projectVisibleCoordinate(coordinate, options) {
    return projectVisibleVector(globeVector(coordinate), options);
  }

  function projectStroke(start, end) {
    const a = dot(start, subtract(start, frame.eye)), b = dot(end, subtract(end, frame.eye));
    if (a>=0&&b>=0)return null;
    const left = projectVector(a>=0?add(start, scale(subtract(end, start), a/(a-b))):start,frame);
    const right = projectVector(b>=0?add(end, scale(subtract(start, end), b/(b-a))):end,frame);
    return left&&right?[left, right]:null;
  }

  function drag(from, to) {
    const deltaX = to[0] - from[0], deltaY = to[1] - from[1];
    const ratio = referenceZoomPixelsPerDegree(snapshot.zoom);
    const [lon, lat] = snapshot.center;
    const guess = { ...snapshot, center: [lon - deltaX / ratio, clamp(lat + deltaY / ratio, -90, 90)] };
    const ray = worldRay(from);
    const anchor = ray && add(ray.origin, scale(ray.direction, ray.start));
    return createGlobeCamera(anchor && inside(to) ? alignAnchor(guess, viewport, anchor, to) : guess, viewport);
  }

  function zoomAt(point, delta) {
    const next = { ...snapshot, zoom: clamp(snapshot.zoom + delta, -2, 22) };
    const ray = worldRay(point);
    const anchor = ray && add(ray.origin, scale(ray.direction, ray.start));
    return createGlobeCamera(anchor ? alignAnchor(next, viewport, anchor, point) : next, viewport);
  }

  return Object.freeze({ view: snapshot, frame: Object.freeze(frame),
    projectCoordinate: coordinate => projectVector(globeVector(coordinate), frame), projectVisibleCoordinate, projectVisibleVector,
    screenToGeo: point => { const ray = worldRay(point); return ray?mapCoordinate(add(ray.origin, scale(ray.direction, ray.start))):null; },
    worldRay, geographicBounds, projectStroke, drag, zoomAt });
}
