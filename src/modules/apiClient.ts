/**
 * apiClient.ts — Zentrale Sammlung aller externen API-Aufrufe für MetaSync.
 *
 * Jede Quelle besitzt genau eine `fetchFrom…`-Funktion, die eine normalisierte
 * {@link RawMetadata}-Struktur zurückgibt (oder `null`, falls kein Treffer bzw.
 * ein Fehler auftrat). Alle HTTP-Anfragen laufen ausschließlich über Zoteros
 * eigenen XHR-Wrapper `Zotero.HTTP.request` (kein Node-`fetch`). Fehler werden
 * grundsätzlich per `Zotero.debug()` protokolliert und niemals als `alert()`
 * ausgegeben.
 *
 * Entwicklungsreihenfolge Schritt 1.
 */

// ---------------------------------------------------------------------------
// Normalisiertes Ergebnis-Modell
// ---------------------------------------------------------------------------

/** Kennung der Quelle, aus der ein {@link RawMetadata}-Datensatz stammt. */
export type ApiSource =
  | "crossref"
  | "openLibrary"
  | "googleBooks"
  | "dnb"
  | "semanticScholar";

/**
 * Rolle eines Beteiligten, abgeleitet aus der jeweiligen API-Antwort.
 * `seriesEditor` = Herausgeber der Reihe (in der Theologie häufig getrennt von
 * den Band-/Sammelband-Herausgebern zu führen).
 */
export type CreatorRole = "author" | "editor" | "seriesEditor";

/**
 * Normalisierter Beteiligter. Manche Quellen liefern getrennte Vor-/Nachnamen
 * (Crossref), andere nur einen einzelnen Namensstring (Open Library, DNB).
 * Es ist daher immer entweder {@link RawCreator.lastName} **oder**
 * {@link RawCreator.name} gesetzt.
 */
export interface RawCreator {
  /** Vorname(n), falls die Quelle eine getrennte Darstellung liefert. */
  firstName?: string;
  /** Nachname, falls die Quelle eine getrennte Darstellung liefert. */
  lastName?: string;
  /** Vollständiger Name als Einzelfeld, falls keine Trennung möglich ist. */
  name?: string;
  /** Rolle (Autor/Herausgeber), aus der Quelle abgeleitet. */
  role: CreatorRole;
}

/**
 * Vereinheitlichte Metadaten als **Union aller möglichen Felder** der fünf
 * unterstützten APIs. Sämtliche Felder sind optional; jede Quelle füllt nur
 * die von ihr gelieferten Felder. Das spätere Mapping auf konkrete
 * Zotero-Eintragstypen übernimmt `fieldMapper.ts`.
 */
export interface RawMetadata {
  /** Quelle, aus der dieser Datensatz stammt. */
  source: ApiSource;

  // Titelangaben
  title?: string;
  subtitle?: string;
  shortTitle?: string;

  // Beteiligte
  creators?: RawCreator[];

  // Erscheinungsangaben
  date?: string;
  publisher?: string;
  place?: string;
  edition?: string;
  language?: string;

  // Identifikatoren
  ISBN?: string;
  ISSN?: string;
  DOI?: string;
  url?: string;

  // Reihen-/Serieninformationen (hohe Priorität in theologischer Literatur)
  series?: string;
  seriesNumber?: string;

  // Monographie-spezifisch
  numPages?: string;

  // Zeitschriften-/Aufsatz-spezifisch
  publicationTitle?: string;
  bookTitle?: string;
  volume?: string;
  issue?: string;
  pages?: string;

  // Sonstiges
  abstractNote?: string;

  /**
   * Titel, der für den Levenshtein-Ähnlichkeitsvergleich herangezogen werden
   * soll (i. d. R. identisch mit {@link RawMetadata.title}). Wird vom Aufrufer
   * gegen den Zotero-Suchtitel verglichen.
   */
  matchTitle?: string;
}

// ---------------------------------------------------------------------------
// Konstanten & Hilfsfunktionen
// ---------------------------------------------------------------------------

/** Timeout pro API-Anfrage in Millisekunden (Spezifikation: 10 Sekunden). */
const REQUEST_TIMEOUT_MS = 10_000;

/** Höfliche Identifikation gegenüber den APIs (Crossref-Etikette etc.). */
const USER_AGENT = "MetaSync/1.0 (Zotero-Plugin; mailto:mail@sebastianrink.de)";

/** Preferences-Schlüssel des Google-Books-API-Keys. */
const PREF_GOOGLE_API_KEY = "extensions.zotero.metasync.googleApiKey";

/**
 * Führt eine GET-Anfrage über Zoteros XHR-Wrapper aus und gibt den Rohtext der
 * Antwort zurück. Bei Timeout, Netzwerkfehler oder Nicht-2xx-Status wird `null`
 * zurückgegeben und der Fehler per `Zotero.debug()` protokolliert.
 *
 * @param url Vollständige, bereits kodierte Anfrage-URL.
 * @param accept Erwarteter `Accept`-Header (Default: JSON).
 * @returns Antworttext oder `null` bei Fehler.
 */
async function httpGet(
  url: string,
  accept = "application/json",
): Promise<string | null> {
  try {
    const xhr = await Zotero.HTTP.request("GET", url, {
      timeout: REQUEST_TIMEOUT_MS,
      responseType: "text",
      headers: {
        Accept: accept,
        "User-Agent": USER_AGENT,
      },
    });
    if (xhr.status < 200 || xhr.status >= 300) {
      Zotero.debug(`[MetaSync] HTTP ${xhr.status} für ${url}`);
      return null;
    }
    return xhr.responseText;
  } catch (error) {
    Zotero.debug(`[MetaSync] Anfrage fehlgeschlagen (${url}): ${String(error)}`);
    return null;
  }
}

/** Parst Antworttext als JSON und liefert `null` bei ungültigem JSON. */
function parseJson<T>(text: string, context: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    Zotero.debug(`[MetaSync] Ungültiges JSON (${context}): ${String(error)}`);
    return null;
  }
}

/** Gibt das erste Element eines Arrays zurück oder `undefined`. */
function first<T>(value: T[] | undefined | null): T | undefined {
  return value && value.length > 0 ? value[0] : undefined;
}

/**
 * Entfernt überflüssige Leerzeichen sowie C1-Steuerzeichen (U+0080–U+009F,
 * u. a. die DNB-Sortierzeichen ˜ ˝). Leere Strings werden zu `undefined`.
 */
function clean(value: string | undefined | null): string | undefined {
  if (value == null) return undefined;
  const stripped = value.replace(/[\u0080-\u009F]/g, "");
  const trimmed = stripped.replace(/\s+/g, " ").trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// ---------------------------------------------------------------------------
// 1) Crossref
// ---------------------------------------------------------------------------

/** Crossref-Namensobjekt (Autor/Herausgeber). */
interface CrossrefName {
  given?: string;
  family?: string;
  name?: string;
}

/** Datums-Container in Crossref-Antworten (`date-parts`). */
interface CrossrefDate {
  "date-parts"?: number[][];
}

/** Relevanter Ausschnitt eines Crossref-Werks. */
interface CrossrefWork {
  title?: string[];
  subtitle?: string[];
  "short-title"?: string[];
  author?: CrossrefName[];
  editor?: CrossrefName[];
  publisher?: string;
  "publisher-location"?: string;
  "container-title"?: string[];
  "short-container-title"?: string[];
  volume?: string;
  issue?: string;
  page?: string;
  DOI?: string;
  ISSN?: string[];
  ISBN?: string[];
  language?: string;
  abstract?: string;
  URL?: string;
  edition?: string;
  "series-title"?: string[];
  published?: CrossrefDate;
  issued?: CrossrefDate;
  "published-print"?: CrossrefDate;
  "published-online"?: CrossrefDate;
}

/** Hülle der Crossref-Einzelwerk-Antwort. */
interface CrossrefResponse {
  message?: CrossrefWork;
}

/** Wandelt Crossrefs `date-parts` in einen Datumsstring (YYYY[-MM[-DD]]) um. */
function crossrefDate(...candidates: (CrossrefDate | undefined)[]): string | undefined {
  for (const candidate of candidates) {
    const parts = candidate?.["date-parts"]?.[0];
    if (parts && parts.length > 0 && typeof parts[0] === "number") {
      return parts
        .filter((p) => typeof p === "number")
        .map((p) => String(p).padStart(p === parts[0] ? 0 : 2, "0"))
        .join("-");
    }
  }
  return undefined;
}

/** Konvertiert Crossref-Namen in normalisierte {@link RawCreator}. */
function crossrefCreators(
  names: CrossrefName[] | undefined,
  role: CreatorRole,
): RawCreator[] {
  if (!names) return [];
  return names.map((n) => {
    if (n.family || n.given) {
      return { firstName: clean(n.given), lastName: clean(n.family), role };
    }
    return { name: clean(n.name), role };
  });
}

/**
 * Fragt Crossref für eine DOI ab und liefert normalisierte Metadaten.
 *
 * @param doi DOI des Werks (ohne URL-Präfix).
 * @returns Metadaten oder `null`, falls kein Treffer/Fehler.
 */
export async function fetchFromCrossref(doi: string): Promise<RawMetadata | null> {
  const trimmed = clean(doi);
  if (!trimmed) return null;

  const url = `https://api.crossref.org/works/${encodeURIComponent(trimmed)}?mailto=mail@sebastianrink.de`;
  const text = await httpGet(url);
  if (!text) return null;

  const json = parseJson<CrossrefResponse>(text, "Crossref");
  const work = json?.message;
  if (!work) return null;

  const title = clean(first(work.title));
  if (!title) {
    Zotero.debug("[MetaSync] Crossref: Treffer ohne Titel verworfen.");
    return null;
  }

  const creators = [
    ...crossrefCreators(work.author, "author"),
    ...crossrefCreators(work.editor, "editor"),
  ];

  return {
    source: "crossref",
    title,
    subtitle: clean(first(work.subtitle)),
    shortTitle: clean(first(work["short-title"])),
    creators: creators.length > 0 ? creators : undefined,
    date: crossrefDate(
      work.issued,
      work["published-print"],
      work["published-online"],
      work.published,
    ),
    publisher: clean(work.publisher),
    place: clean(work["publisher-location"]),
    publicationTitle: clean(first(work["container-title"])),
    bookTitle: clean(first(work["container-title"])),
    volume: clean(work.volume),
    issue: clean(work.issue),
    pages: clean(work.page),
    DOI: clean(work.DOI),
    ISSN: clean(first(work.ISSN)),
    ISBN: clean(first(work.ISBN)),
    series: clean(first(work["series-title"])),
    edition: clean(work.edition),
    language: clean(work.language),
    abstractNote: clean(work.abstract?.replace(/<[^>]+>/g, "")),
    url: clean(work.URL),
    matchTitle: title,
  };
}

// ---------------------------------------------------------------------------
// 2) Open Library
// ---------------------------------------------------------------------------

/** Benannte Entität (Autor, Verlag, Ort) in Open-Library-Antworten. */
interface OpenLibraryNamed {
  name?: string;
  url?: string;
}

/** Identifikator-Sammlung in Open-Library-Antworten. */
interface OpenLibraryIdentifiers {
  isbn_13?: string[];
  isbn_10?: string[];
  issn?: string[];
}

/** Reihen-/Klassifikationsangaben. */
interface OpenLibraryClassification {
  [scheme: string]: string[] | undefined;
}

/** Relevanter Ausschnitt eines Open-Library-Buchdatensatzes (`jscmd=data`). */
interface OpenLibraryBook {
  title?: string;
  subtitle?: string;
  authors?: OpenLibraryNamed[];
  publishers?: OpenLibraryNamed[];
  publish_places?: OpenLibraryNamed[];
  publish_date?: string;
  number_of_pages?: number;
  identifiers?: OpenLibraryIdentifiers;
  classifications?: OpenLibraryClassification;
  url?: string;
  notes?: string;
  excerpts?: { text?: string }[];
}

/** Top-Level-Antwort: Objekt, dessen Schlüssel `ISBN:{isbn}` lautet. */
type OpenLibraryResponse = Record<string, OpenLibraryBook | undefined>;

/**
 * Fragt die Open Library für eine ISBN ab und liefert normalisierte Metadaten.
 *
 * @param isbn ISBN-10 oder ISBN-13 (mit/ohne Bindestriche).
 * @returns Metadaten oder `null`, falls kein Treffer/Fehler.
 */
export async function fetchFromOpenLibrary(isbn: string): Promise<RawMetadata | null> {
  const normalized = clean(isbn)?.replace(/[-\s]/g, "");
  if (!normalized) return null;

  const bibkey = `ISBN:${normalized}`;
  const url = `https://openlibrary.org/api/books?bibkeys=${encodeURIComponent(bibkey)}&format=json&jscmd=data`;
  const text = await httpGet(url);
  if (!text) return null;

  const json = parseJson<OpenLibraryResponse>(text, "Open Library");
  const book = json?.[bibkey];
  if (!book) return null;

  const title = clean(book.title);
  if (!title) {
    Zotero.debug("[MetaSync] Open Library: Treffer ohne Titel verworfen.");
    return null;
  }

  const creators: RawCreator[] = (book.authors ?? [])
    .map((a) => clean(a.name))
    .filter((n): n is string => Boolean(n))
    .map((name) => ({ name, role: "author" as const }));

  return {
    source: "openLibrary",
    title,
    subtitle: clean(book.subtitle),
    creators: creators.length > 0 ? creators : undefined,
    date: clean(book.publish_date),
    publisher: clean(first(book.publishers)?.name),
    place: clean(first(book.publish_places)?.name),
    numPages:
      typeof book.number_of_pages === "number"
        ? String(book.number_of_pages)
        : undefined,
    ISBN: clean(first(book.identifiers?.isbn_13) ?? first(book.identifiers?.isbn_10)) ?? normalized,
    ISSN: clean(first(book.identifiers?.issn)),
    abstractNote: clean(book.notes ?? first(book.excerpts)?.text),
    url: clean(book.url),
    matchTitle: title,
  };
}

// ---------------------------------------------------------------------------
// 3) Google Books
// ---------------------------------------------------------------------------

/** Industrieller Identifikator (ISBN/ISSN) in Google-Books-Antworten. */
interface GoogleIndustryIdentifier {
  type?: string;
  identifier?: string;
}

/** Relevanter Ausschnitt der `volumeInfo` eines Google-Books-Treffers. */
interface GoogleVolumeInfo {
  title?: string;
  subtitle?: string;
  authors?: string[];
  publisher?: string;
  publishedDate?: string;
  description?: string;
  pageCount?: number;
  industryIdentifiers?: GoogleIndustryIdentifier[];
  language?: string;
  infoLink?: string;
  canonicalVolumeLink?: string;
}

/** Einzelner Treffer der Google-Books-Volumes-Antwort. */
interface GoogleVolume {
  volumeInfo?: GoogleVolumeInfo;
}

/** Hülle der Google-Books-Volumes-Antwort. */
interface GoogleBooksResponse {
  totalItems?: number;
  items?: GoogleVolume[];
}

/** Liest die ISBN-13 (ersatzweise ISBN-10) aus den Industrie-Identifikatoren. */
function googleIsbn(ids: GoogleIndustryIdentifier[] | undefined): string | undefined {
  const isbn13 = ids?.find((i) => i.type === "ISBN_13")?.identifier;
  const isbn10 = ids?.find((i) => i.type === "ISBN_10")?.identifier;
  return clean(isbn13 ?? isbn10);
}

/**
 * Fragt Google Books für eine ISBN ab und liefert normalisierte Metadaten.
 *
 * @param isbn ISBN-10 oder ISBN-13 (mit/ohne Bindestriche).
 * @param apiKey Google-Books-API-Key aus den Preferences (darf leer sein).
 * @returns Metadaten oder `null`, falls kein Treffer/Fehler.
 */
export async function fetchFromGoogleBooks(
  isbn: string,
  apiKey: string,
): Promise<RawMetadata | null> {
  const normalized = clean(isbn)?.replace(/[-\s]/g, "");
  if (!normalized) return null;

  const keyParam = clean(apiKey) ? `&key=${encodeURIComponent(clean(apiKey)!)}` : "";
  const url = `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(normalized)}${keyParam}`;
  const text = await httpGet(url);
  if (!text) return null;

  const json = parseJson<GoogleBooksResponse>(text, "Google Books");
  const info = first(json?.items)?.volumeInfo;
  if (!info) return null;

  const title = clean(info.title);
  if (!title) {
    Zotero.debug("[MetaSync] Google Books: Treffer ohne Titel verworfen.");
    return null;
  }

  const creators: RawCreator[] = (info.authors ?? [])
    .map((a) => clean(a))
    .filter((n): n is string => Boolean(n))
    .map((name) => ({ name, role: "author" as const }));

  return {
    source: "googleBooks",
    title,
    subtitle: clean(info.subtitle),
    creators: creators.length > 0 ? creators : undefined,
    date: clean(info.publishedDate),
    publisher: clean(info.publisher),
    numPages: typeof info.pageCount === "number" ? String(info.pageCount) : undefined,
    ISBN: googleIsbn(info.industryIdentifiers) ?? normalized,
    language: clean(info.language),
    abstractNote: clean(info.description),
    url: clean(info.canonicalVolumeLink ?? info.infoLink),
    matchTitle: title,
  };
}

// ---------------------------------------------------------------------------
// 4) Deutsche Nationalbibliothek (DNB) — SRU / MARC21-XML
// ---------------------------------------------------------------------------

/**
 * Findet den ersten MARC21-Datensatz innerhalb einer SRU-Antwort.
 * Sowohl der SRU-Wrapper als auch der MARC-Datensatz heißen `record`; der
 * MARC-Datensatz wird dadurch erkannt, dass er `datafield`-Kinder besitzt.
 */
function firstMarcRecord(doc: Document): Element | null {
  const candidates = doc.getElementsByTagName("*");
  for (let i = 0; i < candidates.length; i++) {
    const el = candidates[i];
    if (el.localName !== "record") continue;
    const descendants = el.getElementsByTagName("*");
    for (let j = 0; j < descendants.length; j++) {
      if (descendants[j].localName === "datafield") return el;
    }
  }
  return null;
}

/** Liefert alle `datafield`-Elemente eines Records mit dem angegebenen MARC-Tag. */
function marcFields(record: Element, tag: string): Element[] {
  const result: Element[] = [];
  const all = record.getElementsByTagName("*");
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (el.localName === "datafield" && el.getAttribute("tag") === tag) {
      result.push(el);
    }
  }
  return result;
}

/** Liefert den Textinhalt des ersten `subfield` mit dem angegebenen Code. */
function marcSub(field: Element | undefined, code: string): string | undefined {
  if (!field) return undefined;
  const subs = field.getElementsByTagName("*");
  for (let i = 0; i < subs.length; i++) {
    const el = subs[i];
    if (el.localName === "subfield" && el.getAttribute("code") === code) {
      return clean(el.textContent);
    }
  }
  return undefined;
}

/** Wandelt einen MARC-Personennamen "Nachname, Vorname" in {@link RawCreator}. */
function marcCreator(raw: string | undefined, role: CreatorRole): RawCreator | null {
  const name = clean(raw);
  if (!name) return null;
  const commaIndex = name.indexOf(",");
  if (commaIndex > -1) {
    return {
      lastName: clean(name.slice(0, commaIndex)),
      firstName: clean(name.slice(commaIndex + 1)),
      role,
    };
  }
  return { name, role };
}

/** Liefert die Texte aller Subfelder mit den genannten Codes in Dokumentreihenfolge. */
function marcSubsInOrder(field: Element | undefined, codes: string[]): string[] {
  if (!field) return [];
  const result: string[] = [];
  const subs = field.getElementsByTagName("*");
  for (let i = 0; i < subs.length; i++) {
    const el = subs[i];
    if (el.localName === "subfield" && codes.includes(el.getAttribute("code") ?? "")) {
      const text = clean(el.textContent);
      if (text) result.push(text);
    }
  }
  return result;
}

/**
 * Wandelt einen Namen in der Reihenfolge „Vorname Nachname" in {@link RawCreator}
 * (z. B. aus der Verantwortlichkeitsangabe 245 $c). Das letzte Wort gilt als
 * Nachname, der Rest als Vorname.
 */
function nameFirstLast(raw: string | undefined, role: CreatorRole): RawCreator | null {
  const name = clean(raw);
  if (!name) return null;
  const parts = name.split(/\s+/);
  if (parts.length === 1) return { name, role };
  const lastName = parts.pop();
  return { firstName: clean(parts.join(" ")), lastName: clean(lastName), role };
}

/** Baut einen einzelnen {@link RawMetadata}-Datensatz aus einem MARC-Record. */
function mapMarcRecord(record: Element): RawMetadata | null {
  const titleField = first(marcFields(record, "245"));

  // Vollständiger Titel: Haupttitel ($a) + ggf. Teil-/Abteilungsangaben ($n/$p),
  // damit bei Mehrbänden keine Titelbestandteile verloren gehen.
  const titleParts = marcSubsInOrder(titleField, ["a", "n", "p"]).map((s) =>
    s.replace(/\s*[/:]\s*$/, "").trim(),
  );
  const title = clean(titleParts.filter(Boolean).join(". "));
  if (!title) return null;

  const creators: RawCreator[] = [];
  const main = marcCreator(marcSub(first(marcFields(record, "100")), "a"), "author");
  if (main) creators.push(main);
  for (const f of marcFields(record, "700")) {
    // $4 enthält ggf. die Relator-Rolle (z. B. "edt" für Herausgeber).
    const relator = marcSub(f, "4");
    const role: CreatorRole = relator === "edt" ? "editor" : "author";
    const creator = marcCreator(marcSub(f, "a"), role);
    if (creator) creators.push(creator);
  }
  // 800 = Reihen-Nebeneintragung (Personenname) → Herausgeber der Reihe.
  for (const f of marcFields(record, "800")) {
    const creator = marcCreator(marcSub(f, "a"), "seriesEditor");
    if (creator) creators.push(creator);
  }

  // Fallback: Fehlt eine strukturierte Herausgeber-Eintragung, die
  // Verantwortlichkeitsangabe 245 $c nach „hrsg. von …" auswerten.
  if (!creators.some((c) => c.role === "editor")) {
    const responsibility = marcSub(titleField, "c");
    const match = responsibility?.match(
      /(?:hrsg\.?|hg\.?|herausgegeben)\s+von\s+([^.;]+)/i,
    );
    if (match) {
      const namePart = match[1]
        .split(/\s+(?:in\s+verbindung|unter\s+mitarb|unter\s+mitarbeit|und|u\.|mit)\b/i)[0]
        .split(/[,;]/)[0]
        .trim();
      const editor = nameFirstLast(namePart, "editor");
      if (editor) creators.push(editor);
    }
  }

  // 264 (RDA) bevorzugt, 260 (AACR2) als Rückfall.
  const pub = first(marcFields(record, "264")) ?? first(marcFields(record, "260"));
  const seriesField = first(marcFields(record, "490")) ?? first(marcFields(record, "830"));

  return {
    source: "dnb",
    title,
    subtitle: marcSub(titleField, "b")?.replace(/\s*[/:]\s*$/, ""),
    creators: creators.length > 0 ? creators : undefined,
    date: marcSub(pub, "c")?.replace(/[^0-9]/g, "") || marcSub(pub, "c"),
    publisher: marcSub(pub, "b")?.replace(/\s*[,:]\s*$/, ""),
    // 264 kann mehrere Orte ($a) führen (z. B. Berlin / Boston) – ersten nehmen.
    place: first(marcSubsInOrder(pub, ["a"]))?.replace(/\s*[,:]\s*$/, ""),
    edition: marcSub(first(marcFields(record, "250")), "a"),
    numPages: marcSub(first(marcFields(record, "300")), "a"),
    ISBN: marcSub(first(marcFields(record, "020")), "a")?.replace(/[^0-9Xx].*$/, ""),
    ISSN: marcSub(first(marcFields(record, "022")), "a"),
    series: marcSub(seriesField, "a")?.replace(/\s*[;,]\s*$/, ""),
    seriesNumber: marcSub(seriesField, "v"),
    language: marcSub(first(marcFields(record, "041")), "a"),
    abstractNote: marcSub(first(marcFields(record, "520")), "a"),
    matchTitle: title,
  };
}

/**
 * Führt eine DNB-SRU-Suche mit der angegebenen CQL-Abfrage aus und liefert den
 * ersten MARC21-Datensatz normalisiert zurück.
 */
async function dnbSearch(cql: string): Promise<RawMetadata | null> {
  const url =
    "https://services.dnb.de/sru/dnb?version=1.1&operation=searchRetrieve" +
    `&query=${encodeURIComponent(cql)}` +
    "&recordSchema=MARC21-xml&maximumRecords=5";

  const text = await httpGet(url, "application/xml");
  if (!text) return null;

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(text, "application/xml");
  } catch (error) {
    Zotero.debug(`[MetaSync] DNB: XML-Parsing fehlgeschlagen: ${String(error)}`);
    return null;
  }

  if (doc.getElementsByTagName("parsererror").length > 0) {
    Zotero.debug("[MetaSync] DNB: Antwort enthielt einen Parser-Fehler.");
    return null;
  }

  const record = firstMarcRecord(doc);
  if (!record) {
    Zotero.debug("[MetaSync] DNB: Kein MARC21-Datensatz in der Antwort.");
    return null;
  }

  return mapMarcRecord(record);
}

/**
 * Durchsucht die DNB via SRU nach Titel + erstem Autor.
 *
 * Hinweis: Die DNB-SRU verwendet den Index `PER` (Person) für Beteiligte; das in
 * manchen Beispielen genannte `aut` wird mit „Unsupported index" abgelehnt.
 *
 * @param title Titel des Werks bzw. Aufsatztitels.
 * @param author Nachname des ersten Autors.
 * @returns Metadaten des besten Treffers oder `null`.
 */
export async function fetchFromDNB(
  title: string,
  author: string,
): Promise<RawMetadata | null> {
  const t = clean(title);
  if (!t) return null;
  const a = clean(author);
  const queryParts = [`tit=${t}`];
  if (a) queryParts.push(`PER=${a}`);
  return dnbSearch(queryParts.join(" AND "));
}

/**
 * Durchsucht die DNB via SRU nach ISBN (Index `NUM`). Liefert den exakten
 * Katalogdatensatz und ist für deutsche/theologische Literatur die
 * verlässlichste Buchquelle.
 *
 * @param isbn ISBN-10 oder ISBN-13 (mit/ohne Bindestriche).
 * @returns Metadaten des Treffers oder `null`.
 */
export async function fetchFromDNBByISBN(isbn: string): Promise<RawMetadata | null> {
  const normalized = clean(isbn)?.replace(/[-\s]/g, "");
  if (!normalized) return null;
  return dnbSearch(`NUM=${normalized}`);
}

// ---------------------------------------------------------------------------
// 5) Semantic Scholar
// ---------------------------------------------------------------------------

/** Autor in Semantic-Scholar-Antworten. */
interface SemanticScholarAuthor {
  name?: string;
}

/** Externe Identifikatoren in Semantic-Scholar-Antworten. */
interface SemanticScholarExternalIds {
  DOI?: string;
  ISSN?: string;
  [key: string]: string | undefined;
}

/** Zeitschriftenangaben in Semantic-Scholar-Antworten. */
interface SemanticScholarJournal {
  name?: string;
  volume?: string;
  pages?: string;
}

/** Einzelner Treffer der Semantic-Scholar-Suche. */
interface SemanticScholarPaper {
  title?: string;
  authors?: SemanticScholarAuthor[];
  year?: number;
  journal?: SemanticScholarJournal;
  doi?: string;
  externalIds?: SemanticScholarExternalIds;
}

/** Hülle der Semantic-Scholar-Suchantwort. */
interface SemanticScholarResponse {
  total?: number;
  data?: SemanticScholarPaper[];
}

/**
 * Durchsucht Semantic Scholar nach einem Titel und liefert den ersten Treffer
 * normalisiert zurück.
 *
 * Hinweis: Semantic Scholar liefert mehrere Treffer; aktuell wird der erste
 * zurückgegeben (Signatur gemäß Spezifikation Schritt 1). Die Mehrfach-
 * Trefferauswahl folgt im Trefferauswahl-Dialog (Schritt 5).
 *
 * @param title Titel des gesuchten Artikels.
 * @returns Metadaten des besten Treffers oder `null`.
 */
export async function fetchFromSemanticScholar(
  title: string,
): Promise<RawMetadata | null> {
  const t = clean(title);
  if (!t) return null;

  const fields = "title,authors,year,journal,volume,issue,pages,doi,externalIds";
  const url =
    "https://api.semanticscholar.org/graph/v1/paper/search" +
    `?query=${encodeURIComponent(t)}&fields=${encodeURIComponent(fields)}&limit=5`;

  const text = await httpGet(url);
  if (!text) return null;

  const json = parseJson<SemanticScholarResponse>(text, "Semantic Scholar");
  const paper = first(json?.data);
  if (!paper) return null;

  const paperTitle = clean(paper.title);
  if (!paperTitle) return null;

  const creators: RawCreator[] = (paper.authors ?? [])
    .map((a) => clean(a.name))
    .filter((n): n is string => Boolean(n))
    .map((name) => ({ name, role: "author" as const }));

  return {
    source: "semanticScholar",
    title: paperTitle,
    creators: creators.length > 0 ? creators : undefined,
    date: typeof paper.year === "number" ? String(paper.year) : undefined,
    publicationTitle: clean(paper.journal?.name),
    volume: clean(paper.journal?.volume),
    pages: clean(paper.journal?.pages),
    DOI: clean(paper.doi ?? paper.externalIds?.DOI),
    ISSN: clean(paper.externalIds?.ISSN),
    url: paper.doi || paper.externalIds?.DOI
      ? `https://doi.org/${paper.doi ?? paper.externalIds?.DOI}`
      : undefined,
    matchTitle: paperTitle,
  };
}

// ---------------------------------------------------------------------------
// Selbsttest
// ---------------------------------------------------------------------------

/**
 * Ruft alle fünf Quellen mit festen Testdaten auf und protokolliert die
 * Ergebnisse per `Zotero.debug()`. Dient ausschließlich der manuellen
 * Verifikation während der Entwicklung.
 *
 * Testdaten:
 *  - DOI:   10.1515/9783110340112  (De Gruyter, Theologie)
 *  - ISBN:  9783525560174          (Vandenhoeck & Ruprecht)
 *  - Titel: „Kritische Gesamtausgabe", Autor: „Schleiermacher"
 */
export async function testAllAPIs(): Promise<void> {
  const testDoi = "10.1515/9783110340112";
  const testIsbn = "9783525560174";
  const testTitle = "Kritische Gesamtausgabe";
  const testAuthor = "Schleiermacher";

  const apiKey = (Zotero.Prefs.get(PREF_GOOGLE_API_KEY, true) as string) || "";

  /** Führt einen einzelnen Test aus und protokolliert das Ergebnis. */
  const run = async (
    label: string,
    fn: () => Promise<RawMetadata | null>,
  ): Promise<void> => {
    Zotero.debug(`[MetaSync] === Test ${label} ===`);
    try {
      const result = await fn();
      if (result) {
        Zotero.debug(`[MetaSync] ${label}: ${JSON.stringify(result, null, 2)}`);
      } else {
        Zotero.debug(`[MetaSync] ${label}: kein Treffer (null).`);
      }
    } catch (error) {
      Zotero.debug(`[MetaSync] ${label}: Ausnahme — ${String(error)}`);
    }
  };

  await run("Crossref", () => fetchFromCrossref(testDoi));
  await run("Open Library", () => fetchFromOpenLibrary(testIsbn));
  await run("Google Books", () => fetchFromGoogleBooks(testIsbn, apiKey));
  await run("DNB", () => fetchFromDNB(testTitle, testAuthor));
  await run("Semantic Scholar", () => fetchFromSemanticScholar(testTitle));

  Zotero.debug("[MetaSync] === testAllAPIs abgeschlossen ===");
}
