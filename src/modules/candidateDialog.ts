/**
 * candidateDialog.ts — Controller des Trefferauswahl-Dialogs.
 *
 * Übergibt die (bereits aufbereiteten) Trefferdaten via `window.arguments` an
 * `addon/content/candidateDialog.xhtml`, öffnet den Dialog modal und liest die
 * Auswahl aus `io.result`. Rendern und Button-Logik laufen im Inline-Skript des
 * Dialogs (kein Cross-Window-Zugriff).
 *
 * Entwicklungsreihenfolge Schritt 5.
 */

import type { RawMetadata } from "./apiClient";
import { getString } from "../utils/locale";

/** Ein anzeigbarer Treffer inklusive Übereinstimmungsgrad und Quelle. */
export interface Candidate {
  /** Die normalisierten Metadaten des Treffers. */
  metadata: RawMetadata;
  /** Übereinstimmungsgrad 0..1 (Levenshtein-Ähnlichkeit des Titels). */
  score: number;
  /** Anzeigename der Quelle (z. B. „DNB", „Crossref"). */
  sourceName: string;
}

/** Ergebnis des Trefferauswahl-Dialogs. */
export type CandidateChoice =
  | { action: "use"; candidate: Candidate }
  | { action: "skip" }
  | { action: "cancel" };

// ---------------------------------------------------------------------------
// Anzeige-Hilfsfunktionen
// ---------------------------------------------------------------------------

/** Kürzt einen String auf `max` Zeichen (mit Auslassungszeichen). */
function truncate(value: string, max: number): string {
  const v = value.trim();
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}

/** Extrahiert eine vierstellige Jahreszahl aus einem Datumsstring. */
function extractYear(date: string | undefined): string {
  return date?.match(/\d{4}/)?.[0] ?? "";
}

/** Formatiert die Autorenliste eines Treffers (max. 3, dann „u. a."). */
function formatAuthors(meta: RawMetadata): string {
  const authors = (meta.creators ?? []).filter((c) => c.role === "author");
  const names = authors.map((c) => {
    if (c.lastName) {
      return c.firstName ? `${c.lastName}, ${c.firstName}` : c.lastName;
    }
    return c.name ?? "";
  });
  const shown = names.slice(0, 3).filter(Boolean);
  if (shown.length === 0) return "";
  return authors.length > 3 ? `${shown.join("; ")} u. a.` : shown.join("; ");
}

/** Qualitätsstufe eines Scores für die Balkenfarbe. */
function qualityClass(score: number): "high" | "medium" | "low" {
  if (score >= 0.95) return "high";
  if (score >= 0.85) return "medium";
  return "low";
}

// ---------------------------------------------------------------------------
// Öffentliche API
// ---------------------------------------------------------------------------

/**
 * Öffnet den Trefferauswahl-Dialog (modal) und gibt die Auswahl zurück.
 *
 * @param searchedTitle Titel des gesuchten Zotero-Eintrags (für die Kopfzeile).
 * @param candidates Trefferliste (max. 5 sinnvoll), absteigend nach Score.
 * @returns Die getroffene Auswahl (`use` / `skip` / `cancel`).
 */
export function openCandidateDialog(
  searchedTitle: string,
  candidates: Candidate[],
): Promise<CandidateChoice> {
  const dialogInput = {
    heading: getString("candidate-heading"),
    searchedLabel: getString("candidate-searched"),
    searchedTitle: truncate(searchedTitle, 80),
    sourceLabel: getString("candidate-source"),
    matchLabel: getString("candidate-match"),
    useLabel: getString("candidate-use"),
    skipLabel: getString("candidate-skip"),
    cancelLabel: getString("candidate-cancel"),
    candidates: candidates.map((c) => ({
      title: truncate(c.metadata.title ?? c.metadata.matchTitle ?? "", 90),
      authors: formatAuthors(c.metadata),
      year: extractYear(c.metadata.date),
      publisher: c.metadata.publisher ?? "",
      sourceName: c.sourceName,
      pct: Math.round(c.score * 100),
      quality: qualityClass(c.score),
    })),
  };

  const io: { input: typeof dialogInput; result?: { action: string; index: number } } =
    { input: dialogInput };

  const url = `chrome://${addon.data.config.addonRef}/content/candidateDialog.xhtml`;
  Zotero.getMainWindow().openDialog(
    url,
    "metasync-candidate",
    "chrome,modal,centerscreen,resizable,width=560,height=480",
    io,
  );

  const result = io.result ?? { action: "cancel", index: 0 };
  if (result.action === "use") {
    const candidate = candidates[result.index];
    if (candidate) return Promise.resolve({ action: "use", candidate });
    return Promise.resolve({ action: "cancel" });
  }
  if (result.action === "skip") return Promise.resolve({ action: "skip" });
  return Promise.resolve({ action: "cancel" });
}
