# Map UI preview

Acorn substitutes `react-native-maps` only in its isolated Expo web compilation.
The adapter renders a labelled coordinate schematic, not Google Maps tiles or a
native SDK. It starts no simulator, needs no map key, and makes no tile requests.

Supported: Web Mercator coordinate placement, custom marker children and image
assets, marker press callbacks, polylines, polygons, approximate circles, camera
commands, coordinate conversion, fitting markers/coordinates, drag-to-pan and
wheel-to-zoom. Existing application filters still decide which markers exist.
Data requests still use Acorn's existing data bridge; missing or authenticated
responses are not synthesized by the adapter.

Limitations: no roads, labels or satellite imagery, no pitch/heading rendering,
no native animation fidelity, no draggable markers, and no custom callout or
image overlay rendering. Default marker titles can be shown on click. This is
for inspecting UI, not verifying native SDK behavior. Automatic Expo compilation
supports Expo SDK 54–57; versions outside that range are rejected.

## Application compatibility

`src/main/expo-preview/map-compatibility.cjs` contains an explicit rule for the known
`src/components/map/GoogleTransitMap.tsx` wrapper. Only when its expected import,
export and exact configuration guard match does the preview transformer replace
that guard with schematic availability. This keeps the wrapper's actual marker,
route, filtering and event code. It does not modify the repository, Expo config,
API keys or Platform.OS. A changed guard fails closed (no substitution).

The artifact warnings disclose the mapped file and the page banner identifies
schematic maps. Other apps can use the library adapter directly; wrappers with
other native readiness checks need their own reviewed compatibility rule. A
universal bypass of application guards is deliberately not provided.

## Verification

- `npm test` includes geometry, compatibility scope and Expo compiler checks.
- `electron scripts/verify-map-preview.cjs` checks actual DOM rendering, custom
  markers, route geometry, marker clicks and camera/fit commands.
- `electron scripts/verify-mobile-preview.cjs /path/to/project --public-data --map`
  checks the actual app and requires rendered markers plus no captured errors.
  This runs an isolated Acorn session and does not write project sources.

## Shared Expo feature isolation

Project JSX now receives per-component React error boundaries during the
isolated preview transform. A failing render or React lifecycle/effect displays
an inline notice for that component while siblings continue working. Errors are
labelled as preview errors rather than incorrectly attributed to native support.
Navigation declarations, member components (including context providers), and
direct `asChild` children retain their original element types. Ref forwarding and
list keys stay on the appropriate elements; key expressions evaluate once.

An Acorn-owned registry (`src/main/expo-preview/feature-adapters.cjs`) substitutes
`expo-camera`, `react-native-webview`, `react-native-vision-camera`, and
`expo-local-authentication`. Camera/WebView surfaces show feature notices;
permission requests return denied and biometric authentication returns an
explicit unsuccessful result. They do not open devices or claim successful
native operations. Existing map/ads/share adapters remain available.

This is shared infrastructure, not a universal native runtime. Missing packages,
unsupported Expo SDKs, module-level initialization failures, asynchronous/event
handler exceptions, and app-wide permission gates cannot in general be recovered
by a React boundary. An error in the root component can replace the root. Unknown
native dependencies are not silently replaced with fabricated service responses.
Apps using React.createElement directly do not get JSX boundaries from this pass.

`electron scripts/verify-feature-preview.cjs` checks independent camera/WebView
placeholders, render and effect failures, zero uncaught errors, and a working
sibling button. The compiler test also builds an unrelated Expo fixture with
these features without installing or evaluating their native packages.
