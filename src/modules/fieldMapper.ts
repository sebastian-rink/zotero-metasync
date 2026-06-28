/**
 * fieldMapper.ts — Bildet eine normalisierte {@link RawMetadata}-Struktur auf
 * die jeweils relevanten Felder eines Zotero-Eintragstyps ab.
 *
 * Es werden ausschließlich die drei unterstützten Eintragstypen behandelt
 * (`book`, `journalArticle`, `bookSection`). Pro Eintragstyp werden nur die in
 * der Spezifikation genannten Felder erzeugt; Felder ohne Wert in der
 * API-Antwort werden ausgelassen. Der Vergleich gegen die vorhandenen
 * Zotero-Werte (Ergänzung vs. Korrektur) erfolgt anschließend in `diffEngine.ts`.
 *
 * Entwicklungsreihenfolge Schritt 2.
 */

import type { RawCreator, RawMetadata } from "./apiClient";

/** Von MetaSync unterstützte Zotero-Eintragstypen. */
export type SupportedItemType = "book" | "journalArticle" | "bookSection";

/** Art eines abgebildeten Feldes: einfacher Text oder eine Beteiligtenliste. */
export type MappedFieldType = "text" | "creators";

/**
 * Ein einzelner Beteiligter im Zielformat. Es ist immer entweder
 * {@link MappedCreator.lastName} **oder** {@link MappedCreator.name} gesetzt
 * (zweiteiliger vs. einteiliger Name).
 */
export interface MappedCreator {
  firstName?: string;
  lastName?: string;
  /** Vollständiger Name, falls keine Vor-/Nachname-Trennung vorliegt. */
  name?: string;
  /** Zotero-Creator-Typ. */
  creatorType: CreatorRoleType;
}

/** Beteiligten-Rollen, die MetaSync getrennt führt. */
export type CreatorRoleType = "author" | "editor" | "seriesEditor";

/**
 * Ein auf einen Zotero-Eintragstyp abgebildetes Feld. Für `type === "text"`
 * trägt {@link MappedField.value} den Wert, für `type === "creators"` trägt
 * {@link MappedField.creators} die Beteiligtenliste.
 */
export interface MappedField {
  /**
   * Eindeutiger Schlüssel innerhalb eines Datensatzes: der Zotero-Feldname
   * (z. B. `"title"`) bzw. `"creator:author"` / `"creator:editor"` für
   * Beteiligtenlisten.
   */
  key: string;
  /**
   * Tatsächlicher Zotero-Feldname zum Schreiben (`item.setField`). Für
   * Beteiligtenlisten der Sentinel `"creators"`.
   */
  zoteroField: string;
  /** FTL-Lokalisierungsschlüssel für den Anzeigenamen im Dialog (de-DE). */
  labelKey: string;
  /** Art des Feldes. */
  type: MappedFieldType;
  /** Vorgeschlagener Textwert (nur bei `type === "text"`). */
  value?: string;
  /** Vorgeschlagene Beteiligte (nur bei `type === "creators"`). */
  creators?: MappedCreator[];
}

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

/**
 * Fügt ein Textfeld an, sofern ein nicht-leerer Wert vorliegt.
 */
function pushText(
  out: MappedField[],
  key: string,
  zoteroField: string,
  labelKey: string,
  value: string | undefined,
): void {
  const v = value?.trim();
  if (v) {
    out.push({ key, zoteroField, labelKey, type: "text", value: v });
  }
}

/**
 * Setzt den Zotero-Titel zusammen: „Titel: Untertitel" bzw. nur „Titel".
 * Gibt `undefined` zurück, wenn kein Haupttitel vorhanden ist.
 */
function combinedTitle(raw: RawMetadata): string | undefined {
  const title = raw.title?.trim();
  if (!title) return undefined;
  const subtitle = raw.subtitle?.trim();
  return subtitle ? `${title}: ${subtitle}` : title;
}

/**
 * Wählt die bevorzugte URL: vorrangig eine DOI-Adresse, sonst eine
 * Verlags-/Landingpage. Reine Aggregator-Links (Open Library, Google Books)
 * werden verworfen, da sie keine zitierfähige Quelle darstellen.
 */
function bestUrl(raw: RawMetadata): string | undefined {
  const doi = raw.DOI?.trim();
  if (doi) return `https://doi.org/${doi.replace(/^https?:\/\/doi\.org\//i, "")}`;
  const url = raw.url?.trim();
  if (!url) return undefined;
  if (/openlibrary\.org|books\.google\.|google\.[a-z.]+\/books/i.test(url)) {
    return undefined;
  }
  return url;
}

/** Filtert die Beteiligten einer Rolle und überführt sie ins Zielformat. */
function creatorsOfRole(
  raw: RawMetadata,
  role: CreatorRoleType,
): MappedCreator[] {
  return (raw.creators ?? [])
    .filter((c: RawCreator) => c.role === role)
    .map((c: RawCreator) => ({
      firstName: c.firstName,
      lastName: c.lastName,
      name: c.name,
      creatorType: role,
    }));
}

/**
 * Fügt eine Beteiligtenliste einer Rolle an, sofern mindestens ein Beteiligter
 * vorhanden ist.
 */
function pushCreators(
  out: MappedField[],
  raw: RawMetadata,
  role: CreatorRoleType,
  labelKey: string,
): void {
  const creators = creatorsOfRole(raw, role);
  if (creators.length > 0) {
    out.push({
      key: `creator:${role}`,
      zoteroField: "creators",
      labelKey,
      type: "creators",
      creators,
    });
  }
}

// ---------------------------------------------------------------------------
// Mapping je Eintragstyp
// ---------------------------------------------------------------------------

/**
 * Bildet Metadaten auf die Felder einer Monographie (`book`) ab.
 *
 * Relevante Felder: title, shortTitle, creators (author/editor), date,
 * publisher, place, ISBN, numPages, series, seriesNumber, edition, language,
 * abstractNote, url.
 *
 * @param raw Normalisierte Metadaten einer Quelle.
 * @returns Liste der belegten Zielfelder.
 */
export function mapBook(raw: RawMetadata): MappedField[] {
  const out: MappedField[] = [];
  pushText(out, "title", "title", "field-title", combinedTitle(raw));
  pushText(out, "shortTitle", "shortTitle", "field-shortTitle", raw.shortTitle);
  pushCreators(out, raw, "author", "field-author");
  pushCreators(out, raw, "editor", "field-editor");
  pushCreators(out, raw, "seriesEditor", "field-seriesEditor");
  pushText(out, "date", "date", "field-date", raw.date);
  pushText(out, "publisher", "publisher", "field-publisher", raw.publisher);
  pushText(out, "place", "place", "field-place", raw.place);
  pushText(out, "ISBN", "ISBN", "field-ISBN", raw.ISBN);
  pushText(out, "numPages", "numPages", "field-numPages", raw.numPages);
  pushText(out, "series", "series", "field-series", raw.series);
  pushText(out, "seriesNumber", "seriesNumber", "field-seriesNumber", raw.seriesNumber);
  pushText(out, "edition", "edition", "field-edition", raw.edition);
  pushText(out, "language", "language", "field-language", raw.language);
  pushText(out, "abstractNote", "abstractNote", "field-abstractNote", raw.abstractNote);
  pushText(out, "url", "url", "field-url", bestUrl(raw));
  return out;
}

/**
 * Bildet Metadaten auf die Felder eines Zeitschriftenartikels
 * (`journalArticle`) ab.
 *
 * Relevante Felder: title, creators (author), date, publicationTitle, volume,
 * issue, pages, DOI, ISSN, language, abstractNote, url.
 *
 * @param raw Normalisierte Metadaten einer Quelle.
 * @returns Liste der belegten Zielfelder.
 */
export function mapJournalArticle(raw: RawMetadata): MappedField[] {
  const out: MappedField[] = [];
  pushText(out, "title", "title", "field-title", combinedTitle(raw));
  pushCreators(out, raw, "author", "field-author");
  pushText(out, "date", "date", "field-date", raw.date);
  pushText(out, "publicationTitle", "publicationTitle", "field-publicationTitle", raw.publicationTitle);
  pushText(out, "volume", "volume", "field-volume", raw.volume);
  pushText(out, "issue", "issue", "field-issue", raw.issue);
  pushText(out, "pages", "pages", "field-pages", raw.pages);
  pushText(out, "DOI", "DOI", "field-DOI", raw.DOI);
  pushText(out, "ISSN", "ISSN", "field-ISSN", raw.ISSN);
  pushText(out, "language", "language", "field-language", raw.language);
  pushText(out, "abstractNote", "abstractNote", "field-abstractNote", raw.abstractNote);
  pushText(out, "url", "url", "field-url", bestUrl(raw));
  return out;
}

/**
 * Bildet Metadaten auf die Felder eines Buchkapitels / Sammelbandbeitrags
 * (`bookSection`) ab.
 *
 * Relevante Felder: title, creators (author), bookTitle, creators (editor),
 * date, publisher, place, pages, ISBN, series, seriesNumber, language,
 * abstractNote, url.
 *
 * @param raw Normalisierte Metadaten einer Quelle.
 * @returns Liste der belegten Zielfelder.
 */
export function mapBookSection(raw: RawMetadata): MappedField[] {
  const out: MappedField[] = [];
  pushText(out, "title", "title", "field-title", combinedTitle(raw));
  pushCreators(out, raw, "author", "field-author");
  // Crossref liefert den Sammelband-Titel als container-title (bookTitle).
  pushText(out, "bookTitle", "bookTitle", "field-bookTitle", raw.bookTitle ?? raw.publicationTitle);
  pushCreators(out, raw, "editor", "field-editor");
  pushCreators(out, raw, "seriesEditor", "field-seriesEditor");
  pushText(out, "date", "date", "field-date", raw.date);
  pushText(out, "publisher", "publisher", "field-publisher", raw.publisher);
  pushText(out, "place", "place", "field-place", raw.place);
  pushText(out, "pages", "pages", "field-pages", raw.pages);
  pushText(out, "ISBN", "ISBN", "field-ISBN", raw.ISBN);
  pushText(out, "series", "series", "field-series", raw.series);
  pushText(out, "seriesNumber", "seriesNumber", "field-seriesNumber", raw.seriesNumber);
  pushText(out, "language", "language", "field-language", raw.language);
  pushText(out, "abstractNote", "abstractNote", "field-abstractNote", raw.abstractNote);
  pushText(out, "url", "url", "field-url", bestUrl(raw));
  return out;
}

/**
 * Dispatcher: bildet Metadaten je nach Eintragstyp auf die passenden Felder ab.
 *
 * @param raw Normalisierte Metadaten einer Quelle.
 * @param itemType Unterstützter Zotero-Eintragstyp.
 * @returns Liste der belegten Zielfelder; leer bei unbekanntem Typ.
 */
export function mapMetadata(
  raw: RawMetadata,
  itemType: SupportedItemType,
): MappedField[] {
  switch (itemType) {
    case "book":
      return mapBook(raw);
    case "journalArticle":
      return mapJournalArticle(raw);
    case "bookSection":
      return mapBookSection(raw);
    default:
      // Unerreichbar bei korrektem Aufruf; defensiv leere Liste zurückgeben.
      return [];
  }
}
