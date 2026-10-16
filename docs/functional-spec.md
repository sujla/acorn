# Functional Specification

## 1. Repository connection

The user can select an existing local Git working folder without signing in. Acorn validates that the folder has at least one commit and stores up to 12 repository paths in Electron's user-data directory.

## 2. Ref selection and diffs

Base and Target list local branches followed by up to 50 recent commits. The default Base is `main`, `master`, or the first branch. Target defaults to the first commit entry displayed below the branch entries in the dropdown. If no commit entry is available, Target falls back to Base.

Different refs use `git diff` to load numeric statistics, file status, and unified patches. Identical refs compare `HEAD` with staged and unstaged changes to tracked files. Untracked files are not included.

## 3. Preview detection

Acorn exposes one UI Preview mode. It detects Mobile, Desktop, and Web platform
hints for labels and default frame dimensions, then discovers browser-renderable
entries from the selected revision.

The compiler selects the Expo pipeline when `package.json` declares Expo; other
supported browser source uses the general web compiler. There is no runtime selector.

## 4. Revision isolation

Working-folder previews copy selected source into a unique system temporary directory. A historical ref is exported with `git archive` into a temporary directory. Preview code never runs from the connected repository itself.

Acorn does not run `git checkout`, mutate the index, or modify repository history.

## 5. Expo web preview

For each selected revision Acorn uses its bundled SDK-specific compiler to produce a static web artifact, starts an ephemeral loopback file server, and renders it through the guarded preview proxy. It does not run `expo start` or execute project configuration and build plugins. Identical Base and Target refs share one compiled preview resource.

Expo SDK 54–57 is supported. Compatible local dependencies are reused. When a historical revision needs different dependencies, Acorn can create an isolated npm or supported Yarn 4 installation with package scripts disabled. Native-only behavior remains outside the preview's scope.

## 6. Web preview

Acorn compiles supported browser source or copies a compatible static entry into a cached artifact, then serves it from an ephemeral loopback file server. It does not run the project's `dev` script. The page picker controls the route shown by each guarded iframe.

## 7. Preview dimensions

Mobile-labelled projects start at a `390×844` logical viewport; other projects start at `1440×900`. The preview scales uniformly to fit its panel. Users can resize the frame directly, fit it to the available section, and adjust zoom.

Portrait previews also fit within the vertical space remaining in the window, preventing the preview frame from creating an outer page scrollbar. Git changes are hidden by default and open from the Show Diff action in a resizable right-side column that pushes the workspace instead of covering it. While open, the same action reads Close Diff and closes the column; the panel's own Close action remains available. Opening the column collapses the left navigation, and the column can grow to half of the app width. The preview grid responds to its remaining workspace width, stacking Base above Target when two side-by-side panels would be too narrow. App-shell scrollbars stay visually hidden while scrolling remains available; only the diff detail shows its scrollbar.

## 8. Refresh and cleanup

Repository activation and Base or Target changes schedule an automatic preview refresh. The manual button forces the same flow. Preview resources remain available across ref changes so a previous preview can be reused. App shutdown stops every preview server and removes temporary snapshots before quitting.

## 9. Error handling

Repository, Git, snapshot, compilation, dependency, and preview-server failures return through the preload bridge and appear in the existing modal, diff, loading, or notification surfaces.

## 10. MVP exclusions

- Android
- Remote fetch and remote branch browsing
- Commit, push, pull, merge, and rebase
- Pull-request integration and authentication management
- Native platform execution
- Historical dependency installation outside npm and the supported Yarn 4 configuration
- Packaged application distribution
