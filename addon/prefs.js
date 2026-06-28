// MetaSync-Preferences. Der Präfix extensions.zotero.metasync wird vom
// Scaffold automatisch vorangestellt (siehe package.json > config.prefsPrefix).

// Google-Books-API-Key (im Preferences-Pane maskiert dargestellt).
pref("googleApiKey", "");

// Aktivierte Quellen.
pref("source.crossref", true);
pref("source.crossrefSearch", true);
pref("source.openLibrary", true);
pref("source.googleBooks", true);
pref("source.dnb", true);
pref("source.semanticScholar", true);

// Vorschau: "always" = Dialog immer anzeigen, "direct" = direkt übernehmen.
pref("previewMode", "always");

// DNB-Suchsprache: "both" | "de" | "en".
pref("dnbLanguage", "both");

// Trefferqualitäts-Schwelle in Prozent (0–100, Default 85).
pref("matchThreshold", 85);
