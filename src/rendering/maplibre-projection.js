const radians=Math.PI/180;
const vector=([lng,lat])=>{const x=lng*radians,y=lat*radians,c=Math.cos(y);return [c*Math.cos(x),c*Math.sin(x),Math.sin(y)];};
const valid=value=>Array.isArray(value)&&value.length>=2&&Number.isFinite(value[0])&&Number.isFinite(value[1]);

export function readMapLibreCamera(map){
 const center=map.getCenter(),canvas=map.getCanvas();
 const projection=map.getProjection();
 return Object.freeze({center:Object.freeze([center.lng,center.lat]),zoom:map.getZoom(),bearing:map.getBearing(),pitch:map.getPitch(),roll:map.getRoll(),projection:projection?projection.type:null,viewport:Object.freeze([canvas.clientWidth,canvas.clientHeight])});
}

/** Screen conversion follows MapLibre's actual camera, including its globe horizon. */
export function createMapLibreProjection(map){
 if(!map||typeof map.project!=='function'||typeof map.unproject!=='function')throw new TypeError('MapLibre map projection is required');
 const projectCoordinate=coordinate=>{
  if(!valid(coordinate)||map.getProjection()?.type!=='globe')return null;
  const point=map.project(coordinate);
  return Number.isFinite(point.x)&&Number.isFinite(point.y)?[point.x,point.y]:null;
 };
 const screenToGeo=point=>{
  if(!valid(point)||map.getProjection()?.type!=='globe')return null;
  const canvas=map.getCanvas();if(point[0]<0||point[1]<0||point[0]>canvas.clientWidth||point[1]>canvas.clientHeight)return null;
  const location=map.unproject(point),coordinate=[location.lng,location.lat],projected=projectCoordinate(coordinate);
  return projected&&Math.hypot(projected[0]-point[0],projected[1]-point[1])<=0.5?coordinate:null;
 };
 const projectVisibleCoordinate=coordinate=>{
  if(map.getProjection()?.type!=='globe')return null;
  const point=projectCoordinate(coordinate),inverse=point&&screenToGeo(point);
  if(!inverse)return null;
  const a=vector(coordinate),b=vector(inverse);
  return Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2])<=0.00001?point:null;
 };
 const geographicBounds=()=>{
  const projection=map.getProjection();
  if(projection?.type!=='globe')return null;
  const center=map.getCenter(),canvas=map.getCanvas();
  if(!canvas.clientWidth||!canvas.clientHeight)return null;
  const origin=vector([center.lng,center.lat]);
  const corners=[[0,0],[canvas.clientWidth,0],[0,canvas.clientHeight],[canvas.clientWidth,canvas.clientHeight]];
  const native=map.getBounds().toArray().flat();
  if(!native.every(Number.isFinite)||native[1]>native[3])return null;
  const radius=Math.max(...corners.map(point=>{const coordinate=map.unproject(point),v=vector([coordinate.lng,coordinate.lat]);return Math.acos(Math.max(-1,Math.min(1,origin.reduce((sum,value,index)=>sum+value*v[index],0))))/radians;}))+1e-6;
  if(!Number.isFinite(radius))return native;
  const south=Math.max(-90,Math.min(native[1],center.lat-radius)),north=Math.min(90,Math.max(native[3],center.lat+radius));
  // Native globe bounds sample only eight edge points. The corner-distance cap
  // also covers intervening horizon extrema; final labels use the exact camera.
  if(Math.abs(center.lat)+radius>=90||native[2]-native[0]>=360)return [center.lng-180,south,center.lng+180,north];
  const longitudeRadius=Math.asin(Math.min(1,Math.sin(radius*radians)/Math.cos(center.lat*radians)))/radians;
  const nativeCenter=(native[0]+native[2])/2,wrap=Math.round((center.lng-nativeCenter)/360)*360;
  const west=Math.min(native[0]+wrap,center.lng-longitudeRadius),east=Math.max(native[2]+wrap,center.lng+longitudeRadius);
  return east-west>=360?[center.lng-180,south,center.lng+180,north]:[west,south,east,north];
 };
 return Object.freeze({projectCoordinate,projectVisibleCoordinate,screenToGeo,geographicBounds});
}
