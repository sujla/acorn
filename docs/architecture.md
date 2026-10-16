# Architecture

## Preview structure

Acorn uses Electron with a narrow preview boundary:

1. **Renderer (`src/renderer/index.html`, `src/renderer/app.js`, `src/renderer/styles.css`)** manages repository and ref selection, Git diff rendering, and guarded iframe previews.
2. **Preload bridge (`src/main/preload.cjs`)** exposes explicit IPC methods while keeping renderer Node integration disabled.
3. **Main process (`src/main/desktop-main.cjs`)** owns Git access, temporary snapshots, preview compilation, loopback servers, and lifecycle cleanup.
4. **Compiler worker (`src/main/preview-compiler-worker.cjs`)** selects the Expo or general web compiler from the snapshot's `package.json` and returns a static artifact.
5. **UI preview proxy (`src/main/ui-preview-server.cjs`)** serves allowed artifact resources and injects the browser guard before project scripts.

## Preview dispatch

Repository inspection exposes one `web` UI Preview capability. The renderer sends
Base and Target refs to `preview:start`; the main process resolves both into isolated
snapshots, compiles them, and serves the artifacts from ephemeral loopback ports.

```text
Base / Target changes
          |
          +----> Git diff service
          |
          +----> snapshot each selected state
                     |
                     +--> Working folder: temporary copy
                     +--> commit ref: git archive snapshot
                                  |
                                  +--> compiler worker
                                         |
                              Expo compiler / web compiler
                                         |
                                  static artifact
                                         |
                           loopback server + UI guard
                                         |
                                      iframes
```

The application does not launch `expo start`, a project `dev` script, or a project
development server. Identical committed Base and Target refs share one compiled
resource. A Working-folder refresh creates a new temporary copy so current local
edits are included without running code from the connected repository.

## IPC surface

| Renderer method | Channel | Purpose |
| --- | --- | --- |
| `listRepositories()` | `repositories:list` | Load saved repositories and platform hints |
| `chooseLocalRepository()` | `repositories:choose-local` | Connect a local Git folder |
| `getDiff(payload)` | `repositories:diff` | Compare refs or load tracked working-tree changes |
| `startPreview(payload)` | `preview:start` | Prepare Base and Target previews |
| `getPreviewData(payload)` | `preview:data:get` | Read a restricted public HTTPS JSON resource for a normal preview |

## Resource lifecycle

- `previewServers` tracks compiled artifacts and their loopback HTTP servers.
- `previewSnapshots` tracks temporary directories by repository and revision.
- Identical refs can share one preview resource while each side keeps its own guarded iframe.
- Ref changes retain reusable resources; comparison release and app shutdown stop unowned servers and remove temporary snapshots.
- Compiled artifacts and isolated dependency installations are cached separately from the connected repository.

## Security boundaries

- BrowserWindow uses context isolation and disables renderer Node integration.
- The preload exposes only explicit repository and preview methods.
- Git and package-manager commands use executable/argument arrays rather than shell interpolation.
- During compilation, project source and configuration are read without running project development servers, package scripts, or arbitrary build plugins. Compiled application code runs only inside the guarded preview browser.
- Working-folder and commit previews compile from temporary snapshots, never from the connected repository directory.
- Preview and proxy servers bind to loopback, and static paths are resolved beneath their allowed roots.
- The guarded browser blocks direct external networking and desktop APIs. Normal previews can make the separately restricted public JSON GET requests documented in the README.

## Validation boundary

`npm test` runs syntax checks and unit/integration fixtures covering compilers,
snapshot isolation, dependency preparation, preview data, resource lifecycle, and
renderer behavior. Native-device rendering and arbitrary third-party projects still
require separate manual or project-specific verification.

## UI-only page previews

`src/main/preview-pages.cjs` discovers a revision-specific page catalog.
`src/renderer/page-picker.js` renders the column browser below each revision selector.
`src/main/ui-preview-server.cjs` proxies allowed resources and injects
`src/renderer/ui-preview-guard.js` before application scripts. The compiler reads a
temporary snapshot and writes generated files only to that snapshot, temporary build
directories, and Acorn's preview cache; the
connected repository is not a writable preview workspace. See
[supported pages, behavior, and limitations](ui-preview.md).
