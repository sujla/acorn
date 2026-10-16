# Project Overview

## Purpose

Acorn is a local-first desktop review tool for comparing application behavior and source changes across Git branches and commits. Supported web and Expo source is compiled into guarded local web previews.

## Problem

Reviewing historical application states normally requires branch switching, stashing work, and starting multiple development servers. Those steps interrupt the active working directory and make side-by-side review cumbersome.

## Product approach

Acorn reads local branches and the latest 50 commits as Base and Target choices. It creates isolated snapshots without changing the active checkout, compiles each selected revision, and keeps the code diff in the same workspace.

For supported Expo and web projects, Base and Target are served from separate loopback URLs and embedded through Acorn's guarded preview proxy. Acorn does not start the project's development server.

## Primary workflow

1. Connect an existing local Git repository.
2. Let Acorn inspect the project's platform hints and preview entries.
3. Choose Base and Target.
4. Interact with both live previews and inspect the file diff.
5. Change refs; Acorn rebuilds and refreshes previews automatically.

## MVP scope

- Local Git repository connections
- Local branch and recent commit selection
- Tracked working-tree and ref-to-ref diffs
- Locally compiled web previews for supported Expo projects
- Locally compiled or static previews for supported web source
- Historical snapshots that do not change the original checkout
- Preview-session reuse across menu changes with resource cleanup on app exit

Android, iOS, native desktop execution, remote Git operations, pull-request features, and packaged distribution are outside the current MVP.

## Success criteria

- A supported Expo repository compiles into a web preview without a runtime choice.
- Base and Target can run concurrently without checking out either ref in the connected repository.
- Live previews accept the browser interactions supported by their web runtime.
- Web projects continue to work with a lighter preview path.
- The displayed Git diff reflects the selected Base and Target.
- Child processes and temporary snapshots are cleaned up reliably.
