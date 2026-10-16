const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const valid = p => p && Number.isFinite(p.latitude) && Number.isFinite(p.longitude);
function world(p) {
  const lat = clamp(p.latitude, -85.051129, 85.051129) * Math.PI / 180;
  return { x: (p.longitude + 180) / 360, y: (1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2 };
}
function coordinate(p) { return { latitude: Math.atan(Math.sinh(Math.PI * (1 - 2 * p.y))) * 180 / Math.PI, longitude: ((p.x * 360) % 360 + 360) % 360 - 180 }; }
function project(point, camera, size) {
  const p = world(point), c = world(camera.center), scale = 256 * 2 ** camera.zoom;
  let dx = p.x - c.x; dx -= Math.round(dx);
  return { x: size.width / 2 + dx * scale, y: size.height / 2 + (p.y - c.y) * scale };
}
function unproject(point, camera, size) {
  const c = world(camera.center), scale = 256 * 2 ** camera.zoom;
  return coordinate({ x: c.x + (point.x - size.width / 2) / scale, y: c.y + (point.y - size.height / 2) / scale });
}
function region(camera, size) {
  const top = unproject({ x: 0, y: 0 }, camera, size), bottom = unproject({ x: size.width, y: size.height }, camera, size);
  return { ...camera.center, latitudeDelta: Math.abs(top.latitude - bottom.latitude), longitudeDelta: Math.min(360, size.width / (256 * 2 ** camera.zoom) * 360) };
}
function fromRegion(r, size) {
  return { center: { latitude: r.latitude, longitude: r.longitude }, zoom: clamp(Math.log2(size.width * 360 / (256 * Math.max(r.longitudeDelta || .01, 1e-8))), 0, 22), heading: 0, pitch: 0 };
}
function fit(points, size, padding = {}) {
  const ps = points.filter(valid).map(world); if (!ps.length) return null;
  // Unwrap around the first coordinate so routes crossing the date line fit tightly.
  ps.forEach(p => { p.x -= Math.round(p.x - ps[0].x); });
  const minX = Math.min(...ps.map(p => p.x)), maxX = Math.max(...ps.map(p => p.x));
  const minY = Math.min(...ps.map(p => p.y)), maxY = Math.max(...ps.map(p => p.y));
  const width = Math.max(1, size.width - (padding.left || 0) - (padding.right || 0));
  const height = Math.max(1, size.height - (padding.top || 0) - (padding.bottom || 0));
  const zoom = clamp(Math.min(Math.log2(width / (256 * Math.max(maxX - minX, 1e-8))), Math.log2(height / (256 * Math.max(maxY - minY, 1e-8)))), 0, 21);
  const scale = 256 * 2 ** zoom;
  return { center: coordinate({ x: (minX + maxX) / 2 + ((padding.right || 0) - (padding.left || 0)) / (2 * scale), y: (minY + maxY) / 2 + ((padding.bottom || 0) - (padding.top || 0)) / (2 * scale) }), zoom, heading: 0, pitch: 0 };
}
module.exports = { clamp, valid, project, unproject, region, fromRegion, fit };
