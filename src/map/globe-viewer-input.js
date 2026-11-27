// Transient gestures own their input state; the renderer owns the camera.
const centerOf = ([a, b]) => [(a[0]+b[0])/2,(a[1]+b[1])/2];
const span = ([a, b]) => Math.max(1, Math.hypot(a[0]-b[0], a[1]-b[1]));
export function createGlobeViewerInput({
  getCamera, getViewport, setCamera, invalidate, beforeMovement, onMovementStart, onMovementEnd, signal,
}) {
  const events = new Map(), pointers = new Map();
  let moving = false, moveTimer, velocity, pointerTravel = 0, lastPointerMove = 0;
  function subscribeInput(type, callback) {
    if (!events.has(type))events.set(type, new Set());
    events.get(type).add(callback); return () => events.get(type)?.delete(callback);
  }
  function emit(type, event = {}) {for (const callback of events.get(type)??[])callback(event);}
  function finishMovement() {
    clearTimeout(moveTimer); if (!moving)return;
    moving = false; velocity = null; emit('moveend'); onMovementEnd();
  }
  function beginMovement() {
    clearTimeout(moveTimer); if (moving)return;
    beforeMovement(); moving = true; emit('movestart'); onMovementStart();
  }
  function attach(canvas) {
  function screenPoint(event) {const rect = canvas.getBoundingClientRect(); return [event.clientX-rect.left, event.clientY-rect.top];}
    const listen = (type, fn, options) => canvas.addEventListener(type, fn, {signal, ...options});
    listen('pointerdown', event => {
      if (!getCamera()||event.button!==0)return;
      if (!pointers.size)pointerTravel = 0;
      velocity = null; pointers.set(event.pointerId, screenPoint(event)); canvas.setPointerCapture(event.pointerId);
    });
    listen('pointermove', event => {
      const point = screenPoint(event), previous = pointers.get(event.pointerId);
      if (!previous) {emit('mousemove', {point, originalEvent:event}); return;}
      if (pointers.size>2)return;
      const now = performance.now(), dt = Math.max(8, now-lastPointerMove); lastPointerMove = now;
      pointerTravel+=Math.hypot(point[0]-previous[0], point[1]-previous[1]);
      pointers.set(event.pointerId, point);
      if (pointerTravel<3&&pointers.size===1)return;
      beginMovement();
      if (pointers.size===1) {
        velocity = [(point[0]-previous[0])/dt,(point[1]-previous[1])/dt];
        setCamera(getCamera().drag(previous, point));
      }else {
        const other = [...pointers].find(([id]) => id!==event.pointerId)[1], from = centerOf([previous, other]), to = centerOf([point, other]);
        velocity = null; setCamera(getCamera().drag(from, to).zoomAt(to, Math.log2(span([point, other])/span([previous,other]))));
      }
    });
    const end = event => {
      if (!pointers.delete(event.pointerId)||pointers.size)return;
      if (event.type==='pointerup'&&pointerTravel<3&&!moving)emit('click', {point:screenPoint(event), originalEvent:event});
      if (event.type!=='pointerup'||matchMedia('(prefers-reduced-motion: reduce)').matches||performance.now()-lastPointerMove>75||!velocity)finishMovement();
      else invalidate('three-inertia');
    };
    for (const type of ['pointerup','pointercancel','lostpointercapture'])listen(type, end);
    listen('pointerleave', () => emit('mouseout'));
    listen('wheel', event => {
      if (!getCamera())return; event.preventDefault(); beginMovement(); velocity = null;
      const units = event.deltaMode===1?16:event.deltaMode===2?getViewport().height:1;
      setCamera(getCamera().zoomAt(screenPoint(event), Math.max(-1, Math.min(1, -event.deltaY*units/400))));
      moveTimer = setTimeout(finishMovement, 140);
    }, {passive:false});
  }

  function advanceInertia() {
    if (moving&&!pointers.size&&velocity) {
      const now = performance.now(), elapsed = Math.max(0, now-lastPointerMove); lastPointerMove = now;
      // Bound a single camera step, but decay velocity by actual wall time.
      // Slow asset preparation or software rendering must not prolong inertia.
      const dt = Math.min(32, elapsed), point = getCamera().frame.center;
      velocity = velocity.map(value => value*Math.exp(-elapsed/135));
      if (Math.hypot(...velocity)<0.02)finishMovement();
      else setCamera(getCamera().drag(point, [point[0]+velocity[0]*dt, point[1]+velocity[1]*dt]));
    }
  }
  function panBy(dx, dy) {if (!getCamera())return false; beginMovement(); const point = getCamera().frame.center; setCamera(getCamera().drag(point, [point[0]+dx, point[1]+dy])); finishMovement(); return true;}
  function dispose() {
    clearTimeout(moveTimer);
    events.clear();
    pointers.clear();
  }
  return Object.freeze({attach, subscribeInput, emit, isMoving:() => moving, advanceInertia, panBy, dispose});
}
