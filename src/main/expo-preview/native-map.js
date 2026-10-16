import React, { createContext, forwardRef, useContext, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Image, StyleSheet } from 'react-native-web';
import geometry from './map-geometry.cjs';
const { clamp, valid, project, unproject, region, fromRegion, fit } = geometry;
const Context = createContext(null);
const noop = () => {};
const fill = { position: 'absolute', inset: 0, width: '100%', height: '100%' };
const MapView = forwardRef(function SchematicMap(props, ref) {
  const element = useRef(null), latest = useRef(props); latest.current = props;
  const [size, setSize] = useState({ width: 390, height: 600 });
  const [camera, setCamera] = useState(() => props.camera || props.initialCamera || (props.region || props.initialRegion ? fromRegion(props.region || props.initialRegion, size) : { center: { latitude: 0, longitude: 0 }, zoom: 2, heading: 0, pitch: 0 }));
  const state = useRef({ camera, size }); state.current = { camera, size };
  const markers = useRef(new Map());
  const update = (next, gesture = false) => {
    const current = state.current;
    const value = { ...current.camera, ...next, zoom: clamp(next.zoom ?? current.camera.zoom, props.minZoomLevel ?? 0, props.maxZoomLevel ?? 22) };
    if (!valid(value.center)) return;
    state.current.camera = value; setCamera(value);
    const r = region(value, current.size), detail = { isGesture: gesture };
    latest.current.onRegionChange?.(r, detail); latest.current.onRegionChangeComplete?.(r, detail);
  };
  useEffect(() => {
    const observer = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      if (width && height) { setSize({ width, height }); latest.current.onLayout?.({ nativeEvent: { layout: { width, height, x: 0, y: 0 } } }); }
    });
    observer.observe(element.current);
    latest.current.onMapReady?.(); latest.current.onMapLoaded?.();
    return () => observer.disconnect();
  }, []);
  useEffect(() => { if (props.camera) update(props.camera); }, [props.camera]);
  useEffect(() => { if (props.region) update(fromRegion(props.region, state.current.size)); }, [props.region]);
  const fitPoints = (points, options) => { const next = fit(points, state.current.size, options?.edgePadding); if (next) update(next); };
  useImperativeHandle(ref, () => ({
    animateCamera: next => update(next), setCamera: next => update(next),
    animateToRegion: r => update(fromRegion(r, state.current.size)),
    getCamera: async () => state.current.camera,
    pointForCoordinate: async p => project(p, state.current.camera, state.current.size),
    coordinateForPoint: async p => unproject(p, state.current.camera, state.current.size),
    fitToCoordinates: fitPoints,
    fitToElements: options => fitPoints([...markers.current.values()].map(m => m.coordinate), options),
    fitToSuppliedMarkers: (ids, options) => fitPoints([...markers.current.values()].filter(m => ids.includes(m.identifier)).map(m => m.coordinate), options),
  }));
  const drag = useRef(null);
  const point = event => { const rect = element.current.getBoundingClientRect(); return { x: (event.clientX - rect.left) * size.width / rect.width, y: (event.clientY - rect.top) * size.height / rect.height }; };
  return <Context.Provider value={{ camera, size, markers, point }}><div ref={element} data-acorn-map="schematic" aria-label="Schematic map preview" style={{ position: 'relative', ...StyleSheet.flatten(props.style), overflow: 'hidden', backgroundColor: '#e9eee9', backgroundImage: 'linear-gradient(#cad4cc66 1px, transparent 1px),linear-gradient(90deg,#cad4cc66 1px,transparent 1px)', backgroundSize: '48px 48px', touchAction: 'none', minHeight: 120 }}
    onPointerDown={event => { if (event.button !== 0) return; drag.current = { point: point(event), camera: state.current.camera, moved: false }; event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerMove={event => { const d = drag.current; if (!d || props.scrollEnabled === false) return; const p = point(event), dx = p.x - d.point.x, dy = p.y - d.point.y; if (Math.abs(dx) + Math.abs(dy) < 3) return; d.moved = true; update({ ...d.camera, center: unproject({ x: size.width / 2 - dx, y: size.height / 2 - dy }, d.camera, size) }, true); }}
    onPointerUp={event => { const d = drag.current; drag.current = null; if (d && !d.moved) props.onPress?.({ nativeEvent: { coordinate: unproject(point(event), state.current.camera, size), position: point(event), action: 'press' } }); }}
    onPointerCancel={() => { drag.current = null; }}
    onWheel={event => { if (props.zoomEnabled !== false) update({ zoom: state.current.camera.zoom + (event.deltaY < 0 ? .5 : -.5) }, true); }}>
    {props.children}
    <div style={{ position: 'absolute', left: 8, top: 8, zIndex: 100000, pointerEvents: 'none', font: '11px system-ui', background: '#ffffffdf', color: '#415448', padding: '4px 7px', borderRadius: 5 }}>Map UI preview · No basemap</div>
  </div></Context.Provider>;
});
export default MapView;
export const Marker = forwardRef(function Marker(props, ref) {
  const context = useContext(Context), token = useRef({}), [callout, setCallout] = useState(false);
  useImperativeHandle(ref, () => ({ redraw: noop, showCallout: () => setCallout(true), hideCallout: () => setCallout(false), animateMarkerToCoordinate: noop }));
  useEffect(() => { if (!context) return; context.markers.current.set(token.current, props); return () => context.markers.current.delete(token.current); }, [context?.markers, props.coordinate, props.identifier]);
  if (!context || !valid(props.coordinate)) return null;
  const p = project(props.coordinate, context.camera, context.size), anchor = props.anchor || { x: .5, y: 1 };
  const source = props.image || props.icon;
  return <div data-acorn-marker={props.identifier || ''} title={props.title} style={{ position: 'absolute', left: p.x, top: p.y, transform: `translate(${-anchor.x * 100}%, ${-anchor.y * 100}%)`, zIndex: props.zIndex ?? 1, opacity: props.opacity ?? 1, cursor: props.tappable === false ? 'default' : 'pointer', pointerEvents: props.tappable === false ? 'none' : 'auto' }}
    onPointerDown={event => event.stopPropagation()}
    onClick={event => { event.stopPropagation(); setCallout(v => !v); props.onPress?.({ nativeEvent: { coordinate: props.coordinate, id: props.identifier, action: 'marker-press' } }); }}>
    {source ? <Image source={source} style={{ width: Image.resolveAssetSource?.(source)?.width || source.width || 28, height: Image.resolveAssetSource?.(source)?.height || source.height || 28 }} /> : props.children || <span style={{ display: 'block', width: 18, height: 18, background: props.pinColor || '#d64343', border: '2px solid white', borderRadius: '50% 50% 50% 0', transform: 'rotate(-45deg)', boxShadow: '0 1px 4px #0004' }} />}
    {callout && props.title && <div style={{ background: 'white', color: '#222', padding: 5, whiteSpace: 'nowrap', font: '12px system-ui' }}>{props.title}</div>}
  </div>;
});
function Shape({ coordinates = [], strokeColor = '#3977bc', strokeWidth = 2, fillColor = 'transparent', zIndex = 0, closed = false, ...props }) {
  const context = useContext(Context); if (!context) return null;
  const points = coordinates.filter(valid).map(p => project(p, context.camera, context.size)).map(p => `${p.x},${p.y}`).join(' ');
  const Tag = closed ? 'polygon' : 'polyline';
  return <svg data-acorn-map-shape="" style={{ ...fill, pointerEvents: 'none', zIndex }}><Tag points={points} fill={closed ? fillColor : 'none'} stroke={strokeColor} strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" strokeDasharray={props.lineDashPattern?.join(' ')} /></svg>;
}
export const Polyline = props => <Shape {...props} />;
export const Polygon = props => <Shape {...props} closed />;
export function Circle({ center, radius = 0, ...props }) {
  if (!valid(center)) return null;
  const points = Array.from({ length: 65 }, (_, i) => ({ latitude: center.latitude + radius / 111320 * Math.sin(i * Math.PI / 32), longitude: center.longitude + radius / (111320 * Math.cos(center.latitude * Math.PI / 180)) * Math.cos(i * Math.PI / 32) }));
  return <Shape {...props} coordinates={points} closed />;
}
export const Callout = () => null;
export const Overlay = () => null;
export const PROVIDER_GOOGLE = 'google';
export const PROVIDER_DEFAULT = null;
