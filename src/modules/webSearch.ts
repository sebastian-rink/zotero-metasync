/**
 * webSearch.ts — Manuelle Web-Suche zu einem Zotero-Eintrag.
 *
 * Ergänzt die automatische Quellenabfrage um eine schnelle Recherche im
 * Standardbrowser des Nutzers: Aus Titel und erstem Autor wird ein Suchbegriff
 * gebaut und an die URL der gewählten Suchmaschine angehängt (deren Suchfeld
 * damit faktisch „vorausgefüllt" ist). Geöffnet wird über `Zotero.launchURL`,
 * das die System-Standardanwendung für `http(s)` verwendet.
 *
 * Eine fremde Website lässt sich technisch nicht direkt im DOM befüllen; der
 * Query-Parameter-Ansatz erreicht dasselbe Ziel auf robuste, browserneutrale
 * Weise.
 */

import { getString } from "../utils/locale";
import type { FluentMessageId } from "../../typings/i10n";

// ---------------------------------------------------------------------------
// Suchmaschinen-Definitionen
// ---------------------------------------------------------------------------

/** Kennung einer Suchmaschine (zugleich Menü-Item-Suffix). */
export type WebSearchEngineId = "google" | "scholar" | "dnb" | "worldcat";

/** Beschreibt ein Suchziel samt URL-Vorlage. */
export interface WebSearchEngine {
  /** Eindeutige Kennung. */
  id: WebSearchEngineId;
  /** FTL-Schlüssel der Menübeschriftung. */
  labelKey: FluentMessageId;
  /**
   * URL-Vorlage mit dem Platzhalter `{q}`, der durch den bereits
   * URL-kodierten Suchbegriff ersetzt wird.
   */
  urlTemplate: string;
}

/**
 * Verfügbare Suchziele in Anzeigereihenfolge. Auswahl mit Blick auf
 * deutsche/theologische Literatur: allgemeine Websuche, akademische Suche
 * sowie zwei Bibliothekskataloge (DNB, WorldCat).
 */
export const WEB_SEARCH_ENGINES: readonly WebSearchEngine[] = [
  {
    id: "google",
    labelKey: "websearch-google",
    urlTemplate: "https://www.google.com/search?q={q}",
  },
  {
    id: "scholar",
    labelKey: "websearch-scholar",
    urlTemplate: "https://scholar.google.com/scholar?q={q}",
  },
  {
    id: "dnb",
    labelKey: "websearch-dnb",
    urlTemplate: "https://portal.dnb.de/opac/simpleSearch?query={q}",
  },
  {
    id: "worldcat",
    labelKey: "websearch-worldcat",
    urlTemplate: "https://search.worldcat.org/search?q={q}",
  },
];

// ---------------------------------------------------------------------------
// Feldzugriff & Suchbegriff
// ---------------------------------------------------------------------------

/** Liest ein Feld sicher aus (leerer String bei nicht vorhandenem Feld). */
function field(item: Zotero.Item, name: string): string {
  try {
    return (item.getField(name) as string)?.trim() ?? "";
  } catch {
    return "";
  }
}

/** Liefert den Nachnamen des ersten Beteiligten (zur Eingrenzung der Suche). */
function firstCreatorLastName(item: Zotero.Item): string {
  const creators = item.getCreators();
  const first = creators[0];
  if (!first) return "";
  // Einzelfeld-Modus (fieldMode 1) führt den Namen komplett in lastName.
  return first.lastName?.trim() ?? "";
}

/**
 * Prüft, ob ein Eintrag durchsuchbar ist: reguläre Quelle mit nicht-leerem
 * Titel. Bewusst breiter als die MetaSync-Synchronisation, da eine Web-Suche
 * zu jedem betitelten Eintrag sinnvoll ist.
 */
export function isSearchableItem(item: Zotero.Item): boolean {
  return item.isRegularItem() && field(item, "title").length > 0;
}

/**
 * Baut den Suchbegriff aus Titel (in Anführungszeichen für Phrasen-Treffer)
 * und – falls vorhanden – dem Nachnamen des ersten Autors. Gibt `null` zurück,
 * wenn kein Titel vorhanden ist.
 */
export function buildSearchQuery(item: Zotero.Item): string | null {
  const title = field(item, "title");
  if (!title) return null;
  const author = firstCreatorLastName(item);
  const parts = [`"${title}"`];
  if (author) parts.push(author);
  return parts.join(" ");
}

/** Setzt den Suchbegriff in die URL-Vorlage einer Suchmaschine ein. */
function buildSearchUrl(engine: WebSearchEngine, query: string): string {
  return engine.urlTemplate.replace("{q}", encodeURIComponent(query));
}

// ---------------------------------------------------------------------------
// Ausführung
// ---------------------------------------------------------------------------

/** Zeigt eine kurze Statusmeldung im ProgressWindow. */
function notify(messageKey: FluentMessageId): void {
  new ztoolkit.ProgressWindow(addon.data.config.addonName)
    .createLine({ text: getString(messageKey), type: "default", progress: 100 })
    .show();
}

/**
 * Öffnet im Standardbrowser eine Suche nach dem aktuell ausgewählten Eintrag.
 *
 * Bei mehreren markierten Einträgen wird der erste durchsuchbare verwendet, um
 * ein unbeabsichtigtes Öffnen vieler Browser-Tabs zu vermeiden.
 *
 * @param engineId Kennung der gewünschten Suchmaschine.
 */
export function searchSelectedItemInBrowser(engineId: WebSearchEngineId): void {
  const engine = WEB_SEARCH_ENGINES.find((e) => e.id === engineId);
  if (!engine) return;

  const pane = ztoolkit.getGlobal("ZoteroPane");
  const item = pane.getSelectedItems().find(isSearchableItem);
  if (!item) {
    notify("websearch-no-title");
    return;
  }

  const query = buildSearchQuery(item);
  if (!query) {
    notify("websearch-no-title");
    return;
  }

  try {
    Zotero.launchURL(buildSearchUrl(engine, query));
  } catch (error) {
    Zotero.debug(`[MetaSync] Web-Suche fehlgeschlagen: ${String(error)}`);
    notify("websearch-failed");
  }
}
