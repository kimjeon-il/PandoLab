// Identical drawing commands for document and Worker OffscreenCanvas.
// Preserve the existing text, alignment, marker and font-weight policy.
export const GLOBE_LABEL_FONT_SIZE = 56, GLOBE_LABEL_OUTLINE_RANGE = 12;
// Preserve the label layout and atlas quad padding independently of the distance range.
export const GLOBE_LABEL_PADDING = 9;
export const GLOBE_LABEL_FONT_PATH = 'assets/fonts/pretendard-v1.3.9/PretendardVariable.woff2';
export function globeLabelFont(place) {
  return `${place?600:800} ${GLOBE_LABEL_FONT_SIZE}px "Pretendard Variable", sans-serif`;
}
export function globeLabelLineMetrics(context, lines, font) {
  context.font = font;
  return lines.map(line => {
    const m = context.measureText(line);
    return [m.width, m.actualBoundingBoxLeft, m.actualBoundingBoxRight, m.actualBoundingBoxAscent, m.actualBoundingBoxDescent]
      .map(value => Number.isFinite(value)?value:null);
  });
}
export function globeLabelMetricsMatch(a, b) {
  return Array.isArray(a)&&a.length===b.length&&a.every((row, i) => row.length===b[i].length&&row.every((value, j) => {
    const other = b[i][j]; return value===null||other===null?value===other:Math.abs(value-other)<=1/64;
  }));
}
export function createGlobeLabelRaster() {
  const canvas = new OffscreenCanvas(1, 1), context = canvas.getContext('2d', {willReadFrequently:true});
  if (!context)throw Error('Label raster context unavailable');
  function mask(row) {
    const {width, height, font, lineHeight, markerWidth, textX, anchorX, anchorY} = row;
    if (!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<=0||height<=0||width*height>2048**2)throw Error('Invalid label raster size');
    // Reuse the backing canvas between same-size labels. Grow only as needed
    // during a batch; clearing the exact requested region preserves output.
    if (canvas.width<width||canvas.height<height||canvas.width*canvas.height>width*height*4) {canvas.width = width; canvas.height = height;}
    context.clearRect(0, 0, width, height);
    context.font = font; context.textAlign = row.place?'left':'center'; context.textBaseline = 'middle'; context.fillStyle = '#fff';
    row.lines.forEach((line, i) => context.fillText(line, textX, GLOBE_LABEL_PADDING+lineHeight*(i+.5), width-GLOBE_LABEL_PADDING*2-markerWidth));
    if (row.marker) {context.beginPath(); context.arc(anchorX, anchorY, row.marker==='capital'?13:10, 0, Math.PI*2); context.fill();}
    const rgba = context.getImageData(0, 0, width, height).data, result = new Uint8Array(width*height);
    for (let i = 0; i<result.length; i++)result[i] = rgba[i*4+3];
    return result;
  }
  function reset() {canvas.width = 1; canvas.height = 1;}
  return {canvas, context, mask, reset};
}
export function globeLabelRasterRow(label) {
  const {atlasKey:key, width, height, font, lineHeight, markerWidth, textX, anchorX, anchorY, place, marker, lines, lineMetrics} = label;
  return {key, width, height, font, lineHeight, markerWidth, textX, anchorX, anchorY, place:Boolean(place), marker:marker??'', lines, lineMetrics, outlineRange:GLOBE_LABEL_OUTLINE_RANGE};
}
