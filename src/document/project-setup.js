import { compareTemporal } from './temporal.js';
/** One canonical shape for a dated builtin map admitted as a project.
  * Date validity is checked by the source selector and the C++ document owner. */
export function createBuiltinProjectSetup(initialMonth) {
  return {initialMonth, timelineRange:null, initialMapBounds:null, sourceMode:'builtin'};
}
export function requireProjectMonth(setup, month) {
  const range = setup?.timelineRange; if (range&&(compareTemporal(month, range.start)<0||compareTemporal(month, range.end)>0))throw new Error('탐색 기간 밖입니다. 선택한 시점이 탐색 기간 밖입니다.');
}
