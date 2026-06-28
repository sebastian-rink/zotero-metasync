import { getString, initLocale } from "./utils/locale";
import { createZToolkit } from "./utils/ztoolkit";
import { isSupportedItem, syncSelectedItems } from "./modules/metaSync";
import {
  isSearchableItem,
  searchSelectedItemInBrowser,
  WEB_SEARCH_ENGINES,
  type WebSearchEngineId,
} from "./modules/webSearch";

/** popupshowing-Listener je Hauptfenster, für sauberes Cleanup. */
const itemMenuListeners = new Map<Window, () => void>();

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  // ztoolkit pro Fenster erzeugen.
  addon.data.ztoolkit = createZToolkit();

  // MetaSync-FTL für DOM-gebundene Lokalisierung verfügbar machen.
  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-metasync.ftl`,
  );

  registerItemMenu(win);
  registerToolsMenu();
}

/**
 * Registriert den Kontextmenü-Eintrag und einen popupshowing-Listener, der den
 * Eintrag bei nicht unterstützten Eintragstypen deaktiviert (mit Tooltip).
 */
function registerItemMenu(win: _ZoteroTypes.MainWindow): void {
  const menuIcon = `chrome://${addon.data.config.addonRef}/content/icons/favicon@0.5x.png`;
  ztoolkit.Menu.register("item", {
    tag: "menuitem",
    id: "metasync-itemmenu-sync",
    label: getString("menu-sync"),
    commandListener: () => addon.hooks.onMetaSyncRun(),
    icon: menuIcon,
  });

  // Untermenü „Im Web suchen": öffnet je Suchmaschine eine vorbefüllte Suche.
  ztoolkit.Menu.register("item", {
    tag: "menu",
    id: "metasync-itemmenu-websearch",
    label: getString("menu-websearch"),
    icon: menuIcon,
    children: WEB_SEARCH_ENGINES.map((engine) => ({
      tag: "menuitem",
      id: `metasync-itemmenu-websearch-${engine.id}`,
      label: getString(engine.labelKey),
      commandListener: () => addon.hooks.onWebSearchRun(engine.id),
    })),
  });

  const itemMenu = win.document.getElementById("zotero-itemmenu");
  if (!itemMenu) return;

  const listener = () => {
    const items = ztoolkit.getGlobal("ZoteroPane").getSelectedItems();

    const menuitem = win.document.getElementById(
      "metasync-itemmenu-sync",
    ) as XUL.MenuItem | null;
    if (menuitem) {
      const anySupported = items.some((item) => isSupportedItem(item));
      if (anySupported) {
        menuitem.removeAttribute("disabled");
        menuitem.removeAttribute("tooltiptext");
      } else {
        menuitem.setAttribute("disabled", "true");
        menuitem.setAttribute("tooltiptext", getString("menu-unsupported"));
      }
    }

    // Web-Suche ist für jeden betitelten Eintrag sinnvoll (breiter als Sync).
    const websearch = win.document.getElementById(
      "metasync-itemmenu-websearch",
    ) as XUL.Menu | null;
    if (websearch) {
      const anySearchable = items.some((item) => isSearchableItem(item));
      if (anySearchable) {
        websearch.removeAttribute("disabled");
      } else {
        websearch.setAttribute("disabled", "true");
      }
    }
  };
  itemMenu.addEventListener("popupshowing", listener);
  itemMenuListeners.set(win, listener);
}

/** Registriert den Eintrag im Extras-(Tools-)Menü. */
function registerToolsMenu(): void {
  ztoolkit.Menu.register("menuTools", {
    tag: "menuitem",
    id: "metasync-toolsmenu-sync",
    label: getString("menu-sync"),
    commandListener: () => addon.hooks.onMetaSyncRun(),
  });
}

async function onMainWindowUnload(win: Window): Promise<void> {
  // Manuell registrierten popupshowing-Listener entfernen.
  const listener = itemMenuListeners.get(win);
  const itemMenu = win.document.getElementById("zotero-itemmenu");
  if (listener && itemMenu) {
    itemMenu.removeEventListener("popupshowing", listener);
  }
  itemMenuListeners.delete(win);

  ztoolkit.unregisterAll();
}

function onShutdown(): void {
  ztoolkit.unregisterAll();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

/** Dispatcher für den MetaSync-Befehl (Kontext-/Extras-Menü). */
async function onMetaSyncRun(): Promise<void> {
  await syncSelectedItems();
}

/** Dispatcher für die Web-Suche (Untermenü „Im Web suchen"). */
function onWebSearchRun(engineId: WebSearchEngineId): void {
  searchSelectedItemInBrowser(engineId);
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onMetaSyncRun,
  onWebSearchRun,
};
