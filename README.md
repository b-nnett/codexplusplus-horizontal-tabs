# Codex Horizontal Tabs

Stable horizontal chat tabs for Codex++.

This tweak adds a native-feeling tab strip across the top of the Codex chat surface. It keeps recently opened chats available as tabs, mirrors Codex's own tab styling, and stays focused on one job: fast horizontal navigation between chats.

Version `1.0.0` is intentionally scoped to the horizontal tab bar only. Split-view work lives on the `split-view-added` branch.

## Features

- Horizontal tab bar for open Codex chats
- Native Codex-style selected, hover, divider, and close states
- Sidebar-aware unread and running indicators
- Keyboard shortcuts for `Cmd+1` through `Cmd+9`
- `Cmd+W` closes the current tab
- Drag and drop to reorder tabs
- Middle-click to close a tab
- Right-click tab context menu
- Uses Codex's original chat actions menu for selected tabs
- Opens chats from the sidebar and recent chat history
- Preserves tab order independently from Codex navigation
- Hides the tab strip on settings surfaces

## Install

Clone the tweak into your Codex++ tweaks folder:

```sh
cd "$HOME/Library/Application Support/codex-plusplus/tweaks"
git clone https://github.com/b-nnett/codexplusplus-horizontal-tabs.git co.bennett.codex-horizontal-tabs
```

Then reload Codex or restart the app.

For local development from this repository, symlink the project folder instead:

```sh
ln -s "/Users/bennett/Documents/Projects/codexplusplus-horizontal-tabs" \
  "$HOME/Library/Application Support/codex-plusplus/tweaks/co.bennett.codex-horizontal-tabs"
```

## Branches

- `stable-1.0.0`: stable release branch for horizontal tabs.
- `split-view-added`: experimental branch with split-view tab panes.

## Notes

Codex does not expose a public open-tabs API. This tweak maintains a small local open-tab list and uses visible sidebar rows plus recent session history to keep titles, unread state, and running indicators fresh.

The selected tab's ellipsis button delegates to Codex's native chat actions menu. That keeps rename, archive, mini-window, and other first-party actions aligned with the app instead of recreating them.
