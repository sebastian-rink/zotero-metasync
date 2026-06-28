/**
 * previewDialog.ts — Controller des Vorschau-Dialogs.
 *
 * Übergibt die (bereits lokalisierten) Anzeige- und Diff-Daten via
 * `window.arguments` an `addon/content/previewDialog.xhtml`, öffnet den Dialog
 * modal und liest die gewählte Aktion aus `io.result`. Das Rendern und die
 * Button-Logik laufen vollständig im Inline-Skript des Dialogs (kein
 * Cross-Window-Zugriff).
 *
 * Entwicklungsreihenfolge Schritt 7.
 */

import type { DiffResult } from "./diffEngine";
import type { SupportedItemType } from "./fieldMapper";
import type { FluentMessageId } from "../../typings/i10n";
import { getString } from "../utils/locale";

/** Trefferqualitätsstufe für die Kopfzeile. */
export type PreviewQuality = "high" | "medium" | "low";

/** Eingabedaten für den Vorschau-Dialog eines einzelnen Eintrags. */
export interface PreviewInput {
  /** Titel des Eintrags (wird auf 80 Zeichen gekürzt). */
  itemTitle: string;
  /** Eintragstyp (für das Icon). */
  itemTypeKey: SupportedItemType;
  /** Anzeigename der Quelle. */
  sourceName: string;
  /** Trefferqualität (hoch/mittel/niedrig). */
  quality: PreviewQuality;
  /** Warnbanner anzeigen (bester Treffer unter Schwellenwert). */
  lowMatch: boolean;
  /** Die darzustellenden Unterschiede. */
  diffs: DiffResult[];
  /** 0-basierter Index im Mehrfachdurchlauf. */
  index: number;
  /** Gesamtzahl der Einträge im Durchlauf. */
  total: number;
  /** „Keine Metadaten gefunden"-Ansicht anzeigen. */
  noData?: boolean;
}

/** Vom Vorschau-Dialog zurückgemeldete Aktion. */
export type PreviewAction =
  | { action: "applyAll" }
  | { action: "applySelected"; selectedKeys: string[] }
  | { action: "skip" }
  | { action: "back" }
  | { action: "next" }
  | { action: "cancel" }
  | { action: "close" };

/** An den Dialog übergebene Zeile. */
interface PreviewRow {
  key: string;
  label: string;
  current: string;
  proposed: string;
  status: "addition" | "correction";
}

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

/** Kürzt einen String auf `max` Zeichen. */
function truncate(value: string, max: number): string {
  const v = value.trim();
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}

/** Liefert ein Icon-Symbol für den Eintragstyp. */
function typeIcon(itemType: SupportedItemType): string {
  switch (itemType) {
    case "book":
      return "📕";
    case "journalArticle":
      return "📄";
    case "bookSection":
      return "📑";
  }
}

// ---------------------------------------------------------------------------
// Öffentliche API
// ---------------------------------------------------------------------------

/**
 * Öffnet den Vorschau-Dialog (modal) und gibt die gewählte Aktion zurück.
 *
 * @param input Anzeige- und Diff-Daten des aktuellen Eintrags.
 * @returns Die gewählte Aktion (apply/skip/back/next/cancel/close).
 */
export function openPreviewDialog(input: PreviewInput): Promise<PreviewAction> {
  const rows: PreviewRow[] = input.diffs.map((d) => ({
    key: d.key,
    label: getString(d.labelKey as FluentMessageId),
    current: d.currentDisplay,
    proposed: d.proposedDisplay,
    status: d.status,
  }));

  const dialogInput = {
    itemTitle: truncate(input.itemTitle, 80),
    typeIcon: typeIcon(input.itemTypeKey),
    sourceLabel: getString("preview-source"),
    sourceName: input.sourceName,
    qualityLabel: getString("preview-quality"),
    qualityText: getString(`preview-quality-${input.quality}` as FluentMessageId),
    quality: input.quality,
    warningText: getString("preview-warning-lowmatch"),
    warningShow: input.lowMatch,
    colField: getString("preview-col-field"),
    colCurrent: getString("preview-col-current"),
    colProposed: getString("preview-col-proposed"),
    rows,
    emptyText: getString("preview-empty"),
    noData: Boolean(input.noData),
    noDataText: getString("preview-no-data"),
    showNav: input.total > 1,
    progressText: getString("preview-progress", {
      args: { current: input.index + 1, total: input.total },
    }),
    backText: getString("preview-back"),
    backDisabled: input.index === 0,
    nextText: getString("preview-next"),
    nextDisabled: input.index === input.total - 1,
    labelApplyAll: getString("preview-apply-all"),
    labelApplySelected: getString("preview-apply-selected"),
    labelSkip: getString("preview-skip"),
    labelCancel: getString("preview-cancel"),
    labelClose: getString("preview-close"),
    selectAllTitle: getString("preview-select-all"),
  };

  const io: { input: typeof dialogInput; result?: PreviewAction } = {
    input: dialogInput,
  };

  const url = `chrome://${addon.data.config.addonRef}/content/previewDialog.xhtml`;
  Zotero.getMainWindow().openDialog(
    url,
    "metasync-preview",
    "chrome,modal,centerscreen,resizable,width=760,height=600",
    io,
  );

  return Promise.resolve(
    io.result ?? { action: input.noData ? "close" : "cancel" },
  );
}
