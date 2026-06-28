/**
 * diffEngine.ts — Vergleicht die aus einer Quelle abgebildeten Felder
 * ({@link MappedField}) mit den aktuell im Zotero-Eintrag vorhandenen Werten und
 * liefert nur die tatsächlich abweichenden bzw. neuen Felder als
 * {@link DiffResult}[] zurück.
 *
 * Regeln (gemäß Spezifikation „Überschreiben-Logik"):
 *  - Leeres Feld in Zotero + Wert aus API            → Ergänzung („addition")
 *  - Belegtes Feld in Zotero + abweichender API-Wert → Korrektur („correction")
 *  - Identische Werte                                → ausgeblendet (nicht enthalten)
 *  - Autoren-/Herausgeberlisten                      → nur, wenn die API-Liste
 *    länger ist als die Zotero-Liste
 *
 * Entwicklungsreihenfolge Schritt 3.
 */

import type {
  CreatorRoleType,
  MappedCreator,
  MappedField,
  MappedFieldType,
} from "./fieldMapper";

/** Art der Änderung eines Feldes. */
export type DiffStatus = "addition" | "correction";

/**
 * Ein einzelnes Vergleichsergebnis für ein Feld, das im Vorschau-Dialog als
 * Zeile dargestellt wird.
 */
export interface DiffResult {
  /** Eindeutiger Schlüssel (aus {@link MappedField.key}). */
  key: string;
  /** Zotero-Feldname bzw. Sentinel `"creators"`. */
  zoteroField: string;
  /** FTL-Schlüssel für den lokalisierten Feldnamen. */
  labelKey: string;
  /** Feldart (Text oder Beteiligtenliste). */
  type: MappedFieldType;
  /** Ergänzung oder Korrektur. */
  status: DiffStatus;
  /** Anzeigewert des aktuellen Zotero-Inhalts (leer = `""`). */
  currentDisplay: string;
  /** Anzeigewert des Vorschlags. */
  proposedDisplay: string;
  /** Vorgeschlagener Textwert (nur bei `type === "text"`). */
  proposedText?: string;
  /** Vorgeschlagene Beteiligte (nur bei `type === "creators"`). */
  proposedCreators?: MappedCreator[];
  /**
   * Standard-Auswahlzustand der Checkbox. Standardmäßig `false`, da i. d. R. nur
   * einzelne Felder gezielt übernommen werden.
   */
  selected: boolean;
}

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

/** Normalisiert einen String für den Identitätsvergleich (Trim + Whitespace). */
function normalize(value: string | undefined | null): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/** Formatiert einen Beteiligten als „Nachname, Vorname" bzw. „Name". */
function formatCreator(c: {
  firstName?: string;
  lastName?: string;
  name?: string;
}): string {
  const last = normalize(c.lastName);
  const firstRaw = c.firstName?.trim();
  if (last) {
    return firstRaw ? `${last}, ${firstRaw}` : last;
  }
  return normalize(c.name);
}

/** Formatiert eine Beteiligtenliste als „A; B; C". */
function formatCreators(
  creators: { firstName?: string; lastName?: string; name?: string }[],
): string {
  return creators.map(formatCreator).filter(Boolean).join("; ");
}

/** Liefert den lesbaren Creator-Typ-Namen zu einer Zotero-Creator-Type-ID. */
function creatorTypeName(creatorTypeID: number): string {
  try {
    return Zotero.CreatorTypes.getName(creatorTypeID);
  } catch {
    return "";
  }
}

/**
 * Liest die aktuellen Beteiligten eines bestimmten Typs aus dem Eintrag.
 * @returns Liste mit Vor-/Nachname (oder Einzelname bei `fieldMode === 1`).
 */
function currentCreatorsOfType(
  item: Zotero.Item,
  creatorType: CreatorRoleType,
): { firstName?: string; lastName?: string; name?: string }[] {
  return item
    .getCreators()
    .filter((c) => creatorTypeName(c.creatorTypeID) === creatorType)
    .map((c) =>
      c.fieldMode === 1
        ? { name: c.lastName }
        : { firstName: c.firstName, lastName: c.lastName },
    );
}

// ---------------------------------------------------------------------------
// Diff je Feldart
// ---------------------------------------------------------------------------

/** Vergleicht ein Textfeld; gibt `null` zurück, wenn identisch. */
function diffTextField(
  item: Zotero.Item,
  field: MappedField,
): DiffResult | null {
  const proposed = normalize(field.value);
  if (!proposed) return null;

  let current = "";
  try {
    current = normalize(item.getField(field.zoteroField) as string);
  } catch {
    // Feld für diesen Eintragstyp nicht vorhanden → wie leer behandeln.
    current = "";
  }

  if (current === proposed) return null;

  return {
    key: field.key,
    zoteroField: field.zoteroField,
    labelKey: field.labelKey,
    type: "text",
    status: current === "" ? "addition" : "correction",
    currentDisplay: current,
    proposedDisplay: field.value!.trim(),
    proposedText: field.value!.trim(),
    selected: false,
  };
}

/**
 * Vergleicht eine Beteiligtenliste. Vorschlag nur, wenn die API-Liste länger ist
 * als die im Eintrag vorhandene Liste desselben Typs.
 */
function diffCreatorField(
  item: Zotero.Item,
  field: MappedField,
): DiffResult | null {
  const proposed = field.creators ?? [];
  if (proposed.length === 0) return null;

  const creatorType = proposed[0].creatorType;
  const current = currentCreatorsOfType(item, creatorType);

  if (proposed.length <= current.length) return null;

  return {
    key: field.key,
    zoteroField: field.zoteroField,
    labelKey: field.labelKey,
    type: "creators",
    status: current.length === 0 ? "addition" : "correction",
    currentDisplay: formatCreators(current),
    proposedDisplay: formatCreators(proposed),
    proposedCreators: proposed,
    selected: false,
  };
}

// ---------------------------------------------------------------------------
// Öffentliche API
// ---------------------------------------------------------------------------

/**
 * Vergleicht die abgebildeten Felder mit dem Eintrag und liefert ausschließlich
 * die geänderten bzw. neuen Felder zurück.
 *
 * @param item Der zu aktualisierende Zotero-Eintrag.
 * @param fields Die aus einer Quelle abgebildeten Zielfelder.
 * @returns Liste der Unterschiede (leer, wenn nichts zu ändern ist).
 */
export function computeDiff(
  item: Zotero.Item,
  fields: MappedField[],
): DiffResult[] {
  const results: DiffResult[] = [];
  for (const field of fields) {
    const diff =
      field.type === "creators"
        ? diffCreatorField(item, field)
        : diffTextField(item, field);
    if (diff) results.push(diff);
  }
  return results;
}
