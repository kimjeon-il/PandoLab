export function createMenuPositionScheduler(callback, {
  requestFrame = callbackToRun => requestAnimationFrame(callbackToRun),
  cancelFrame = frame => cancelAnimationFrame(frame),
} = {}) {
  let frame = 0;
  return Object.freeze({
    schedule() {
      if (frame) return;
      frame = requestFrame(() => {
        frame = 0;
        callback();
      });
    },
    cancel() {
      if (!frame) return;
      cancelFrame(frame);
      frame = 0;
    },
  });
}

