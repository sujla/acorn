# Preview startup performance — 2026-09-24

Measured locally with Electron 43.2.0 / arm64 against a representative connected repository. Repository files were read only; snapshots and build caches were placed in temporary directories. These are development-build measurements.

## Results

| Stage | Observed duration |
| --- | ---: |
| Resolve HEAD | 7.4 ms |
| Export commit (first profiling run) | 30,198.7 ms |
| Discover pages | 23 ms |
| Cold compile, total | 3,114 ms |
| Scan and hash all files (within cold compile) | 254 ms |
| Copy files (within cold compile) | 212.5 ms |
| Compile source pages (within cold compile) | 1,722.2 ms |
| Bundle dependencies (within cold compile) | 919.4 ms |
| Cached compile, two repeats | 386.3 / 423.5 ms |

An independent desktop integration run, including concurrent startup requests, actual iframe rendering, blocked external fetch, stop and restart, completed in 37,848 ms. This is a broader workload and should not be compared directly to an individual stage above. Socket-listen and browser-paint times were not separately measured.

## Confirmed dominant cost: Git export

`local-git.cjs:options()` supplies no shared `cache` object. `treeFiles()` and each `readBlob()` therefore use separate default caches. The installed isomorphic-git implementation defaults `readBlob`'s cache to a new object, while `readPackIndex` stores its reusable packfile data in that object.

A development-only experiment changes the options object to `{ fs, dir: root, cache: {} }`, sharing a cache within one operation. The shared operation cache was subsequently applied to production `src/main/local-git.cjs` at the user’s request. Each export or Git operation gets its own cache; separate operations do not retain it. Packed-history regression coverage checks exact text/binary exports, diffs and visibility of subsequent commits.

| Export implementation | Total | Blob reads | Time inside blob reads |
| --- | ---: | ---: | ---: |
| Shared-cache experiment, run 1 | 2,311.6 ms | 376 | 1,413.9 ms |
| Shared-cache experiment, run 2 | 2,247.9 ms | 376 | 1,381.5 ms |
| Current implementation, run after experiments | 29,733.6 ms | 376 | 28,705.8 ms |

Every exported relative path and SHA-256 content digest matched between the current implementation and the experiment. The roughly 13× export improvement is measured, not an end-to-end startup guarantee. The runs used the same machine and commit in sequence; OS caches and other system load were not controlled.

## Secondary costs identified before later optimizations

- The snapshot includes 206 files / 92,414,465 bytes in generated `docs`, plus 128 files / 58,462,512 bytes in source `assets`. Output HTML is excluded from compilation only after export, content hashing and copying. Most of the generated files are therefore still processed.
- A cache hit is checked after every source file is read and hashed. An already running server also goes through compiler validation before its URL is reused.
- Renderer `schedulePreview()` chains Base and Target through one promise. The compiler queue also permits one worker at a time. Consequently Target cannot start its preparation until the renderer's previous request finishes.
- Commit snapshots live only for the current app session. Restarting requires export again even when a compiled artifact exists in the persistent cache.

## Recommended order

1. Share a Git cache within each export/diff operation. Keep its lifetime bounded, preserve read-only Git access, and add packed-repository regression coverage. This has the strongest measured benefit and does not need shell Git or broader file access.
2. Exclude configured generated output before snapshot export/hash/copy when a source entry is present; retain explicit preview entries and referenced assets. Do not categorically exclude arbitrary `docs` folders.
3. Index compiled artifacts by repository, immutable commit SHA and compiler version before snapshot export, validating live dependency fingerprints before reuse. Treat working-tree previews separately. Reuse a healthy running server when inputs have not changed.
4. Allow Base/Target preparation to overlap with bounded resource use, cancel obsolete selections, and report stages in the loading UI. Do not simply launch unlimited compiler workers; that would multiply packfile I/O and cache races.

The cache experiment suggests a single-revision cold preparation budget of roughly 5–6 seconds on this fixture (2.3 seconds export + 3.1 seconds compilation), before browser loading and other app work. This is an estimate to validate after integration, not a promised SLA. The second revision and arbitrary frameworks have not been measured by this experiment.

These proposals retain the existing direction of bundled compilation, no project package scripts and user-selected local file access.

## Reproduce

```sh
node_modules/.bin/electron scripts/profile-preview.cjs /absolute/repository
node_modules/.bin/electron scripts/profile-git-export.cjs /absolute/repository
node_modules/.bin/electron scripts/verify-desktop-preview.cjs /absolute/repository
```

Profiling scripts instrument an in-memory copy of the relevant module; they do not modify the production Git exporter or source repository. The Git comparison script now compares the production shared-cache implementation against an uncached baseline reconstructed in memory.

## Production verification after applying recommendation 1

The same desktop integration workflow on the representative project passed in **8,014 ms**, compared with **37,848 ms** in the earlier run. Both used a new temporary profile and build cache and included concurrent startup requests, actual frame rendering, external-fetch denial, stop and restart. These are sequential local observations, not a controlled benchmark or isolated first-paint times. All 69 npm tests passed, including packed-history export and post-commit freshness coverage.

## Generated-output exclusion verification

After the generated-output exclusion changes, preview output filtering was moved ahead of Git tree/blob extraction, working-folder copying, source hashing and compilation. Page discovery and explicit page manifests use the same output-directory policy, and desktop startup reuses the snapshot’s discovered page catalog. Ordinary Git export and code diff behavior remain unchanged.

On the same representative project in a new temporary cache:

| Stage | Measured after exclusion |
| --- | ---: |
| Export HEAD | 1,080.9 ms |
| Discover pages | 17.1 ms |
| Cold compile | 2,543 ms |
| Cached compile, two runs | 223.9 / 232.7 ms |
| Scan/hash within cold compile | 84.5 ms |
| Copy within cold compile | 102.2 ms |

The generated `docs` tree (206 files / 92,414,465 bytes in the original inventory) was absent from the snapshot. The desktop integration workflow passed in **4,649 ms**, compared with **8,014 ms** after Git cache sharing alone. Measurements were sequential local runs, not a controlled benchmark or a guarantee for other projects. All 73 npm tests passed. The desktop check also verifies excluded directories are absent from compiled output and the page catalog.
