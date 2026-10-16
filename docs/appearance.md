# Acorn appearance

Acorn defaults to **System**. The sidebar Appearance button opens a compact selection menu with Light,
Dark, and System. The active choice has a trailing check. Explicit choices persist in `localStorage` under `acorn.theme`.
System follows live OS color-scheme changes. Theme initialization runs before
the stylesheet is rendered so a saved preference is applied on first paint.

The neutral palette is adapted visually from these Linear screens on Mobbin:

- Light: https://mobbin.com/screens/dba91946-d147-4b2f-ad92-4195eae017fc
- Dark: https://mobbin.com/screens/267d16a1-982b-4479-85b5-22294fdab01a

These are Acorn's chosen values based on the references, not verified Linear
source tokens. Light uses a near-white workspace and pale gray sidebar; dark
uses a near-black workspace, slightly lighter sidebar, charcoal sections, and
subtly lighter gray secondary controls. Icon buttons retain transparent backgrounds.
Violet is based on `#6200eb`, with theme-adjusted primary actions: light `#6810e8` and dark `#7826ee`. It denotes primary actions
and selection accents; dark-mode accent text uses a lighter violet (`#b58aff`).
Green/red denote changes and status.

Semantic CSS variables cover shell surfaces, controls, overlays, and code diffs.
The shell's `color-scheme` is scoped to Acorn controls. Preview iframe elements
use `color-scheme: light dark`, allowing their preferred scheme to follow the
OS independently of Acorn's explicit override. Acorn does not modify preview
documents, their theme preferences, or Electron's global native theme source.

## Sidebar

The sidebar geometry and collapse behavior are visually adapted from ChatGPT's
web sidebar on Mobbin:

- Expanded: https://mobbin.com/screens/0bee4b5c-92de-42b2-91a1-7a6042f810b1
- Collapsed: https://mobbin.com/screens/d9925cb3-c483-46ed-8e7c-acfdf39185b9
- Flow: https://mobbin.com/flows/c5500dc5-efd5-4ad8-91fd-4f020669ad41
- Current full sidebar: https://mobbin.com/screens/83ee2b5a-1692-4041-896b-67d85ac1696d

Mobbin did not return a separate Codex app record; the selected ChatGPT capture includes a Codex navigation item.
Acorn uses the observed 14px navigation text, 12px group text,
36px navigation rows, 16px line icons, 8px item padding and corner radii,
and a 264px expanded / 56px collapsed sidebar. These are raster-derived
estimates (approximately +/-2px), not verified OpenAI source tokens. The collapsed rail keeps the Acorn mark,
reveals the expand control on hover or keyboard focus, and preserves the project and server-status icons.
Only geometry and interaction are adapted; colors continue to use Acorn's semantic theme variables.
Project connection, selection, drag reordering, server status, and appearance
controls retain their existing behavior. Long project names truncate in one
line and expose the full name as an accessible label and hover title.
Project rows intentionally use a consistent 16px outline folder icon rather than
loading each repository's favicon or application logo. Connect project uses the
matching folder-plus variant from the same navigation icon treatment.

## Appearance menu

The sidebar Appearance button opens a popover with Light, Dark, and System choices.
The selection applies immediately and the active choice shows a check mark. There
is no account-management or Preview Data section in this menu.
