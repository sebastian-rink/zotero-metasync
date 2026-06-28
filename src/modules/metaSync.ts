/**
 * metaSync.ts — Haupt-Controller und Orchestrierung von MetaSync.
 *
 * Ablauf je Eintrag: Eintragstyp erkennen → Quellen gemäß Strategie abfragen →
 * Trefferauswahl (Schwellenwert / Dialog) → Mapping → Diff → Vorschau-Dialog →
 * Speichern via `saveTx()`. Unterstützt Mehrfachauswahl mit Navigation
 * (Zurück/Weiter), Ratenbegrenzung und die Preferences (aktive Quellen,
 * Schwellenwert, Vorschaumodus).
 *
 * Entwicklungsreihenfolge Schritt 8.
 */

import {
  fetchFromCrossref,
  fetchFromDNB,
  fetchFromDNBByISBN,
  fetchFromGoogleBooks,
  fetchFromOpenLibrary,
  fetchFromSemanticScholar,
  type ApiSource,
  type RawMetadata,
} from "./apiClient";
import { mapMetadata, type SupportedItemType } from "./fieldMapper";
import { computeDiff, type DiffResult } from "./diffEngine";
import {
  openCandidateDialog,
  type Candidate,
} from "./candidateDialog";
import {
  openPreviewDialog,
  type PreviewInput,
  type PreviewQuality,
} from "./previewDialog";
import { getPref } from "../utils/prefs";
import { getString } from "../utils/locale";

/** Anzeigenamen der Quellen für die Dialoge. */
const SOURCE_NAMES: Record<ApiSource, string> = {
  crossref: "Crossref",
  openLibrary: "Open Library",
  googleBooks: "Google Books",
  dnb: "DNB",
  semanticScholar: "Semantic Scholar",
};

/** Pause zwischen Netzanfragen verschiedener Einträge (Ratenbegrenzung). */
const RATE_LIMIT_MS = 500;

// ---------------------------------------------------------------------------
// Eintragstyp & Feldzugriff
// ---------------------------------------------------------------------------

/** Liefert den unterstützten Eintragstyp oder `null`. */
function getSupportedType(item: Zotero.Item): SupportedItemType | null {
  const name = Zotero.ItemTypes.getName(item.itemTypeID);
  if (name === "book" || name === "journalArticle" || name === "bookSection") {
    return name;
  }
  return null;
}

/**
 * Prüft, ob ein Eintrag von MetaSync unterstützt wird (für die Menü-Aktivierung).
 */
export function isSupportedItem(item: Zotero.Item): boolean {
  return item.isRegularItem() && getSupportedType(item) !== null;
}

/** Liest ein Feld sicher aus (leerer String bei nicht vorhandenem Feld). */
function field(item: Zotero.Item, name: string): string {
  try {
    return (item.getField(name) as string)?.trim() ?? "";
  } catch {
    return "";
  }
}

/** Liefert den Nachnamen des ersten Autors (für titelbasierte Suchen). */
function firstAuthorLastName(item: Zotero.Item): string {
  const creators = item.getCreators();
  const first = creators[0];
  return first ? first.lastName?.trim() ?? "" : "";
}

// ---------------------------------------------------------------------------
// Titel-Ähnlichkeit (Levenshtein)
// ---------------------------------------------------------------------------

/** Berechnet die Levenshtein-Distanz zweier Strings. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/** Ähnlichkeit 0..1 zweier Titel (normalisiert, Levenshtein-basiert). */
function titleSimilarity(a: string, b: string): number {
  const na = a.toLowerCase().replace(/\s+/g, " ").trim();
  const nb = b.toLowerCase().replace(/\s+/g, " ").trim();
  if (!na && !nb) return 1;
  if (!na || !nb) return 0;
  const maxLen = Math.max(na.length, nb.length);
  return 1 - levenshtein(na, nb) / maxLen;
}

// ---------------------------------------------------------------------------
// Preferences-Helfer
// ---------------------------------------------------------------------------

/** Schwellenwert als Anteil 0..1 (aus Prozent-Pref). */
function getThreshold(): number {
  const pct = Number(getPref("matchThreshold"));
  const safe = Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 85;
  return safe / 100;
}

/** Prüft, ob eine Quelle in den Preferences aktiviert ist. */
function sourceEnabled(source: ApiSource): boolean {
  switch (source) {
    case "crossref":
      return Boolean(getPref("source.crossref"));
    case "openLibrary":
      return Boolean(getPref("source.openLibrary"));
    case "googleBooks":
      return Boolean(getPref("source.googleBooks"));
    case "dnb":
      return Boolean(getPref("source.dnb"));
    case "semanticScholar":
      return Boolean(getPref("source.semanticScholar"));
  }
}

// ---------------------------------------------------------------------------
// Lookup-Strategie je Eintragstyp
// ---------------------------------------------------------------------------

/** Sammelt Ergebnisse für eine Monographie. */
async function lookupBook(item: Zotero.Item): Promise<RawMetadata[]> {
  const results: RawMetadata[] = [];
  const doi = field(item, "DOI");
  const isbn = field(item, "ISBN");
  const apiKey = String(getPref("googleApiKey") ?? "");

  // DOI hat höchste Priorität: eindeutiger Bezeichner, vollständige Crossref-Daten.
  if (doi && sourceEnabled("crossref")) {
    const r = await fetchFromCrossref(doi);
    if (r) results.push(r);
  }

  if (results.length === 0 && isbn) {
    // DNB per ISBN: autoritativer Katalogdatensatz für deutsche/
    // theologische Literatur (korrekte Reihe, Verlag, Rollen).
    if (sourceEnabled("dnb")) {
      const r = await fetchFromDNBByISBN(isbn);
      if (r) results.push(r);
    }
    // Fallback Open Library, falls die DNB nichts liefert.
    if (results.length === 0 && sourceEnabled("openLibrary")) {
      const r = await fetchFromOpenLibrary(isbn);
      if (r) results.push(r);
    }
    // Fallback Google Books.
    if (results.length === 0 && sourceEnabled("googleBooks")) {
      const r = await fetchFromGoogleBooks(isbn, apiKey);
      if (r) results.push(r);
    }
  }

  // Kein DOI/ISBN bzw. keine Treffer → DNB nach Titel + Autor.
  if (results.length === 0 && sourceEnabled("dnb")) {
    const r = await fetchFromDNB(field(item, "title"), firstAuthorLastName(item));
    if (r) results.push(r);
  }

  return results;
}

/** Sammelt Ergebnisse für einen Zeitschriftenartikel. */
async function lookupJournalArticle(item: Zotero.Item): Promise<RawMetadata[]> {
  const results: RawMetadata[] = [];
  const doi = field(item, "DOI");

  if (doi && sourceEnabled("crossref")) {
    const r = await fetchFromCrossref(doi);
    if (r) results.push(r);
  }

  if (results.length === 0 && sourceEnabled("semanticScholar")) {
    const r = await fetchFromSemanticScholar(field(item, "title"));
    if (r) results.push(r);
  }

  return results;
}

/** Sammelt Ergebnisse für ein Buchkapitel / einen Sammelbandbeitrag. */
async function lookupBookSection(item: Zotero.Item): Promise<RawMetadata[]> {
  const results: RawMetadata[] = [];
  const doi = field(item, "DOI");

  if (doi && sourceEnabled("crossref")) {
    const r = await fetchFromCrossref(doi);
    if (r) results.push(r);
  }

  if (results.length === 0 && sourceEnabled("dnb")) {
    const r = await fetchFromDNB(field(item, "title"), firstAuthorLastName(item));
    if (r) results.push(r);
  }

  // Fallback: Open Library über die ISBN des Sammelbands.
  const isbn = field(item, "ISBN");
  if (results.length === 0 && isbn && sourceEnabled("openLibrary")) {
    const r = await fetchFromOpenLibrary(isbn);
    if (r) results.push(r);
  }

  return results;
}

/** Dispatcher für die Lookup-Strategie. */
async function lookup(
  item: Zotero.Item,
  type: SupportedItemType,
): Promise<RawMetadata[]> {
  switch (type) {
    case "book":
      return lookupBook(item);
    case "journalArticle":
      return lookupJournalArticle(item);
    case "bookSection":
      return lookupBookSection(item);
  }
}

/** Wandelt Rohergebnisse in bewertete, absteigend sortierte Kandidaten um. */
function toCandidates(
  results: RawMetadata[],
  searchTitle: string,
): Candidate[] {
  return results
    .map((metadata) => ({
      metadata,
      score: titleSimilarity(searchTitle, metadata.matchTitle ?? metadata.title ?? ""),
      sourceName: SOURCE_NAMES[metadata.source],
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

// ---------------------------------------------------------------------------
// Vorbereitung eines Eintrags (Lookup + Trefferauswahl + Diff)
// ---------------------------------------------------------------------------

/** Aufbereitete Anzeigedaten eines Eintrags. */
interface ReadyData {
  item: Zotero.Item;
  type: SupportedItemType;
  sourceName: string;
  quality: PreviewQuality;
  lowMatch: boolean;
  diffs: DiffResult[];
}

/** Ergebnis der Vorbereitung. */
type Prepared =
  | { kind: "ready"; data: ReadyData }
  | { kind: "noData"; item: Zotero.Item; type: SupportedItemType }
  | { kind: "skip" }
  | { kind: "cancel" };

/** Leitet die Qualitätsstufe aus Score und Schwellenwert ab. */
function qualityOf(score: number, threshold: number): PreviewQuality {
  if (score >= 0.95) return "high";
  if (score >= threshold) return "medium";
  return "low";
}

/** Baut aus einem gewählten Kandidaten die ReadyData (Mapping + Diff). */
function buildReadyData(
  item: Zotero.Item,
  type: SupportedItemType,
  chosen: Candidate,
  threshold: number,
): ReadyData {
  const mapped = mapMetadata(chosen.metadata, type);
  const diffs = computeDiff(item, mapped);
  return {
    item,
    type,
    sourceName: chosen.sourceName,
    quality: qualityOf(chosen.score, threshold),
    lowMatch: chosen.score < threshold,
    diffs,
  };
}

/**
 * Führt Lookup und Trefferauswahl für einen Eintrag durch.
 * @param throttle Wenn `true`, wird vor den Netzanfragen pausiert.
 */
async function prepareEntry(
  item: Zotero.Item,
  type: SupportedItemType,
  throttle: boolean,
): Promise<Prepared> {
  if (throttle) await Zotero.Promise.delay(RATE_LIMIT_MS);

  const searchTitle = field(item, "title");
  let results: RawMetadata[] = [];
  try {
    results = await lookup(item, type);
  } catch (error) {
    Zotero.debug(`[MetaSync] Lookup fehlgeschlagen: ${String(error)}`);
  }

  const candidates = toCandidates(results, searchTitle);
  if (candidates.length === 0) {
    return { kind: "noData", item, type };
  }

  const threshold = getThreshold();
  const aboveThreshold = candidates.filter((c) => c.score >= threshold);

  let chosen: Candidate;
  if (aboveThreshold.length === 1) {
    // Genau ein hinreichend ähnlicher Treffer → direkt weiter.
    chosen = aboveThreshold[0];
  } else {
    // Mehrere ≥ Schwelle, oder bester Treffer < Schwelle → Auswahl anbieten.
    const offered = aboveThreshold.length >= 2 ? aboveThreshold : candidates;
    const choice = await openCandidateDialog(searchTitle, offered);
    if (choice.action === "cancel") return { kind: "cancel" };
    if (choice.action === "skip") return { kind: "skip" };
    chosen = choice.candidate;
  }

  return { kind: "ready", data: buildReadyData(item, type, chosen, threshold) };
}

// ---------------------------------------------------------------------------
// Speichern
// ---------------------------------------------------------------------------

/** JSON-Form eines Beteiligten, wie sie `item.setCreators` akzeptiert. */
type CreatorJSON = Extract<
  Parameters<Zotero.Item["setCreators"]>[0][number],
  { creatorType: unknown }
>;
/** Erlaubte Creator-Typ-Namen (z. B. „author", „editor"). */
type CreatorTypeName = CreatorJSON["creatorType"];

/** Sortier-Priorität der Creator-Typen für eine stabile Reihenfolge. */
const CREATOR_ORDER: Record<string, number> = {
  author: 0,
  bookAuthor: 1,
  editor: 2,
  seriesEditor: 3,
  translator: 4,
};

/** Priorität eines Creator-Typs (unbekannte Typen ans Ende). */
function creatorOrder(type: string): number {
  return CREATOR_ORDER[type] ?? 9;
}

/** Liefert den lesbaren Creator-Typ-Namen zu einer Zotero-Creator-Type-ID. */
function creatorTypeName(creatorTypeID: number): string {
  try {
    return Zotero.CreatorTypes.getName(creatorTypeID);
  } catch {
    return "";
  }
}

/** Wendet eine Liste von Diffs auf den Eintrag an und speichert via saveTx(). */
async function applyDiffs(
  item: Zotero.Item,
  diffs: DiffResult[],
): Promise<void> {
  for (const diff of diffs) {
    if (diff.type === "text" && diff.proposedText != null) {
      try {
        item.setField(diff.zoteroField, diff.proposedText);
      } catch (error) {
        Zotero.debug(
          `[MetaSync] Feld ${diff.zoteroField} konnte nicht gesetzt werden: ${String(error)}`,
        );
      }
    } else if (diff.type === "creators" && diff.proposedCreators) {
      try {
        const role = diff.proposedCreators[0]?.creatorType;
        if (!role) continue;
        const roleName = role as CreatorTypeName;
        // Bestehende Beteiligte anderer Typen erhalten, eigene ersetzen.
        const retained: CreatorJSON[] = item
          .getCreators()
          .filter((c) => creatorTypeName(c.creatorTypeID) !== role)
          .map((c) => ({
            creatorType: creatorTypeName(c.creatorTypeID) as CreatorTypeName,
            firstName: c.firstName,
            lastName: c.lastName,
            fieldMode: c.fieldMode,
          }));
        const added: CreatorJSON[] = diff.proposedCreators.map((mc) =>
          mc.lastName || mc.firstName
            ? {
                creatorType: roleName,
                firstName: mc.firstName ?? "",
                lastName: mc.lastName ?? "",
                fieldMode: 0,
              }
            : { creatorType: roleName, lastName: mc.name ?? "", fieldMode: 1 },
        );
        // Reihenfolge bewahren: Autor → Herausgeber → Reihenherausgeber → Rest.
        // (Array.sort ist stabil, die Reihenfolge innerhalb einer Rolle bleibt.)
        const combined = [...retained, ...added].sort(
          (a, b) => creatorOrder(a.creatorType) - creatorOrder(b.creatorType),
        );
        item.setCreators(combined);
      } catch (error) {
        Zotero.debug(
          `[MetaSync] Beteiligte (${diff.key}) konnten nicht gesetzt werden: ${String(error)}`,
        );
      }
    }
  }
  await item.saveTx();
  Zotero.debug(
    `[MetaSync] ${diffs.length} Feld(er) auf Eintrag ${item.id} angewendet und gespeichert.`,
  );
}

// ---------------------------------------------------------------------------
// Anzeige & Durchlauf-Steuerung
// ---------------------------------------------------------------------------

/** Baut die Eingabedaten für den Vorschau-Dialog. */
function toPreviewInput(
  data: ReadyData,
  index: number,
  total: number,
): PreviewInput {
  return {
    itemTitle: data.item.getDisplayTitle(),
    itemTypeKey: data.type,
    sourceName: data.sourceName,
    quality: data.quality,
    lowMatch: data.lowMatch,
    diffs: data.diffs,
    index,
    total,
  };
}

/** Zeigt eine kurze Statusmeldung im ProgressWindow. */
function notify(messageKey: Parameters<typeof getString>[0], args?: Record<string, unknown>): void {
  new ztoolkit.ProgressWindow(addon.data.config.addonName)
    .createLine({
      text: args ? getString(messageKey, { args }) : getString(messageKey),
      type: "default",
      progress: 100,
    })
    .show();
}

/** Zeigt eine Fehlermeldung sichtbar im ProgressWindow (und im Log). */
function notifyError(text: string): void {
  Zotero.debug(`[MetaSync] FEHLER: ${text}`);
  new ztoolkit.ProgressWindow(addon.data.config.addonName)
    .createLine({ text: `MetaSync: ${text}`, type: "fail", progress: 100 })
    .show();
}

/** Wendet Diffs an und meldet Erfolg/Fehler sichtbar; gibt Erfolg zurück. */
async function applyDiffsSafe(
  item: Zotero.Item,
  diffs: DiffResult[],
): Promise<boolean> {
  try {
    await applyDiffs(item, diffs);
    new ztoolkit.ProgressWindow(addon.data.config.addonName)
      .createLine({
        text: `MetaSync: ${diffs.length} Feld(er) gespeichert.`,
        type: "success",
        progress: 100,
      })
      .show();
    return true;
  } catch (error) {
    notifyError(`Speichern fehlgeschlagen: ${String(error)}`);
    return false;
  }
}

/**
 * Verarbeitet eine Liste von Einträgen mit Vorschau, Navigation und Speichern.
 */
async function runBatch(items: Zotero.Item[]): Promise<void> {
  const total = items.length;
  const prepared: (Prepared | undefined)[] = new Array(total);
  const directMode = String(getPref("previewMode")) === "direct";
  let updatedCount = 0;
  let fetched = false;
  let i = 0;

  while (i >= 0 && i < total) {
    const item = items[i];
    const type = getSupportedType(item);
    if (!type) {
      i++;
      continue;
    }

    if (!prepared[i]) {
      prepared[i] = await prepareEntry(item, type, fetched);
      fetched = true;
    }
    const entry = prepared[i]!;

    if (entry.kind === "cancel") {
      notify("notify-cancelled");
      return;
    }
    if (entry.kind === "skip") {
      i++;
      continue;
    }
    if (entry.kind === "noData") {
      if (directMode) {
        i++;
        continue;
      }
      const action = await openPreviewDialog({
        itemTitle: item.getDisplayTitle(),
        itemTypeKey: type,
        sourceName: "",
        quality: "low",
        lowMatch: false,
        diffs: [],
        index: i,
        total,
        noData: true,
      });
      if (action.action === "cancel") {
        notify("notify-cancelled");
        return;
      }
      if (action.action === "back") {
        i = Math.max(0, i - 1);
        continue;
      }
      i++;
      continue;
    }

    // entry.kind === "ready"
    const data = entry.data;

    if (directMode) {
      if (data.diffs.length > 0 && (await applyDiffsSafe(item, data.diffs))) {
        updatedCount++;
      }
      i++;
      continue;
    }

    const action = await openPreviewDialog(toPreviewInput(data, i, total));
    switch (action.action) {
      case "applyAll":
        if (data.diffs.length > 0 && (await applyDiffsSafe(item, data.diffs))) {
          updatedCount++;
        }
        i++;
        break;
      case "applySelected": {
        const keys = new Set(action.selectedKeys);
        const selected = data.diffs.filter((d) => keys.has(d.key));
        if (selected.length === 0) {
          // Nichts ausgewählt → Hinweis, Eintrag unverändert, beim Eintrag bleiben.
          notify("notify-nothing-selected");
          break;
        }
        if (await applyDiffsSafe(item, selected)) {
          updatedCount++;
        }
        i++;
        break;
      }
      case "skip":
      case "next":
      case "close":
        i++;
        break;
      case "back":
        i = Math.max(0, i - 1);
        break;
      case "cancel":
        notify("notify-cancelled");
        return;
    }
  }

  if (updatedCount > 0) {
    notify("notify-updated", { count: updatedCount });
  } else {
    notify("notify-no-metadata");
  }
}

// ---------------------------------------------------------------------------
// Öffentlicher Einstiegspunkt
// ---------------------------------------------------------------------------

/**
 * Einstiegspunkt: gleicht die aktuell ausgewählten Einträge mit MetaSync ab.
 * Nicht unterstützte Eintragstypen werden übersprungen.
 */
export async function syncSelectedItems(): Promise<void> {
  const pane = ztoolkit.getGlobal("ZoteroPane");
  const selected: Zotero.Item[] = pane.getSelectedItems();
  const items = selected.filter(isSupportedItem);

  if (items.length === 0) {
    notify("notify-no-metadata");
    return;
  }

  try {
    await runBatch(items);
  } catch (error) {
    notifyError(`Durchlauf abgebrochen: ${String(error)}`);
  }
}
