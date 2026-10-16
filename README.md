# Acorn

<img width="2172" height="691" alt="acorn-banner" src="https://github.com/user-attachments/assets/8ae1c6b4-fdeb-40ff-885f-a2568ffe5b64" />


Acorn is an Electron desktop app for comparing Git branches and commits.<br/>
It builds web-renderable previews locally for supported web and Expo projects.<br/><br/>


## Demo


https://github.com/user-attachments/assets/59a2ac54-d0f8-4e85-8622-d434f9d140f3




## Install and run

```bash
npm install
npm run desktop
```

Acorn keeps one process per application profile. Launching it again restores and
focuses the existing window. Keep `desktop.cjs` and `desktop-lifecycle.cjs` at the
project root when reorganizing source folders; update `acorn.main` and
`acorn.renderer` in `package.json` to match the new locations, along with any
relative imports in the moved code. In development, Acorn checks these paths and
restarts after both new entry files exist. Incomplete moves are retried. This
does not discover an arbitrary move of the entire project directory; quit the
app before moving that directory and launch it from its new location afterward.



## Features

<img width="1624" height="1025" alt="acorn-screenshot" src="https://github.com/user-attachments/assets/bdb64253-b1c3-42a3-a14e-af8ce87b4417" />


- Connect an existing local Git repository.
- Select a branch or commit as Base and Target.
- Preview historical commits from temporary snapshots without checking them out in the connected repository.
- Review changed files, line counts, and unified text patches.
- Compile supported Expo-based React Native projects into local web previews inside Acorn.
- Compile supported web previews locally and serve them through an isolated loopback viewer.


## Requirements

- macOS
- Node.js and npm
- Git
- A local Git repository containing a supported web or Expo project

Acorn does not require an account, API key, hosted backend, or GitHub OAuth app. Git inspection, snapshots, and preview compilation run locally. A normal preview can request restricted public HTTPS JSON through Preview Data, and an incompatible historical dependency set can require package-registry access to populate Acorn's separate preview cache. These exceptions are described below.

## Preview model

Acorn compiles supported source files from the selected revision, serves the result on an ephemeral `127.0.0.1` port, and embeds a guarded local UI proxy in an iframe. These loopback servers exist only while Acorn runs; no hosted service or external backend is involved.

When Working folder is selected, Acorn copies the working directory so local edits are included without running against the original files. Selected commits (including HEAD) are exported with `git archive` to temporary directories. The connected repository is never checked out to another ref.

## Known limitations

- Previews are UI-only: the page picker and ordinary internal navigation work; local UI interactions and validation are enabled, while backend requests and desktop actions are restricted. Unavailable pages are omitted from the picker. Protected screens in other projects may require an existing UI preview entry. See [supported pages and configuration](docs/ui-preview.md).

- The MVP supports web-renderable Expo and web source projects; Android, iOS, and native desktop execution are not implemented.
- Native-only modules and platform behavior are outside the web preview runtime's scope.
- Working-tree diffs include tracked files only; untracked files are not listed.
- Acorn does not fetch, commit, merge, or push Git changes.
- Automated validation covers syntax, preview compilation, snapshot isolation, cache behavior, and preview lifecycle. It does not emulate native-device rendering.

## Documentation

- [Project overview](docs/project-overview.md)
- [Functional specification](docs/functional-spec.md)
- [Architecture](docs/architecture.md)

## Project structure

- `src/main/` — Electron main process, Git integration, and preview engines
- `src/renderer/` — Desktop interface, styles, and bundled visual assets
- `tests/` — Automated behavior and regression tests
- `scripts/` — Local development and verification utilities
- `docs/` — Architecture, behavior, and preview documentation

## Repository

<https://github.com/sujla/acorn>

### Change overlays

Highlight Changes uses literal attributes and text on changed source lines. CSS context is used only to identify the rule containing a changed declaration; unchanged neighboring rules and markup are not highlighted. Dashed purple overlays are estimates, not exact source-to-component mappings. Added content can appear on Target and removed content on Base. Unmatched changes, backend logic, dynamic expressions, canvas content and unsupported selectors may have no highlight. A persistent bottom-right “Locating changes…” notification remains until both previews report their results (including zero matches), or Highlight Changes is turned off. Preview header status text is omitted. Overlays follow scrolling and layout updates and do not intercept clicks.

Select “Working folder · uncommitted changes” on either side to include local edits. Choose HEAD on Base and Working folder on Target to inspect uncommitted changes. The diff uses the working folder on that side too. Selecting the same state on both sides shows no changes. All commit refs, including HEAD, compare their committed snapshots. Working-folder comparisons cover tracked files only; untracked files are not included in the diff or overlays. Refresh after editing local files to update diff hints.

The revision menu uses compact OS-style rows, follows the app appearance theme, and hides its scrollbar while preserving wheel, trackpad and keyboard scrolling. Working folder stays first.

### Generated files

Show Diff always includes all tracked changes, including build outputs and their line counts. Only Highlight Changes excludes generated files: common output directories (`dist`, `build`, `.next`, `.nuxt`, `.output`, `coverage`, `node_modules`, `.cache`, `.turbo`), minified JS/CSS, JS/CSS source maps, and TypeScript build metadata. Literal `outDir` paths in root Vite configs are also read from both compared states, so custom outputs such as `docs` are excluded from overlays without hiding their code diffs. Config files are read as text, never executed. Computed output paths and other build systems may need additional detection.

Overlay labels name changed CSS properties, for example `line-height change` or `line-height, padding change`. Unchanged declarations on the same line are omitted. Multiple hints for the same element are combined. When no property can be identified, the label remains `Estimated change`; labels describe code edits, not a measured visual difference.

## Local repository connection

Choose an existing Git working folder on this Mac. Acorn opens directly into the local workspace without sign-in, GitHub App registration, or OAuth credentials. Repository cloning is not provided; clone repositories separately before connecting their local folders.

## Returning to a project

During the current app session, project switching restores the selected commits and pages from the existing preview servers without requesting compilation. The three most recently used projects keep their live preview documents, including input and scroll state. Older projects retain their selections and reload the existing preview URL when revisited. Switching to another comparison reuses an existing server, including the working folder, without compilation and does not wait for unrelated renderer requests. Explicit refresh and commit changes still validate the preview; stopped servers are restarted when needed. Working-folder changes appear after refresh.

Closing a comparison releases every server it used during this app session. The main process keeps ownership across renderer reloads: shared servers stay running until their last comparison closes. The last release cancels queued or active compilation, fences late requests, and closes both the preview server and its viewer proxy, including open connections. Revision extraction and working-folder copying check cancellation between files. Merely referencing the same revision in an unopened comparison does not keep a server alive. Server and build reuse remain unchanged for comparisons that actually use them; cached artifacts remain available for later reopening.

`Command/Ctrl+R` invokes **Refresh Preview**, rereads the active repository's local branches and commit log, and preserves the selected pages, refs, zoom, and viewport size. This local refresh does not run `git fetch`. The button shows the shortcut on hover. `Command/Ctrl+Shift+R` saves the workspace, drains pending preview requests, stops all preview servers, and reloads Acorn; only the active comparison starts again immediately. A renderer reload reconnects to surviving servers and restores the last project, comparison, pages, layout, zoom, and size from window session storage. Reloading documents does not preserve their JavaScript heap or unsaved form inputs; recent comparison switches retain live documents as described above.

## Generated output in previews

Except for the Expo export path described below, preview snapshots exclude root `dist`, `build`, `out`, `web-build`, `.next`, `.nuxt`, and `.output` folders, plus literal Vite `build.outDir` paths from the selected revision. Exclusion happens before Git blob extraction or working-folder copying and applies to hashing, compilation and page discovery, including explicit page manifests. Source documentation folders remain available unless configured as output. Git file lists and code diffs still include build files. Revisions containing only generated output require a browser source entry rather than falling back to deployment HTML. Project configuration is read as text, never executed; computed output paths are not inferred.

### Automatic Expo web previews

Expo SDK 54–57 projects now build automatically from the selected source snapshot.
Acorn detects the installed Expo version and selects matching pinned Metro,
Babel/Expo, React, React DOM and
React Native Web. Users do not choose a web output mode, run terminal commands,
or commit generated exports to preview supported source. The connected project
is not modified. A preparing indicator stays visible while the worker builds;
validated artifacts are reused afterward.

The compiler uses existing local project dependencies and supplies its bundled
React/DOM/Web runtime when web dependencies are absent. During compilation it does
not execute project packages as Node tooling or run package scripts, JavaScript config files, custom Babel/Metro
plugins, or native binaries. `app.json` is read as data. Web platform resolution,
Expo Router snapshot routes, common App entries, SVG components and local assets
are supported. SDK 54–57 is the current supported range. Missing packages with
unchanged dependency declarations still require a local installation. A
historical dependency/lockfile mismatch selects an isolated npm or supported Yarn 4
installation when a compatible lockfile is available. Matching environments reuse
the current installation; new ones use `npm ci --ignore-scripts` or Yarn's immutable,
skip-build installation with package scripts disabled, and persist in the preview
cache. The loading panel shows preparation progress, and refresh retries an install
failure. Local Node and the matching package manager are required. Expo SDK versions
outside 54–57, package managers other than npm and the supported Yarn 4 configuration,
workspace/local/Git dependencies, and automatic cache eviction are not yet supported.

Native maps, Google Mobile Ads and share intents use explicit web-preview
substitutes. Maps render a labelled coordinate schematic without a basemap; ads and
unsupported native operations show an unavailable notice. These substitutes do not reproduce native
behavior. Source-side guards may show the project's own unavailable screen before
reaching a substitute. Requests, device permissions and desktop access remain
restricted. Dynamic app configuration, API/server routes and arbitrary build
plugins are not executed. Source transforms and rendering are not a general
Expo compatibility guarantee.

If automatic compilation fails and this same revision contains an existing
`dist/index.html` or legacy `web-build/index.html`, Acorn displays that saved export
with a warning in the page picker. It never borrows the current export for a
historical commit. A saved export may differ from its source.

Verification: `npm test` covers source compilation, cache invalidation, snapshot
route discovery and non-execution of project configuration. Use
`ACORN_VERIFY_EXPO=1 node_modules/.bin/electron scripts/verify-desktop-preview.cjs /absolute/project`
for actual desktop rendering checks.

### Preview Data and project platforms

Normal previews begin with external data disabled. When a preview requests public
HTTPS JSON, Acorn pauses the request and opens the project's Preview Data settings.
The settings list each detected service name and origin, and only the origins the
user selects are allowed for the current app session. Restarting Acorn clears these
permissions. The main process sends allowed requests without cookies or authorization
headers, while the preview browser keeps its direct networking restrictions. Only GET
is supported. Private/local IP addresses, redirects, non-JSON responses, and responses
over 32 MB are refused. DNS results are checked and the connection uses the checked IP.

Permission applies to the displayed origin, so an allowed service may receive
different paths and query strings requested by the preview. Base and Target share
cached responses for an identical full URL, including its query. Refresh Preview
retains this in-memory dataset; restarting Acorn starts a new one. Current data is
used even for historical commits; it is not a historical data reconstruction.
Changing query parameters can produce different requests. No background polling
replaces a saved response. The session cache is limited to 128 requests and 128 MB
per project. A failed request is returned to the preview and Acorn shows a generic
notification. Credentials, POST requests, and private APIs are not supported by this
first version.

The project badge detects Mobile (Expo/React Native/native platform folders),
Desktop (Electron/Tauri), and Web (web packages or entry/config files), allowing
multiple labels. It reads files without executing project configuration. This is
a heuristic capability label, not a claim that every platform builds successfully;
the preview still runs web-renderable UI rather than a native mobile/desktop app.

Mobile projects start with a 390 × 844 CSS-pixel preview viewport; other projects
start at 1440 × 900. The frame scales to available space. Manual frame sizes are
retained per project during the session, and Refresh resets to its platform default.
This controls layout dimensions, not the emulated operating system.
