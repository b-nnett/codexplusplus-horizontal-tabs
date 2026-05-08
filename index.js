/**
 * Codex Horizontal Tabs
 *
 * Adds a Chrome-like top tab strip for local Codex conversations. The renderer
 * owns the DOM tab strip and menu; main owns local session-index reads and route
 * navigation through Codex's native desktop message channel.
 */

const IPC_RECENT_CHATS = "recent-chats";
const IPC_NAVIGATE_CHAT = "navigate-chat";
const MAX_TABS = 9;
const RECENT_SCAN_LIMIT = 24;
const OPEN_IDS_KEY = "open-tab-ids:v1";
const CLOSED_IDS_KEY = "closed-tab-ids:v1";
const KNOWN_TABS_KEY = "known-tabs:v1";
const RENDERER_STATE_KEY = "__codexppConversationTabsState";
const RENDERER_STATES_KEY = "__codexppConversationTabsStates";
const RENDERER_GENERATION_KEY = "__codexppConversationTabsGeneration";
const PENDING_NEW_CHAT_TTL_MS = 120000;

/** @type {import("@codex-plusplus/sdk").Tweak} */
module.exports = {
  start(api) {
    if (api.process === "main") {
      startMain(api);
      return;
    }
    startRenderer(this, api);
  },

  stop() {
    if (typeof window !== "undefined") disposeAllRendererStates(this._state);
    if (typeof document !== "undefined") cleanupOrphanTabBars();
  },
};

// ---------------------------------------------------------------- renderer --

function startRenderer(self, api) {
  disposeAllRendererStates();
  cleanupOrphanTabBars();

  const state = {
    api,
    disposed: false,
    root: null,
    list: null,
    style: null,
    menu: null,
    tabs: [],
    openIds: readArray(api, OPEN_IDS_KEY),
    closedIds: new Set(readArray(api, CLOSED_IDS_KEY)),
    knownTabs: readKnownTabs(api),
    currentChatId: getCurrentChatId(),
    lastUrl: window.location.href,
    refreshTimer: null,
    refreshing: false,
    observer: null,
    routePoll: null,
    activationSeq: 0,
    pendingNewChat: null,
    generation: nextRendererGeneration(),
    draggedTabId: null,
    dragDropTargetId: null,
    dragDropSide: null,
    dragSuppressClick: false,
    onKeyDown: null,
    onDocumentPointerDown: null,
    onNewChatIntent: null,
    onRouteChange: null,
    onResize: null,
    onTabShortcut: null,
    onCloseCurrentTabShortcut: null,
  };
  self._state = state;
  window[RENDERER_STATE_KEY] = state;
  registerRendererState(state);

  installStyle(state);
  ensureTabBar(state);

  state.onKeyDown = (event) => {
    handleGlobalKeyDown(state, event);
  };
  state.onTabShortcut = (event) => {
    const index = Number(event.detail?.index);
    if (!Number.isInteger(index)) return;
    if (activateTabAtIndex(state, index)) event.preventDefault();
  };
  state.onCloseCurrentTabShortcut = (event) => {
    if (closeCurrentTab(state)) event.preventDefault();
  };
  state.onDocumentPointerDown = (event) => {
    handleDocumentPointerDown(state, event);
  };
  state.onNewChatIntent = (event) => {
    beginPendingNewChat(state, event?.detail?.source || "shortcut");
  };
  state.onRouteChange = () => handleRouteChange(state);

  document.addEventListener("keydown", state.onKeyDown, true);
  document.addEventListener("pointerdown", state.onDocumentPointerDown, true);
  window.addEventListener("codexpp-conversation-tab-new-chat-intent", state.onNewChatIntent);
  window.addEventListener("codexpp-conversation-tab-shortcut", state.onTabShortcut);
  window.addEventListener("codexpp-conversation-tab-close-current", state.onCloseCurrentTabShortcut);
  window.addEventListener("popstate", state.onRouteChange);
  window.addEventListener("hashchange", state.onRouteChange);
  state.onResize = () => updateTabMaskVisibility(state.root);
  window.addEventListener("resize", state.onResize);
  patchHistory();

  state.observer = new MutationObserver((mutations) => {
    const externalMutations = mutations.filter((mutation) => !isOwnMutationTarget(state, mutation.target));
    const changedLayout = ensureTabBar(state);
    const changedActiveThread = externalMutations.some((mutation) =>
      mutation.type === "attributes" &&
      (
        mutation.attributeName === "data-app-action-sidebar-thread-active" ||
        mutation.attributeName === "aria-current" ||
        mutation.attributeName === "data-state"
      )
    );
    const changedThreadTitle = externalMutations.some(isThreadTitleMutation);
    if (changedLayout || changedActiveThread || changedThreadTitle) {
      if (changedThreadTitle) syncHeaderIntegration(state);
      scheduleRefresh(state, changedActiveThread ? 40 : 80);
    }
  });
  state.observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [
      "data-app-action-sidebar-thread-active",
      "data-app-action-sidebar-thread-title",
      "aria-current",
      "data-state",
    ],
    childList: true,
    characterData: true,
    subtree: true,
  });
  state.routePoll = window.setInterval(() => handleRouteChange(state), 800);
  scheduleRefresh(state, 0);
  api.log.info("[conversation-tabs] renderer active");
}

function disposeRendererState(state) {
  if (!state) return;
  if (typeof document === "undefined" || typeof window === "undefined") return;
  state.disposed = true;
  unregisterRendererState(state);
  document.removeEventListener("keydown", state.onKeyDown, true);
  document.removeEventListener("pointerdown", state.onDocumentPointerDown, true);
  window.removeEventListener("codexpp-conversation-tab-shortcut", state.onTabShortcut);
  window.removeEventListener("codexpp-conversation-tab-close-current", state.onCloseCurrentTabShortcut);
  window.removeEventListener("codexpp-conversation-tab-new-chat-intent", state.onNewChatIntent);
  window.removeEventListener("popstate", state.onRouteChange);
  window.removeEventListener("hashchange", state.onRouteChange);
  window.removeEventListener("resize", state.onResize);
  window.removeEventListener("codexpp-conversation-tabs-route", state.onRouteChange);
  if (state.refreshTimer) window.clearTimeout(state.refreshTimer);
  if (state.routePoll) window.clearInterval(state.routePoll);
  state.observer?.disconnect();
  closeMenu(state);
  closeTabHoverTooltip();
  clearNativeChatActionsButton(state);
  state.root?.remove();
  state.style?.remove();
  clearNativeHeaderTitleHiding();
  if (window[RENDERER_STATE_KEY] === state) {
    window[RENDERER_STATE_KEY] = null;
  }
}

function disposeAllRendererStates(extraState) {
  if (typeof window === "undefined") return;
  const states = rendererStates();
  if (extraState) states.add(extraState);
  if (window[RENDERER_STATE_KEY]) states.add(window[RENDERER_STATE_KEY]);
  for (const state of Array.from(states)) disposeRendererState(state);
  window[RENDERER_STATES_KEY] = new Set();
  window[RENDERER_STATE_KEY] = null;
}

function rendererStates() {
  if (typeof window === "undefined") return new Set();
  const existing = window[RENDERER_STATES_KEY];
  if (existing instanceof Set) return existing;
  const next = new Set();
  window[RENDERER_STATES_KEY] = next;
  return next;
}

function registerRendererState(state) {
  rendererStates().add(state);
}

function unregisterRendererState(state) {
  const states = rendererStates();
  states.delete(state);
}

function nextRendererGeneration() {
  const next = (Number(window[RENDERER_GENERATION_KEY]) || 0) + 1;
  window[RENDERER_GENERATION_KEY] = next;
  return next;
}

function isActiveRendererState(state) {
  return (
    !!state &&
    !state.disposed &&
    window[RENDERER_STATE_KEY] === state &&
    state.generation === window[RENDERER_GENERATION_KEY]
  );
}

function installStyle(state) {
  document.getElementById("codexpp-vertical-tabs-style")?.remove();
  document.getElementById("codexpp-conversation-tabs-style")?.remove();
  const style = document.createElement("style");
  style.id = "codexpp-conversation-tabs-style";
  style.textContent = `
    [data-codexpp-conversation-tabs="true"] {
      --codexpp-tabbar-left-safe-area: 0px;
      --codexpp-tabbar-right-safe-area: 96px;
      --codexpp-tab-close-mask-solid: 21px;
      --codexpp-tab-close-mask-fade: 26px;
      --codexpp-tab-scroll-mask-solid: 5px;
      --codexpp-tab-scroll-mask-fade: 14px;
      contain: layout paint;
      pointer-events: auto;
      -webkit-app-region: no-drag;
    }

    [data-codexpp-conversation-tabs="true"][data-codexpp-conversation-tabs-hidden="true"] {
      display: none !important;
    }

    [data-codexpp-conversation-tabs="true"][data-codexpp-conversation-tabs-placement="header"] {
      position: fixed !important;
      inset-inline-start: var(--codexpp-tabbar-left-safe-area) !important;
      inset-inline-end: var(--codexpp-tabbar-right-safe-area) !important;
      top: 0 !important;
      z-index: 31 !important;
      height: var(--height-toolbar, 46px) !important;
      border-bottom: 0 !important;
      background: transparent !important;
      overflow: hidden !important;
      padding-inline: 0 !important;
    }

    [data-codexpp-conversation-tabs="true"][data-codexpp-conversation-tabs-placement="flow"] {
      pointer-events: auto;
    }

    [data-codexpp-conversation-tabs-list="true"] {
      box-sizing: border-box;
      gap: 3px;
      inset: 0;
      padding-inline-end: 0.5rem;
      padding-inline-start: 0.5rem;
      pointer-events: auto;
      scrollbar-width: none;
      mask-image: none;
      -webkit-app-region: no-drag;
    }

    [data-codexpp-conversation-tabs="true"][data-codexpp-conversation-tabs-placement="header"] [data-codexpp-conversation-tabs-list="true"] {
      position: absolute;
      inset-inline-start: 0;
      inset-inline-end: 0;
      padding-inline-start: 0.5rem;
      padding-inline-end: 0.5rem;
      pointer-events: auto;
    }

    [data-codexpp-conversation-tabs-list="true"]::-webkit-scrollbar {
      display: none;
    }

    [data-codexpp-conversation-tabs="true"][data-codexpp-left-mask-visible="true"]:not([data-codexpp-right-mask-visible="true"]) [data-codexpp-conversation-tabs-list="true"] {
      mask-image: linear-gradient(
        to right,
        transparent 0,
        transparent var(--codexpp-tab-scroll-mask-solid),
        black var(--codexpp-tab-scroll-mask-fade)
      );
    }

    [data-codexpp-conversation-tabs="true"]:not([data-codexpp-left-mask-visible="true"])[data-codexpp-right-mask-visible="true"] [data-codexpp-conversation-tabs-list="true"] {
      mask-image: linear-gradient(
        to right,
        black 0,
        black calc(100% - var(--codexpp-tab-scroll-mask-fade)),
        transparent calc(100% - var(--codexpp-tab-scroll-mask-solid)),
        transparent 100%
      );
    }

    [data-codexpp-conversation-tabs="true"][data-codexpp-left-mask-visible="true"][data-codexpp-right-mask-visible="true"] [data-codexpp-conversation-tabs-list="true"] {
      mask-image: linear-gradient(
        to right,
        transparent 0,
        transparent var(--codexpp-tab-scroll-mask-solid),
        black var(--codexpp-tab-scroll-mask-fade),
        black calc(100% - var(--codexpp-tab-scroll-mask-fade)),
        transparent calc(100% - var(--codexpp-tab-scroll-mask-solid)),
        transparent 100%
      );
    }

    [data-codexpp-conversation-tab="true"] {
      --app-shell-tab-background: color-mix(
        in srgb,
        var(--color-token-foreground) 5%,
        var(--color-token-main-surface-primary)
      );
      --codexpp-tab-hover-min-width: 5rem;
      background: var(--color-token-main-surface-primary);
      cursor: var(--cursor-interaction, pointer);
      padding-inline-end: 0.5rem;
      -webkit-app-region: no-drag;
      pointer-events: auto;
    }

    [data-codexpp-conversation-tab="true"][aria-selected="true"] {
      max-width: max(9rem, min(30rem, calc(100vw - var(--codexpp-tabbar-left-safe-area) - var(--codexpp-tabbar-right-safe-area) - 8rem))) !important;
      padding-inline-end: 1.75rem;
    }

    [data-codexpp-conversation-tab="true"]:hover,
    [data-codexpp-conversation-tab="true"]:focus-within,
    [data-codexpp-conversation-tab="true"][data-codexpp-hovered="true"] {
      background: var(--color-token-list-hover-background, var(--app-shell-tab-background));
      min-width: var(--codexpp-tab-hover-min-width);
    }

    [data-codexpp-conversation-tab="true"][aria-selected="true"] {
      background: var(--app-shell-tab-background);
    }

    [data-codexpp-conversation-tab-wrapper="true"] {
      align-items: center;
      contain: content;
      display: flex;
      flex-shrink: 0;
      gap: 0.125rem;
      margin-block: auto;
      padding-inline-end: 0.25rem;
      position: relative;
    }

    [data-codexpp-conversation-tab-wrapper="true"][data-codexpp-drop-before="true"]::before,
    [data-codexpp-conversation-tab-wrapper="true"][data-codexpp-drop-after="true"]::after {
      background: var(--color-token-text-link-foreground, var(--color-token-foreground));
      border-radius: 9999px;
      bottom: 0.375rem;
      content: "";
      position: absolute;
      top: 0.375rem;
      width: 2px;
      z-index: 30;
    }

    [data-codexpp-conversation-tab-wrapper="true"][data-codexpp-drop-before="true"]::before {
      inset-inline-start: 0;
    }

    [data-codexpp-conversation-tab-wrapper="true"][data-codexpp-drop-after="true"]::after {
      inset-inline-end: 1px;
    }

    [data-codexpp-conversation-tab-divider="true"] {
      background: var(--color-token-border, var(--color-token-border-default, rgba(252, 252, 252, 0.153)));
      height: 0.75rem;
      inset-inline-end: 0;
      opacity: 1;
      pointer-events: none;
      position: absolute;
      top: 50%;
      transform: translateY(-50%);
      transition: opacity 200ms;
      width: 1px;
    }

    [data-codexpp-conversation-tab-wrapper="true"][data-codexpp-conversation-tab-divider-hidden="true"] [data-codexpp-conversation-tab-divider="true"] {
      opacity: 0;
    }

    [data-codexpp-conversation-tab="true"][data-codexpp-dragging="true"] {
      opacity: 0.55;
    }

    [data-codexpp-conversation-tab="true"][data-codexpp-conversation-tab-unread="true"] [data-codexpp-conversation-tab-activate="true"] {
      color: var(--color-token-text-primary);
    }

    [data-codexpp-conversation-tab-title="true"] {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    [data-codexpp-conversation-tab-indicators="true"]:not(:empty) {
      margin-inline-start: 0.375rem;
    }

    [data-codexpp-conversation-tab="true"]:hover [data-codexpp-conversation-tab-body="true"],
    [data-codexpp-conversation-tab="true"]:focus-within [data-codexpp-conversation-tab-body="true"],
    [data-codexpp-conversation-tab="true"][data-codexpp-hovered="true"] [data-codexpp-conversation-tab-body="true"] {
      mask-image: linear-gradient(
        to right,
        transparent 0,
        transparent var(--codexpp-tab-close-mask-solid),
        black var(--codexpp-tab-close-mask-fade)
      );
    }

    [data-codexpp-conversation-tab-close="true"] {
      inset-inline-start: 0;
      top: 0;
      height: 100% !important;
      width: 1.625rem !important;
      justify-content: center;
      padding-inline-start: 0;
      opacity: 0;
      pointer-events: none;
      background: transparent !important;
      backdrop-filter: none;
      -webkit-app-region: no-drag;
    }

    [data-codexpp-conversation-tab-more="true"] {
      inset-inline-end: 0.125rem;
      top: 0.125rem;
      opacity: 1;
      pointer-events: auto;
      -webkit-app-region: no-drag;
    }

    [data-codexpp-conversation-tabs="true"][data-codexpp-native-chat-actions-mounted="true"] [data-codexpp-conversation-tab-more="true"] {
      opacity: 0;
      pointer-events: none;
    }

    [data-codexpp-conversation-tab="true"]:hover [data-codexpp-conversation-tab-close="true"],
    [data-codexpp-conversation-tab="true"]:focus-within [data-codexpp-conversation-tab-close="true"],
    [data-codexpp-conversation-tab="true"][data-codexpp-hovered="true"] [data-codexpp-conversation-tab-close="true"],
    [data-codexpp-conversation-tab-close="true"]:focus-visible {
      opacity: 1;
      pointer-events: auto;
    }

    [data-codexpp-conversation-tab="true"] button {
      -webkit-app-region: no-drag;
    }

    [data-codexpp-conversation-tabs-mask] {
      display: none !important;
    }

    [data-codexpp-conversation-tabs-right-spacer="true"] {
      display: none !important;
    }

    [data-codexpp-conversation-tabs-right-mask="true"] {
      display: none !important;
    }

    [data-codexpp-tab-hover-tooltip="true"] {
      position: fixed;
      z-index: 2147483647;
      max-width: min(20rem, calc(100vw - 16px));
      pointer-events: none;
    }

    [data-codexpp-native-title-hidden="true"],
    [data-codexpp-native-title-hidden="true"] * {
      opacity: 0 !important;
      pointer-events: none !important;
      visibility: hidden !important;
    }

    [data-codexpp-native-chat-actions-button="true"] {
      -webkit-app-region: no-drag !important;
      opacity: 1 !important;
      pointer-events: auto !important;
      visibility: visible !important;
    }

    [data-codexpp-native-chat-actions-button="true"][data-codexpp-native-chat-actions-suppressed="true"] {
      opacity: 0 !important;
      pointer-events: none !important;
      visibility: hidden !important;
    }

    header:has([data-codexpp-native-chat-actions-button="true"]) {
      z-index: 32 !important;
      pointer-events: none !important;
    }

    header:has([data-codexpp-native-chat-actions-button="true"]) button,
    header:has([data-codexpp-native-chat-actions-button="true"]) [role="button"] {
      pointer-events: auto !important;
    }

    [data-codexpp-conversation-tabs-menu="true"] {
      min-width: 190px;
      animation: codexppConversationTabsMenuIn 80ms ease-out;
    }

    [data-codexpp-conversation-tabs-menu-item="true"] {
      width: 100%;
    }

    [data-codexpp-conversation-tabs-menu-item="true"]:hover,
    [data-codexpp-conversation-tabs-menu-item="true"]:focus-visible {
      background: var(--color-token-list-hover-background);
      outline: none;
    }

    [data-codexpp-conversation-tabs-menu-item="true"][disabled] {
      cursor: default;
      opacity: 0.45;
    }

    @keyframes codexppConversationTabsMenuIn {
      from { opacity: 0; transform: translateY(-2px) scale(0.98); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

    @media (max-width: 960px) {
      [data-codexpp-conversation-tab="true"]:not([aria-selected="true"]) {
        max-width: 9.75rem !important;
      }
    }
  `;
  document.head.appendChild(style);
  state.style = style;
}

function cleanupOrphanTabBars(keep) {
  for (const node of document.querySelectorAll("[data-codexpp-conversation-tabs='true']")) {
    if (node !== keep) node.remove();
  }
}

function ensureTabBar(state) {
  if (!isActiveRendererState(state)) return false;
  const header = findAppHeader();
  const main = findMainSurface();
  const layout = findContentLayoutRow();
  if (!header && (!main || !layout)) {
    if (state.root) syncTabBarVisibility(state);
    return false;
  }
  let changed = false;
  if (!header && layout?.getAttribute("data-codexpp-conversation-tabs-layout") !== "true") {
    layout?.setAttribute("data-codexpp-conversation-tabs-layout", "true");
    changed = true;
  }

  if (!state.root) {
    const root = el(
      "div",
      "relative z-10 box-content flex h-toolbar min-w-0 shrink-0 items-center gap-1 border-b border-token-border-default bg-token-main-surface-primary px-2",
    );
    root.setAttribute("data-codexpp-conversation-tabs", "true");
    root.setAttribute("data-app-shell-tab-controller", "codexpp-conversation-tabs");
    root.setAttribute("aria-label", "Open chats");

    const list = el(
      "div",
      "hide-scrollbar relative flex h-full min-w-0 flex-1 scroll-px-1 items-center gap-1 overflow-x-auto overflow-y-hidden",
    );
    list.setAttribute("data-codexpp-conversation-tabs-list", "true");
    list.setAttribute("role", "tablist");
    list.setAttribute("aria-orientation", "horizontal");
    list.addEventListener("wheel", (event) => {
      if (!shouldUseWheelForHorizontalTabs(list, event)) return;
      event.preventDefault();
      list.scrollLeft += event.deltaY;
      updateTabMaskVisibility(root);
    }, { passive: false });
    list.addEventListener("scroll", () => {
      updateTabMaskVisibility(root);
      syncNativeChatActionsButton(state);
    }, { passive: true });
    list.addEventListener("dragover", (event) => handleTabListDragOver(state, event));
    list.addEventListener("drop", (event) => handleTabDrop(state, event));
    list.addEventListener("dragleave", (event) => handleTabListDragLeave(state, event));
    root.appendChild(list);
    state.root = root;
    state.list = list;
    changed = true;
  }

  cleanupOrphanTabBars(state.root);

  state.root.querySelectorAll("[data-codexpp-conversation-tabs-mask]").forEach((node) => node.remove());
  state.root.querySelector("[data-codexpp-conversation-tabs-right-mask='true']")?.remove();
  state.root.querySelector("[data-codexpp-conversation-tabs-right-spacer='true']")?.remove();

  if (header) {
    if (state.root.getAttribute("data-codexpp-conversation-tabs-placement") !== "header") {
      state.root.setAttribute("data-codexpp-conversation-tabs-placement", "header");
      changed = true;
    }
    if (state.root.parentElement !== document.body) {
      document.body.appendChild(state.root);
      changed = true;
    }
  } else if (main && layout && (state.root.parentElement !== main || state.root.nextElementSibling !== layout)) {
    if (state.root.getAttribute("data-codexpp-conversation-tabs-placement") !== "flow") {
      state.root.setAttribute("data-codexpp-conversation-tabs-placement", "flow");
      changed = true;
    }
    main.insertBefore(state.root, layout);
    changed = true;
  }
  if (!syncTabBarVisibility(state)) return changed;
  syncHeaderIntegration(state);
  updateTabMaskVisibility(state.root);
  syncNativeChatActionsButton(state);
  return changed;
}

function findAppHeader() {
  return document.querySelector("header");
}

function findMainSurface() {
  return document.querySelector("main.main-surface");
}

function findContentLayoutRow() {
  const rows = Array.from(
    document.querySelectorAll("main.main-surface div.relative.flex.min-h-0.flex-1.overflow-hidden"),
  );
  return rows.find((row) =>
    row instanceof HTMLElement &&
    Array.from(row.children).some(
      (child) =>
        child instanceof HTMLElement &&
        child.getAttribute("data-app-shell-main-content-layout") != null,
    )
  ) || null;
}

function shouldShowConversationTabs(state) {
  if (isSettingsViewOpen()) return false;
  if (isSettingsRoute(window.location.pathname) || isSettingsRoute(window.location.href)) return false;
  return Boolean(
    chatIdFromPathname(window.location.pathname) ||
    chatIdFromHref(window.location.href) ||
    currentChatIdFromSidebarActive() ||
    currentChatIdFromActiveLink() ||
    state?.currentChatId ||
    state?.tabs?.length ||
    state?.openIds?.length
  );
}

function isSettingsRoute(value) {
  return /(?:^|[/?#])(?:settings|account|preferences)(?:[/?#]|$)/i.test(String(value || ""));
}

function isSettingsViewOpen() {
  const dialogs = Array.from(document.querySelectorAll("[role='dialog'], [data-radix-dialog-content]"));
  if (dialogs.some((node) => node instanceof HTMLElement && isVisibleElement(node) && hasSettingsTitle(node))) {
    return true;
  }
  if (hasSettingsNavigation()) return true;
  if (chatIdFromPathname(window.location.pathname) || chatIdFromHref(window.location.href)) return false;
  const main = findMainSurface();
  return main instanceof HTMLElement && hasSettingsTitle(main);
}

function hasSettingsNavigation() {
  const labels = new Set([
    "General",
    "Appearance",
    "Configuration",
    "Personalization",
    "MCP servers",
    "Git",
    "Environments",
    "Worktrees",
    "Browser",
    "Archived chats",
  ]);
  let visibleCount = 0;
  for (const button of document.querySelectorAll("button[aria-label]")) {
    if (!(button instanceof HTMLElement) || !isVisibleElement(button)) continue;
    if (!labels.has(button.getAttribute("aria-label") || "")) continue;
    const rect = button.getBoundingClientRect();
    if (rect.left > 360 || rect.width < 120) continue;
    visibleCount += 1;
    if (visibleCount >= 5) return true;
  }
  return false;
}

function hasSettingsTitle(root) {
  const label = normalizeIndicatorText(root.getAttribute("aria-label") || "");
  if (/^(settings|preferences|account)$/.test(label)) return true;
  const headings = Array.from(root.querySelectorAll("h1, h2, [role='heading']"));
  return headings.some((node) =>
    node instanceof HTMLElement &&
    isVisibleElement(node) &&
    /^(settings|preferences|account)$/.test(normalizeIndicatorText(node.textContent))
  );
}

function syncHeaderIntegration(state) {
  if (state.disposed || !state.root || !shouldShowConversationTabs(state)) return;
  hideNativeHeaderTitle(state);
  updateHeaderSafeAreas(state.root);
}

function syncTabBarVisibility(state) {
  if (!state.root) return false;
  const visible = shouldShowConversationTabs(state);
  setBooleanAttribute(state.root, "data-codexpp-conversation-tabs-hidden", !visible);
  if (!visible) {
    clearNativeHeaderTitleHiding();
    clearNativeChatActionsButton(state);
    closeMenu(state);
    closeTabHoverTooltip();
    state.root.removeAttribute("data-codexpp-left-mask-visible");
    state.root.removeAttribute("data-codexpp-right-mask-visible");
  }
  return visible;
}

function updateHeaderSafeAreas(root) {
  const header = findAppHeader();
  const rootRect = root.getBoundingClientRect();
  let leftSafeArea = 0;
  let rightSafeArea = 96;
  let sidebarOpen = false;
  if (header && rootRect.width > 0) {
    const headerRect = header.getBoundingClientRect();
    const controlRects = Array.from(header.querySelectorAll("button, [role='button']"))
      .filter((node) =>
        node instanceof HTMLElement &&
        !root.contains(node) &&
        node.getAttribute("data-codexpp-native-chat-actions-button") !== "true" &&
        isVisibleHeaderControl(node)
      )
      .map((node) => node.getBoundingClientRect())
      .filter((rect) =>
        rect.width > 1 &&
        rect.height > 1 &&
        rect.bottom > headerRect.top &&
        rect.top < headerRect.bottom &&
        rect.right > headerRect.left &&
        rect.left < headerRect.right
      );
    const leftBoundary = headerRect.left + Math.min(260, headerRect.width * 0.26);
    const rightBoundary = headerRect.left + headerRect.width * 0.62;
    const leftRects = controlRects.filter((rect) => rect.left + rect.width / 2 < leftBoundary);
    const rightRects = controlRects.filter((rect) => rect.left > rightBoundary);
    if (leftRects.length) {
      const toolbarRight = Math.max(...leftRects.map((rect) => rect.right));
      leftSafeArea = Math.max(0, Math.min(320, Math.ceil(toolbarRight - headerRect.left + 16)));
    }
    const main = findMainSurface();
    const mainRect = main?.getBoundingClientRect();
    if (mainRect && mainRect.left > headerRect.left + 1 && mainRect.left < headerRect.right - 240) {
      const mainOffset = mainRect.left - headerRect.left;
      sidebarOpen = mainOffset > 80;
      leftSafeArea = Math.max(leftSafeArea, Math.min(520, sidebarOpen ? mainOffset : Math.ceil(mainOffset + 8)));
    }
    if (rightRects.length) {
      const toolbarLeft = Math.min(...rightRects.map((rect) => rect.left));
      rightSafeArea = Math.max(96, Math.min(maxHeaderRightSafeArea(headerRect, leftSafeArea), Math.ceil(headerRect.right - toolbarLeft + 16)));
    }
    const rightPanelRect = findRightPanelRect(headerRect);
    if (rightPanelRect) {
      rightSafeArea = Math.max(
        rightSafeArea,
        Math.min(maxHeaderRightSafeArea(headerRect, leftSafeArea), Math.ceil(headerRect.right - rightPanelRect.left)),
      );
    }
  }
  root.style.setProperty("--codexpp-tabbar-left-safe-area", `${leftSafeArea}px`);
  root.style.setProperty("--codexpp-tabbar-right-safe-area", `${rightSafeArea}px`);
  root.setAttribute("data-codexpp-sidebar-open", String(sidebarOpen));
  updateTabMaskVisibility(root);
}

function isVisibleHeaderControl(node) {
  const style = getComputedStyle(node);
  return style.display !== "none" && style.visibility !== "hidden";
}

function maxHeaderRightSafeArea(headerRect, leftSafeArea) {
  return Math.max(96, Math.floor(headerRect.width - leftSafeArea - 160));
}

function findRightPanelRect(headerRect) {
  const panels = Array.from(document.querySelectorAll("[data-app-shell-focus-area='right-panel']"));
  for (const panel of panels) {
    if (!(panel instanceof HTMLElement) || !isVisibleElement(panel)) continue;
    const rect = panel.getBoundingClientRect();
    if (rect.width < 120 || rect.height < headerRect.height) continue;
    if (rect.left <= headerRect.left + 240) continue;
    if (rect.right < headerRect.right - 4) continue;
    return rect;
  }
  return null;
}

function syncNativeChatActionsButton(state) {
  if (!state.root || state.root.getAttribute("data-codexpp-conversation-tabs-hidden") === "true") {
    clearNativeChatActionsButton(state);
    return;
  }
  const nativeButton = findChatActionsButton();
  const placeholder = state.root.querySelector("[data-codexpp-conversation-tab-more='true']");
  if (!(nativeButton instanceof HTMLElement)) {
    clearNativeChatActionsButton(state);
    return;
  }
  if (!(placeholder instanceof HTMLElement)) {
    suppressNativeChatActionsButton(state, nativeButton);
    return;
  }

  const rect = placeholder.getBoundingClientRect();
  const listRect = state.list?.getBoundingClientRect();
  if (rect.width <= 1 || rect.height <= 1 || !isRectFullyVisibleWithin(rect, listRect)) {
    suppressNativeChatActionsButton(state, nativeButton);
    return;
  }

  nativeButton.setAttribute("data-codexpp-native-chat-actions-button", "true");
  nativeButton.removeAttribute("data-codexpp-native-chat-actions-suppressed");
  nativeButton.style.position = "fixed";
  nativeButton.style.left = `${rect.left}px`;
  nativeButton.style.top = `${rect.top}px`;
  nativeButton.style.width = `${rect.width}px`;
  nativeButton.style.height = `${rect.height}px`;
  nativeButton.style.zIndex = "33";
  nativeButton.style.opacity = "1";
  nativeButton.style.pointerEvents = "auto";
  nativeButton.style.visibility = "visible";
  state.root.setAttribute("data-codexpp-native-chat-actions-mounted", "true");
}

function suppressNativeChatActionsButton(state, nativeButton) {
  state?.root?.removeAttribute("data-codexpp-native-chat-actions-mounted");
  nativeButton.setAttribute("data-codexpp-native-chat-actions-button", "true");
  nativeButton.setAttribute("data-codexpp-native-chat-actions-suppressed", "true");
  for (const property of ["position", "left", "top", "width", "height", "zIndex"]) {
    nativeButton.style[property] = "";
  }
  nativeButton.style.opacity = "0";
  nativeButton.style.pointerEvents = "none";
  nativeButton.style.visibility = "hidden";
}

function isRectFullyVisibleWithin(rect, bounds) {
  if (!bounds || bounds.width <= 1 || bounds.height <= 1) return false;
  return (
    rect.left >= bounds.left - 1 &&
    rect.right <= bounds.right + 1 &&
    rect.top >= bounds.top - 1 &&
    rect.bottom <= bounds.bottom + 1
  );
}

function clearNativeChatActionsButton(state) {
  state?.root?.removeAttribute("data-codexpp-native-chat-actions-mounted");
  for (const node of document.querySelectorAll("[data-codexpp-native-chat-actions-button='true']")) {
    if (!(node instanceof HTMLElement)) continue;
    node.removeAttribute("data-codexpp-native-chat-actions-button");
    node.removeAttribute("data-codexpp-native-chat-actions-suppressed");
    for (const property of ["position", "left", "top", "width", "height", "zIndex", "opacity", "pointerEvents", "visibility"]) {
      node.style[property] = "";
    }
  }
}

function shouldUseWheelForHorizontalTabs(list, event) {
  if (list.scrollWidth <= list.clientWidth + 1) return false;
  if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return false;
  const maxScrollLeft = list.scrollWidth - list.clientWidth;
  if (event.deltaY < 0 && list.scrollLeft <= 0) return false;
  if (event.deltaY > 0 && list.scrollLeft >= maxScrollLeft - 1) return false;
  return true;
}

function updateTabMaskVisibility(root) {
  if (!root) return;
  if (root.getAttribute("data-codexpp-conversation-tabs-hidden") === "true") {
    root.removeAttribute("data-codexpp-left-mask-visible");
    root.removeAttribute("data-codexpp-right-mask-visible");
    return;
  }
  const list = root.querySelector("[data-codexpp-conversation-tabs-list='true']");
  if (!(list instanceof HTMLElement)) return;

  const maxScrollLeft = Math.max(0, list.scrollWidth - list.clientWidth);
  const hasOverflow = maxScrollLeft > 1;
  const leftVisible = hasOverflow && list.scrollLeft > 1;
  const rightVisible = hasOverflow && list.scrollLeft < maxScrollLeft - 1;

  setBooleanAttribute(root, "data-codexpp-left-mask-visible", leftVisible);
  setBooleanAttribute(root, "data-codexpp-right-mask-visible", rightVisible);
}

function setBooleanAttribute(node, name, enabled) {
  if (enabled) {
    node.setAttribute(name, "true");
  } else {
    node.removeAttribute(name);
  }
}

function isOwnMutationTarget(state, target) {
  if (!(target instanceof Node)) return false;
  if (state.root?.contains(target)) return true;
  const element = target instanceof Element ? target : target.parentElement;
  return Boolean(
    element?.closest("[data-codexpp-tab-hover-tooltip='true'], [data-codexpp-conversation-tabs-menu='true']"),
  );
}

function isThreadTitleMutation(mutation) {
  if (mutation.type === "attributes") {
    return mutation.attributeName === "data-app-action-sidebar-thread-title";
  }

  const target = mutation.target;
  const element = target instanceof Element ? target : target.parentElement;
  if (element?.closest("[data-app-action-sidebar-thread-row], header")) return true;

  if (mutation.type !== "childList") return false;
  return Array.from([...mutation.addedNodes, ...mutation.removedNodes]).some((node) =>
    node instanceof Element &&
    (
      node.matches("[data-app-action-sidebar-thread-row]") ||
      Boolean(node.querySelector("[data-app-action-sidebar-thread-row]"))
    )
  );
}

function hideNativeHeaderTitle(state) {
  const header = document.querySelector("header");
  if (!header) return;

  clearNativeHeaderTitleHiding();

  const titles = nativeHeaderTitlesToHide(state);
  if (!titles.size) return;
  const candidates = Array.from(header.querySelectorAll("span, div"))
    .filter((node) => node instanceof HTMLElement)
    .filter((node) => !state.root?.contains(node))
    .filter((node) => !node.querySelector("[data-codexpp-native-chat-actions-button='true'], button, [role='button'], a"))
    .filter((node) => !node.closest("button, [role='button'], a"))
    .filter((node) => titles.has(normalizeIndicatorText(node.textContent)))
    .map((node) => ({ node, rect: node.getBoundingClientRect() }))
    .filter(({ rect }) => rect.width > 1 && rect.height > 1 && rect.width <= 520 && rect.height <= 32)
    .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));
  for (const { node } of candidates) {
    const region = nativeHeaderTitleRegion(node, header);
    if (state.root?.contains(region) || region.contains(state.root)) continue;
    if (region.querySelector("[data-codexpp-native-chat-actions-button='true'], button, [role='button'], a")) continue;
    region.setAttribute("data-codexpp-native-title-hidden", "true");
  }
}

function nativeHeaderTitlesToHide(state) {
  const titles = new Set();
  const add = (title) => {
    const normalized = normalizeIndicatorText(title);
    if (normalized) titles.add(normalized);
  };

  add(currentTitleForHeader(state));
  add(currentNativeHeaderTitle(state));
  add(titleFromSidebarRow(document.querySelector("[data-app-action-sidebar-thread-active='true'][data-app-action-sidebar-thread-title]")));
  for (const item of state.tabs) add(item.title);
  for (const node of state.root?.querySelectorAll("[data-codexpp-conversation-tab-title='true']") || []) {
    add(node.textContent);
  }
  return titles;
}

function clearNativeHeaderTitleHiding() {
  for (const node of document.querySelectorAll("[data-codexpp-native-title-hidden='true']")) {
    if (node instanceof HTMLElement) node.removeAttribute("data-codexpp-native-title-hidden");
  }
}

function currentTitleForHeader(state) {
  const liveTitle = currentLiveSidebarTitle(state);
  if (liveTitle) return liveTitle;
  const current = state.currentChatId
    ? state.tabs.find((tab) => tab.id === state.currentChatId) || state.knownTabs[state.currentChatId]
    : null;
  if (current?.title) return current.title;
  const active = document.querySelector("[data-app-action-sidebar-thread-active='true'][data-app-action-sidebar-thread-title]");
  return titleFromSidebarRow(active);
}

function currentLiveSidebarTitle(state) {
  const currentId = state.currentChatId || chatIdFromPathname(window.location.pathname) || chatIdFromHref(window.location.href);
  if (currentId) {
    const sidebarNode = findSidebarChatNode({ id: currentId, title: "" });
    const title = titleFromSidebarRow(sidebarNode);
    if (title) return title;
  }
  const active = document.querySelector("[data-app-action-sidebar-thread-active='true'][data-app-action-sidebar-thread-title]");
  return titleFromSidebarRow(active);
}

function titleFromSidebarRow(row) {
  if (!(row instanceof HTMLElement)) return "";
  return row.getAttribute("data-app-action-sidebar-thread-title")
    || normalizeVisibleTitle(row.textContent)
    || "";
}

function nativeHeaderTitleRegion(leaf, header) {
  let node = leaf;
  const leafRect = leaf.getBoundingClientRect();
  while (node.parentElement && node.parentElement !== header) {
    const parent = node.parentElement;
    const rect = parent.getBoundingClientRect();
    if (parent.querySelector("[data-codexpp-native-chat-actions-button='true'], button, [role='button'], a")) break;
    if (rect.height >= 36 && rect.width > leafRect.width + 24) return parent;
    node = parent;
  }
  return leaf;
}

function scheduleRefresh(state, delay) {
  if (!isActiveRendererState(state)) return;
  if (state.refreshTimer) return;
  state.refreshTimer = window.setTimeout(() => {
    state.refreshTimer = null;
    refreshTabs(state).catch((error) => {
      state.api.log.warn("[conversation-tabs] refresh failed", error);
    });
  }, delay);
}

async function refreshTabs(state) {
  if (!isActiveRendererState(state) || state.refreshing) return;
  state.refreshing = true;
  try {
    ensureTabBar(state);
    const sidebarChats = readSidebarChats();
    for (const item of sidebarChats) rememberKnownTab(state, item);

    expirePendingNewChat(state);
    const currentId = getCurrentChatIdForState(state);
    if (currentId) {
      state.currentChatId = currentId;
      state.closedIds.delete(currentId);
      if (!claimPendingNewChat(state, currentId)) {
        clearPendingNewChat(state);
        rememberOpenId(state, currentId);
      }
    } else if (state.pendingNewChat) {
      state.currentChatId = null;
    }

    let recent = [];
    try {
      recent = await state.api.ipc.invoke(IPC_RECENT_CHATS, { limit: RECENT_SCAN_LIMIT });
    } catch (error) {
      state.api.log.warn("[conversation-tabs] recent chats unavailable", error);
    }
    if (!Array.isArray(recent)) recent = [];

    for (const item of recent) rememberKnownTab(state, item);
    if (!state.currentChatId && state.pendingNewChat) {
      claimPendingRecentChat(state, recent);
    }

    const recentById = new Map(recent.map((item) => [item.id, item]));
    const sidebarById = new Map(
      sidebarChats.map((item) => [item.id, { ...recentById.get(item.id), ...item }]),
    );

    if (sidebarChats.length) {
      const liveIds = new Set(sidebarChats.map((item) => item.id));
      if (state.currentChatId) liveIds.add(state.currentChatId);
      state.openIds = state.openIds.filter((id) => liveIds.has(id));
      for (const item of sidebarChats) {
        if (state.openIds.length >= MAX_TABS) break;
        if (!state.closedIds.has(item.id) && !state.openIds.includes(item.id)) {
          state.openIds.push(item.id);
        }
      }
    } else if (!state.openIds.length) {
      state.openIds = recent
        .slice(0, MAX_TABS)
        .map((item) => item.id)
        .filter(Boolean);
    }

    if (!sidebarChats.length) {
      for (const item of recent) {
        if (state.openIds.length >= MAX_TABS) break;
        if (!state.closedIds.has(item.id) && !state.openIds.includes(item.id)) {
          state.openIds.push(item.id);
        }
      }
    }

    trimOpenIds(state, state.currentChatId);

    const byId = new Map([...recentById, ...sidebarById]);
    state.tabs = state.openIds
      .filter((id) => !state.closedIds.has(id) || id === state.currentChatId)
      .map((id) => byId.get(id) || state.knownTabs[id])
      .filter(Boolean)
      .slice(0, MAX_TABS);

    if (state.currentChatId && !state.tabs.some((tab) => tab.id === state.currentChatId)) {
      const current = byId.get(state.currentChatId) || state.knownTabs[state.currentChatId];
      if (current) {
        if (!state.openIds.includes(state.currentChatId)) {
          rememberOpenId(state, state.currentChatId);
          state.tabs = state.tabs.filter((tab) => state.openIds.includes(tab.id));
        }
        state.tabs.push(current);
      }
    }
    state.tabs = attachSidebarIndicators(state.tabs).slice(0, MAX_TABS);
    persistState(state);
    renderTabs(state);
    syncHeaderIntegration(state);
  } finally {
    state.refreshing = false;
    expirePendingNewChat(state);
    if (state.pendingNewChat) scheduleRefresh(state, 500);
  }
}

function renderTabs(state) {
  const list = state.list;
  if (!list) return;

  if (patchExistingTabs(state, list)) {
    afterRenderTabs(state);
    return;
  }

  list.replaceChildren();

  for (const item of state.tabs) {
    const selected = item.id === state.currentChatId;
    const wrapper = el("div", "my-auto flex shrink-0 relative items-center contain-content gap-0.5 pe-1");
    wrapper.setAttribute("data-codexpp-conversation-tab-wrapper", "true");
    wrapper.setAttribute("data-tab-id", item.id);
    const tab = el(
      "div",
      "group/tab relative flex h-7 max-w-39 min-w-28 shrink-0 items-center overflow-hidden rounded-lg bg-token-main-surface-primary px-2 py-1 text-left",
    );
    tab.setAttribute("data-codexpp-conversation-tab", "true");
    tab.setAttribute("data-tab-id", item.id);
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(selected));
    tab.draggable = true;
    setBooleanAttribute(tab, "data-codexpp-conversation-tab-unread", item.hasUnread);
    tab.tabIndex = selected ? 0 : -1;
    tab.__codexppConversationTabItem = item;
    tab.addEventListener("dragstart", (event) => {
      handleTabDragStart(state, event, currentTabItem(tab, item));
    });
    tab.addEventListener("dragend", () => {
      handleTabDragEnd(state);
    });
    tab.addEventListener("dragover", (event) => {
      handleTabListDragOver(state, event);
    });
    tab.addEventListener("drop", (event) => {
      handleTabDrop(state, event);
    });
    tab.addEventListener("contextmenu", (event) => {
      const tabItem = currentTabItem(tab, item);
      void handleTabContextMenu(state, event, tabItem);
    });
    tab.addEventListener("mousedown", (event) => {
      if (event.button === 1) {
        const tabItem = currentTabItem(tab, item);
        event.preventDefault();
        event.stopPropagation();
        closeTab(state, tabItem.id);
      }
    });
    tab.addEventListener("pointerenter", () => {
      tab.setAttribute("data-codexpp-hovered", "true");
      showTabHoverTooltip(state, currentTabItem(tab, item), tab);
    });
    tab.addEventListener("pointermove", () => {
      if (tab.getAttribute("data-codexpp-hovered") === "true") {
        showTabHoverTooltip(state, currentTabItem(tab, item), tab);
      }
    });
    tab.addEventListener("pointerleave", () => {
      tab.removeAttribute("data-codexpp-hovered");
      closeTabHoverTooltip();
    });
    tab.addEventListener("focusin", () => {
      tab.setAttribute("data-codexpp-hovered", "true");
      showTabHoverTooltip(state, currentTabItem(tab, item), tab);
    });
    tab.addEventListener("focusout", () => {
      tab.removeAttribute("data-codexpp-hovered");
      closeTabHoverTooltip();
    });
    tab.addEventListener("click", (event) => {
      if (state.dragSuppressClick) {
        event.preventDefault();
        event.stopPropagation();
        state.dragSuppressClick = false;
        return;
      }
      if (event.target instanceof Element && event.target.closest("[data-codexpp-conversation-tab-close='true']")) {
        return;
      }
      void activateTab(state, currentTabItem(tab, item).id);
    });
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      void activateTab(state, currentTabItem(tab, item).id);
    });

    const activate = el(
      "button",
      selected
        ? "relative z-10 flex min-w-0 flex-1 items-center text-sm text-token-text-primary cursor-interaction"
        : "relative z-10 flex min-w-0 flex-1 items-center text-sm text-token-text-secondary cursor-interaction",
    );
    activate.type = "button";
    activate.draggable = false;
    activate.tabIndex = -1;
    activate.setAttribute("data-codexpp-conversation-tab-activate", "true");
    activate.setAttribute("aria-label", item.title || "Untitled chat");
    activate.addEventListener("click", (event) => {
      if (state.dragSuppressClick) {
        event.preventDefault();
        event.stopPropagation();
        state.dragSuppressClick = false;
        return;
      }
      const tabItem = currentTabItem(tab, item);
      event.stopPropagation();
      void activateTab(state, tabItem.id);
    });

    const body = el("span", "flex min-w-0 flex-1 items-center gap-1.5");
    body.setAttribute("data-codexpp-conversation-tab-body", "true");
    const title = el(
      "span",
      "block min-w-0 flex-1 overflow-hidden",
    );
    title.setAttribute("data-codexpp-conversation-tab-title", "true");
    title.textContent = item.title || "Untitled chat";
    body.append(title);

    const indicators = sidebarIndicatorsNode(item);
    indicators.setAttribute("data-codexpp-conversation-tab-indicators", "true");
    activate.append(body, indicators);

    const close = el(
      "button",
      "absolute z-20 flex h-6 w-6 items-center justify-center rounded-md bg-[var(--app-shell-tab-background)] text-token-text-tertiary hover:text-token-text-primary cursor-interaction",
    );
    close.type = "button";
    close.draggable = false;
    close.setAttribute("data-codexpp-conversation-tab-close", "true");
    close.setAttribute("aria-label", `Close ${item.title || "Untitled chat"} tab`);
    close.innerHTML = closeIconSvg("icon-xs");
    close.addEventListener("mousedown", stopEvent);
    close.addEventListener("click", (event) => {
      const tabItem = currentTabItem(tab, item);
      stopEvent(event);
      closeTab(state, tabItem.id);
    });

    if (selected) {
      const more = el(
        "button",
        "absolute z-20 flex h-6 w-6 items-center justify-center rounded-md bg-[var(--app-shell-tab-background)] text-token-text-tertiary hover:text-token-text-primary cursor-interaction",
      );
      more.type = "button";
      more.draggable = false;
      more.setAttribute("data-codexpp-conversation-tab-more", "true");
      more.setAttribute("aria-label", "Chat actions");
      more.innerHTML = ellipsisIconSvg("icon-xs");
      more.addEventListener("mousedown", stopEvent);
      more.addEventListener("click", (event) => {
        stopEvent(event);
        void openNativeChatActionsMenu().then((opened) => {
          if (!opened) {
            state.api.log.warn("[conversation-tabs] native chat actions menu unavailable", {
              id: currentTabItem(tab, item).id,
            });
          }
        });
      });
      tab.append(activate, more, close);
    } else {
      tab.append(activate, close);
    }
    const divider = el("div", "");
    divider.setAttribute("data-codexpp-conversation-tab-divider", "true");
    wrapper.append(tab, divider);
    list.appendChild(wrapper);
  }

  if (!state.tabs.length) {
    const empty = el("div", "px-2 text-sm text-token-text-tertiary");
    empty.textContent = "No open chats";
    list.appendChild(empty);
  }
  syncTabDividers(list);
  afterRenderTabs(state);
}

function afterRenderTabs(state) {
  requestAnimationFrame(() => {
    if (!isActiveRendererState(state)) return;
    updateTabMaskVisibility(state.root);
    syncNativeChatActionsButton(state);
  });
}

function patchExistingTabs(state, list) {
  if (!state.tabs.length) return false;
  const existingTabs = renderedTabElements(list);
  if (existingTabs.length !== state.tabs.length) return false;

  for (let index = 0; index < state.tabs.length; index += 1) {
    const tab = existingTabs[index];
    const item = state.tabs[index];
    const selected = item.id === state.currentChatId;
    if (tab.getAttribute("data-tab-id") !== item.id) return false;
    if (tab.getAttribute("aria-selected") !== String(selected)) return false;
  }

  for (let index = 0; index < state.tabs.length; index += 1) {
    patchExistingTab(state, existingTabs[index], state.tabs[index]);
  }
  syncTabDividers(list);
  return true;
}

function renderedTabElements(list) {
  if (!list) return [];
  return Array.from(list.querySelectorAll("[data-codexpp-conversation-tab='true']"))
    .filter((node) =>
      node instanceof HTMLElement &&
      node.closest("[data-codexpp-conversation-tabs-list='true']") === list
    );
}

function patchExistingTab(state, tab, item) {
  tab.__codexppConversationTabItem = item;
  const title = item.title || "Untitled chat";
  setBooleanAttribute(tab, "data-codexpp-conversation-tab-unread", item.hasUnread);
  tab.closest("[data-codexpp-conversation-tab-wrapper='true']")?.setAttribute("data-tab-id", item.id);
  const titleNode = tab.querySelector("[data-codexpp-conversation-tab-title='true']");
  if (titleNode instanceof HTMLElement && titleNode.textContent !== title) {
    titleNode.textContent = title;
  }

  const activate = tab.querySelector("[data-codexpp-conversation-tab-activate='true']")
    || Array.from(tab.children).find((node) =>
      node instanceof HTMLButtonElement &&
      node.getAttribute("data-codexpp-conversation-tab-close") !== "true" &&
      node.getAttribute("data-codexpp-conversation-tab-more") !== "true"
    );
  if (activate instanceof HTMLElement) {
    activate.setAttribute("aria-label", title);
    const previousIndicators = activate.querySelector("[data-codexpp-conversation-tab-indicators='true']")
      || (activate.lastElementChild !== activate.querySelector("[data-codexpp-conversation-tab-body='true']")
        ? activate.lastElementChild
        : null);
    if (!(previousIndicators instanceof HTMLElement) || previousIndicators.dataset.codexppIndicatorSignature !== indicatorSignature(item)) {
      const nextIndicators = sidebarIndicatorsNode(item);
      if (previousIndicators instanceof Element) {
        previousIndicators.replaceWith(nextIndicators);
      } else {
        activate.appendChild(nextIndicators);
      }
    }
  }

  const close = tab.querySelector("[data-codexpp-conversation-tab-close='true']");
  if (close instanceof HTMLElement) {
    close.setAttribute("aria-label", `Close ${title} tab`);
  }

  if (tab.getAttribute("data-codexpp-hovered") === "true") {
    showTabHoverTooltip(state, item, tab);
  }
}

function syncTabDividers(list) {
  const tabs = renderedTabElements(list);
  for (let index = 0; index < tabs.length; index += 1) {
    const tab = tabs[index];
    const wrapper = tab.closest("[data-codexpp-conversation-tab-wrapper='true']");
    if (!(wrapper instanceof HTMLElement)) continue;
    const nextTab = tabs[index + 1];
    const hidden = (
      index === tabs.length - 1 ||
      tab.getAttribute("aria-selected") === "true" ||
      nextTab?.getAttribute("aria-selected") === "true"
    );
    setBooleanAttribute(wrapper, "data-codexpp-conversation-tab-divider-hidden", hidden);
  }
}

function currentTabItem(tab, fallback) {
  return tab.__codexppConversationTabItem || fallback;
}

function sidebarIndicatorsNode(item) {
  const wrap = el("span", "flex shrink-0 items-center justify-end gap-1.5");
  wrap.setAttribute("data-codexpp-conversation-tab-indicators", "true");
  wrap.dataset.codexppIndicatorSignature = indicatorSignature(item);
  if (item.hasProgress || item.isRunning) {
    const progress = el(
      "span",
      "h-3 w-3 rounded-full border border-token-text-secondary border-t-transparent animate-spin",
    );
    progress.setAttribute("aria-label", "Running");
    wrap.appendChild(progress);
  }
  if (item.hasUnread) {
    const unread = el("span", "h-2 w-2 rounded-full bg-token-charts-blue");
    unread.setAttribute("aria-label", "Unread");
    wrap.appendChild(unread);
  }
  return wrap;
}

function indicatorSignature(item) {
  return `${item.hasProgress || item.isRunning ? "running" : "idle"}:${item.hasUnread ? "unread" : "read"}`;
}

function showTabHoverTooltip(state, item, tab) {
  if (state.disposed || !item?.title || !(tab instanceof HTMLElement)) return;
  let tooltip = document.querySelector("[data-codexpp-tab-hover-tooltip='true']");
  if (!(tooltip instanceof HTMLElement)) {
    tooltip = el(
      "div",
      "bg-token-dropdown-background text-token-foreground border-token-border z-50 w-fit select-none rounded-lg border px-2 py-1 text-sm whitespace-normal break-words m-px !rounded-xl !border-0 !bg-token-dropdown-background/90 !p-0 !shadow-xl-spread !ring-[0.5px] !ring-token-border backdrop-blur-sm",
    );
    tooltip.setAttribute("data-codexpp-tab-hover-tooltip", "true");
    tooltip.setAttribute("role", "tooltip");
    document.body.appendChild(tooltip);
  }

  const project = item.projectName || projectNameFromSidebarItem(item) || "Chat";
  tooltip.replaceChildren();
  const shell = el("div", "flex items-center gap-2");
  const content = el("div", "min-w-0 w-full");
  const stack = el(
    "div",
    "flex w-fit max-w-[min(20rem,calc(100vw-16px))] min-w-56 flex-col gap-1 px-row-x py-1.5 text-token-foreground",
  );
  const title = el("div", "truncate pb-0.5 text-base leading-6 font-medium text-token-foreground");
  title.textContent = item.title || "Untitled chat";
  const meta = el("div", "flex min-w-0 gap-1.5 text-sm leading-5 h-5 items-center");
  const icon = el("span", "flex h-5 w-4 shrink-0 items-center justify-center text-token-description-foreground");
  icon.innerHTML = folderIconSvg("icon-xs");
  const projectPill = projectPillFromSidebarItem(item);
  if (projectPill) {
    meta.append(icon, projectPill);
  } else {
    const metaText = el("span", "block min-w-0 flex-1 leading-5 overflow-hidden text-ellipsis whitespace-nowrap text-token-foreground");
    metaText.textContent = project;
    meta.append(icon, metaText);
  }
  stack.append(title, meta);
  content.appendChild(stack);
  shell.appendChild(content);
  tooltip.appendChild(shell);

  const tabRect = tab.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const left = Math.max(8, Math.min(Math.round(tabRect.left), window.innerWidth - tooltipRect.width - 8));
  const top = Math.min(
    window.innerHeight - tooltipRect.height - 8,
    Math.round(tabRect.bottom + 8),
  );
  tooltip.style.left = "0px";
  tooltip.style.top = "0px";
  tooltip.style.transform = `translate(${left}px, ${Math.max(8, top)}px)`;
}

function closeTabHoverTooltip() {
  document.querySelector("[data-codexpp-tab-hover-tooltip='true']")?.remove();
}

function handleDocumentPointerDown(state, event) {
  const target = event.target;
  const element = target instanceof Element ? target : null;

  if (element?.closest("[data-codexpp-conversation-tab='true']")) {
    clearPendingNewChat(state);
  } else if (element?.closest("[data-app-action-sidebar-thread-row]")) {
    clearPendingNewChat(state);
  } else if (isNewChatTriggerElement(element)) {
    beginPendingNewChat(state, "button");
  }

  if (!state.menu) return;
  if (target instanceof Node && state.menu.contains(target)) return;
  closeMenu(state);
}

function handleGlobalKeyDown(state, event) {
  if (event.key === "Escape") {
    closeMenu(state);
    return;
  }

  if (isCloseCurrentTabShortcut(event) && closeCurrentTab(state)) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  if (isNewChatShortcut(event)) {
    beginPendingNewChat(state, "keyboard");
    return;
  }

  const tabIndex = tabShortcutIndex(event);
  if (tabIndex === null) return;

  if (activateTabAtIndex(state, tabIndex)) {
    event.preventDefault();
    event.stopPropagation();
  }
}

function closeCurrentTab(state) {
  if (!state.root || state.root.getAttribute("data-codexpp-conversation-tabs-hidden") === "true") {
    return false;
  }
  const selectedTab = state.list?.querySelector("[data-codexpp-conversation-tab='true'][aria-selected='true']");
  const id = state.currentChatId || selectedTab?.getAttribute("data-tab-id");
  if (!id) return false;
  return closeTab(state, id);
}

function activateTabAtIndex(state, tabIndex) {
  const item = tabItemAtIndex(state, tabIndex);
  if (!item?.id) return false;

  closeMenu(state);
  closeTabHoverTooltip();
  void activateTab(state, item.id);
  return true;
}

function tabItemAtIndex(state, tabIndex) {
  const item = state.tabs[tabIndex];
  if (item?.id) return item;

  const tab = Array.from(state.list?.querySelectorAll("[data-codexpp-conversation-tab='true']") || [])[tabIndex];
  if (!(tab instanceof HTMLElement)) return null;
  const renderedItem = tab.__codexppConversationTabItem;
  if (renderedItem?.id) return renderedItem;
  const id = tab.getAttribute("data-tab-id");
  if (!id) return null;
  return state.knownTabs[id] || {
    id,
    title: normalizeIndicatorText(tab.textContent) || "Untitled chat",
  };
}

function tabShortcutIndex(event) {
  if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  if (event.repeat) return null;

  if (/^[1-9]$/.test(event.key)) return Number(event.key) - 1;
  const codeMatch = String(event.code || "").match(/^(?:Digit|Numpad)([1-9])$/);
  return codeMatch ? Number(codeMatch[1]) - 1 : null;
}

function isCloseCurrentTabShortcut(event) {
  if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  if (event.repeat) return false;
  return String(event.key || "").toLowerCase() === "w" || event.code === "KeyW";
}

function isNewChatShortcut(event) {
  if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  if (event.repeat) return false;
  return String(event.key || "").toLowerCase() === "n" || event.code === "KeyN";
}

async function activateTab(state, id) {
  if (!isActiveRendererState(state)) return;
  if (!id || id === state.currentChatId) return;
  clearPendingNewChat(state);
  const activationSeq = ++state.activationSeq;
  const previousId = state.currentChatId;
  rememberOpenId(state, id);
  state.currentChatId = id;
  persistState(state);
  renderTabs(state);
  scrollTabIntoView(state, id);
  syncHeaderIntegration(state);
  const started = await navigateToChat(state, id);
  const activated = await waitForActiveChatId(id, started ? 1800 : 500, () => activationSeq !== state.activationSeq);
  if (activationSeq !== state.activationSeq) return;
  if (activated || started) {
    state.currentChatId = id;
  } else {
    state.currentChatId = getCurrentChatId() || previousId;
    state.api.log.warn("[conversation-tabs] tab activation did not reach target chat", { id });
  }
  if (activationSeq === state.activationSeq) scheduleRefresh(state, 120);
}

function scrollTabIntoView(state, id) {
  const tab = findRenderedTab(state, id);
  if (!tab) return;
  requestAnimationFrame(() => {
    tab.scrollIntoView({ block: "nearest", inline: "nearest" });
    updateTabMaskVisibility(state.root);
  });
}

function findRenderedTab(state, id) {
  if (!state.list || !id) return null;
  return renderedTabElements(state.list).find((tab) =>
    tab instanceof HTMLElement && tab.getAttribute("data-tab-id") === id
  ) || null;
}

function handleTabDragStart(state, event, item) {
  if (!item?.id) {
    event.preventDefault();
    return;
  }
  if (event.target instanceof Element && event.target.closest(
    "[data-codexpp-conversation-tab-close='true'], [data-codexpp-conversation-tab-more='true']",
  )) {
    event.preventDefault();
    return;
  }
  closeMenu(state);
  closeTabHoverTooltip();
  state.draggedTabId = item.id;
  state.dragDropTargetId = null;
  state.dragDropSide = null;
  state.dragSuppressClick = true;
  event.dataTransfer?.setData("text/plain", item.id);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  findRenderedTab(state, item.id)?.setAttribute("data-codexpp-dragging", "true");
}

function handleTabListDragOver(state, event) {
  if (!state.draggedTabId) return;
  const target = tabDropTargetFromEvent(state, event);
  if (!target) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  setTabDropTarget(state, target.id, target.side);
}

function handleTabDrop(state, event) {
  const draggedId = state.draggedTabId || event.dataTransfer?.getData("text/plain");
  if (!draggedId) return;
  const target = tabDropTargetFromEvent(state, event) || {
    id: state.dragDropTargetId,
    side: state.dragDropSide,
  };
  event.preventDefault();
  event.stopPropagation();
  const moved = moveOpenTab(state, draggedId, target.id, target.side);
  clearTabDragState(state);
  if (!moved) return;
  persistState(state);
  renderTabs(state);
  scrollTabIntoView(state, state.currentChatId || draggedId);
}

function handleTabDragEnd(state) {
  clearTabDragState(state);
}

function handleTabListDragLeave(state, event) {
  if (!state.draggedTabId || !(state.list instanceof HTMLElement)) return;
  const related = event.relatedTarget;
  if (related instanceof Node && state.list.contains(related)) return;
  clearTabDropTarget(state);
}

function tabDropTargetFromEvent(state, event) {
  if (!(state.list instanceof HTMLElement)) return null;
  const targetTab = event.target instanceof Element
    ? event.target.closest("[data-codexpp-conversation-tab='true']")
    : null;
  if (targetTab instanceof HTMLElement && state.list.contains(targetTab)) {
    const id = targetTab.getAttribute("data-tab-id");
    if (!id || id === state.draggedTabId) return null;
    const rect = targetTab.getBoundingClientRect();
    return {
      id,
      side: event.clientX < rect.left + rect.width / 2 ? "before" : "after",
    };
  }

  const tabs = renderedTabElements(state.list);
  if (!tabs.length) return null;
  const visibleTabs = tabs.filter((tab) => tab.getAttribute("data-tab-id") !== state.draggedTabId);
  if (!visibleTabs.length) return null;
  const firstRect = visibleTabs[0].getBoundingClientRect();
  if (event.clientX <= firstRect.left) {
    return { id: visibleTabs[0].getAttribute("data-tab-id"), side: "before" };
  }
  const lastRect = visibleTabs[visibleTabs.length - 1].getBoundingClientRect();
  if (event.clientX >= lastRect.right) {
    return { id: visibleTabs[visibleTabs.length - 1].getAttribute("data-tab-id"), side: "after" };
  }
  let closest = null;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const tab of visibleTabs) {
    const rect = tab.getBoundingClientRect();
    const center = rect.left + rect.width / 2;
    const distance = Math.abs(event.clientX - center);
    if (distance < closestDistance) {
      closest = {
        id: tab.getAttribute("data-tab-id"),
        side: event.clientX < center ? "before" : "after",
      };
      closestDistance = distance;
    }
  }
  return closest;
}

function setTabDropTarget(state, id, side) {
  if (!id || !side) {
    clearTabDropTarget(state);
    return;
  }
  if (state.dragDropTargetId === id && state.dragDropSide === side) return;
  clearTabDropTarget(state);
  state.dragDropTargetId = id;
  state.dragDropSide = side;
  const target = findRenderedTab(state, id);
  const wrapper = target?.closest("[data-codexpp-conversation-tab-wrapper='true']");
  if (wrapper instanceof HTMLElement) {
    wrapper.setAttribute(side === "before" ? "data-codexpp-drop-before" : "data-codexpp-drop-after", "true");
  }
}

function clearTabDropTarget(state) {
  state.dragDropTargetId = null;
  state.dragDropSide = null;
  state.list?.querySelectorAll("[data-codexpp-drop-before], [data-codexpp-drop-after]").forEach((node) => {
    node.removeAttribute("data-codexpp-drop-before");
    node.removeAttribute("data-codexpp-drop-after");
  });
}

function clearTabDragState(state) {
  const hadDrag = Boolean(state.draggedTabId);
  if (state.draggedTabId) {
    findRenderedTab(state, state.draggedTabId)?.removeAttribute("data-codexpp-dragging");
  }
  state.draggedTabId = null;
  clearTabDropTarget(state);
  if (hadDrag) {
    window.setTimeout(() => {
      state.dragSuppressClick = false;
    }, 0);
  }
}

function moveOpenTab(state, draggedId, targetId, side) {
  if (!draggedId || !targetId || draggedId === targetId || (side !== "before" && side !== "after")) {
    return false;
  }
  const ids = state.openIds.slice();
  const fromIndex = ids.indexOf(draggedId);
  if (fromIndex === -1) return false;
  ids.splice(fromIndex, 1);
  const targetIndex = ids.indexOf(targetId);
  if (targetIndex === -1) return false;
  ids.splice(targetIndex + (side === "after" ? 1 : 0), 0, draggedId);
  if (ids.join("\u0000") === state.openIds.join("\u0000")) return false;

  state.openIds = ids;
  const tabsById = new Map(state.tabs.map((tab) => [tab.id, tab]));
  state.tabs = state.openIds.map((id) => tabsById.get(id)).filter(Boolean);
  return true;
}

function closeTab(state, id) {
  if (!id) return false;
  closeMenu(state);
  const visibleIds = state.tabs.map((tab) => tab.id);
  const index = visibleIds.indexOf(id);
  state.closedIds.add(id);
  state.openIds = state.openIds.filter((candidate) => candidate !== id);
  state.tabs = state.tabs.filter((tab) => tab.id !== id);
  persistState(state);

  if (id === state.currentChatId) {
    const nextId = visibleIds[index + 1] || visibleIds[index - 1] || null;
    if (nextId) {
      void activateTab(state, nextId);
    } else {
      state.currentChatId = null;
      renderTabs(state);
      setBooleanAttribute(state.root, "data-codexpp-conversation-tabs-hidden", true);
      void navigateToNewChat(state);
      return true;
    }
  }
  renderTabs(state);
  return true;
}

async function handleTabContextMenu(state, event, item) {
  event.preventDefault();
  event.stopPropagation();
  closeMenu(state);
  closeTabHoverTooltip();

  const x = event.clientX;
  const y = event.clientY;
  try {
    const shouldSwitchTabs = item?.id && item.id !== state.currentChatId;
    if (shouldSwitchTabs) await activateTab(state, item.id);

    await nextAnimationFrame();
    if (shouldSwitchTabs) await wait(120);
    syncNativeChatActionsButton(state);
    if (await openNativeChatActionsMenu()) return;
  } catch (error) {
    state.api.log.warn("[conversation-tabs] native context menu unavailable", error);
  }

  showContextMenu(state, x, y, item);
}

function showContextMenu(state, x, y, item) {
  closeMenu(state);
  const menu = el(
    "div",
    "fixed z-[2147483647] rounded-lg border border-token-border-default bg-token-main-surface-primary p-1 text-token-text-primary shadow-xl",
  );
  menu.setAttribute("data-codexpp-conversation-tabs-menu", "true");
  menu.setAttribute("role", "menu");

  const open = menuItem("Open in new window", externalWindowIconSvg("icon-sm"), false, () => {
    closeMenu(state);
    void openInNewWindow(state, item.id);
  });
  const close = menuItem("Close tab", closeIconSvg("icon-sm"), state.tabs.length <= 1, () => {
    closeTab(state, item.id);
  });
  menu.append(open, separator(), close);
  document.body.appendChild(menu);
  positionMenu(menu, x, y);
  state.menu = menu;
  const first = menu.querySelector("[data-codexpp-conversation-tabs-menu-item='true']:not([disabled])");
  if (first instanceof HTMLElement) first.focus({ preventScroll: true });
}

function menuItem(label, iconSvg, disabled, onClick) {
  const item = el(
    "button",
    "flex h-8 items-center gap-2 rounded-md px-2 text-left text-sm cursor-interaction",
  );
  item.type = "button";
  item.setAttribute("data-codexpp-conversation-tabs-menu-item", "true");
  item.setAttribute("role", "menuitem");
  if (disabled) item.disabled = true;
  const icon = el("span", "flex h-4 w-4 shrink-0 items-center justify-center text-token-text-secondary");
  icon.innerHTML = iconSvg;
  const text = el("span", "min-w-0 flex-1 truncate");
  text.textContent = label;
  item.append(icon, text);
  item.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!item.disabled) onClick();
  });
  return item;
}

function separator() {
  const node = el("div", "my-1 h-px bg-token-border-default");
  node.setAttribute("role", "separator");
  return node;
}

function positionMenu(menu, x, y) {
  const margin = 8;
  const rect = menu.getBoundingClientRect();
  const left = Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin));
  const top = Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin));
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

function closeMenu(state) {
  state.menu?.remove();
  state.menu = null;
}

function closeContextMenu() {
  document.dispatchEvent(new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "Escape",
  }));
}

async function openInNewWindow(state, id) {
  const previousId = state.currentChatId;
  try {
    if (id && id !== state.currentChatId) {
      const started = await navigateToChat(state, id);
      if (await waitForActiveChatId(id, started ? 1800 : 500)) {
        state.currentChatId = id;
      }
      await wait(450);
    }
    const opened = await openNativeMiniWindowAction();
    if (!opened) {
      state.api.log.warn("[conversation-tabs] native mini-window action unavailable", { id });
    }
  } finally {
    if (previousId && id !== previousId) {
      await wait(250);
      await navigateToChat(state, previousId);
      state.currentChatId = previousId;
    }
    scheduleRefresh(state, 250);
  }
}

async function openNativeMiniWindowAction() {
  const actionsButton = findChatActionsButton();
  if (!actionsButton) return false;
  clickElement(actionsButton);
  let item = null;
  for (let i = 0; i < 10; i += 1) {
    await wait(80);
    item = findOpenMiniWindowItem();
    if (item) break;
  }
  if (!item) return false;
  clickElement(item);
  return true;
}

async function openNativeChatActionsMenu() {
  const actionsButton = findChatActionsButton();
  if (!actionsButton) return false;
  closeContextMenu();
  clickElement(actionsButton);
  if (await waitForNativeChatActionsMenu()) return true;
  if (invokeReactPointerDown(actionsButton) && await waitForNativeChatActionsMenu()) return true;
  if (!invokeReactClick(actionsButton)) return false;
  return waitForNativeChatActionsMenu();
}

async function waitForNativeChatActionsMenu() {
  for (let i = 0; i < 8; i += 1) {
    await wait(50);
    if (findNativeChatActionsMenu()) return true;
  }
  return false;
}

function findNativeChatActionsMenu() {
  return Array.from(document.querySelectorAll('[role="menu"], [role="dialog"], [data-radix-popper-content-wrapper]'))
    .find((node) =>
      node instanceof HTMLElement &&
      isVisibleElement(node) &&
      !node.closest("[data-codexpp-conversation-tabs='true']") &&
      !node.closest("[data-codexpp-conversation-tabs-menu='true']") &&
      /(?:pin chat|rename chat|archive chat|copy session id|open in new window)/i.test(node.textContent || "")
    ) || null;
}

function findChatActionsButton() {
  return Array.from(document.querySelectorAll("button, [role='button']"))
    .find((node) =>
      node instanceof HTMLElement &&
      !node.closest("[data-codexpp-conversation-tabs='true']") &&
      /^(Chat|Conversation) actions$/i.test(node.getAttribute("aria-label") || "")
    ) || null;
}

function findOpenMiniWindowItem() {
  return Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"], [role="menuitem"]'))
    .find((item) =>
      item instanceof HTMLElement &&
      /open in (mini|new) window/i.test(item.textContent || "")
    ) || null;
}

function handleRouteChange(state) {
  if (!isActiveRendererState(state)) return;
  const nextUrl = window.location.href;
  expirePendingNewChat(state);
  const nextId = getCurrentChatIdForState(state);
  if (nextUrl === state.lastUrl && nextId === state.currentChatId) return;
  state.lastUrl = nextUrl;
  if (nextId) {
    state.currentChatId = nextId;
    state.closedIds.delete(nextId);
    if (!claimPendingNewChat(state, nextId)) {
      clearPendingNewChat(state);
      rememberOpenId(state, nextId);
    }
    persistState(state);
  } else if (state.pendingNewChat) {
    state.currentChatId = null;
    renderTabs(state);
    syncHeaderIntegration(state);
  }
  if (state.root) syncTabBarVisibility(state);
  scheduleRefresh(state, 80);
}

function patchHistory() {
  if (window.__codexppConversationTabsHistoryPatchVersion === 1) return;
  window.__codexppConversationTabsHistoryPatchVersion = 1;
  for (const method of ["pushState", "replaceState"]) {
    const previous = history[method];
    history[method] = function patchedHistoryMethod() {
      const result = previous.apply(this, arguments);
      window.dispatchEvent(new Event("codexpp-conversation-tabs-route"));
      return result;
    };
  }
}

async function navigateToChat(state, id) {
  const item = state.tabs.find((tab) => tab.id === id) || state.knownTabs[id] || { id };
  const sidebarNode = findSidebarChatNode(item);
  if (sidebarNode) {
    activateSidebarChatNode(sidebarNode);
    return true;
  }

  const path = `/local/${encodeURIComponent(id)}`;
  try {
    const ok = await state.api.ipc.invoke(IPC_NAVIGATE_CHAT, id);
    if (ok) return true;
  } catch (error) {
    state.api.log.warn("[conversation-tabs] main navigation failed", error);
  }

  const pathAttr = cssString(path);
  const anchor = document.querySelector(`a[href="${pathAttr}"], a[href^="${pathAttr}?"]`);
  if (anchor instanceof HTMLElement) {
    clickElement(anchor);
    return true;
  }
  return false;
}

function beginPendingNewChat(state, source = "unknown") {
  if (!isActiveRendererState(state)) return;
  if (state.pendingNewChat && Date.now() - state.pendingNewChat.startedAt < 1000) return;
  const afterId = state.currentChatId || selectedRenderedTabId(state) || null;
  state.pendingNewChat = {
    source,
    afterId,
    startedAt: Date.now(),
    knownIds: knownConversationIds(state),
  };
  state.activationSeq += 1;
  state.currentChatId = null;
  closeMenu(state);
  closeTabHoverTooltip();
  clearNativeHeaderTitleHiding();
  clearNativeChatActionsButton(state);
  renderTabs(state);
  syncHeaderIntegration(state);
  scheduleRefresh(state, 80);
}

function clearPendingNewChat(state) {
  if (state) state.pendingNewChat = null;
}

function expirePendingNewChat(state) {
  if (!state?.pendingNewChat) return;
  if (Date.now() - state.pendingNewChat.startedAt > PENDING_NEW_CHAT_TTL_MS) {
    state.pendingNewChat = null;
  }
}

function knownConversationIds(state) {
  const ids = new Set([
    ...state.openIds,
    ...state.tabs.map((tab) => tab.id).filter(Boolean),
    ...Object.keys(state.knownTabs || {}),
  ]);
  for (const item of readSidebarChats()) {
    if (item.id) ids.add(item.id);
  }
  return ids;
}

function selectedRenderedTabId(state) {
  const selected = state.list?.querySelector("[data-codexpp-conversation-tab='true'][aria-selected='true']");
  return selected instanceof HTMLElement ? selected.getAttribute("data-tab-id") : null;
}

function getCurrentChatIdForState(state) {
  const routeId = currentChatIdFromRoute();
  if (routeId) return routeId;

  const sidebarId = currentChatIdFromSidebarActive();
  if (sidebarId && pendingAllowsCurrentId(state, sidebarId)) return sidebarId;

  if (state?.pendingNewChat) return null;
  return currentChatIdFromActiveLink() || currentChatIdFromHeaderTitle(state);
}

function pendingAllowsCurrentId(state, id) {
  const pending = state?.pendingNewChat;
  if (!pending || !id) return true;
  return !pending.knownIds?.has(id);
}

function claimPendingNewChat(state, id) {
  const pending = state?.pendingNewChat;
  if (!pending || !id || !pendingAllowsCurrentId(state, id)) return false;

  insertOpenIdAfter(state, id, pending.afterId);
  if (!state.knownTabs[id]) {
    rememberKnownTab(state, {
      id,
      title: currentLiveSidebarTitle(state) || "New chat",
      updatedAt: null,
      cwdBasename: null,
      projectName: null,
      isRunning: false,
    });
  }
  state.pendingNewChat = null;
  return true;
}

function claimPendingRecentChat(state, recent) {
  const pending = state?.pendingNewChat;
  if (!pending || !Array.isArray(recent)) return false;

  const item = recent.find((candidate) =>
    candidate?.id &&
    pendingAllowsCurrentId(state, candidate.id) &&
    recentChatBelongsToPendingNewChat(pending, candidate)
  );
  if (!item) return false;

  state.currentChatId = item.id;
  state.closedIds.delete(item.id);
  insertOpenIdAfter(state, item.id, pending.afterId);
  rememberKnownTab(state, item);
  state.pendingNewChat = null;
  return true;
}

function recentChatBelongsToPendingNewChat(pending, item) {
  if (!item?.updatedAt) return true;
  const updatedAt = Date.parse(item.updatedAt);
  if (!Number.isFinite(updatedAt)) return true;
  return updatedAt >= pending.startedAt - 30000;
}

function insertOpenIdAfter(state, id, afterId) {
  state.openIds = state.openIds.filter((candidate) => candidate !== id);
  const index = afterId ? state.openIds.indexOf(afterId) : -1;
  const insertAt = index >= 0 ? index + 1 : state.openIds.length;
  state.openIds.splice(insertAt, 0, id);
  trimOpenIds(state, id);
}

async function navigateToNewChat(state) {
  beginPendingNewChat(state, "internal");
  clearNativeHeaderTitleHiding();
  clearNativeChatActionsButton(state);
  closeTabHoverTooltip();

  const button = findNewChatButton();
  if (button) {
    clickElement(button);
    await wait(120);
    handleRouteChange(state);
    scheduleRefresh(state, 80);
    return true;
  }

  state.api.log.warn("[conversation-tabs] new chat action unavailable");
  scheduleRefresh(state, 80);
  return false;
}

function findNewChatButton() {
  const candidates = Array.from(document.querySelectorAll("button, [role='button'], a"))
    .filter((node) =>
      node instanceof HTMLElement &&
      isVisibleElement(node) &&
      !node.closest("[data-codexpp-conversation-tabs='true']") &&
      !node.closest("[data-codexpp-conversation-tabs-menu='true']")
    );

  const matches = candidates.filter((node) => {
    return isNewChatTriggerElement(node);
  });

  return matches.find((node) => node.getBoundingClientRect().top > 4) || matches[0] || null;
}

function isNewChatTriggerElement(element) {
  const node = element?.closest?.("button, [role='button'], a");
  if (!(node instanceof HTMLElement)) return false;
  if (!isVisibleElement(node)) return false;
  if (node.closest("[data-codexpp-conversation-tabs='true']")) return false;
  if (node.closest("[data-codexpp-conversation-tabs-menu='true']")) return false;
  const label = normalizeIndicatorText(node.getAttribute("aria-label") || "");
  const title = normalizeIndicatorText(node.getAttribute("title") || "");
  const text = normalizeIndicatorText(node.textContent || "").replace(/\s+/g, "");
  if (label === "new chat" || title === "new chat" || text === "newchat" || text === "newchat⌘n") {
    return true;
  }
  return isIconOnlyNewChatButton(node, { label, title, text });
}

function isIconOnlyNewChatButton(node, normalized = {}) {
  if (!(node instanceof HTMLElement)) return false;
  if (normalized.label || normalized.title || normalized.text) return false;
  if (node.tagName !== "BUTTON") return false;

  const rect = node.getBoundingClientRect();
  if (rect.top < -2 || rect.top > 56 || rect.width > 44 || rect.height > 44) return false;

  const pathData = Array.from(node.querySelectorAll("svg path"))
    .map((path) => path.getAttribute("d") || "")
    .join(" ");
  return pathData.includes("M2.6687 11.333")
    && pathData.includes("V8.66699")
    && pathData.includes("3.10425 4.85156");
}

function activateSidebarChatNode(node) {
  if (!(node instanceof HTMLElement)) return false;
  clickElement(node);
  invokeReactClick(node);
  return true;
}

function invokeReactClick(node) {
  return invokeReactHandler(node, "onClick", {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
  });
}

function invokeReactPointerDown(node) {
  return invokeReactHandler(node, "onPointerDown", {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    pointerType: "mouse",
  });
}

function invokeReactHandler(node, handlerName, eventFields) {
  const propsKey = Object.keys(node).find((key) => key.startsWith("__reactProps$"));
  const handler = propsKey ? node[propsKey]?.[handlerName] : null;
  if (typeof handler !== "function") return false;
  try {
    handler({
      currentTarget: node,
      target: node,
      ...eventFields,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {},
      persist() {},
    });
    return true;
  } catch {
    return false;
  }
}

async function waitForActiveChatId(id, timeoutMs, shouldCancel) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (shouldCancel?.()) return false;
    if (getCurrentChatId() === id) return true;
    await wait(80);
  }
  return !shouldCancel?.() && getCurrentChatId() === id;
}

function rememberOpenId(state, id) {
  if (!id) return;
  if (!state.openIds.includes(id)) {
    state.openIds.push(id);
  }
  trimOpenIds(state, id);
}

function trimOpenIds(state, preferredId) {
  const seen = new Set();
  state.openIds = state.openIds.filter((id) => {
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  while (state.openIds.length > MAX_TABS) {
    const removableIndex = state.openIds.findIndex((id) =>
      id !== preferredId && id !== state.currentChatId
    );
    state.openIds.splice(removableIndex === -1 ? 0 : removableIndex, 1);
  }
}

function rememberKnownTab(state, item) {
  if (!item?.id) return;
  state.knownTabs[item.id] = {
    id: item.id,
    title: item.title || "Untitled chat",
    updatedAt: item.updatedAt || null,
    cwdBasename: item.cwdBasename || null,
    projectName: item.projectName || null,
    isRunning: !!item.isRunning,
  };
}

function persistState(state) {
  state.api.storage.set(OPEN_IDS_KEY, state.openIds);
  state.api.storage.set(CLOSED_IDS_KEY, Array.from(state.closedIds));
  state.api.storage.set(KNOWN_TABS_KEY, state.knownTabs);
}

function readSidebarChats() {
  const rows = Array.from(
    document.querySelectorAll("[data-app-action-sidebar-thread-row][data-app-action-sidebar-thread-id]"),
  );
  const chats = [];
  const seen = new Set();
  for (const row of rows) {
    if (!(row instanceof HTMLElement)) continue;
    const id = normalizeSidebarThreadId(row.getAttribute("data-app-action-sidebar-thread-id"));
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const title = titleFromSidebarRow(row) || "Untitled chat";
    const projectName = projectNameFromSidebarRow(row);
    const indicators = readSidebarIndicators(row);
    chats.push({
      id,
      title,
      updatedAt: null,
      cwdBasename: null,
      projectName,
      isRunning: indicators.hasProgress,
      hasProgress: indicators.hasProgress,
      hasUnread: indicators.hasUnread,
    });
  }
  return chats;
}

function attachSidebarIndicators(items) {
  return items.map((item) => {
    const sidebarNode = findSidebarChatNode(item);
    const indicators = readSidebarIndicators(sidebarNode);
    return {
      ...item,
      hasUnread: indicators.hasUnread,
      hasProgress: item.isRunning || indicators.hasProgress,
    };
  });
}

function findSidebarChatNode(item) {
  if (!item?.id) return null;
  if (item?.id) {
    const threadId = cssString(`local:${item.id}`);
    const matches = Array.from(document.querySelectorAll(
      `[data-app-action-sidebar-thread-row][data-app-action-sidebar-thread-id="${threadId}"]`,
    )).filter((node) => node instanceof HTMLElement);
    const visible = matches.find((node) => isVisibleElement(node));
    if (visible instanceof HTMLElement) return visible;
    if (matches[0] instanceof HTMLElement) return matches[0];
  }

  const path = `/local/${encodeURIComponent(item.id)}`;
  const pathAttr = cssString(path);
  const idAttr = cssString(encodeURIComponent(item.id));
  const anchors = [
    ...document.querySelectorAll(`a[href="${pathAttr}"], a[href^="${pathAttr}?"]`),
    ...document.querySelectorAll(`a[href$="/local/${idAttr}"], a[href*="/local/${idAttr}?"]`),
  ];
  for (const anchor of anchors) {
    const row = closestSidebarItem(anchor);
    if (row) return row;
  }

  const title = normalizeIndicatorText(item.title);
  if (!title) return null;
  for (const row of document.querySelectorAll("[data-app-action-sidebar-thread-row][data-app-action-sidebar-thread-title]")) {
    if (!(row instanceof HTMLElement)) continue;
    const rowTitle = normalizeIndicatorText(row.getAttribute("data-app-action-sidebar-thread-title"));
    if (rowTitle === title) return row;
  }
  const titleMatches = [];
  for (const node of document.querySelectorAll("aside *, nav *")) {
    if (!(node instanceof HTMLElement)) continue;
    const text = normalizeIndicatorText(node.textContent);
    if (!text) continue;
    if (text === title || text.includes(title) || (text.length >= 8 && title.includes(text))) {
      titleMatches.push({ node, textLength: text.length });
    }
  }
  titleMatches.sort((a, b) => a.textLength - b.textLength);
  for (const match of titleMatches) {
    const row = closestSidebarItem(match.node);
    if (row) return row;
  }
  return null;
}

function projectNameFromSidebarItem(item) {
  const row = findSidebarChatNode(item);
  return projectNameFromSidebarRow(row);
}

function projectPillFromSidebarItem(item) {
  const row = findSidebarChatNode(item);
  if (!(row instanceof HTMLElement)) return null;
  const scope = row.closest("[role='listitem']") || row;
  const pill = scope.querySelector("[data-codexpp-chat-label='pill']");
  return pill instanceof HTMLElement ? pill.cloneNode(true) : null;
}

function projectNameFromSidebarRow(row) {
  if (!(row instanceof HTMLElement)) return "";
  const label = row.querySelector("[data-codexpp-chat-label='text']");
  if (label instanceof HTMLElement) {
    const text = normalizeVisibleTitle(label.textContent);
    if (text) return text;
  }
  const title = row.getAttribute("data-app-action-sidebar-thread-title") || "";
  const raw = normalizeVisibleTitle(row.textContent);
  if (!raw || !title) return "";
  const index = normalizeIndicatorText(raw).indexOf(normalizeIndicatorText(title));
  return index > 0 ? raw.slice(0, index).trim() : "";
}

function isVisibleElement(node) {
  if (!(node instanceof HTMLElement)) return false;
  const rect = node.getBoundingClientRect();
  return rect.width > 1 && rect.height > 1;
}

function closestSidebarItem(node) {
  if (!(node instanceof Element)) return null;
  const row = node.closest("[data-app-action-sidebar-thread-row], a[href*='/local/'], button, [role='link'], [role='button'], [role='treeitem'], [role='listitem']");
  if (!(row instanceof HTMLElement)) return node instanceof HTMLElement ? node : null;
  if (row.querySelectorAll("a[href*='/local/']").length > 1) return null;
  return row;
}

function readSidebarIndicators(node) {
  if (!(node instanceof HTMLElement)) return { hasUnread: false, hasProgress: false };
  const hasProgress = hasMatchingElement(
    node,
    [
      "[role='progressbar']",
      "[aria-label*='progress' i]",
      "[aria-label*='running' i]",
      "[aria-label*='loading' i]",
      "[data-testid*='progress' i]",
      "[data-testid*='spinner' i]",
      "[data-testid*='loading' i]",
      "[class*='spinner' i]",
      "svg[class*='animate-spin']",
      "[class~='animate-spin']",
    ],
  );
  const hasUnread = unreadScopesForSidebarItem(node).some((scope) => hasUnreadMarker(scope));
  return { hasUnread, hasProgress };
}

function unreadScopesForSidebarItem(node) {
  const scopes = [node];
  const parent = node.parentElement;
  if (parent && parent.querySelectorAll("[data-app-action-sidebar-thread-row], a[href*='/local/']").length <= 1) scopes.push(parent);
  const grandparent = parent?.parentElement;
  if (grandparent && grandparent.querySelectorAll("[data-app-action-sidebar-thread-row], a[href*='/local/']").length <= 1) scopes.push(grandparent);
  return scopes;
}

function hasUnreadMarker(scope) {
  if (hasUnreadTitleStyle(scope)) return true;
  return hasMatchingElement(
    scope,
    [
      "[aria-label*='unread' i]",
      "[data-testid*='unread' i]",
      "[class*='unread' i]",
      "[class*='bg-token-charts-blue'][class*='rounded-full']",
      "[class*='bg-token-text-link-foreground'][class*='rounded-full']",
      "[class*='bg-token-text-primary'][class*='rounded-full']",
      "[class*='bg-token-foreground'][class*='rounded-full']",
      "[class*='bg-token-list-active-selection-foreground'][class*='rounded-full']",
      "[class*='opacity-100'][class*='rounded-full']",
      "[class*='rounded-full']",
    ],
    (candidate) => !isProgressElement(candidate) && looksLikeUnreadMarker(candidate),
  );
}

function hasUnreadTitleStyle(scope) {
  if (!(scope instanceof HTMLElement)) return false;
  const titleNodes = scope.querySelectorAll(
    [
      ".text-token-foreground\\/40",
      "[class*='text-token-foreground/40']",
      "[class*='group-hover:text-token-foreground']",
    ].join(", "),
  );
  for (const node of titleNodes) {
    if (!(node instanceof HTMLElement)) continue;
    const text = normalizeIndicatorText(node.textContent);
    if (text && text.length > 2) return true;
  }
  return false;
}

function hasMatchingElement(root, selectors, predicate) {
  const matches = [];
  for (const selector of selectors) {
    if (root.matches?.(selector)) matches.push(root);
    matches.push(...root.querySelectorAll(selector));
  }
  return matches.some((candidate) => (
    candidate instanceof HTMLElement || candidate instanceof SVGElement
  ) && (!predicate || predicate(candidate)));
}

function isProgressElement(node) {
  if (!(node instanceof Element)) return false;
  const text = `${node.className || ""} ${node.getAttribute("aria-label") || ""} ${node.getAttribute("data-testid") || ""}`.toLowerCase();
  return /\b(progress|running|loading|spinner|animate-spin)\b/.test(text);
}

function looksLikeUnreadMarker(node) {
  if (!(node instanceof Element)) return false;
  if (node.closest("[data-codexpp-chat-label]")) return false;
  const text = `${node.className || ""} ${node.getAttribute("aria-label") || ""} ${node.getAttribute("data-testid") || ""}`.toLowerCase();
  if (/\bunread\b/.test(text)) return true;
  if (!text.includes("rounded-full")) return false;

  const rect = node.getBoundingClientRect?.();
  const hasSizeClass = /\b(size|h|w)-\d|h-\[|w-\[/.test(text);
  if (!rect || rect.width === 0 || rect.height === 0) return hasSizeClass;
  if (rect.width > 14 || rect.height > 14) return false;
  return hasSizeClass || hasVisibleMarkerFill(node);
}

function hasVisibleMarkerFill(node) {
  if (!(node instanceof Element)) return false;
  const background = getComputedStyle(node).backgroundColor;
  return Boolean(background && background !== "transparent" && !/rgba?\(\s*0\s*,\s*0\s*,\s*0\s*(?:,\s*0\s*)?\)/i.test(background));
}

function normalizeIndicatorText(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeVisibleTitle(value) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  return text.length <= 120 ? text : text.slice(0, 117).trimEnd() + "...";
}

function normalizeSidebarThreadId(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const local = raw.match(/^local:([0-9a-f-]{36})$/i);
  if (local) return local[1];
  return /^[0-9a-f-]{36}$/i.test(raw) ? raw : null;
}

function getCurrentChatId() {
  return currentChatIdFromRoute()
    || currentChatIdFromSidebarActive()
    || currentChatIdFromActiveLink();
}

function currentChatIdFromRoute() {
  return chatIdFromPathname(window.location.pathname)
    || chatIdFromHref(window.location.href);
}

function chatIdFromPathname(pathname) {
  const match = pathname.match(/^\/local\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function chatIdFromHref(href) {
  const match = String(href || "").match(/\/local\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function currentChatIdFromActiveLink() {
  const selectors = [
    'a[aria-current="page"][href*="/local/"]',
    'a[data-state="active"][href*="/local/"]',
    'a[aria-selected="true"][href*="/local/"]',
  ];
  for (const selector of selectors) {
    const anchor = document.querySelector(selector);
    if (anchor instanceof HTMLAnchorElement) {
      const id = chatIdFromHref(anchor.href);
      if (id) return id;
    }
  }
  return null;
}

function currentChatIdFromHeaderTitle(state) {
  const title = normalizeIndicatorText(currentNativeHeaderTitle(state));
  if (!title) return null;

  const items = [
    ...state.openIds.map((id) => state.knownTabs[id]).filter(Boolean),
    ...state.tabs,
    ...Object.values(state.knownTabs || {}),
  ];
  const seen = new Set();
  for (const item of items) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    if (normalizeIndicatorText(item.title) === title) return item.id;
  }
  return null;
}

function currentNativeHeaderTitle(state) {
  const header = document.querySelector("header");
  if (!(header instanceof HTMLElement)) return "";

  const candidates = Array.from(header.querySelectorAll("span, div"))
    .filter((node) => node instanceof HTMLElement)
    .filter((node) => !state?.root?.contains(node))
    .filter((node) => !node.closest("button, [role='button'], a"))
    .map((node) => ({
      node,
      title: normalizeVisibleTitle(node.textContent),
      rect: node.getBoundingClientRect(),
    }))
    .filter(({ title, rect }) =>
      title &&
      rect.width > 1 &&
      rect.height > 1 &&
      rect.width <= 520 &&
      rect.height <= 40
    )
    .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));

  return candidates[0]?.title || "";
}

function currentChatIdFromSidebarActive() {
  const selectors = [
    '[data-app-action-sidebar-thread-active="true"][data-app-action-sidebar-thread-id]',
    '[data-app-action-sidebar-thread-row][aria-current="page"][data-app-action-sidebar-thread-id]',
    '[data-app-action-sidebar-thread-row][data-state="active"][data-app-action-sidebar-thread-id]',
  ];
  for (const selector of selectors) {
    const row = document.querySelector(selector);
    if (!(row instanceof HTMLElement)) continue;
    const id = normalizeSidebarThreadId(row.getAttribute("data-app-action-sidebar-thread-id"));
    if (id) return id;
  }
  return null;
}

function formatMetadata(item) {
  const pieces = [];
  if (item.cwdBasename) pieces.push(item.cwdBasename);
  if (item.updatedAt) pieces.push(relativeTime(item.updatedAt));
  return pieces.join(" - ") || "Recent chat";
}

function relativeTime(value) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "";
  const diff = Date.now() - ms;
  const min = Math.max(0, Math.round(diff / 60000));
  if (min < 1) return "now";
  if (min < 60) return `${min}m ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function clickElement(node) {
  if (!(node instanceof HTMLElement)) return false;
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
    const EventConstructor = type.startsWith("pointer") && typeof PointerEvent === "function"
      ? PointerEvent
      : MouseEvent;
    node.dispatchEvent(new EventConstructor(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 0,
      pointerType: "mouse",
      isPrimary: true,
    }));
  }
  node.click();
  return true;
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function nextAnimationFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function readArray(api, key) {
  const value = api.storage.get(key, []);
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function readKnownTabs(api) {
  const value = api.storage.get(KNOWN_TABS_KEY, {});
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cssString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function stopEvent(event) {
  event.preventDefault();
  event.stopPropagation();
}

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function closeIconSvg(className) {
  return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" class="' + className + '" aria-hidden="true">' +
    '<path d="M5.75 5.75L14.25 14.25M14.25 5.75L5.75 14.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
    "</svg>";
}

function externalWindowIconSvg(className) {
  return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" class="' + className + '" aria-hidden="true">' +
    '<path d="M11 4.75h4.25V9M10.5 9.5l4.5-4.5M8.75 5.75H6.5A1.75 1.75 0 0 0 4.75 7.5v6A1.75 1.75 0 0 0 6.5 15.25h6A1.75 1.75 0 0 0 14.25 13.5v-2.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    "</svg>";
}

function ellipsisIconSvg(className) {
  return '<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" class="' + className + '" aria-hidden="true">' +
    '<circle cx="5" cy="10" r="1.25"/><circle cx="10" cy="10" r="1.25"/><circle cx="15" cy="10" r="1.25"/>' +
    "</svg>";
}

function folderIconSvg(className) {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" viewBox="0 0 20 20" class="' + className + '" aria-hidden="true">' +
    '<path d="M6.584 2.874a3.01 3.01 0 0 1 1.816.757c.073.064.142.135.243.237.112.113.15.15.187.183.292.26.663.415 1.053.44.049.002.102.002.261.002h2.718c.56 0 1.015 0 1.386.027.377.027.714.086 1.034.226.608.267 1.11.727 1.43 1.31.168.307.256.637.316 1.01.03.181.054.383.077.609h.371a1.915 1.915 0 0 1 1.832 2.475l-1.645 5.367a2.331 2.331 0 0 1-2.229 1.648H4.754c-.61 0-1.15-.23-1.559-.6a3.006 3.006 0 0 1-.847-.933c-.191-.33-.287-.687-.351-1.093-.063-.398-.1-.89-.147-1.499l-.418-5.435c-.052-.683-.096-1.235-.093-1.681.002-.453.05-.858.214-1.237a3.008 3.008 0 0 1 1.365-1.475c.366-.192.766-.27 1.218-.308.444-.036.997-.036 1.682-.036h.427c.144 0 .242 0 .339.006Zm-.66 6.13a.586.586 0 0 0-.559.415l-1.57 5.121a1.002 1.002 0 0 0 .589 1.224c.109.03.244.055.422.071h10.628c.44 0 .828-.288.957-.708l1.645-5.366a.585.585 0 0 0-.56-.756H5.925Zm-.106-4.872c-.706 0-1.198 0-1.579.032-.374.03-.582.087-.734.167a1.744 1.744 0 0 0-.791.855c-.068.157-.11.369-.112.745-.002.382.036.873.09 1.578l.374 4.87 1.028-3.35a1.916 1.916 0 0 1 1.83-1.354h9.909a8.189 8.189 0 0 0-.052-.406c-.05-.304-.107-.476-.178-.606a1.746 1.746 0 0 0-.829-.76c-.135-.059-.312-.1-.618-.123a19.667 19.667 0 0 0-1.294-.023h-2.718c-.143 0-.243 0-.34-.006a3.007 3.007 0 0 1-1.815-.757 6.091 6.091 0 0 1-.243-.237 4.418 4.418 0 0 0-.187-.183 1.745 1.745 0 0 0-1.052-.44c-.05-.002-.103-.002-.262-.002h-.427Z"></path>' +
    "</svg>";
}

// ------------------------------------------------------------------- main --

const MAIN_GLOBAL_KEY = "__bennettCodexVerticalTabsService";
const MAIN_SHORTCUT_BRIDGE_KEY = "__bennettCodexVerticalTabsShortcutBridge";

function startMain(api) {
  installMainShortcutBridge(api);

  const service = createMainService(api);
  globalThis[MAIN_GLOBAL_KEY] = service;

  replaceMainHandler(api, IPC_RECENT_CHATS, (payload = {}) => {
    const active = globalThis[MAIN_GLOBAL_KEY];
    return active?.getRecentChats?.(payload) || [];
  });
  replaceMainHandler(api, IPC_NAVIGATE_CHAT, (id) => {
    const active = globalThis[MAIN_GLOBAL_KEY];
    return active?.navigateChat?.(id) || false;
  });

  api.log.info("[conversation-tabs] main provider active");
}

function installMainShortcutBridge(api) {
  let electron;
  try {
    electron = require("electron");
  } catch (error) {
    api.log.warn("[conversation-tabs] shortcut bridge unavailable", error);
    return;
  }

  globalThis[MAIN_SHORTCUT_BRIDGE_KEY]?.dispose?.();

  const attached = new Map();
  const attach = (wc) => {
    if (!wc || wc.isDestroyed?.() || attached.has(wc)) return;

    const beforeInput = (event, input = {}) => {
      const index = mainTabShortcutIndex(input);
      const closeCurrent = mainCloseCurrentTabShortcut(input);
      const newChat = mainNewChatShortcut(input);
      if ((index === null && !closeCurrent && !newChat) || !isCodexAppWebContents(wc)) return;

      if (newChat) {
        wc.executeJavaScript(dispatchNewChatIntentScript("keyboard"), true).catch((error) => {
          api.log.warn("[conversation-tabs] new chat intent dispatch failed", error);
        });
        return;
      }

      event.preventDefault();
      if (closeCurrent) {
        wc.executeJavaScript(dispatchCloseCurrentTabShortcutScript(), true).catch((error) => {
          api.log.warn("[conversation-tabs] close shortcut dispatch failed", error);
        });
        return;
      }

      wc.executeJavaScript(dispatchTabShortcutScript(index), true).then((result) => {
        const navigateId = result && typeof result.navigateId === "string" ? result.navigateId : null;
        if (navigateId) globalThis[MAIN_GLOBAL_KEY]?.navigateChat?.(navigateId);
      }).catch((error) => {
        api.log.warn("[conversation-tabs] shortcut dispatch failed", error);
      });
    };
    const destroyed = () => {
      attached.delete(wc);
    };

    wc.on("before-input-event", beforeInput);
    wc.once("destroyed", destroyed);
    attached.set(wc, { beforeInput, destroyed });
  };

  const onCreated = (_event, wc) => attach(wc);
  for (const wc of electron.webContents.getAllWebContents()) attach(wc);
  electron.app.on("web-contents-created", onCreated);

  globalThis[MAIN_SHORTCUT_BRIDGE_KEY] = {
    dispose() {
      electron.app.removeListener("web-contents-created", onCreated);
      for (const [wc, listeners] of attached) {
        if (!wc.isDestroyed?.()) {
          wc.removeListener("before-input-event", listeners.beforeInput);
          wc.removeListener("destroyed", listeners.destroyed);
        }
      }
      attached.clear();
    },
  };
}

function mainTabShortcutIndex(input = {}) {
  if (input.type !== "keyDown" && input.type !== "rawKeyDown") return null;
  if (!(input.meta || input.command) || input.control || input.alt || input.shift) return null;
  if (input.isAutoRepeat) return null;

  const key = String(input.key || input.keyCode || "");
  if (/^[1-9]$/.test(key)) return Number(key) - 1;
  const codeMatch = String(input.code || "").match(/^(?:Digit|Numpad)([1-9])$/);
  return codeMatch ? Number(codeMatch[1]) - 1 : null;
}

function mainCloseCurrentTabShortcut(input = {}) {
  if (input.type !== "keyDown" && input.type !== "rawKeyDown") return false;
  if (!(input.meta || input.command) || input.control || input.alt || input.shift) return false;
  if (input.isAutoRepeat) return false;
  return String(input.key || "").toLowerCase() === "w" || input.code === "KeyW";
}

function mainNewChatShortcut(input = {}) {
  if (input.type !== "keyDown" && input.type !== "rawKeyDown") return false;
  if (!(input.meta || input.command) || input.control || input.alt || input.shift) return false;
  if (input.isAutoRepeat) return false;
  return String(input.key || "").toLowerCase() === "n" || input.code === "KeyN";
}

function isCodexAppWebContents(wc) {
  const url = wc.getURL?.() || "";
  return url.startsWith("app://") || url.includes("codex");
}

function dispatchCloseCurrentTabShortcutScript() {
  return `
    (() => {
      const event = new Event("codexpp-conversation-tab-close-current", {
        cancelable: true,
      });
      window.dispatchEvent(event);
      return { handled: event.defaultPrevented };
    })()
  `;
}

function dispatchNewChatIntentScript(source) {
  return `
    (() => {
      const event = new CustomEvent("codexpp-conversation-tab-new-chat-intent", {
        detail: { source: ${JSON.stringify(source || "keyboard")} },
        cancelable: false,
      });
      window.dispatchEvent(event);
      return { handled: true };
    })()
  `;
}

function dispatchTabShortcutScript(index) {
  return `
    (() => {
      const event = new CustomEvent("codexpp-conversation-tab-shortcut", {
        detail: { index: ${Number(index) || 0} },
        cancelable: true,
      });
      window.dispatchEvent(event);
      if (event.defaultPrevented) return { handled: true };

      const tabs = Array.from(document.querySelectorAll("[data-codexpp-conversation-tab='true']"));
      const tab = tabs[${Number(index) || 0}];
      const id = tab instanceof HTMLElement ? tab.getAttribute("data-tab-id") : null;
      if (!id) return { handled: false };

      for (const item of tabs) item.setAttribute("aria-selected", String(item === tab));
      tab.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      return { handled: true, navigateId: id };
    })()
  `;
}

function replaceMainHandler(api, channel, handler) {
  try {
    const { ipcMain } = require("electron");
    ipcMain.removeHandler(`codexpp:${api.manifest.id}:${channel}`);
  } catch {
    // Older Electron builds may not expose removeHandler; the runtime will
    // register the handler through the normal path.
  }
  api.ipc.handle(channel, handler);
}

function createMainService(api) {
  let cache = { at: 0, value: [] };
  const TTL_MS = 800;

  return {
    getRecentChats(payload = {}) {
      const now = Date.now();
      if (now - cache.at >= TTL_MS) {
        try {
          cache = { at: now, value: readRecentChats() };
        } catch (error) {
          api.log.warn("[conversation-tabs] recent scan failed", error);
          cache = { at: now, value: [] };
        }
      }
      const limit = Math.max(1, Math.min(RECENT_SCAN_LIMIT, Number(payload?.limit) || RECENT_SCAN_LIMIT));
      return cache.value.slice(0, limit);
    },

    navigateChat(id) {
      try {
        return navigateFocusedWindowToChat(id);
      } catch (error) {
        api.log.warn("[conversation-tabs] navigate failed", error);
        return false;
      }
    },
  };
}

function readRecentChats() {
  const fs = require("node:fs");
  const path = require("node:path");
  const os = require("node:os");
  const home = process.env.HOME || os.homedir();
  const indexPath = path.join(home, ".codex", "session_index.jsonl");
  const lines = fs.readFileSync(indexPath, "utf8").split(/\r?\n/);
  const byId = new Map();

  for (const line of lines) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || typeof row.id !== "string") continue;
    const updatedAt = typeof row.updated_at === "string" ? row.updated_at : null;
    const prev = byId.get(row.id);
    if (!prev || compareIso(updatedAt, prev.updatedAt) > 0) {
      byId.set(row.id, {
        id: row.id,
        title: typeof row.thread_name === "string" && row.thread_name.trim()
          ? row.thread_name.trim()
          : "Untitled chat",
        updatedAt,
      });
    }
  }

  const sessions = collectSessionFiles(fs, path, home);
  return uniqueByTitle(Array.from(byId.values()))
    .sort((a, b) => compareIso(b.updatedAt, a.updatedAt))
    .slice(0, RECENT_SCAN_LIMIT)
    .map((chat) => enrichChat(fs, path, chat, sessions.get(chat.id)));
}

function uniqueByTitle(items) {
  const byTitle = new Map();
  for (const item of items) {
    const key = normalizeTitleKey(item.title);
    const previous = byTitle.get(key);
    if (!previous || compareIso(item.updatedAt, previous.updatedAt) > 0) {
      byTitle.set(key, item);
    }
  }
  return Array.from(byTitle.values());
}

function normalizeTitleKey(title) {
  return String(title || "Untitled chat").trim().replace(/\s+/g, " ").toLowerCase();
}

function enrichChat(fs, path, chat, sessionFile) {
  if (!sessionFile) return { ...chat, cwdBasename: null, isRunning: false };
  const details = readSessionDetails(fs, path, sessionFile);
  return {
    ...chat,
    cwdBasename: details.cwdBasename,
    isRunning: details.isRunning,
  };
}

function collectSessionFiles(fs, path, home) {
  const roots = [
    path.join(home, ".codex", "sessions"),
    path.join(home, ".codex", "archived_sessions"),
  ];
  const out = new Map();
  for (const root of roots) collectJsonlFiles(fs, root, out);
  return out;
}

function collectJsonlFiles(fs, dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      collectJsonlFiles(fs, full, out);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      const match = entry.name.match(
        /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
      );
      const id = match?.[1];
      if (id && !out.has(id)) out.set(id, full);
    }
  }
}

function readSessionDetails(fs, path, file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { cwdBasename: null, isRunning: false };
  }

  let cwdBasename = null;
  let isRunning = false;
  const lines = text.split(/\r?\n/);
  for (const line of lines.slice(0, 40)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      const cwd = row?.payload?.cwd || row?.payload?.session_meta?.cwd;
      if (typeof cwd === "string" && cwd.trim()) {
        cwdBasename = path.basename(cwd);
        break;
      }
    } catch {
      // Ignore malformed session lines.
    }
  }

  for (let i = lines.length - 1, seen = 0; i >= 0 && seen < 80; i -= 1) {
    const line = lines[i];
    if (!line?.trim()) continue;
    seen += 1;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (containsInProgress(row)) {
      isRunning = true;
      break;
    }
    if (containsTerminalTurnState(row)) break;
  }
  return { cwdBasename, isRunning };
}

function containsInProgress(value) {
  if (!value || typeof value !== "object") return false;
  if (value.status === "inProgress" || value.status === "in_progress") return true;
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && containsInProgress(child)) return true;
  }
  return false;
}

function containsTerminalTurnState(value) {
  if (!value || typeof value !== "object") return false;
  const terminal = new Set(["completed", "failed", "cancelled", "canceled"]);
  if (typeof value.status === "string" && terminal.has(value.status)) return true;
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && containsTerminalTurnState(child)) return true;
  }
  return false;
}

function compareIso(a, b) {
  const at = Date.parse(a || "");
  const bt = Date.parse(b || "");
  const av = Number.isFinite(at) ? at : 0;
  const bv = Number.isFinite(bt) ? bt : 0;
  return av - bv;
}

function navigateFocusedWindowToChat(id) {
  if (typeof id !== "string" || !id.trim()) return false;
  const electron = require("electron");
  const window = electron.BrowserWindow.getFocusedWindow()
    || electron.BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed() && candidate.isVisible());
  if (!window || window.isDestroyed()) return false;
  const path = `/local/${encodeURIComponent(id.trim())}`;
  window.webContents.send("codex_desktop:message-for-view", {
    type: "navigate-to-route",
    path,
  });
  return true;
}
