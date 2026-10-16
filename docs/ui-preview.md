# Page browsing and UI-only previews

The control below each Base/Target revision is now a page picker. Click it to browse
folders in adjacent columns, then choose a page. Arrow keys navigate rows/columns;
Enter selects; Escape closes. Each side reads pages from its selected revision.
The current page is preserved across revision changes when its ID is still present;
otherwise the first available page is selected with a notification.

## What is discovered

- Acorn revisions: Workspace (empty state) and Settings, only when their
  corresponding DOM exists in the selected revision.
- Static HTML entry points outside generated/public output folders.
- Expo Router `app`/`src/app`, Next `pages`/`src/pages` and App Router page files.
- React Router JSX routes with literal absolute paths.
- Explicit `.acorn/pages.json`, when already present in the selected revision.

Routes under `docs` are omitted because the picker is limited to product UI results.

Route discovery is a best-effort page catalog, not a reconstruction of a product's
complete semantic IA. Computed routes, relative JSX routes, monorepo applications,
and routes expressed as arbitrary JavaScript are not inferred. Parameterized routes
are excluded until a concrete example path is supplied. No IDs are
invented. Invalid explicit configuration shows an error instead of silently falling
back to a different catalog.

## Explicit IA / UI entry points

An optional existing project configuration can provide labels, groups, and a separate
UI-only entry point. Acorn reads it; it does not write it to connected repositories.

```json
{
  "pages": [
    {
      "id": "order-complete",
      "label": "Order complete",
      "group": ["Shop", "Orders"],
      "path": "/orders/example/complete",
      "previewPath": "/preview/order-complete"
    }
  ]
}
```

`previewPath` must already render the screen without real authentication/API calls,
for example using local fixture props. It is not an auth-bypass flag. Acorn does not
inject login tokens, relax authorization, remove validation, or automatically make
an arbitrary protected React component render. Without a suitable preview entry,
an app's guard may still show a login screen or its data may remain unavailable.
Ordinary pages, including portfolios and landing pages, never automatically enter
Visual Preview / Sample data mode just because their URL changes. Discovered Expo
Router screens with both a Redirect and a supported account/session/profile/consent
hook automatically qualify for a synthetic-state retry after a failed direct
landing. This preserves guarded onboarding previews without requiring project
configuration. An initial URL event does not end the bounded watch, because React
guards may redirect after hydration. Other pages can explicitly set
`"visualFallback": true` in `.acorn/pages.json`. This uses the existing state-hook
adapter, not a general authentication bypass. Selecting an ordinary page leaves
synthetic-state mode. Detection is bounded to the screen source; indirect guards
in shared wrappers may still need explicit configuration.
Before populating the picker, Acorn checks each candidate in a hidden, isolated browser. HTTP failures, server/client redirects away from the requested path, blank renders, startup script failures and detected in-place login forms on non-login pages are excluded. Folders with no accepted pages are excluded too. This is a bounded loading check, not proof that every state of an arbitrary app can render. Page queries use the reserved `__acorn_page`
parameter internally; it is removed before forwarding to the local artifact server.

## Isolation and behavior

If no supported screen entry is found, the preview pane keeps a neutral empty
state instead of an error toast. This is a detection result, not proof that the
commit has no UI: unsupported entries or Preview Settings exclusions can also
cause it. Expo checks screen entries before preparing historical dependencies.
Missing dependency lockfiles and unsupported package managers remain separate
errors; neither is described as an absent screen.

Automatic Expo web previews compile plain CSS and `.module.css` with Acorn's
bundled compiler. CSS modules export scoped class names and inject their styles;
local `@import` rules and image/font URLs are bundled within the allowed preview
roots. Dependency CSS and assets participate in cache validation. Project PostCSS
configuration and plugins are not executed. Missing-module alerts show the import
and source file instead of temporary snapshot paths and resolver candidate lists.

- Both commit snapshots and Working folder use temporary directories. Working folder
  copies local edits and untracked files while excluding Git and runtime caches.
- The source compiler reads the connected project's installed packages when
  dependency declarations and lockfiles match, fingerprints the inputs it uses,
  and writes browser bundles to Acorn's cache. It does not execute package scripts.
  When dependency declarations or lockfiles
  differ, npm revisions get an isolated `npm ci --ignore-scripts` installation and
  supported Yarn 4 revisions get an immutable skip-build installation with scripts
  disabled in `preview-cache/installed-dependencies`; matching manifests and locks reuse it.
  Installation runs only when a browser source imports a package (or the Expo
  adapter needs its packages). Progress appears in the preview loading panel;
  refresh retries failed installations. Installation has a two-minute deadline.
  This requires local Node, the matching package manager, and registry access.
  pnpm/Bun locks, unsupported Yarn configurations, and workspace/local/Git packages
  are not supported yet.
  Project `.npmrc` files are not evaluated; custom install flags may need support.
  Completed installs persist across restarts; automatic eviction is not yet implemented.
- A local proxy injects the UI guard before project scripts. Browser API calls,
  network form submissions, WebSockets, workers, nested frames and external resources are blocked. Cookies
  from the upstream server are not forwarded. Clicks, inputs, keyboard interactions, local tabs/modals and client-side form validation remain active. Same-preview links, hash navigation and history work alongside the page picker. Native form network submissions are blocked after client submit handlers have run.
- Project development servers and package scripts are not run. Compilation reads and
  writes only within a temporary snapshot, temporary build directories, and Acorn's preview cache. The connected
  repository is not used as a preview working directory.
- Desktop bridge APIs are never exposed to the preview. Acorn's built-in adapter
  selects existing DOM views after load; it does not connect a real project or account.

This is a frontend inspection mode; it does not grant backend or desktop permissions. API-dependent
content, external fonts/images, HMR and server rendering that requires network access
may not work. Refresh restarts a Working-folder copy so local edits are picked up.
The comparison diff continues to use the original Git states; UI adapters are not
included in the source diff. Temporary servers and copies are removed on normal exit.

## Verification

Preview Settings recommendations follow references from root HTML pages, common
browser/Expo entry files, `.acorn/preview.json`, and Next/Expo Router route roots.
The scanner reads HTML/CSS resources, JS/TS imports and reexports, literal lazy
imports, tsconfig/jsconfig path aliases, bounded template paths and file globs.
Public assets and Expo assets are retained as implicit runtime inputs. Unlinked
tooling folders are no longer included simply because they are not build output.

This is bounded static analysis, not execution or proof of a minimum file set.
Computed imports without a usable prefix, unresolved local imports, unsupported
source/configuration, or scan limits keep uncertain folders selected with a reason.
No project code or configuration is executed, and symlinks are not followed.
Existing explicit choices take precedence; **Use recommendations** resets them.
Saving persists the effective folder selection for both working and historical
previews. Recommendations are computed from the connected working tree; a past
revision with different dependencies may require manually selecting another folder.

`node --test tests/preview-file-settings.test.cjs` checks reference graphs and
snapshot output. `node_modules/.bin/electron scripts/verify-preview-files.cjs`
checks recommendations, reset, save, historical inclusion and reload persistence
with a disposable repository and profile.

`npm test` includes catalog, snapshot-isolation, compiler, dependency, and HTTP-proxy tests.
`node_modules/.bin/electron scripts/verify-ui-preview.cjs` uses a temporary Electron
profile and an archived HEAD revision of Acorn to exercise the actual picker and
guard. It verifies direct landing, independent Base/Target selection, blocked APIs
and desktop actions, ordinary links/history, local form validation, and
unavailable-page filtering, and prints temporary screenshot paths.
