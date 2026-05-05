import {
  PDFDocument,
  AFRelationship,
  PDFName,
  PDFString,
  PDFHexString,
  StandardFonts,
  rgb,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import pako from 'pako';
import { FONT_DATA } from './fonts.js';
import { fmt, fmtPDF, round2 } from './utils.js';

// -------- State --------
const STORAGE_KEY = 'erechnung:seller:v1';
const BOILERPLATE_KEY = 'erechnung:boilerplate:v1';
const BUYERS_KEY = 'erechnung:buyers:v1';
const COUNTER_KEY = 'erechnung:last_invoice:v1';
const FOOTNOTES_KEY = 'erechnung:footnotes:v1';
const HISTORY_KEY = 'erechnung:history:v1';
const HISTORY_ENABLED_KEY = 'erechnung:history_enabled:v1';
const HISTORY_LIMIT = 1000;
const YOY_ENABLED_KEY = 'erechnung:yoy_enabled:v1';
const YOY_DATA_KEY = 'erechnung:yoy:v1';
const SELLER_COLLAPSED_KEY = 'erechnung:seller_collapsed:v1';

const state = {
  items: [],
  pdfFile: null,
  buyers: [],
  footnotes: [],
  history: [],            // array of invoice snapshots, newest first
  historyEnabled: true,   // user toggle; defaults to on
  yoyEnabled: false,      // year-over-year arrow visibility (default off)
  yoyData: {},            // backfill: { CUR: { YEAR: number[12] } }
};

// -------- Helpers --------
const $ = (id) => document.getElementById(id);
const nz = (v, d = '') => (v === undefined || v === null) ? d : String(v);
const esc = (s) => nz(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const dateCompact = (iso) => iso ? iso.replace(/-/g, '') : '';

// -------- i18n: language dictionary --------
const I18N = {
  de: {
    // Header
    title: 'E-Rechnung Generator',
    subtitle: 'ZUGFeRD 2.3 · Factur-X · EN 16931 (Comfort)',
    theme_auto: 'Auto (System)',
    theme_light: 'Hell (manuell)',
    theme_dark: 'Dunkel (manuell)',
    // Intro
    intro_main: 'Erstellt ZUGFeRD- bzw. Factur-X-konforme Rechnungen. Läuft komplett offline, alle Daten bleiben lokal im Browser, nichts wird hochgeladen.',
    intro_alt: 'Alternativ kann eine bereits gestaltete PDF (z. B. aus InDesign) hochgeladen werden, das Tool bettet die XML dann in die bestehende PDF ein. Für volle Konformität in InDesign als PDF/A-3 exportieren (Datei → Exportieren → Adobe PDF, unter Standard PDF/A-3:2012 wählen).',
    // Sections
    section_seller: 'Verkäufer',
    section_seller_hint: 'Stammdaten · Standardtexte (Intro, Zahlungshinweis, Gruß, Fußnote) werden pro Rechnungssprache gespeichert',
    section_buyer: 'Käufer',
    section_buyer_hint: 'Empfänger der Rechnung',
    section_invoice: 'Rechnung',
    section_invoice_hint: 'Kopfdaten',
    section_items: 'Positionen',
    section_items_hint: 'Leistungen und Produkte',
    section_output: 'Ausgabe',
    section_output_hint: 'PDF-Quelle wählen',
    section_filename: 'Dateiname',
    section_filename_hint: 'Bausteine anklicken zum Einfügen · Muster wird gespeichert',
    // Buttons
    btn_save_template: 'als Vorlage speichern',
    btn_reset: 'zurücksetzen',
    btn_save_buyer: 'als Kunde speichern',
    btn_delete_selected: 'ausgewählten löschen',
    btn_save_footnote: 'aktuelle Fußnote speichern',
    btn_delete_footnote: 'ausgewählte löschen',
    btn_save_pattern: 'Muster speichern',
    btn_save_filename: 'Muster speichern',
    btn_add_item: '+ Position hinzufügen',
    btn_create_pdf: 'PDF erstellen',
    btn_create_pdf_progress: 'Wird erstellt…',
    btn_xml_only: 'Nur XML herunterladen',
    btn_validate: 'XML prüfen',
    btn_export_data: 'Daten exportieren',
    btn_import_data: 'Daten importieren',
    btn_clear: 'leeren',
    // Mode toggle
    mode_generate: 'PDF neu generieren',
    mode_upload: 'Aus InDesign-PDF',
    mode_generate_hint: 'Das Tool erzeugt eine sauber gesetzte A4-PDF aus deinen Daten und bettet die EN 16931-XML ein.',
    drop_pdf: 'PDF hier ablegen oder klicken zum Auswählen',
    // Field labels — seller
    f_company: 'Firmenname / Name',
    f_address: 'Adresszeile',
    f_zip: 'Postleitzahl',
    f_city: 'Stadt',
    f_country: 'Land (ISO)',
    f_country_de: 'Land (ISO, z.B. DE)',
    f_vat: 'USt-IdNr',
    f_vat_de: 'USt-IdNr (z.B. DE123456789)',
    f_vat_b2b: 'USt-IdNr (bei B2B)',
    f_siret: 'SIREN / SIRET (FR, optional)',
    f_siret_placeholder: '9 oder 14 Ziffern',
    f_email: 'E-Mail',
    f_phone: 'Telefon (optional)',
    f_iban: 'IBAN',
    f_bic: 'BIC (optional)',
    f_bank: 'Bankname (optional)',
    // Field labels — buyer
    f_buyer_picker: 'Neuer Kunde / Formular leeren',
    f_buyer_reference: 'Käufer-Referenz / Leitweg-ID (BT-10, optional)',
    f_buyer_reference_hint: 'Pflichtfeld für deutsche Behörden (Leitweg-ID). Bei privatwirtschaftlichen Kunden meist frei.',
    // Field labels — invoice
    f_number: 'Rechnungsnummer',
    f_number_pattern_summary: 'Muster anpassen',
    f_number_pattern_hint: 'Counter ist eine fortlaufende Zahl, die nach jeder erstellten Rechnung um 1 steigt, unabhängig vom Jahr.',
    chip_next_number: '↻ Nächste Nr.',
    chip_year4: 'Jahr (4)',
    chip_year2: 'Jahr (2)',
    chip_month: 'Monat',
    chip_day: 'Tag',
    chip_counter: 'Counter',
    chip_counter3: 'Counter (3-stellig)',
    chip_counter5: 'Counter (5-stellig)',
    f_date: 'Rechnungsdatum',
    f_delivery: 'Leistungsdatum',
    f_delivery_end: 'Leistungsdatum bis (optional)',
    f_due: 'Fälligkeit',
    chip_days: 'Tage',
    f_currency: 'Währung',
    f_taxmode: 'Steuerart',
    f_invoice_lang: 'Rechnungssprache',
    f_invoice_lang_hint: 'Sprache der erzeugten PDF/XML, unabhängig von der UI-Sprache',
    f_invoice_font: 'Schriftart der Rechnung',
    f_invoice_font_hint: 'Alle Schriften sind eingebettet und funktionieren offline',
    f_invoice_layout: 'Rechnungslayout',
    f_invoice_layout_hint: 'Visuelle Anordnung der Rechnung',
    invoice_lang_auto: 'wie Oberfläche',
    tax_S: 'Standard (MwSt wird berechnet)',
    tax_AE: 'Reverse Charge (B2B EU-Ausland)',
    tax_Z: 'Nullsatz (0%)',
    tax_E: 'Steuerbefreit',
    tax_O: 'Nicht steuerbar',
    f_project: 'Projekttitel / Referenz',
    f_project_placeholder: 'z.B. SS26 Campaign | Brand',
    f_category: 'Leistungskategorie (erscheint fett über der Positionen-Tabelle)',
    f_category_placeholder: 'z.B. Photography',
    f_intro: 'Intro-Text',
    f_intro_placeholder: 'z.B. Wie vereinbart stelle ich Ihnen folgende Leistungen in Rechnung:',
    f_payment_note: 'Zahlungshinweis (Platzhalter {due} wird durch Fälligkeitsdatum ersetzt)',
    f_payment_note_placeholder: 'z.B. Zahlbar bis {due} per Überweisung auf das unten genannte Konto.',
    f_greeting: 'Grußformel',
    f_greeting_placeholder: 'z.B. Mit freundlichen Grüßen,',
    f_signature: 'Gruß-Name',
    f_signature_placeholder: 'wird aus Verkäufer-Name übernommen',
    f_note: 'Zusätzliche Notiz (optional, erscheint in der XML)',
    f_footnote: 'Erklärung / Fußnote auf der PDF (optional)',
    f_footnote_placeholder: 'z.B. Erklärung zu einer Leistungsposition oder zu Aufschlägen',
    f_footnote_hint: 'Erscheint kursiv unter der VAT-Zeile auf der PDF.',
    f_footnote_picker: 'Vorgefertigte Fußnote auswählen',
    // Items table
    th_desc: 'Beschreibung',
    th_qty: 'Menge',
    th_price: 'Einzelpreis',
    th_vat_pct: 'MwSt %',
    item_placeholder: 'Leistung…',
    // Totals
    total_net: 'Zwischensumme (netto)',
    total_tax_S: 'MwSt',
    total_tax_AE: 'Reverse Charge (0%)',
    total_tax_Z: 'Nullsatz (0%)',
    total_tax_E: 'Steuerbefreit',
    total_tax_O: 'Nicht steuerbar',
    total_grand: 'Gesamt',
    // Filename pattern chips
    chip_nr: 'Nr.',
    chip_project: 'Projekt',
    chip_buyer: 'Kunde',
    chip_date: 'Datum',
    chip_category: 'Kategorie',
    chip_seller: 'Verkäufer',
    chip_layout: 'Layout',
    f_filename_pattern: 'Dateiname-Muster',
    // Footer
    footer_main: 'Format: ZUGFeRD 2.3 / Factur-X 1.0 · Profil: EN 16931 (Comfort) · Konform mit §14 UStG und deutscher E-Rechnungspflicht seit 2025. XML nach BT-Nummern der EN 16931. Validierung z.B. mit Quba-Viewer, Mustang oder ELSTER E-Rechnungsviewer.',
    footer_disclaimer: 'Keine Gewähr. Vor produktivem Einsatz validieren. Details siehe Hilfe.',
    footer_backup: 'Datensicherung:',
    // Status messages
    msg_seller_saved: 'Verkäufer-Angaben gespeichert.',
    msg_save_failed: 'Speichern fehlgeschlagen.',
    msg_reset: 'Zurückgesetzt.',
    msg_buyer_saved: 'als neuer Kunde gespeichert.',
    msg_buyer_updated: 'aktualisiert.',
    msg_buyer_no_name: 'Bitte zuerst den Kundennamen eintragen.',
    msg_buyer_unnamed: '(ohne Namen)',
    msg_buyer_no_select: 'Keinen gespeicherten Kunden ausgewählt.',
    msg_buyer_confirm_delete: 'wirklich löschen?',
    msg_deleted: 'Gelöscht.',
    msg_footnote_no_text: 'Erst eine Fußnote ins Textfeld schreiben, dann speichern.',
    msg_footnote_overwrite: 'mit aktuellem Text überschreiben?',
    msg_footnote_name_prompt: 'Name der Fußnote (z.B. „Overtime Standard"):',
    msg_footnote_no_select: 'Keine Fußnote ausgewählt.',
    msg_pattern_saved: 'Muster gespeichert:',
    msg_filename_saved: 'Dateiname-Muster gespeichert.',
    msg_pdf_select_first: 'Bitte zuerst eine PDF auswählen.',
    msg_pdf_done: 'Rechnung erstellt:',
    msg_pdf_done_2: 'Enthält EN 16931-konforme XML-Rechnungsdaten.\nTipp: mit Quba-Viewer oder ELSTER E-Rechnungsviewer prüfen.',
    msg_xml_done: 'XML heruntergeladen.',
    msg_xml_valid: 'XML gültig aufgebaut. Alle Pflichtfelder EN 16931 enthalten.\nFür volle Syntax-Validierung empfohlen: Quba-Viewer oder ELSTER E-Rechnungsviewer.',
    msg_xml_warnings: 'Hinweise:',
    msg_error: 'Fehler:',
    msg_backup_export: 'Backup exportiert:',
    msg_backup_seller: 'Verkäufer-Profil',
    msg_backup_buyers: 'Kunde(n)',
    msg_backup_footnotes: 'Fußnote(n)',
    msg_backup_import_done: 'Backup eingelesen:',
    msg_backup_import_confirm: 'Backup einlesen?\n\nEnthält: {seller} Verkäufer-Profil, {buyers} Kunde(n), {footnotes} Fußnote(n).\n\nAchtung: bestehende gespeicherte Daten werden überschrieben.',
    msg_backup_invalid: 'Datei ist kein E-Rechnung-Backup.',
    msg_backup_failed: 'Import fehlgeschlagen:',
    // PDF labels
    pdf_billed_to: 'RECHNUNG AN',
    pdf_from: 'VON',
    pdf_no: 'NR.',
    pdf_date: 'DATUM',
    pdf_service: 'LEISTUNG',
    pdf_price: 'Preis',
    pdf_amount: 'Menge',
    pdf_total: 'Gesamt',
    pdf_sum: 'Summe',
    pdf_grand_total: 'Gesamt',
    pdf_vat_S: 'USt: Standardsatz',
    pdf_vat_AE: 'USt: Reverse-Charge-Verfahren',
    pdf_vat_Z: 'USt: Nullsatz',
    pdf_vat_E: 'USt: Steuerbefreit',
    pdf_vat_O: 'USt: Nicht steuerbar',
    pdf_vat_label: 'USt:',
    pdf_due_short: 'FÄLLIG',
    pdf_payment: 'ZAHLUNG',
    pdf_invoice_label: 'RECHNUNG',
    pdf_vat_id_label: 'USt-IdNr.',
    // XML / legal notes
    rc_note: 'Steuerschuldnerschaft des Leistungsempfängers. Reverse charge nach Art. 196 Richtlinie 2006/112/EG.',
    rc_note_Z: 'Steuersatz 0%.',
    rc_note_E: 'Umsatzsteuerbefreit.',
    rc_note_O: 'Nicht im Anwendungsbereich der Umsatzsteuer.',
    // --- Errors / labels / XML output strings (added by review) ---
    xml_sepa_info: 'SEPA-Überweisung',
    xml_payable_by: 'Zahlbar bis {date}',
    err_no_number: 'Rechnungsnummer fehlt.',
    err_no_date: 'Rechnungsdatum fehlt.',
    err_no_seller_name: 'Verkäufer-Name fehlt.',
    err_no_buyer_name: 'Käufer-Name fehlt.',
    err_no_items: 'Mindestens eine Position erforderlich.',
    err_country_required: 'Land ist erforderlich (ISO-Code wie DE, FR, GB).',
    err_country_unknown: 'Unbekanntes Land: "{input}". Bitte ISO 3166-1 alpha-2 verwenden (z.B. DE, FR, GB).',
    err_rc_seller_vat: 'Reverse-Charge: Verkäufer benötigt eine USt-IdNr (oder Handelsregistereintragung / Steuervertreter).',
    err_rc_buyer_vat: 'Reverse-Charge: Käufer benötigt eine USt-IdNr (oder Handelsregistereintragung).',
    th_desc: 'Beschreibung',
    th_qty: 'Menge',
    th_price: 'Einzelpreis',
    th_vat: 'MwSt %',
    aria_remove_item: 'Position entfernen',
    // --- History feature ---
    section_history: 'Verlauf',
    section_history_hint: 'Generierte Rechnungen werden automatisch hier gespeichert · Klonen lädt alle Felder ins Formular',
    history_enable_label: 'Rechnungen im Verlauf speichern',
    option_history_select: 'Verlaufseintrag wählen…',
    btn_history_clone: 'Klonen',
    btn_history_delete: 'Eintrag löschen',
    btn_history_clear_all: 'Alle löschen',
    history_clear_confirm: 'Wirklich alle {count} Einträge aus dem Verlauf löschen?',
    history_empty: 'Noch keine Rechnungen im Verlauf',
    msg_history_saved: 'Im Verlauf gespeichert.',
    msg_history_cloned: 'Aus Verlauf geklont.',
    msg_history_deleted: 'Eintrag gelöscht.',
    msg_history_no_select: 'Keinen Verlaufseintrag ausgewählt.',
    msg_history_cleared: 'Verlauf geleert.',
    // --- Past invoice entry ---
    btn_history_add_past: 'Alte Rechnung hinzufügen',
    past_modal_title: 'Alte Rechnung hinzufügen',
    past_modal_hint: 'Manuell erfasste Rechnungen erscheinen im Verlauf und in der Statistik. Klonen funktioniert eingeschränkt, da nur Grunddaten erfasst werden.',
    past_field_date: 'Rechnungsdatum',
    past_field_buyer: 'Käufer',
    past_field_buyer_select: 'Aus Kunden wählen…',
    past_field_buyer_new: 'Oder neuen Namen eingeben',
    past_field_total: 'Gesamtbetrag (brutto)',
    past_field_currency: 'Währung',
    past_field_taxmode: 'Steuermodus',
    past_field_vat_rate: 'USt-Satz (%)',
    past_field_number: 'Rechnungsnr. (optional)',
    past_field_project: 'Projekt (optional)',
    past_field_category: 'Kategorie (optional)',
    past_save: 'Hinzufügen',
    past_cancel: 'Abbrechen',
    past_err_no_buyer: 'Käufer-Name fehlt.',
    past_err_no_total: 'Gesamtbetrag muss positiv sein.',
    past_err_no_date: 'Rechnungsdatum fehlt.',
    msg_history_added: 'Im Verlauf gespeichert.',
    msg_history_clone_partial: 'Geklont – einige Felder leer (manueller Eintrag).',
    history_imported_marker: 'manuell',
    // --- Statistics + buyer history hint ---
    btn_open_stats: 'Statistik',
    stats_title: 'Statistik',
    stats_close: 'Schließen',
    stats_period_label: 'Zeitraum',
    stats_period_last_month: 'Letzte 30 Tage',
    stats_period_last3: 'Letzte 3 Monate',
    stats_period_last6: 'Letzte 6 Monate',
    stats_period_ytd: 'Aktuelles Jahr',
    stats_period_last12: 'Letzte 12 Monate',
    stats_period_all: 'Alles',
    // --- Stats: tax breakdown ---
    stats_tab_overview: 'Übersicht',
    stats_tab_quarters: 'USt-Aufschlüsselung',
    stats_year_label: 'Jahr',
    stats_empty_year: 'Keine Rechnungen in diesem Jahr.',
    qb_quarter: 'Quartal',
    qb_q1: 'Q1 (Jan–Mär)',
    qb_q2: 'Q2 (Apr–Jun)',
    qb_q3: 'Q3 (Jul–Sep)',
    qb_q4: 'Q4 (Okt–Dez)',
    qb_year_total: 'Jahressumme',
    qb_standard_net: 'Standard netto',
    qb_standard_vat: 'Standard USt',
    qb_reverse_charge: 'Reverse Charge netto',
    qb_zero_rate: 'Steuersatz 0% netto',
    qb_exempt: 'Steuerbefreit netto',
    qb_out_of_scope: 'Nicht steuerbar netto',
    // --- Stats: buyer drill-down ---
    stats_back: 'Zurück',
    stats_buyer_first: 'Erste Rechnung',
    stats_buyer_last: 'Letzte Rechnung',
    stats_buyer_col_date: 'Datum',
    stats_buyer_col_number: 'Nummer',
    stats_buyer_col_total: 'Gesamt',
    // --- Stats: CSV export ---
    btn_export_csv: 'CSV exportieren',
    msg_csv_exported: 'CSV exportiert.',
    msg_csv_no_data: 'Keine Daten zum Exportieren.',
    // --- Stats: YoY arrows + backfill ---
    btn_yoy_toggle: 'Vorjahresvergleich',
    yoy_set_reference: 'Vorjahreswerte eingeben',
    yoy_hint_no_data: 'Vorjahreswerte fehlen für den Vergleich.',
    yoy_hint_no_period: 'Vorjahresvergleich für diesen Zeitraum nicht verfügbar.',
    yoy_modal_title: 'Vorjahreswerte eintragen',
    yoy_modal_intro: 'Brutto-Monatssummen aus dem Vorjahr für den Vergleich. Echte Rechnungen aus der Historie haben Vorrang.',
    yoy_field_year: 'Jahr',
    yoy_field_currency: 'Währung',
    yoy_month_jan: 'Januar',
    yoy_month_feb: 'Februar',
    yoy_month_mar: 'März',
    yoy_month_apr: 'April',
    yoy_month_may: 'Mai',
    yoy_month_jun: 'Juni',
    yoy_month_jul: 'Juli',
    yoy_month_aug: 'August',
    yoy_month_sep: 'September',
    yoy_month_oct: 'Oktober',
    yoy_month_nov: 'November',
    yoy_month_dec: 'Dezember',
    yoy_save: 'Speichern',
    yoy_cancel: 'Abbrechen',
    msg_yoy_saved: 'Vorjahreswerte gespeichert.',
    msg_yoy_cleared: 'Vorjahreswerte gelöscht.',
    msg_yoy_invalid_year: 'Ungültiges Jahr.',
    msg_yoy_invalid_value: 'Negative Werte sind nicht erlaubt.',
    // --- UI restructure: top-bar icons, help/embed modals, past-invoice extras ---
    btn_open_history: 'Historie',
    btn_open_help: 'Hilfe',
    help_title: 'Hilfe & Dokumentation',
    embed_title: 'XML in vorhandenes PDF einbetten',
    embed_intro: 'Lade ein bestehendes PDF hoch (z.B. aus InDesign exportiert). Die XML-Daten der aktuellen Rechnung werden eingebettet, damit das PDF zur konformen E-Rechnung wird.',
    btn_embed_xml: 'XML einbetten...',
    btn_embed_run: 'PDF erzeugen',
    btn_embed_progress: 'Erzeuge...',
    msg_embed_done: 'PDF mit eingebetteter XML erzeugt.',
    msg_embed_failed: 'Einbetten fehlgeschlagen:',
    btn_history_add_past: 'Vergangene Rechnung eintragen',
    past_field_buyer_select: 'Bestehender Kunde',
    past_field_vat_rate: 'USt-Satz (%)',
    past_field_project: 'Projekt',
    past_field_category: 'Kategorie',
    past_err_no_date: 'Datum fehlt.',
    past_err_no_buyer: 'Käufer fehlt.',
    past_err_no_total: 'Brutto-Summe fehlt oder ist ungültig.',
    stats_empty: 'Noch keine Rechnungen im Verlauf — Statistik erscheint, sobald du welche generierst.',
    stats_empty_period: 'Keine Rechnungen in diesem Zeitraum.',
    stats_kpi_total: 'Gesamt (brutto)',
    stats_kpi_net: 'Netto',
    stats_kpi_tax: 'USt',
    stats_kpi_avg: 'Ø pro Rechnung',
    stats_top_buyers: 'Top-Kunden',
    stats_last_12_months: 'Letzte 12 Monate',
    stats_invoice: 'Rechnung',
    stats_invoices: 'Rechnungen',
    buyer_history_hint_today: 'Letzte Rechnung an diesen Kunden: heute · {number} · {total}',
    buyer_history_hint_one_day: 'Letzte Rechnung an diesen Kunden: gestern · {number} · {total}',
    buyer_history_hint_n_days: 'Letzte Rechnung an diesen Kunden: vor {days} Tagen · {number} · {total}',
    buyer_history_hint_no_date: 'Letzte Rechnung an diesen Kunden: {number} · {total}',
  },
  en: {
    title: 'E-Invoice Generator',
    subtitle: 'ZUGFeRD 2.3 · Factur-X · EN 16931 (Comfort)',
    theme_auto: 'Auto (System)',
    theme_light: 'Light (manual)',
    theme_dark: 'Dark (manual)',
    intro_main: 'Generates ZUGFeRD / Factur-X compliant invoices. Runs fully offline, all data stays local in your browser, nothing is uploaded.',
    intro_alt: 'Alternatively, an existing PDF (e.g. from InDesign) can be uploaded, the tool will embed the XML into it. For full compliance, export from InDesign as PDF/A-3 (File → Export → Adobe PDF, choose Standard PDF/A-3:2012).',
    section_seller: 'Seller',
    section_seller_hint: 'Master data · default texts (intro, payment note, greeting, footnote) are saved per invoice language',
    section_buyer: 'Buyer',
    section_buyer_hint: 'Invoice recipient',
    section_invoice: 'Invoice',
    section_invoice_hint: 'Header data',
    section_items: 'Line items',
    section_items_hint: 'Services and products',
    section_output: 'Output',
    section_output_hint: 'Choose PDF source',
    section_filename: 'Filename',
    section_filename_hint: 'Click tokens to insert · pattern is saved',
    btn_save_template: 'save as template',
    btn_reset: 'reset',
    btn_save_buyer: 'save as customer',
    btn_delete_selected: 'delete selected',
    btn_save_footnote: 'save current footnote',
    btn_delete_footnote: 'delete selected',
    btn_save_pattern: 'save pattern',
    btn_save_filename: 'save pattern',
    btn_add_item: '+ Add line item',
    btn_create_pdf: 'Create PDF',
    btn_create_pdf_progress: 'Creating…',
    btn_xml_only: 'Download XML only',
    btn_validate: 'Validate XML',
    btn_export_data: 'Export data',
    btn_import_data: 'Import data',
    btn_clear: 'clear',
    mode_generate: 'Generate PDF',
    mode_upload: 'From InDesign PDF',
    mode_generate_hint: 'The tool generates a clean A4 PDF from your data and embeds the EN 16931 XML.',
    drop_pdf: 'Drop PDF here or click to select',
    f_company: 'Company / Name',
    f_address: 'Address line',
    f_zip: 'ZIP / Postal code',
    f_city: 'City',
    f_country: 'Country (ISO)',
    f_country_de: 'Country (ISO, e.g. DE)',
    f_vat: 'VAT ID',
    f_vat_de: 'VAT ID (e.g. DE123456789)',
    f_vat_b2b: 'VAT ID (B2B)',
    f_siret: 'SIREN / SIRET (FR, optional)',
    f_siret_placeholder: '9 or 14 digits',
    f_email: 'Email',
    f_phone: 'Phone (optional)',
    f_iban: 'IBAN',
    f_bic: 'BIC (optional)',
    f_bank: 'Bank name (optional)',
    f_buyer_picker: 'New customer / clear form',
    f_buyer_reference: 'Buyer reference / Leitweg-ID (BT-10, optional)',
    f_buyer_reference_hint: 'Required for German government clients (Leitweg-ID). Usually optional for private companies.',
    f_number: 'Invoice number',
    f_number_pattern_summary: 'Edit pattern',
    f_number_pattern_hint: 'Counter is a continuous number that increments by 1 after each created invoice, independent of year.',
    chip_next_number: '↻ Next No.',
    chip_year4: 'Year (4)',
    chip_year2: 'Year (2)',
    chip_month: 'Month',
    chip_day: 'Day',
    chip_counter: 'Counter',
    chip_counter3: 'Counter (3-digit)',
    chip_counter5: 'Counter (5-digit)',
    f_date: 'Invoice date',
    f_delivery: 'Service date',
    f_delivery_end: 'Service date end (optional)',
    f_due: 'Due date',
    chip_days: 'days',
    f_currency: 'Currency',
    f_taxmode: 'VAT mode',
    f_invoice_lang: 'Invoice language',
    f_invoice_lang_hint: 'Language used in the generated PDF/XML, independent of the UI language',
    f_invoice_font: 'Invoice font',
    f_invoice_font_hint: 'All fonts are embedded and work offline',
    f_invoice_layout: 'Invoice layout',
    f_invoice_layout_hint: 'Visual arrangement of the invoice',
    invoice_lang_auto: 'follow UI',
    tax_S: 'Standard (VAT applied)',
    tax_AE: 'Reverse Charge (B2B EU)',
    tax_Z: 'Zero rate (0%)',
    tax_E: 'Exempt',
    tax_O: 'Out of scope',
    f_project: 'Project title / reference',
    f_project_placeholder: 'e.g. SS26 Campaign | Brand',
    f_category: 'Service category (appears bold above the items table)',
    f_category_placeholder: 'e.g. Photography',
    f_intro: 'Intro text',
    f_intro_placeholder: 'e.g. As agreed, I will invoice you for the following services:',
    f_payment_note: 'Payment note ({due} placeholder is replaced with the due date)',
    f_payment_note_placeholder: 'e.g. Payment due by {due} via bank transfer to the account at the bottom.',
    f_greeting: 'Greeting',
    f_greeting_placeholder: 'e.g. Best,',
    f_signature: 'Signature name',
    f_signature_placeholder: 'taken from seller name if empty',
    f_note: 'Additional note (optional, appears in the XML)',
    f_footnote: 'Note / footnote on the PDF (optional)',
    f_footnote_placeholder: 'e.g. explanation for a service item or surcharge',
    f_footnote_hint: 'Appears in italic below the VAT line on the PDF.',
    f_footnote_picker: 'Select preset footnote',
    th_desc: 'Description',
    th_qty: 'Qty',
    th_price: 'Unit price',
    th_vat_pct: 'VAT %',
    item_placeholder: 'Service…',
    total_net: 'Subtotal (net)',
    total_tax_S: 'VAT',
    total_tax_AE: 'Reverse Charge (0%)',
    total_tax_Z: 'Zero rate (0%)',
    total_tax_E: 'Exempt',
    total_tax_O: 'Out of scope',
    total_grand: 'Total',
    chip_nr: 'No.',
    chip_project: 'Project',
    chip_buyer: 'Customer',
    chip_date: 'Date',
    chip_category: 'Category',
    chip_seller: 'Seller',
    chip_layout: 'Layout',
    f_filename_pattern: 'Filename pattern',
    footer_main: 'Format: ZUGFeRD 2.3 / Factur-X 1.0 · Profile: EN 16931 (Comfort) · Compliant with German e-invoicing law (§14 UStG, in force since 2025). XML follows EN 16931 BT numbering. Validate e.g. with Quba Viewer, Mustang, or ELSTER E-Rechnungsviewer.',
    footer_disclaimer: 'No warranty. Validate before production use. See Help for details.',
    footer_backup: 'Backup:',
    msg_seller_saved: 'Seller details saved.',
    msg_save_failed: 'Saving failed.',
    msg_reset: 'Reset.',
    msg_buyer_saved: 'saved as new customer.',
    msg_buyer_updated: 'updated.',
    msg_buyer_no_name: 'Please enter the customer name first.',
    msg_buyer_unnamed: '(unnamed)',
    msg_buyer_no_select: 'No saved customer selected.',
    msg_buyer_confirm_delete: 'really delete?',
    msg_deleted: 'Deleted.',
    msg_footnote_no_text: 'Type a footnote in the field first, then save.',
    msg_footnote_overwrite: 'overwrite with current text?',
    msg_footnote_name_prompt: 'Name for this footnote (e.g. "Overtime Standard"):',
    msg_footnote_no_select: 'No footnote selected.',
    msg_pattern_saved: 'Pattern saved:',
    msg_filename_saved: 'Filename pattern saved.',
    msg_pdf_select_first: 'Please select a PDF first.',
    msg_pdf_done: 'Invoice created:',
    msg_pdf_done_2: 'Contains EN 16931 compliant XML data.\nTip: validate with Quba Viewer or ELSTER E-Rechnungsviewer.',
    msg_xml_done: 'XML downloaded.',
    msg_xml_valid: 'XML built successfully. All EN 16931 mandatory fields included.\nFor full syntax validation use Quba Viewer or ELSTER E-Rechnungsviewer.',
    msg_xml_warnings: 'Notes:',
    msg_error: 'Error:',
    msg_backup_export: 'Backup exported:',
    msg_backup_seller: 'seller profile',
    msg_backup_buyers: 'customer(s)',
    msg_backup_footnotes: 'footnote(s)',
    msg_backup_import_done: 'Backup imported:',
    msg_backup_import_confirm: 'Import backup?\n\nContains: {seller} seller profile, {buyers} customer(s), {footnotes} footnote(s).\n\nWarning: existing saved data will be overwritten.',
    msg_backup_invalid: 'File is not an e-invoice backup.',
    msg_backup_failed: 'Import failed:',
    pdf_billed_to: 'BILLED TO',
    pdf_from: 'FROM',
    pdf_no: 'NO.',
    pdf_date: 'DATE',
    pdf_service: 'SERVICE',
    pdf_price: 'Price',
    pdf_amount: 'Amount',
    pdf_total: 'Total',
    pdf_sum: 'Sum',
    pdf_grand_total: 'Total',
    pdf_vat_S: 'VAT: Standard rate',
    pdf_vat_AE: 'VAT: Reverse Charge Procedure',
    pdf_vat_Z: 'VAT: Zero-rated',
    pdf_vat_E: 'VAT: Exempt',
    pdf_vat_O: 'VAT: Out of scope',
    pdf_vat_label: 'VAT:',
    pdf_due_short: 'DUE',
    pdf_payment: 'PAYMENT',
    pdf_invoice_label: 'INVOICE',
    pdf_vat_id_label: 'VAT No.',
    rc_note: 'Reverse charge: recipient liable for VAT under Art. 196 of Council Directive 2006/112/EC.',
    rc_note_Z: 'VAT 0%.',
    rc_note_E: 'VAT exempt.',
    rc_note_O: 'Out of scope of VAT.',
    // --- Errors / labels / XML output strings (added by review) ---
    xml_sepa_info: 'SEPA credit transfer',
    xml_payable_by: 'Payable by {date}',
    err_no_number: 'Invoice number is missing.',
    err_no_date: 'Invoice date is missing.',
    err_no_seller_name: 'Seller name is missing.',
    err_no_buyer_name: 'Buyer name is missing.',
    err_no_items: 'At least one line item is required.',
    err_country_required: 'Country is required (use ISO code like DE, FR, GB).',
    err_country_unknown: 'Unknown country: "{input}". Use ISO 3166-1 alpha-2 (e.g. DE, FR, GB).',
    err_rc_seller_vat: 'Reverse charge requires a Seller VAT ID (or legal registration / tax representative).',
    err_rc_buyer_vat: 'Reverse charge requires a Buyer VAT ID (or legal registration ID).',
    th_desc: 'Description',
    th_qty: 'Qty',
    th_price: 'Unit price',
    th_vat: 'VAT %',
    aria_remove_item: 'Remove item',
    // --- History feature ---
    section_history: 'History',
    section_history_hint: 'Generated invoices are saved here automatically · Clone loads all fields into the form',
    history_enable_label: 'Save invoices to history',
    option_history_select: 'Select history entry…',
    btn_history_clone: 'Clone',
    btn_history_delete: 'Delete entry',
    btn_history_clear_all: 'Delete all',
    history_clear_confirm: 'Really delete all {count} history entries?',
    history_empty: 'No invoices in history yet',
    msg_history_saved: 'Saved to history.',
    msg_history_cloned: 'Cloned from history.',
    msg_history_deleted: 'Entry deleted.',
    msg_history_no_select: 'No history entry selected.',
    msg_history_cleared: 'History cleared.',
    // --- Past invoice entry ---
    btn_history_add_past: 'Add past invoice',
    past_modal_title: 'Add past invoice',
    past_modal_hint: 'Manually entered invoices appear in history and statistics. Cloning works partially since only basic fields are captured.',
    past_field_date: 'Invoice date',
    past_field_buyer: 'Buyer',
    past_field_buyer_select: 'Pick from customers…',
    past_field_buyer_new: 'Or enter a new name',
    past_field_total: 'Total (gross)',
    past_field_currency: 'Currency',
    past_field_taxmode: 'Tax mode',
    past_field_vat_rate: 'VAT rate (%)',
    past_field_number: 'Invoice no. (optional)',
    past_field_project: 'Project (optional)',
    past_field_category: 'Category (optional)',
    past_save: 'Add',
    past_cancel: 'Cancel',
    past_err_no_buyer: 'Buyer name is missing.',
    past_err_no_total: 'Total must be a positive number.',
    past_err_no_date: 'Invoice date is missing.',
    msg_history_added: 'Saved to history.',
    msg_history_clone_partial: 'Cloned with partial data (manual entry).',
    history_imported_marker: 'manual',
    // --- Statistics + buyer history hint ---
    btn_open_stats: 'Statistics',
    stats_title: 'Statistics',
    stats_close: 'Close',
    stats_period_label: 'Period',
    stats_period_last_month: 'Last 30 days',
    stats_period_last3: 'Last 3 months',
    stats_period_last6: 'Last 6 months',
    stats_period_ytd: 'This year',
    stats_period_last12: 'Last 12 months',
    stats_period_all: 'All time',
    // --- Stats: tax breakdown ---
    stats_tab_overview: 'Overview',
    stats_tab_quarters: 'Tax breakdown',
    stats_year_label: 'Year',
    stats_empty_year: 'No invoices in this year.',
    qb_quarter: 'Quarter',
    qb_q1: 'Q1 (Jan–Mar)',
    qb_q2: 'Q2 (Apr–Jun)',
    qb_q3: 'Q3 (Jul–Sep)',
    qb_q4: 'Q4 (Oct–Dec)',
    qb_year_total: 'Year total',
    qb_standard_net: 'Standard net',
    qb_standard_vat: 'Standard VAT',
    qb_reverse_charge: 'Reverse charge net',
    qb_zero_rate: 'Zero rate net',
    qb_exempt: 'Exempt net',
    qb_out_of_scope: 'Out of scope net',
    // --- Stats: buyer drill-down ---
    stats_back: 'Back',
    stats_buyer_first: 'First invoice',
    stats_buyer_last: 'Last invoice',
    stats_buyer_col_date: 'Date',
    stats_buyer_col_number: 'Number',
    stats_buyer_col_total: 'Total',
    // --- Stats: CSV export ---
    btn_export_csv: 'Export CSV',
    msg_csv_exported: 'CSV exported.',
    msg_csv_no_data: 'No data to export.',
    // --- Stats: YoY arrows + backfill ---
    btn_yoy_toggle: 'Year-over-year',
    yoy_set_reference: 'Set previous year reference',
    yoy_hint_no_data: 'Previous year values missing for comparison.',
    yoy_hint_no_period: 'Year-over-year not available for this period.',
    yoy_modal_title: 'Set previous year reference',
    yoy_modal_intro: 'Monthly gross totals from a previous year, used as the comparison baseline. Real invoices from history take precedence.',
    yoy_field_year: 'Year',
    yoy_field_currency: 'Currency',
    yoy_month_jan: 'January',
    yoy_month_feb: 'February',
    yoy_month_mar: 'March',
    yoy_month_apr: 'April',
    yoy_month_may: 'May',
    yoy_month_jun: 'June',
    yoy_month_jul: 'July',
    yoy_month_aug: 'August',
    yoy_month_sep: 'September',
    yoy_month_oct: 'October',
    yoy_month_nov: 'November',
    yoy_month_dec: 'December',
    yoy_save: 'Save',
    yoy_cancel: 'Cancel',
    msg_yoy_saved: 'Previous year values saved.',
    msg_yoy_cleared: 'Previous year values cleared.',
    msg_yoy_invalid_year: 'Invalid year.',
    msg_yoy_invalid_value: 'Negative values are not allowed.',
    // --- UI restructure: top-bar icons, help/embed modals, past-invoice extras ---
    btn_open_history: 'History',
    btn_open_help: 'Help',
    help_title: 'Help & documentation',
    embed_title: 'Embed XML in existing PDF',
    embed_intro: 'Upload an existing PDF (e.g. exported from InDesign). The current invoice data will be embedded as XML, turning the PDF into a compliant e-invoice.',
    btn_embed_xml: 'Embed XML...',
    btn_embed_run: 'Create PDF',
    btn_embed_progress: 'Creating...',
    msg_embed_done: 'PDF with embedded XML created.',
    msg_embed_failed: 'Embed failed:',
    btn_history_add_past: 'Add past invoice',
    past_field_buyer_select: 'Existing customer',
    past_field_vat_rate: 'VAT rate (%)',
    past_field_project: 'Project',
    past_field_category: 'Category',
    past_err_no_date: 'Date is missing.',
    past_err_no_buyer: 'Buyer is missing.',
    past_err_no_total: 'Gross total is missing or invalid.',
    stats_empty: 'No invoices in history yet — statistics appear once you generate some.',
    stats_empty_period: 'No invoices in this period.',
    stats_kpi_total: 'Total (gross)',
    stats_kpi_net: 'Net',
    stats_kpi_tax: 'VAT',
    stats_kpi_avg: 'Avg per invoice',
    stats_top_buyers: 'Top buyers',
    stats_last_12_months: 'Last 12 months',
    stats_invoice: 'invoice',
    stats_invoices: 'invoices',
    buyer_history_hint_today: 'Last invoice to this buyer: today · {number} · {total}',
    buyer_history_hint_one_day: 'Last invoice to this buyer: yesterday · {number} · {total}',
    buyer_history_hint_n_days: 'Last invoice to this buyer: {days} days ago · {number} · {total}',
    buyer_history_hint_no_date: 'Last invoice to this buyer: {number} · {total}',
  },
  fr: {
    title: 'Générateur de factures',
    subtitle: 'ZUGFeRD 2.3 · Factur-X · EN 16931 (Comfort)',
    theme_auto: 'Auto (système)',
    theme_light: 'Clair (manuel)',
    theme_dark: 'Sombre (manuel)',
    intro_main: 'Génère des factures conformes à ZUGFeRD / Factur-X. Fonctionne entièrement hors ligne, toutes les données restent localement dans le navigateur, rien n\'est envoyé.',
    intro_alt: 'Vous pouvez aussi téléverser un PDF déjà mis en page (par ex. depuis InDesign), l\'outil intègre le XML dans ce PDF. Pour une conformité complète, exportez depuis InDesign en PDF/A-3 (Fichier → Exporter → Adobe PDF, sélectionner Standard PDF/A-3:2012).',
    section_seller: 'Vendeur',
    section_seller_hint: 'Vos coordonnées · les textes par défaut (intro, mention de paiement, salutation, note) sont enregistrés par langue de facture',
    section_buyer: 'Acheteur',
    section_buyer_hint: 'Destinataire de la facture',
    section_invoice: 'Facture',
    section_invoice_hint: 'Données d\'en-tête',
    section_items: 'Lignes',
    section_items_hint: 'Prestations et produits',
    section_output: 'Export',
    section_output_hint: 'Choisir la source PDF',
    section_filename: 'Nom de fichier',
    section_filename_hint: 'Cliquez sur les blocs pour les insérer · le modèle est enregistré',
    btn_save_template: 'enregistrer comme modèle',
    btn_reset: 'réinitialiser',
    btn_save_buyer: 'enregistrer le client',
    btn_delete_selected: 'supprimer la sélection',
    btn_save_footnote: 'enregistrer la note actuelle',
    btn_delete_footnote: 'supprimer la sélection',
    btn_save_pattern: 'enregistrer le modèle',
    btn_save_filename: 'enregistrer le modèle',
    btn_add_item: '+ Ajouter une ligne',
    btn_create_pdf: 'Créer la PDF',
    btn_create_pdf_progress: 'Création…',
    btn_xml_only: 'Télécharger le XML',
    btn_validate: 'Vérifier le XML',
    btn_export_data: 'Exporter les données',
    btn_import_data: 'Importer les données',
    btn_clear: 'effacer',
    mode_generate: 'Générer la PDF',
    mode_upload: 'Depuis un PDF InDesign',
    mode_generate_hint: 'L\'outil génère une PDF A4 propre à partir de vos données et y intègre le XML EN 16931.',
    drop_pdf: 'Déposez la PDF ici ou cliquez pour la sélectionner',
    f_company: 'Société / Nom',
    f_address: 'Adresse',
    f_zip: 'Code postal',
    f_city: 'Ville',
    f_country: 'Pays (ISO)',
    f_country_de: 'Pays (ISO, ex. FR)',
    f_vat: 'N° TVA',
    f_vat_de: 'N° TVA (ex. FR12345678901)',
    f_vat_b2b: 'N° TVA (B2B)',
    f_siret: 'SIREN / SIRET (FR, optionnel)',
    f_siret_placeholder: '9 ou 14 chiffres',
    f_email: 'E-mail',
    f_phone: 'Téléphone (optionnel)',
    f_iban: 'IBAN',
    f_bic: 'BIC (optionnel)',
    f_bank: 'Nom de la banque (optionnel)',
    f_buyer_picker: 'Nouveau client / vider le formulaire',
    f_buyer_reference: 'Référence acheteur / Leitweg-ID (BT-10, optionnel)',
    f_buyer_reference_hint: 'Obligatoire pour les administrations allemandes (Leitweg-ID). Habituellement optionnel pour les clients privés.',
    f_number: 'N° de facture',
    f_number_pattern_summary: 'Modifier le modèle',
    f_number_pattern_hint: 'Counter est un compteur continu qui augmente de 1 après chaque facture, indépendamment de l\'année.',
    chip_next_number: '↻ N° suivant',
    chip_year4: 'Année (4)',
    chip_year2: 'Année (2)',
    chip_month: 'Mois',
    chip_day: 'Jour',
    chip_counter: 'Compteur',
    chip_counter3: 'Compteur (3 chiffres)',
    chip_counter5: 'Compteur (5 chiffres)',
    f_date: 'Date de facture',
    f_delivery: 'Date de prestation',
    f_delivery_end: 'Date de fin (optionnelle)',
    f_due: 'Échéance',
    chip_days: 'jours',
    f_currency: 'Devise',
    f_taxmode: 'Régime TVA',
    f_invoice_lang: 'Langue de la facture',
    f_invoice_lang_hint: 'Langue utilisée dans la PDF/XML générée, indépendante de la langue de l\'interface',
    f_invoice_font: 'Police de la facture',
    f_invoice_font_hint: 'Toutes les polices sont intégrées et fonctionnent hors ligne',
    f_invoice_layout: 'Mise en page',
    f_invoice_layout_hint: 'Disposition visuelle de la facture',
    invoice_lang_auto: 'comme l\'interface',
    tax_S: 'Standard (TVA appliquée)',
    tax_AE: 'Autoliquidation (B2B intra-UE)',
    tax_Z: 'Taux zéro (0%)',
    tax_E: 'Exonéré',
    tax_O: 'Hors champ',
    f_project: 'Titre / référence du projet',
    f_project_placeholder: 'ex. Campagne SS26 | Marque',
    f_category: 'Catégorie de prestation (en gras au-dessus du tableau)',
    f_category_placeholder: 'ex. Photographie',
    f_intro: 'Texte d\'intro',
    f_intro_placeholder: 'ex. Comme convenu, je vous facture les prestations suivantes :',
    f_payment_note: 'Mention de paiement (la balise {due} est remplacée par la date d\'échéance)',
    f_payment_note_placeholder: 'ex. Paiement attendu pour le {due} par virement sur le compte indiqué en bas.',
    f_greeting: 'Formule de politesse',
    f_greeting_placeholder: 'ex. Cordialement,',
    f_signature: 'Signature',
    f_signature_placeholder: 'reprise du nom du vendeur si vide',
    f_note: 'Note supplémentaire (optionnelle, apparaît dans le XML)',
    f_footnote: 'Note / mention sur la PDF (optionnelle)',
    f_footnote_placeholder: 'ex. explication d\'une ligne ou d\'un supplément',
    f_footnote_hint: 'Apparaît en italique sous la ligne TVA sur la PDF.',
    f_footnote_picker: 'Sélectionner une note enregistrée',
    th_desc: 'Description',
    th_qty: 'Qté',
    th_price: 'Prix unitaire',
    th_vat_pct: 'TVA %',
    item_placeholder: 'Prestation…',
    total_net: 'Sous-total (net)',
    total_tax_S: 'TVA',
    total_tax_AE: 'Autoliquidation (0%)',
    total_tax_Z: 'Taux zéro (0%)',
    total_tax_E: 'Exonéré',
    total_tax_O: 'Hors champ',
    total_grand: 'Total',
    chip_nr: 'N°',
    chip_project: 'Projet',
    chip_buyer: 'Client',
    chip_date: 'Date',
    chip_category: 'Catégorie',
    chip_seller: 'Vendeur',
    chip_layout: 'Mise en page',
    f_filename_pattern: 'Modèle de nom de fichier',
    footer_main: 'Format : ZUGFeRD 2.3 / Factur-X 1.0 · Profil : EN 16931 (Comfort) · Conforme à la loi allemande sur la facture électronique (§14 UStG, en vigueur depuis 2025). XML suivant la numérotation BT de la EN 16931. Validation possible avec Quba Viewer, Mustang ou ELSTER E-Rechnungsviewer.',
    footer_disclaimer: 'Aucune garantie. Validez avant utilisation en production. Voir Aide.',
    footer_backup: 'Sauvegarde :',
    msg_seller_saved: 'Coordonnées vendeur enregistrées.',
    msg_save_failed: 'Échec de l\'enregistrement.',
    msg_reset: 'Réinitialisé.',
    msg_buyer_saved: 'enregistré comme nouveau client.',
    msg_buyer_updated: 'mis à jour.',
    msg_buyer_no_name: 'Veuillez d\'abord saisir le nom du client.',
    msg_buyer_unnamed: '(sans nom)',
    msg_buyer_no_select: 'Aucun client enregistré sélectionné.',
    msg_buyer_confirm_delete: 'vraiment supprimer ?',
    msg_deleted: 'Supprimé.',
    msg_footnote_no_text: 'Saisissez d\'abord une note dans le champ, puis enregistrez.',
    msg_footnote_overwrite: 'écraser avec le texte actuel ?',
    msg_footnote_name_prompt: 'Nom de la note (ex. « Overtime Standard ») :',
    msg_footnote_no_select: 'Aucune note sélectionnée.',
    msg_pattern_saved: 'Modèle enregistré :',
    msg_filename_saved: 'Modèle de nom de fichier enregistré.',
    msg_pdf_select_first: 'Veuillez d\'abord sélectionner une PDF.',
    msg_pdf_done: 'Facture créée :',
    msg_pdf_done_2: 'Contient les données XML conformes à la EN 16931.\nAstuce : valider avec Quba Viewer ou ELSTER E-Rechnungsviewer.',
    msg_xml_done: 'XML téléchargé.',
    msg_xml_valid: 'XML construit correctement. Tous les champs obligatoires EN 16931 sont présents.\nPour une validation syntaxique complète : Quba Viewer ou ELSTER E-Rechnungsviewer.',
    msg_xml_warnings: 'Remarques :',
    msg_error: 'Erreur :',
    msg_backup_export: 'Sauvegarde exportée :',
    msg_backup_seller: 'profil vendeur',
    msg_backup_buyers: 'client(s)',
    msg_backup_footnotes: 'note(s)',
    msg_backup_import_done: 'Sauvegarde importée :',
    msg_backup_import_confirm: 'Importer la sauvegarde ?\n\nContient : {seller} profil vendeur, {buyers} client(s), {footnotes} note(s).\n\nAttention : les données existantes seront écrasées.',
    msg_backup_invalid: 'Le fichier n\'est pas une sauvegarde de l\'outil.',
    msg_backup_failed: 'Échec de l\'import :',
    pdf_billed_to: 'FACTURÉ À',
    pdf_from: 'DE',
    pdf_no: 'N°',
    pdf_date: 'DATE',
    pdf_service: 'PRESTATION',
    pdf_price: 'Prix',
    pdf_amount: 'Qté',
    pdf_total: 'Total',
    pdf_sum: 'Sous-total',
    pdf_grand_total: 'Total',
    pdf_vat_S: 'TVA : Taux standard',
    pdf_vat_AE: 'TVA : Autoliquidation',
    pdf_vat_Z: 'TVA : Taux zéro',
    pdf_vat_E: 'TVA : Exonérée',
    pdf_vat_O: 'TVA : Hors champ',
    pdf_vat_label: 'TVA :',
    pdf_due_short: 'ÉCHÉANCE',
    pdf_payment: 'PAIEMENT',
    pdf_invoice_label: 'FACTURE',
    pdf_vat_id_label: 'N° TVA',
    rc_note: 'Autoliquidation : TVA due par le preneur conformément à l\'art. 196 de la directive 2006/112/CE.',
    rc_note_Z: 'TVA 0%.',
    rc_note_E: 'Exonéré de TVA.',
    rc_note_O: 'Hors champ d\'application de la TVA.',
    // --- Errors / labels / XML output strings (added by review) ---
    xml_sepa_info: 'Virement SEPA',
    xml_payable_by: 'À régler avant le {date}',
    err_no_number: 'Numéro de facture manquant.',
    err_no_date: 'Date de facture manquante.',
    err_no_seller_name: 'Nom du vendeur manquant.',
    err_no_buyer_name: 'Nom de l\'acheteur manquant.',
    err_no_items: 'Au moins une ligne est requise.',
    err_country_required: 'Pays requis (utilisez un code ISO tel que DE, FR, GB).',
    err_country_unknown: 'Pays inconnu : « {input} ». Utilisez ISO 3166-1 alpha-2 (ex. DE, FR, GB).',
    err_rc_seller_vat: 'Autoliquidation : le vendeur doit avoir un numéro de TVA (ou immatriculation légale / représentant fiscal).',
    err_rc_buyer_vat: 'Autoliquidation : l\'acheteur doit avoir un numéro de TVA (ou immatriculation légale).',
    th_desc: 'Description',
    th_qty: 'Qté',
    th_price: 'Prix unitaire',
    th_vat: 'TVA %',
    aria_remove_item: 'Supprimer la ligne',
    // --- History feature ---
    section_history: 'Historique',
    section_history_hint: 'Les factures générées sont enregistrées ici automatiquement · Cloner charge tous les champs dans le formulaire',
    history_enable_label: 'Enregistrer les factures dans l\'historique',
    option_history_select: 'Choisir une entrée…',
    btn_history_clone: 'Cloner',
    btn_history_delete: 'Supprimer l\'entrée',
    btn_history_clear_all: 'Supprimer tout',
    history_clear_confirm: 'Supprimer vraiment les {count} entrées de l\'historique ?',
    history_empty: 'Aucune facture dans l\'historique',
    msg_history_saved: 'Enregistré dans l\'historique.',
    msg_history_cloned: 'Cloné depuis l\'historique.',
    msg_history_deleted: 'Entrée supprimée.',
    msg_history_no_select: 'Aucune entrée de l\'historique sélectionnée.',
    msg_history_cleared: 'Historique effacé.',
    // --- Past invoice entry ---
    btn_history_add_past: 'Ajouter ancienne facture',
    past_modal_title: 'Ajouter ancienne facture',
    past_modal_hint: 'Les factures saisies manuellement apparaissent dans l\'historique et les statistiques. Le clonage fonctionne partiellement car seuls les champs de base sont saisis.',
    past_field_date: 'Date de facture',
    past_field_buyer: 'Acheteur',
    past_field_buyer_select: 'Choisir parmi les clients…',
    past_field_buyer_new: 'Ou saisir un nouveau nom',
    past_field_total: 'Total (TTC)',
    past_field_currency: 'Devise',
    past_field_taxmode: 'Mode de TVA',
    past_field_vat_rate: 'Taux de TVA (%)',
    past_field_number: 'N° de facture (facultatif)',
    past_field_project: 'Projet (facultatif)',
    past_field_category: 'Catégorie (facultatif)',
    past_save: 'Ajouter',
    past_cancel: 'Annuler',
    past_err_no_buyer: 'Nom de l\'acheteur manquant.',
    past_err_no_total: 'Le total doit être un nombre positif.',
    past_err_no_date: 'Date de facture manquante.',
    msg_history_added: 'Enregistré dans l\'historique.',
    msg_history_clone_partial: 'Cloné avec données partielles (saisie manuelle).',
    history_imported_marker: 'manuel',
    // --- Statistics + buyer history hint ---
    btn_open_stats: 'Statistiques',
    stats_title: 'Statistiques',
    stats_close: 'Fermer',
    stats_period_label: 'Période',
    stats_period_last_month: '30 derniers jours',
    stats_period_last3: '3 derniers mois',
    stats_period_last6: '6 derniers mois',
    stats_period_ytd: 'Cette année',
    stats_period_last12: '12 derniers mois',
    stats_period_all: 'Tout',
    // --- Stats: tax breakdown ---
    stats_tab_overview: 'Vue d\'ensemble',
    stats_tab_quarters: 'Ventilation TVA',
    stats_year_label: 'Année',
    stats_empty_year: 'Aucune facture dans cette année.',
    qb_quarter: 'Trimestre',
    qb_q1: 'T1 (jan–mars)',
    qb_q2: 'T2 (avr–juin)',
    qb_q3: 'T3 (juil–sept)',
    qb_q4: 'T4 (oct–déc)',
    qb_year_total: 'Total annuel',
    qb_standard_net: 'TVA standard net',
    qb_standard_vat: 'TVA standard',
    qb_reverse_charge: 'Autoliquidation net',
    qb_zero_rate: 'Taux 0% net',
    qb_exempt: 'Exonéré net',
    qb_out_of_scope: 'Hors champ net',
    // --- Stats: buyer drill-down ---
    stats_back: 'Retour',
    stats_buyer_first: 'Première facture',
    stats_buyer_last: 'Dernière facture',
    stats_buyer_col_date: 'Date',
    stats_buyer_col_number: 'Numéro',
    stats_buyer_col_total: 'Total',
    // --- Stats: CSV export ---
    btn_export_csv: 'Exporter CSV',
    msg_csv_exported: 'CSV exporté.',
    msg_csv_no_data: 'Aucune donnée à exporter.',
    // --- Stats: YoY arrows + backfill ---
    btn_yoy_toggle: 'Année précédente',
    yoy_set_reference: 'Saisir les valeurs de l\'année précédente',
    yoy_hint_no_data: 'Valeurs de l\'année précédente manquantes.',
    yoy_hint_no_period: 'Comparaison annuelle indisponible pour cette période.',
    yoy_modal_title: 'Valeurs de l\'année précédente',
    yoy_modal_intro: 'Totaux mensuels bruts d\'une année précédente, utilisés comme référence. Les factures réelles ont la priorité.',
    yoy_field_year: 'Année',
    yoy_field_currency: 'Devise',
    yoy_month_jan: 'Janvier',
    yoy_month_feb: 'Février',
    yoy_month_mar: 'Mars',
    yoy_month_apr: 'Avril',
    yoy_month_may: 'Mai',
    yoy_month_jun: 'Juin',
    yoy_month_jul: 'Juillet',
    yoy_month_aug: 'Août',
    yoy_month_sep: 'Septembre',
    yoy_month_oct: 'Octobre',
    yoy_month_nov: 'Novembre',
    yoy_month_dec: 'Décembre',
    yoy_save: 'Enregistrer',
    yoy_cancel: 'Annuler',
    msg_yoy_saved: 'Valeurs enregistrées.',
    msg_yoy_cleared: 'Valeurs supprimées.',
    msg_yoy_invalid_year: 'Année invalide.',
    msg_yoy_invalid_value: 'Les valeurs négatives ne sont pas autorisées.',
    // --- UI restructure: top-bar icons, help/embed modals, past-invoice extras ---
    btn_open_history: 'Historique',
    btn_open_help: 'Aide',
    help_title: 'Aide et documentation',
    embed_title: 'Intégrer XML dans un PDF existant',
    embed_intro: 'Téléversez un PDF existant (ex: exporté d\'InDesign). Les données XML de la facture actuelle seront intégrées, transformant le PDF en facture électronique conforme.',
    btn_embed_xml: 'Intégrer XML...',
    btn_embed_run: 'Créer le PDF',
    btn_embed_progress: 'Création...',
    msg_embed_done: 'PDF avec XML intégré créé.',
    msg_embed_failed: 'Échec de l\'intégration:',
    btn_history_add_past: 'Ajouter une facture passée',
    past_field_buyer_select: 'Client existant',
    past_field_vat_rate: 'Taux de TVA (%)',
    past_field_project: 'Projet',
    past_field_category: 'Catégorie',
    past_err_no_date: 'Date manquante.',
    past_err_no_buyer: 'Acheteur manquant.',
    past_err_no_total: 'Total brut manquant ou invalide.',
    stats_empty: 'Aucune facture dans l\'historique — les statistiques apparaîtront dès que vous en générerez.',
    stats_empty_period: 'Aucune facture dans cette période.',
    stats_kpi_total: 'Total (TTC)',
    stats_kpi_net: 'Net',
    stats_kpi_tax: 'TVA',
    stats_kpi_avg: 'Moy. par facture',
    stats_top_buyers: 'Meilleurs clients',
    stats_last_12_months: '12 derniers mois',
    stats_invoice: 'facture',
    stats_invoices: 'factures',
    buyer_history_hint_today: 'Dernière facture pour ce client : aujourd\'hui · {number} · {total}',
    buyer_history_hint_one_day: 'Dernière facture pour ce client : hier · {number} · {total}',
    buyer_history_hint_n_days: 'Dernière facture pour ce client : il y a {days} jours · {number} · {total}',
    buyer_history_hint_no_date: 'Dernière facture pour ce client : {number} · {total}',
  },
};

const LANG_KEY = 'erechnung:lang';
const INVOICE_LANG_KEY = 'erechnung:invoice_lang';
const THEME_KEY = 'erechnung:theme';
let CURRENT_LANG = 'en';     // UI language
let INVOICE_LANG = null;     // invoice output language; null = follow UI

function detectLang() {
  const saved = localStorage.getItem(LANG_KEY);
  if (saved && I18N[saved]) return saved;
  const nav = (navigator.language || 'de').slice(0, 2);
  return I18N[nav] ? nav : 'en';
}

function detectInvoiceLang() {
  const saved = localStorage.getItem(INVOICE_LANG_KEY);
  if (saved && I18N[saved]) return saved;
  return null; // null = follow UI
}

// Returns the language currently effective for invoice output.
function effectiveInvoiceLang() {
  return INVOICE_LANG || CURRENT_LANG;
}

// Translation helper for the UI.
function t(key, vars) {
  let s = (I18N[CURRENT_LANG] && I18N[CURRENT_LANG][key]) || I18N.en[key] || key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
  return s;
}

// Translation helper for invoice content (PDF labels, XML notes).
// Uses the invoice-output language so a user can keep the UI in their
// native language while emitting an invoice in a different language.
function tInvoice(key, vars) {
  const lang = effectiveInvoiceLang();
  let s = (I18N[lang] && I18N[lang][key]) || I18N.en[key] || key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
  return s;
}

function applyTranslations() {
  // text content
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    el.textContent = t(key);
  });
  // placeholders
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
  });
  // titles (for accessibility)
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
  });
  // <title>
  const titleEl = document.querySelector('title');
  if (titleEl) titleEl.textContent = t('title');
  document.documentElement.lang = CURRENT_LANG;
  // re-render dynamic UI (totals labels depend on tax mode + lang)
  if (typeof calcTotals === 'function') calcTotals();
  if (typeof renderBuyerPicker === 'function') renderBuyerPicker();
  if (typeof renderFootnotePicker === 'function') renderFootnotePicker();
  if (typeof renderHistoryPicker === 'function') renderHistoryPicker();
  if (typeof updateBuyerHistoryHint === 'function') updateBuyerHistoryHint();
  if (typeof renderItems === 'function') renderItems();
  if (typeof updateFilenamePreview === 'function') updateFilenamePreview();
  // re-apply theme so its title gets re-translated
  if (typeof applyTheme === 'function') applyTheme(localStorage.getItem(THEME_KEY));
  if (typeof updateSuggestNumberChipPreview === 'function') updateSuggestNumberChipPreview();
}

function setLang(lang) {
  if (!I18N[lang]) lang = 'en';
  CURRENT_LANG = lang;
  localStorage.setItem(LANG_KEY, lang);
  applyTranslations();
  // Boilerplate follows the invoice-output language, which by default
  // tracks the UI; only reload it here if the invoice lang follows UI.
  if (!INVOICE_LANG && typeof loadBoilerplateForLang === 'function') {
    loadBoilerplateForLang(lang);
  }
}

function setInvoiceLang(lang) {
  // null/empty/'auto' means: follow the UI language
  if (lang && I18N[lang]) {
    INVOICE_LANG = lang;
    localStorage.setItem(INVOICE_LANG_KEY, lang);
  } else {
    INVOICE_LANG = null;
    localStorage.removeItem(INVOICE_LANG_KEY);
  }
  // Re-load boilerplate for the now-effective invoice language
  if (typeof loadBoilerplateForLang === 'function') {
    loadBoilerplateForLang(effectiveInvoiceLang());
  }
}

CURRENT_LANG = detectLang();
INVOICE_LANG = detectInvoiceLang();

// -------- Storage helpers (localStorage primary, Anthropic window.storage as fallback) --------
// Used for application data (seller profile, buyers, footnotes, settings).
//
// Note: theme and language preferences (THEME_KEY, LANG_KEY, INVOICE_LANG_KEY)
// are read directly with `localStorage.getItem(...)` at init time. They need a
// synchronous answer before the first render to avoid a flash of the wrong
// theme/language; `store.get` is async because of the window.storage fallback.
const store = {
  async get(key) {
    try {
      const v = localStorage.getItem(key);
      if (v !== null) return v;
    } catch (_) {}
    if (typeof window !== 'undefined' && window.storage && window.storage.get) {
      try { const r = await window.storage.get(key); return r ? r.value : null; } catch (_) {}
    }
    return null;
  },
  async set(key, value) {
    try { localStorage.setItem(key, value); return true; } catch (_) {}
    if (typeof window !== 'undefined' && window.storage && window.storage.set) {
      try { await window.storage.set(key, value); return true; } catch (_) {}
    }
    return false;
  },
  async del(key) {
    try { localStorage.removeItem(key); } catch (_) {}
    if (typeof window !== 'undefined' && window.storage && window.storage.delete) {
      try { await window.storage.delete(key); } catch (_) {}
    }
  },
};

// -------- Seller profile (persisted) --------
async function loadSeller() {
  try {
    const v = await store.get(STORAGE_KEY);
    if (v) applySellerStammdaten(JSON.parse(v));
  } catch (e) { /* ignore */ }
  // Load boilerplate for currently effective invoice language
  await loadBoilerplateForLang(effectiveInvoiceLang());
}
async function saveSeller() {
  // Stammdaten go into one bucket, boilerplate goes into a per-language bucket.
  const stammdaten = collectSellerStammdaten();
  const boilerplate = collectBoilerplate();
  const ok1 = await store.set(STORAGE_KEY, JSON.stringify(stammdaten));
  // Read existing boilerplate map, merge in current language
  let bMap = {};
  try {
    const raw = await store.get(BOILERPLATE_KEY);
    if (raw) bMap = JSON.parse(raw) || {};
  } catch (_) {}
  bMap[effectiveInvoiceLang()] = boilerplate;
  const ok2 = await store.set(BOILERPLATE_KEY, JSON.stringify(bMap));
  if (ok1 && ok2) {
    flash(t('msg_seller_saved'), 'ok');
    // Auto-collapse after a successful save when the seller has data.
    // Refresh the summary first so the collapsed view shows current values.
    if (isSellerConfigured()) {
      await setSellerCollapsed(true);
    }
  } else {
    flash(t('msg_save_failed'), 'err');
  }
}
async function clearSeller() {
  await store.del(STORAGE_KEY);
  await store.del(BOILERPLATE_KEY);
  ['s_name','s_line1','s_zip','s_city','s_country','s_vat','s_siret','s_email','s_phone','s_iban','s_bic','s_bank',
   'r_intro','r_payment_note','r_greeting','r_signature','r_footnote']
    .forEach(id => $(id).value = id === 's_country' ? 'DE' : '');
  // After clearing, the seller is empty — force expanded so the user can re-enter
  await setSellerCollapsed(false);
  flash(t('msg_reset'), 'ok');
}
function collectSellerStammdaten() {
  return {
    name: $('s_name').value.trim(),
    line1: $('s_line1').value.trim(),
    zip: $('s_zip').value.trim(),
    city: $('s_city').value.trim(),
    country: $('s_country').value.trim().toUpperCase(),
    vat: $('s_vat').value.trim(),
    siret: $('s_siret').value.trim(),
    email: $('s_email').value.trim(),
    phone: $('s_phone').value.trim(),
    iban: $('s_iban').value.replace(/\s/g, ''),
    bic: $('s_bic').value.trim(),
    bank: $('s_bank').value.trim(),
  };
}
function collectBoilerplate() {
  return {
    intro: $('r_intro').value,
    payment_note: $('r_payment_note').value,
    greeting: $('r_greeting').value,
    signature: $('r_signature').value,
    footnote: $('r_footnote').value,
  };
}
// Backward-compatible: collectSeller still produces the merged object,
// used by backup-export so older versions stay readable.
function collectSeller() {
  return { ...collectSellerStammdaten(), ...collectBoilerplate() };
}
function applySellerStammdaten(s) {
  $('s_name').value = nz(s.name);
  $('s_line1').value = nz(s.line1);
  $('s_zip').value = nz(s.zip);
  $('s_city').value = nz(s.city);
  $('s_country').value = nz(s.country, 'DE');
  $('s_vat').value = nz(s.vat);
  $('s_siret').value = nz(s.siret);
  $('s_email').value = nz(s.email);
  $('s_phone').value = nz(s.phone);
  $('s_iban').value = nz(s.iban);
  $('s_bic').value = nz(s.bic);
  $('s_bank').value = nz(s.bank);
}
function applyBoilerplate(b) {
  $('r_intro').value = nz(b.intro);
  $('r_payment_note').value = nz(b.payment_note);
  $('r_greeting').value = nz(b.greeting);
  $('r_signature').value = nz(b.signature);
  $('r_footnote').value = nz(b.footnote);
}

// Per-language boilerplate
async function loadBoilerplateForLang(lang) {
  let bMap = {};
  try {
    const raw = await store.get(BOILERPLATE_KEY);
    if (raw) bMap = JSON.parse(raw) || {};
  } catch (_) {}
  if (bMap[lang]) {
    applyBoilerplate(bMap[lang]);
  } else {
    // No saved boilerplate for this language → clear the boilerplate fields
    applyBoilerplate({});
  }
}

// -------- Buyer profiles (persisted list) --------
function collectBuyer() {
  return {
    name: $('b_name').value.trim(),
    line1: $('b_line1').value.trim(),
    zip: $('b_zip').value.trim(),
    city: $('b_city').value.trim(),
    country: $('b_country').value.trim().toUpperCase(),
    vat: $('b_vat').value.trim(),
    siret: $('b_siret').value.trim(),
    reference: $('b_reference').value.trim(),
  };
}
function applyBuyer(b) {
  $('b_name').value = nz(b.name);
  $('b_line1').value = nz(b.line1);
  $('b_zip').value = nz(b.zip);
  $('b_city').value = nz(b.city);
  $('b_country').value = nz(b.country, 'FR');
  $('b_vat').value = nz(b.vat);
  $('b_siret').value = nz(b.siret);
  $('b_reference').value = nz(b.reference);
}
function clearBuyer() {
  $('b_name').value = '';
  $('b_line1').value = '';
  $('b_zip').value = '';
  $('b_city').value = '';
  $('b_country').value = 'FR';
  $('b_vat').value = '';
  $('b_siret').value = '';
  $('b_reference').value = '';
}
async function loadBuyers() {
  try {
    const v = await store.get(BUYERS_KEY);
    if (v) state.buyers = JSON.parse(v) || [];
  } catch (e) { state.buyers = []; }
  renderBuyerPicker();
}
async function persistBuyers() {
  const ok = await store.set(BUYERS_KEY, JSON.stringify(state.buyers));
  if (!ok) flash(t('msg_save_failed'), 'err');
}
function renderBuyerPicker() {
  const picker = $('buyerPicker');
  const current = picker.value;
  picker.innerHTML = `<option value="">${esc(t('f_buyer_picker'))}</option>` +
    state.buyers
      .map((b, i) => `<option value="${i}">${esc(b.name || t('msg_buyer_unnamed'))}${b.city ? ' · ' + esc(b.city) : ''}</option>`)
      .join('');
  if (current && state.buyers[current]) picker.value = current;
}
async function saveBuyer() {
  const data = collectBuyer();
  if (!data.name) { flash(t('msg_buyer_no_name'), 'err'); return; }
  const picker = $('buyerPicker');
  const idx = picker.value;
  if (idx !== '' && state.buyers[idx]) {
    state.buyers[idx] = data;
    flash(`"${data.name}" ${t('msg_buyer_updated')}`, 'ok');
  } else {
    const existing = state.buyers.findIndex(b => b.name.toLowerCase() === data.name.toLowerCase());
    if (existing >= 0) {
      state.buyers[existing] = data;
      flash(`"${data.name}" ${t('msg_buyer_updated')}`, 'ok');
      await persistBuyers();
      renderBuyerPicker();
      $('buyerPicker').value = existing;
      return;
    }
    state.buyers.push(data);
    flash(`"${data.name}" ${t('msg_buyer_saved')}`, 'ok');
  }
  await persistBuyers();
  renderBuyerPicker();
  // select the newly saved item
  const newIdx = state.buyers.findIndex(b => b.name === data.name);
  if (newIdx >= 0) $('buyerPicker').value = newIdx;
}
async function deleteBuyer() {
  const picker = $('buyerPicker');
  const idx = picker.value;
  if (idx === '' || !state.buyers[idx]) { flash(t('msg_buyer_no_select'), 'err'); return; }
  const name = state.buyers[idx].name;
  if (!confirm(`"${name}" ${t('msg_buyer_confirm_delete')}`)) return;
  state.buyers.splice(idx, 1);
  await persistBuyers();
  renderBuyerPicker();
  clearBuyer();
  flash(t('msg_deleted'), 'ok');
}

// -------- Invoice number counter --------
// Pattern uses tokens: {yyyy}, {yy}, {mm}, {dd}, {counter} or {counter:N} for zero-padding (default N=5).
// The counter is stored as a single integer that increments continuously.
// "Nächste Nr." can also continue from a manually edited number: it finds the
// rightmost numeric run in the input and increments that.
const NUMBER_PATTERN_KEY = 'erechnung:number_pattern:v1';
const DEFAULT_NUMBER_PATTERN = '{yyyy}-{counter:5}';

async function getCounterValue() {
  const stored = await store.get(COUNTER_KEY);
  if (!stored) return 0;
  // Legacy: stored could be a full invoice number like "2026-00357"
  const legacy = String(stored).match(/(\d+)\s*$/);
  if (legacy) return parseInt(legacy[1], 10);
  return parseInt(stored, 10) || 0;
}

async function setCounterValue(n) {
  await store.set(COUNTER_KEY, String(n));
}

async function getNumberPattern() {
  const v = await store.get(NUMBER_PATTERN_KEY);
  return v || DEFAULT_NUMBER_PATTERN;
}

function resolveNumberPattern(pattern, counterValue) {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const yy = yyyy.slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  let result = pattern || DEFAULT_NUMBER_PATTERN;
  result = result.replace(/\{yyyy\}/g, yyyy);
  result = result.replace(/\{yy\}/g, yy);
  result = result.replace(/\{mm\}/g, mm);
  result = result.replace(/\{dd\}/g, dd);
  // {counter} or {counter:N}
  result = result.replace(/\{counter(?::(\d+))?\}/g, (_, pad) => {
    const width = pad ? parseInt(pad, 10) : 5;
    return String(counterValue).padStart(width, '0');
  });
  return result;
}

async function suggestNextInvoiceNumber() {
  const pattern = await getNumberPattern();
  const counter = await getCounterValue();
  return resolveNumberPattern(pattern, counter + 1);
}

// Continue from whatever is currently in the field: increment the rightmost
// numeric run if any, otherwise fall back to the pattern-based suggestion.
async function applyNextInvoiceNumber() {
  const current = $('r_number').value.trim();
  if (current) {
    const m = current.match(/^(.*?)(\d+)([^\d]*)$/);
    if (m) {
      const [, prefix, num, suffix] = m;
      const next = String(parseInt(num, 10) + 1).padStart(num.length, '0');
      $('r_number').value = `${prefix}${next}${suffix}`;
      updateFilenamePreview && updateFilenamePreview();
      return;
    }
  }
  // No usable number in the field — use the pattern
  $('r_number').value = await suggestNextInvoiceNumber();
  updateFilenamePreview && updateFilenamePreview();
}

// Record after successful PDF: extract the rightmost number, store as new counter.
async function recordInvoiceNumber(num) {
  const m = String(num).match(/(\d+)\s*$/);
  if (!m) return;
  const value = parseInt(m[1], 10);
  const current = await getCounterValue();
  if (value > current) await setCounterValue(value);
}

async function saveNumberPattern(pattern) {
  await store.set(NUMBER_PATTERN_KEY, pattern);
}

// -------- Filename pattern --------
const FILENAME_KEY = 'erechnung:filename:v1';

function sanitizeFilename(s) {
  // Remove characters that are illegal in filenames, collapse whitespace
  return String(s || '')
    .replace(/[\/\\:*?"<>|#%&{}$!'@+`=]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .trim();
}

function resolveFilenamePattern(pattern) {
  const tokens = {
    '{nr}':       $('r_number').value.trim(),
    '{project}':  $('r_project').value.trim(),
    '{buyer}':    $('b_name').value.trim(),
    '{date}':     $('r_date').value ? $('r_date').value.replace(/-/g, '') : '',
    '{category}': $('r_category').value.trim(),
    '{seller}':   $('s_name').value.trim(),
    '{layout}':   $('invoiceLayoutSelect').value,
    // Backwards compatibility for legacy German tokens in saved patterns
    '{projekt}':   $('r_project').value.trim(),
    '{kunde}':     $('b_name').value.trim(),
    '{datum}':     $('r_date').value ? $('r_date').value.replace(/-/g, '') : '',
    '{kategorie}': $('r_category').value.trim(),
    '{verkäufer}': $('s_name').value.trim(),
  };
  let result = pattern || '{nr}';
  for (const [tok, val] of Object.entries(tokens)) {
    result = result.replaceAll(tok, val);
  }
  return sanitizeFilename(result) || 'rechnung';
}

function updateFilenamePreview() {
  const pattern = $('r_filename').value;
  const resolved = resolveFilenamePattern(pattern);
  $('filenamePreview').textContent = resolved + '.pdf';
}

async function loadFilenamePattern() {
  try {
    const v = await store.get(FILENAME_KEY);
    if (v) $('r_filename').value = v;
  } catch (_) {}
  updateFilenamePreview();
}

async function saveFilenamePattern() {
  const ok = await store.set(FILENAME_KEY, $('r_filename').value);
  if (ok) flash(t('msg_filename_saved'), 'ok');
  else flash(t('msg_save_failed'), 'err');
}

// -------- Footnote presets (named templates) --------
async function loadFootnotes() {
  try {
    const v = await store.get(FOOTNOTES_KEY);
    if (v) state.footnotes = JSON.parse(v) || [];
  } catch (e) { state.footnotes = []; }
  renderFootnotePicker();
}
async function persistFootnotes() {
  const ok = await store.set(FOOTNOTES_KEY, JSON.stringify(state.footnotes));
  if (!ok) flash(t('msg_save_failed'), 'err');
}
function renderFootnotePicker() {
  const picker = $('footnotePicker');
  const current = picker.value;
  picker.innerHTML = `<option value="">${esc(t('f_footnote_picker'))}</option>` +
    state.footnotes
      .map((f, i) => `<option value="${i}">${esc(f.name)}</option>`)
      .join('');
  if (current && state.footnotes[current]) picker.value = current;
}
async function saveFootnote() {
  const text = $('r_footnote').value.trim();
  if (!text) { flash(t('msg_footnote_no_text'), 'err'); return; }
  const picker = $('footnotePicker');
  const idx = picker.value;
  if (idx !== '' && state.footnotes[idx]) {
    // Update selected
    if (!confirm(`"${state.footnotes[idx].name}" ${t('msg_footnote_overwrite')}`)) return;
    state.footnotes[idx].text = text;
    await persistFootnotes();
    flash(`"${state.footnotes[idx].name}" ${t('msg_buyer_updated')}`, 'ok');
    return;
  }
  const name = prompt(t('msg_footnote_name_prompt'));
  if (!name || !name.trim()) return;
  const trimName = name.trim();
  const existing = state.footnotes.findIndex(f => f.name.toLowerCase() === trimName.toLowerCase());
  if (existing >= 0) {
    if (!confirm(`"${trimName}" ${t('msg_footnote_overwrite')}`)) return;
    state.footnotes[existing].text = text;
  } else {
    state.footnotes.push({ name: trimName, text });
  }
  await persistFootnotes();
  renderFootnotePicker();
  const newIdx = state.footnotes.findIndex(f => f.name === trimName);
  if (newIdx >= 0) $('footnotePicker').value = newIdx;
  flash(`"${trimName}" ${t('msg_buyer_saved').replace(/^.*\s/, '')}`, 'ok');
}
async function deleteFootnote() {
  const picker = $('footnotePicker');
  const idx = picker.value;
  if (idx === '' || !state.footnotes[idx]) { flash(t('msg_footnote_no_select'), 'err'); return; }
  const name = state.footnotes[idx].name;
  if (!confirm(`"${name}" ${t('msg_buyer_confirm_delete')}`)) return;
  state.footnotes.splice(idx, 1);
  await persistFootnotes();
  renderFootnotePicker();
  flash(t('msg_deleted'), 'ok');
}

// -------- History --------
// Snapshots of generated invoices, persisted across sessions. Each entry
// is a complete form snapshot (current schema = v1) plus a few denormalized
// fields for quick display in the picker. Cloning loads everything back
// into the form, including overwriting the buyer.
//
// Toggle via the history-enable checkbox: when off, new invoices are NOT
// saved, but existing entries remain accessible.

async function loadHistory() {
  // History entries
  try {
    const v = await store.get(HISTORY_KEY);
    if (v) state.history = JSON.parse(v) || [];
  } catch (e) { state.history = []; }
  // Enabled flag
  try {
    const v = await store.get(HISTORY_ENABLED_KEY);
    state.historyEnabled = v === null || v === undefined ? true : v !== 'false';
  } catch (e) { state.historyEnabled = true; }
}

async function persistHistory() {
  return store.set(HISTORY_KEY, JSON.stringify(state.history));
}

async function persistHistoryEnabled() {
  return store.set(HISTORY_ENABLED_KEY, String(state.historyEnabled));
}

// -------- Year-over-Year backfill --------
//
// Stores monthly gross totals for years where the user didn't have the tool
// yet, so the YoY arrows have something to compare against. Schema:
//   { EUR: { 2025: [12000, 8000, ...], 2024: [...] }, USD: { 2025: [...] } }
// Each year array is exactly 12 entries (Jan..Dec), zero-filled where
// missing. Numbers are gross (matches snapshot.total semantics).
//
// History always wins over backfill: if a real snapshot exists for a given
// month, the backfill value for that same month is ignored when computing
// YoY comparisons. That way the user can backfill a partial year and let
// real data fill in over time without re-editing.

async function loadYoY() {
  try {
    const v = await store.get(YOY_ENABLED_KEY);
    state.yoyEnabled = v === 'true';
  } catch (e) { state.yoyEnabled = false; }
  try {
    const v = await store.get(YOY_DATA_KEY);
    state.yoyData = v ? (JSON.parse(v) || {}) : {};
  } catch (e) { state.yoyData = {}; }
}

async function persistYoYEnabled() {
  return store.set(YOY_ENABLED_KEY, String(state.yoyEnabled));
}

async function persistYoYData() {
  return store.set(YOY_DATA_KEY, JSON.stringify(state.yoyData));
}

// Save 12 monthly values for one (currency, year). Pass null to delete.
async function saveYoYYear(currency, year, monthlyValues) {
  if (!state.yoyData[currency]) state.yoyData[currency] = {};
  if (monthlyValues === null) {
    delete state.yoyData[currency][year];
    if (Object.keys(state.yoyData[currency]).length === 0) {
      delete state.yoyData[currency];
    }
  } else {
    // Normalize: 12 entries, numeric, rounded
    const arr = new Array(12).fill(0);
    for (let i = 0; i < 12; i++) {
      arr[i] = round2(Number(monthlyValues[i]) || 0);
    }
    state.yoyData[currency][year] = arr;
  }
  await persistYoYData();
}

// Build a snapshot of the current form. Captures everything needed to fully
// reconstruct the invoice via cloning. The seller is snapshotted too so a
// later master-data change doesn't silently rewrite history.
function buildHistorySnapshot() {
  const totals = calcTotals();
  const currency = $('r_currency').value || 'EUR';
  return {
    v: 1,
    ts: Date.now(),
    // Denormalized for picker display
    number: $('r_number').value.trim(),
    date: $('r_date').value,
    total: totals.grand,
    currency,
    buyerName: $('b_name').value.trim(),
    // Full form snapshot
    form: {
      seller: collectSeller(),
      buyer: collectBuyer(),
      items: state.items.map(it => ({
        desc: it.desc, qty: it.qty, unit: it.unit,
        price: it.price, vat: it.vat,
      })),
      number: $('r_number').value,
      date: $('r_date').value,
      delivery: $('r_delivery').value,
      deliveryEnd: $('r_delivery_end').value,
      due: $('r_due').value,
      project: $('r_project').value,
      category: $('r_category').value,
      taxmode: $('r_taxmode').value,
      currency,
      intro: $('r_intro').value,
      paymentNote: $('r_payment_note').value,
      greeting: $('r_greeting').value,
      signature: $('r_signature').value,
      footnote: $('r_footnote').value,
      invoiceLang: $('invoiceLangSelect').value,
      font: $('invoiceFontSelect').value,
      layout: $('invoiceLayoutSelect').value,
    },
  };
}

// Save a generated invoice to history (no-op when disabled).
// Hard cap of HISTORY_LIMIT entries — oldest is dropped when full.
async function recordHistoryEntry() {
  if (!state.historyEnabled) return;
  const snap = buildHistorySnapshot();
  state.history.unshift(snap);
  if (state.history.length > HISTORY_LIMIT) {
    state.history.length = HISTORY_LIMIT;
  }
  await persistHistory();
  renderHistoryPicker();
}

// Currency code → display symbol. Used by history picker and statistics.
const CURRENCY_SYMBOLS = Object.freeze({
  EUR: '€', USD: '$', GBP: '£', CHF: 'CHF',
});
function currencySymbol(code) {
  return CURRENCY_SYMBOLS[code] || code || '';
}

// Render the picker. Each option label combines number, date, buyer, total
// for at-a-glance scanning. Empty state shows the localized "empty" hint.
function renderHistoryPicker() {
  const picker = $('historyPicker');
  if (!picker) return;
  const placeholder = t('option_history_select');
  const empty = t('history_empty');
  if (state.history.length === 0) {
    picker.innerHTML = `<option value="" disabled selected>${esc(empty)}</option>`;
    picker.disabled = true;
    return;
  }
  picker.disabled = false;
  const formatTotal = (n, currency) => `${fmt(n)} ${currencySymbol(currency)}`.trim();
  const formatDate = (iso) => {
    if (!iso) return '';
    // Display format follows UI lang for readability in the picker
    try { return new Date(iso).toLocaleDateString(CURRENT_LANG); } catch { return iso; }
  };
  const opts = [`<option value="" disabled selected>${esc(placeholder)}</option>`];
  for (let i = 0; i < state.history.length; i++) {
    const e = state.history[i];
    const parts = [
      e.number || '—',
      formatDate(e.date),
      e.buyerName || '—',
      formatTotal(e.total, e.currency),
    ];
    if (e.imported) parts.push(`(${t('history_imported_marker')})`);
    opts.push(`<option value="${i}">${esc(parts.join(' · '))}</option>`);
  }
  picker.innerHTML = opts.join('');
}

// Clone a history entry back into the form. All fields from the snapshot are
// applied, including the buyer (overwrites whatever is currently there).
// Date fields stay empty so the user fills them explicitly. Invoice number
// is auto-assigned via applyNextInvoiceNumber.
async function cloneFromHistory() {
  const picker = $('historyPicker');
  const idx = picker.value;
  if (idx === '' || !state.history[idx]) {
    flash(t('msg_history_no_select'), 'err'); return;
  }
  const snap = state.history[idx];
  const f = snap.form || {};

  // Buyer — full overwrite
  applyBuyer(f.buyer || {});

  // Items
  state.items = (f.items || []).map(it => ({
    id: crypto.randomUUID(),
    desc: it.desc || '',
    qty: it.qty ?? 1,
    unit: it.unit || 'C62',
    price: it.price ?? 0,
    vat: it.vat ?? 20,
  }));
  renderItems();

  // Project / category / mode
  $('r_project').value = nz(f.project);
  $('r_category').value = nz(f.category);
  if (f.taxmode) $('r_taxmode').value = f.taxmode;

  // Boilerplate texts
  $('r_intro').value = nz(f.intro);
  $('r_payment_note').value = nz(f.paymentNote);
  $('r_greeting').value = nz(f.greeting);
  $('r_signature').value = nz(f.signature);
  $('r_footnote').value = nz(f.footnote);

  // Invoice settings
  if (f.invoiceLang !== undefined) $('invoiceLangSelect').value = f.invoiceLang || '';
  if (f.font) $('invoiceFontSelect').value = f.font;
  if (f.layout) $('invoiceLayoutSelect').value = f.layout;

  // Date fields stay empty by design — user fills them explicitly
  $('r_number').value = '';
  $('r_date').value = new Date().toISOString().slice(0, 10);
  $('r_delivery').value = '';
  $('r_delivery_end').value = '';
  $('r_due').value = '';

  // Auto-assign the next invoice number
  await applyNextInvoiceNumber();

  // Reset picker so user sees the placeholder again
  picker.value = '';

  calcTotals();
  updateFilenamePreview();
  updateBuyerHistoryHint();
  // Auto-close the history modal so the user is back at the form, ready to edit.
  closeHistoryModal();
  flash(snap.imported ? t('msg_history_clone_partial') : t('msg_history_cloned'), 'ok');
}

async function deleteHistoryEntry() {
  const picker = $('historyPicker');
  const idx = picker.value;
  if (idx === '' || !state.history[idx]) {
    flash(t('msg_history_no_select'), 'err'); return;
  }
  state.history.splice(idx, 1);
  await persistHistory();
  renderHistoryPicker();
  flash(t('msg_history_deleted'), 'ok');
}

async function clearAllHistory() {
  if (state.history.length === 0) return;
  const msg = t('history_clear_confirm').replace('{count}', state.history.length);
  if (!confirm(msg)) return;
  state.history = [];
  await persistHistory();
  renderHistoryPicker();
  flash(t('msg_history_cleared'), 'ok');
}

// -------- Past invoice entry (manual) --------
// Lets a user add invoices to history that weren't generated by this tool
// (e.g. older invoices created before adopting the tool, so statistics can
// cover the full year). Snapshots are flagged with `imported: true` and
// carry only the minimal fields needed for statistics + a partial clone.

function openPastInvoiceModal() {
  const modal = $('pastInvoiceModal');
  if (!modal) return;

  // If history modal is open, close it first — the past-invoice modal
  // takes over.
  closeHistoryModal();

  // Pre-fill defaults
  $('past_date').value = new Date().toISOString().slice(0, 10);
  $('past_buyer_text').value = '';
  $('past_total').value = '';
  $('past_currency').value = $('r_currency').value || 'EUR';
  $('past_taxmode').value = $('r_taxmode').value || 'S';
  $('past_vat_rate').value = '20';
  $('past_number').value = '';
  $('past_project').value = '';
  $('past_category').value = '';

  // Populate buyer dropdown from existing customers
  const buyerSel = $('past_buyer_select');
  const placeholder = t('past_field_buyer_select');
  const opts = [`<option value="">${esc(placeholder)}</option>`];
  for (let i = 0; i < state.buyers.length; i++) {
    opts.push(`<option value="${i}">${esc(state.buyers[i].name || '—')}</option>`);
  }
  buyerSel.innerHTML = opts.join('');
  buyerSel.value = '';

  togglePastVatRateVisibility();

  modal.classList.add('open');
  modal.removeAttribute('hidden');
}

function closePastInvoiceModal() {
  const modal = $('pastInvoiceModal');
  if (!modal) return;
  modal.classList.remove('open');
  modal.setAttribute('hidden', '');
}

// Show/hide the VAT rate field based on tax mode (only relevant for 'S').
function togglePastVatRateVisibility() {
  const mode = $('past_taxmode').value;
  const wrap = $('past_vat_rate_wrap');
  if (!wrap) return;
  wrap.style.display = mode === 'S' ? '' : 'none';
}

// Apply selected customer name into the free-text buyer field.
function applyPastBuyerSelection() {
  const idx = $('past_buyer_select').value;
  if (idx === '' || !state.buyers[idx]) return;
  $('past_buyer_text').value = state.buyers[idx].name || '';
}

async function savePastInvoice() {
  const date = $('past_date').value;
  const buyerName = $('past_buyer_text').value.trim();
  const total = Number($('past_total').value);
  const currency = $('past_currency').value || 'EUR';
  const taxmode = $('past_taxmode').value;
  const vatRate = taxmode === 'S' ? (Number($('past_vat_rate').value) || 0) : 0;
  const number = $('past_number').value.trim();
  const project = $('past_project').value.trim();
  const category = $('past_category').value.trim();

  if (!date)         { flash(t('past_err_no_date'), 'err'); return; }
  if (!buyerName)    { flash(t('past_err_no_buyer'), 'err'); return; }
  if (!Number.isFinite(total) || total <= 0) { flash(t('past_err_no_total'), 'err'); return; }

  // Build a minimal-but-valid snapshot. To make statistics' net/tax math
  // work, we synthesize a single line item that sums to the gross total.
  // For mode 'S': net = gross / (1 + vatRate/100); for others: net = gross.
  const net = taxmode === 'S' && vatRate > 0
    ? round2(total / (1 + vatRate / 100))
    : round2(total);

  const buyerIdx = $('past_buyer_select').value;
  const buyerData = (buyerIdx !== '' && state.buyers[buyerIdx])
    ? { ...state.buyers[buyerIdx], name: buyerName }
    : { name: buyerName };

  const snap = {
    v: 1,
    ts: Date.now(),
    imported: true,             // flag for UI marker + partial-clone warning
    number: number || '',
    date,
    total: round2(total),
    currency,
    buyerName,
    form: {
      seller: collectSeller(),  // current seller as best-guess context
      buyer: buyerData,
      items: [{
        desc: project || category || buyerName,
        qty: 1,
        unit: 'C62',
        price: net,
        vat: vatRate,
      }],
      number,
      date,
      delivery: '',
      deliveryEnd: '',
      due: '',
      project,
      category,
      taxmode,
      currency,
      intro: '', paymentNote: '', greeting: '', signature: '', footnote: '',
      invoiceLang: '', font: '', layout: '',
    },
  };

  state.history.unshift(snap);
  if (state.history.length > HISTORY_LIMIT) state.history.length = HISTORY_LIMIT;
  await persistHistory();
  renderHistoryPicker();
  closePastInvoiceModal();
  flash(t('msg_history_added'), 'ok');
}

// -------- Statistics: core data functions --------
// Pure functions over state.history that the renderers below build on.
// Grouped per currency since invoices come in EUR/USD/GBP/CHF.

const STATS_PERIODS = ['ytd', 'last12', 'last6', 'last3', 'last_month', 'all'];

// Filter snapshots by period. Uses snapshot.date (invoice date), falling
// back to ts (timestamp of save) for entries without a date.
//
// Period semantics:
//   last_month — rolling 30 days back from today
//   last3      — the last 3 calendar months including the current one
//   last6      — the last 6 calendar months including the current one
//   ytd        — start of current year through today
//   last12     — the last 12 calendar months including the current one
//   all        — everything
function filterByPeriod(snapshots, period) {
  if (period === 'all') return snapshots.slice();
  const now = new Date();
  let cutoff;
  if (period === 'last_month') {
    cutoff = now.getTime() - 30 * 86400000;
  } else if (period === 'last3') {
    cutoff = new Date(now.getFullYear(), now.getMonth() - 2, 1).getTime();
  } else if (period === 'last6') {
    cutoff = new Date(now.getFullYear(), now.getMonth() - 5, 1).getTime();
  } else if (period === 'ytd') {
    cutoff = new Date(now.getFullYear(), 0, 1).getTime();
  } else if (period === 'last12') {
    cutoff = new Date(now.getFullYear(), now.getMonth() - 11, 1).getTime();
  } else {
    return snapshots.slice();
  }
  return snapshots.filter(s => {
    const ts = s.date ? new Date(s.date).getTime() : s.ts;
    return Number.isFinite(ts) && ts >= cutoff;
  });
}

// Group snapshots by currency. Returns Map<currency, snapshots[]>.
function groupByCurrency(snapshots) {
  const m = new Map();
  for (const s of snapshots) {
    const c = s.currency || 'EUR';
    if (!m.has(c)) m.set(c, []);
    m.get(c).push(s);
  }
  return m;
}

// Compute per-currency KPIs for a set of snapshots.
function computeKPIs(snapshots) {
  // Reconstruct net/tax from form items where possible. Snapshot has
  // total (grand) but not net/tax — compute it from items + taxmode.
  let total = 0, net = 0, tax = 0;
  for (const s of snapshots) {
    total += Number(s.total) || 0;
    const items = s.form && Array.isArray(s.form.items) ? s.form.items : [];
    const mode = s.form && s.form.taxmode;
    let sNet = 0, sTax = 0;
    for (const it of items) {
      const line = (Number(it.qty) || 0) * (Number(it.price) || 0);
      sNet += line;
      if (mode === 'S') sTax += line * (Number(it.vat) || 0) / 100;
    }
    net += sNet;
    tax += sTax;
  }
  const count = snapshots.length;
  const avg = count > 0 ? total / count : 0;
  return {
    total: round2(total),
    net: round2(net),
    tax: round2(tax),
    count,
    avg: round2(avg),
  };
}

// -------- Statistics: data + render + YoY + interactions --------
//
// This block contains all stats logic: period windows, YoY computation,
// monthly + quarterly aggregations, top-buyer ranking, the SVG chart
// renderer, the three view renderers (overview / quarters / drill-down),
// and the small state machine for switching between them.
//
// Comparison windows per period:
//   ytd        → same span Jan 1..today, but in previous calendar year
//   last_month → same 30-day rolling window, shifted back exactly 365 days
//   last3      → same 3 calendar months, shifted back 12 months
//   last6      → same 6 calendar months, shifted back 12 months
//   last12     → same 12 calendar months, shifted back 12 months
//   all        → no YoY comparison (returns null)

// Compute the [cutoff, until] millisecond window for a period, optionally
// shifted by `yearShift` whole years. Returns null for periods without YoY.
function periodWindow(period, yearShift = 0) {
  const now = new Date();
  const yr = now.getFullYear() - yearShift;
  if (period === 'all') return null;
  if (period === 'ytd') {
    const start = new Date(yr, 0, 1).getTime();
    // For shifted year, until = today's date in that year. For current = now.
    let until;
    if (yearShift === 0) until = now.getTime();
    else until = new Date(yr, now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();
    return [start, until];
  }
  if (period === 'last_month') {
    const start = now.getTime() - 30 * 86400000 - yearShift * 365 * 86400000;
    const end   = now.getTime() - yearShift * 365 * 86400000;
    return [start, end];
  }
  if (period === 'last3' || period === 'last6' || period === 'last12') {
    const monthsBack = period === 'last3' ? 2 : period === 'last6' ? 5 : 11;
    const start = new Date(yr, now.getMonth() - monthsBack, 1).getTime();
    let until;
    if (yearShift === 0) until = now.getTime();
    else until = new Date(yr, now.getMonth() + 1, 0, 23, 59, 59, 999).getTime();
    return [start, until];
  }
  return null;
}

// Filter snapshots to a [cutoff, until] window.
function filterByWindow(snapshots, win) {
  if (!win) return [];
  const [from, to] = win;
  return snapshots.filter(s => {
    const ts = s.date ? new Date(s.date).getTime() : s.ts;
    return Number.isFinite(ts) && ts >= from && ts <= to;
  });
}

// Given a currency and a previous-year window, compute the previous-period
// gross + net + tax KPIs. Combines real history snapshots and backfill
// values; history wins per (year, month). Returns null when no comparable
// data is available for that window.
function computeYoYBaseline(currency, prevWindow, prevYear) {
  if (!prevWindow) return null;
  const [from, to] = prevWindow;

  // Collect history snapshots for the currency in the window
  const histInCur = state.history.filter(s => (s.currency || 'EUR') === currency);
  const histInWin = filterByWindow(histInCur, prevWindow);
  const baseKPI = computeKPIs(histInWin);

  // Track which (year, month) pairs are already covered by real history.
  // Backfill values for those months are then ignored.
  const covered = new Set();
  for (const s of histInWin) {
    if (!s.date) continue;
    const d = new Date(s.date);
    if (Number.isNaN(d.getTime())) continue;
    covered.add(`${d.getFullYear()}-${d.getMonth()}`);
  }

  // Backfill contribution: sum monthly gross values for months in the
  // window that aren't covered by history. We don't have item-level data,
  // so net == gross == total here (no VAT contribution from backfill).
  let backfillGross = 0;
  if (state.yoyData[currency]) {
    // The window may straddle two calendar years (e.g. last_month rolling
    // window in January). Walk month-by-month from `from` to `to`.
    const fromD = new Date(from);
    const toD = new Date(to);
    const cursor = new Date(fromD.getFullYear(), fromD.getMonth(), 1);
    while (cursor.getTime() <= toD.getTime()) {
      const y = cursor.getFullYear();
      const m = cursor.getMonth();
      const key = `${y}-${m}`;
      if (!covered.has(key)) {
        const monthArr = state.yoyData[currency][y];
        if (Array.isArray(monthArr) && monthArr.length === 12) {
          backfillGross += Number(monthArr[m]) || 0;
        }
      }
      cursor.setMonth(cursor.getMonth() + 1);
    }
  }

  const total = round2(baseKPI.total + backfillGross);
  // Backfill has no item-level breakdown — count it 1:1 into net only,
  // tax stays whatever real history contributes.
  const net   = round2(baseKPI.net + backfillGross);
  const tax   = baseKPI.tax;
  const count = baseKPI.count;  // backfill doesn't have a meaningful count
  const avg   = count > 0 ? round2(total / count) : 0;

  if (total === 0 && net === 0 && tax === 0 && count === 0) return null;
  return { total, net, tax, count, avg };
}

// Format a percent change as a display string with an arrow glyph.
// Returns { glyph, pct, cls } where cls is 'up'/'down'/'flat'/'none'.
function yoyDelta(currentValue, prevValue) {
  if (prevValue === null || prevValue === undefined) {
    return { glyph: '\u2013', pct: '', cls: 'none' };
  }
  if (prevValue === 0) {
    if (currentValue > 0) return { glyph: '\u25b2', pct: '\u2014', cls: 'up' };
    return { glyph: '\u2013', pct: '', cls: 'flat' };
  }
  const diff = currentValue - prevValue;
  const pct = Math.round((diff / prevValue) * 100);
  if (pct === 0) return { glyph: '\u2013', pct: '0%', cls: 'flat' };
  if (pct > 0)  return { glyph: '\u25b2', pct: `+${pct}%`, cls: 'up' };
  return { glyph: '\u25bc', pct: `${pct}%`, cls: 'down' };
}

// Top N buyers by total amount, within a single currency. Returns
// [{ name, total, count }, ...] sorted descending.
function topBuyers(snapshots, n = 3) {
  const map = new Map();
  for (const s of snapshots) {
    const name = s.buyerName || '—';
    const cur = map.get(name) || { name, total: 0, count: 0 };
    cur.total += Number(s.total) || 0;
    cur.count += 1;
    map.set(name, cur);
  }
  return Array.from(map.values())
    .map(b => ({ ...b, total: round2(b.total) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, n);
}

// Aggregate by month over the last 12 months ending in the current month.
// Returns array of { ym: 'YYYY-MM', label: 'Apr', total: number } in
// chronological order.
function monthlyTotals(snapshots) {
  const buckets = new Map();
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    buckets.set(ym, {
      ym,
      label: d.toLocaleDateString(CURRENT_LANG, { month: 'short' }),
      total: 0,
    });
  }
  for (const s of snapshots) {
    if (!s.date) continue;
    const d = new Date(s.date);
    if (Number.isNaN(d.getTime())) continue;
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const bucket = buckets.get(ym);
    if (bucket) bucket.total += Number(s.total) || 0;
  }
  return Array.from(buckets.values()).map(b => ({ ...b, total: round2(b.total) }));
}

// For a given currency and a year-month string ('YYYY-MM' from
// monthlyTotals), return the gross total from one year earlier.
// Combines real history snapshots with backfill data; history wins.
// Returns null when no data exists for that month.
function monthYoYValue(currency, ym) {
  const [yStr, mStr] = ym.split('-');
  const prevY = Number(yStr) - 1;
  const monthIdx = Number(mStr) - 1;
  let total = 0;
  let hasData = false;

  // Look in history first
  for (const s of state.history) {
    if (!s.date) continue;
    if ((s.currency || 'EUR') !== currency) continue;
    const d = new Date(s.date);
    if (Number.isNaN(d.getTime())) continue;
    if (d.getFullYear() === prevY && d.getMonth() === monthIdx) {
      total += Number(s.total) || 0;
      hasData = true;
    }
  }

  // Backfill only counts if no real history covered this month
  if (!hasData && state.yoyData[currency]) {
    const arr = state.yoyData[currency][prevY];
    if (Array.isArray(arr) && arr.length === 12) {
      const v = Number(arr[monthIdx]) || 0;
      if (v > 0) {
        total = v;
        hasData = true;
      }
    }
  }

  return hasData ? round2(total) : null;
}

// Build SVG bar-chart for monthly totals. Inline SVG so no library needed.
function renderMonthlyChartSVG(months, currency) {
  const W = 560, H = 140, P_TOP = 16, P_BOT = 28, P_LEFT = 8, P_RIGHT = 8;
  const max = Math.max(1, ...months.map(m => m.total));
  const innerW = W - P_LEFT - P_RIGHT;
  const innerH = H - P_TOP - P_BOT;
  const slot = innerW / months.length;
  const barW = Math.max(3, slot * 0.45);
  const sym = currencySymbol(currency);
  const bars = months.map((m, i) => {
    const h = (m.total / max) * innerH;
    const x = P_LEFT + i * slot + (slot - barW) / 2;
    const y = P_TOP + (innerH - h);

    // Build tooltip text. Adds a YoY comparison line when the toggle is
    // on and a previous-year value exists for this month. The HTML is
    // sanitized via esc(), and the tooltip element renders innerHTML so
    // we can include the <br> as a literal break.
    let tip = `${m.label}: ${fmt(m.total)} ${sym}`;
    if (state.yoyEnabled) {
      const prev = monthYoYValue(currency, m.ym);
      if (prev !== null) {
        const delta = yoyDelta(m.total, prev);
        const arrowText = delta.pct
          ? `${delta.glyph} ${delta.pct}`
          : delta.glyph;
        // Year derived from m.ym = 'YYYY-MM'
        const prevYear = Number(m.ym.split('-')[0]) - 1;
        tip += `\u2002\u00b7\u2002vs. ${prevYear}: ${fmt(prev)} ${sym} ${arrowText}`;
      }
    }
    // Full-slot transparent hitbox so the tooltip works even between bars.
    const hitX = P_LEFT + i * slot;
    return `<g>` +
      `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="currentColor" opacity="0.7"></rect>` +
      `<text x="${(x + barW / 2).toFixed(1)}" y="${(H - 8).toFixed(1)}" text-anchor="middle" font-size="8" fill="currentColor" opacity="0.55">${esc(m.label)}</text>` +
      `<rect class="stats-bar-hit" x="${hitX.toFixed(1)}" y="${P_TOP}" width="${slot.toFixed(1)}" height="${innerH}" fill="transparent" data-tip="${esc(tip)}"></rect>` +
      `</g>`;
  }).join('');
  return `<div class="stats-chart-wrap-inner">` +
    `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" class="stats-chart" role="img">${bars}</svg>` +
    `<div class="stats-chart-tooltip" hidden></div>` +
    `</div>`;
}

// Wire up tooltip behaviour for all bar charts inside the stats body.
// Uses event delegation so it works after each renderStatistics() call.
function attachChartTooltips() {
  const body = $('statsBody');
  if (!body || body.dataset.tooltipsBound === '1') return;
  body.dataset.tooltipsBound = '1';
  body.addEventListener('mousemove', (e) => {
    const hit = e.target.closest('.stats-bar-hit');
    if (!hit) return;
    const wrap = hit.closest('.stats-chart-wrap-inner');
    const tip = wrap && wrap.querySelector('.stats-chart-tooltip');
    if (!tip) return;
    tip.textContent = hit.getAttribute('data-tip') || '';
    tip.hidden = false;
    const wrapRect = wrap.getBoundingClientRect();
    const x = e.clientX - wrapRect.left;
    const y = e.clientY - wrapRect.top;
    tip.style.left = `${Math.max(4, Math.min(wrapRect.width - tip.offsetWidth - 4, x - tip.offsetWidth / 2))}px`;
    tip.style.top  = `${Math.max(4, y - tip.offsetHeight - 8)}px`;
  });
  body.addEventListener('mouseleave', () => {
    for (const tip of body.querySelectorAll('.stats-chart-tooltip')) tip.hidden = true;
  }, true);
}

// Get the most recent invoice (across all currencies) for a given buyer name.
// Used for the "last invoice to this buyer" hint when picking a customer.
function findLastInvoiceForBuyer(buyerName) {
  if (!buyerName) return null;
  const target = buyerName.toLowerCase().trim();
  for (const s of state.history) {
    if ((s.buyerName || '').toLowerCase().trim() === target) return s;
  }
  return null;
}

// Update the small caption under the buyer picker showing context for the
// currently-selected buyer. Empty when no match in history.
function updateBuyerHistoryHint() {
  const hint = $('buyerHistoryHint');
  if (!hint) return;
  const name = $('b_name').value.trim();
  const last = findLastInvoiceForBuyer(name);
  if (!last) { hint.textContent = ''; return; }
  // Days since last invoice
  let daysAgo = null;
  if (last.date) {
    const diff = Date.now() - new Date(last.date).getTime();
    if (Number.isFinite(diff) && diff >= 0) daysAgo = Math.floor(diff / 86400000);
  }
  const totalStr = `${fmt(last.total)} ${currencySymbol(last.currency)}`;
  const num = last.number || '—';
  let tpl;
  if (daysAgo === null) {
    tpl = t('buyer_history_hint_no_date');
  } else if (daysAgo === 0) {
    tpl = t('buyer_history_hint_today');
  } else if (daysAgo === 1) {
    tpl = t('buyer_history_hint_one_day');
  } else {
    tpl = t('buyer_history_hint_n_days');
  }
  hint.textContent = tpl
    .replace('{number}', num)
    .replace('{days}', String(daysAgo))
    .replace('{total}', totalStr);
}

// Render the entire statistics modal body. Called when the modal opens
// and when the period filter changes.
// Stats view: 'overview' (default KPIs + chart + top buyers) or
// 'quarters' (quarterly tax breakdown for one year).
let statsView = 'overview';
// Year shown in the quarters view (independent of period filter).
let statsYear = new Date().getFullYear();
// When non-null, the overview is replaced with a single-buyer drill-down view.
// Reset by clicking the "back" button or switching tabs.
let statsBuyerDrillDown = null;

// Compute a quarterly breakdown for one year of snapshots, grouped by
// tax mode. Returns:
//   { quarters: [{ q, S: {net, tax}, AE: {net}, Z: {net}, E: {net}, O: {net} }, ...],
//     yearTotals: { S: {net, tax}, AE: {net}, Z: {net}, E: {net}, O: {net} } }
function computeQuarterlyBreakdown(snapshots, year) {
  const empty = () => ({
    S:  { net: 0, tax: 0 },
    AE: { net: 0 },
    Z:  { net: 0 },
    E:  { net: 0 },
    O:  { net: 0 },
  });
  const quarters = [empty(), empty(), empty(), empty()];
  const yearTotals = empty();

  for (const s of snapshots) {
    if (!s.date) continue;
    const d = new Date(s.date);
    if (Number.isNaN(d.getTime())) continue;
    if (d.getFullYear() !== year) continue;
    const q = Math.floor(d.getMonth() / 3);
    const mode = (s.form && s.form.taxmode) || 'S';

    // Reconstruct net + tax from items where possible, like computeKPIs does.
    const items = s.form && Array.isArray(s.form.items) ? s.form.items : [];
    let net = 0, tax = 0;
    for (const it of items) {
      const line = (Number(it.qty) || 0) * (Number(it.price) || 0);
      net += line;
      if (mode === 'S') tax += line * (Number(it.vat) || 0) / 100;
    }
    if (net === 0) net = Number(s.total) || 0; // fallback: gross only

    const target = quarters[q][mode] || quarters[q].O;
    target.net += net;
    if (mode === 'S') target.tax += tax;

    const yt = yearTotals[mode] || yearTotals.O;
    yt.net += net;
    if (mode === 'S') yt.tax += tax;
  }

  // Round everything for display
  const round = (obj) => {
    for (const k of Object.keys(obj)) {
      obj[k].net = round2(obj[k].net);
      if (obj[k].tax !== undefined) obj[k].tax = round2(obj[k].tax);
    }
  };
  for (const qb of quarters) round(qb);
  round(yearTotals);

  return {
    quarters: quarters.map((qb, i) => ({ q: i + 1, ...qb })),
    yearTotals,
  };
}

// Years available in the history, for the quarter-view year selector.
function availableYearsInHistory() {
  const set = new Set();
  for (const s of state.history) {
    if (!s.date) continue;
    const d = new Date(s.date);
    if (!Number.isNaN(d.getTime())) set.add(d.getFullYear());
  }
  if (set.size === 0) set.add(new Date().getFullYear());
  return Array.from(set).sort((a, b) => b - a); // newest first
}

// Render the overview (existing) view body.
function renderStatisticsOverview() {
  const period = $('statsPeriod').value;
  const filtered = filterByPeriod(state.history, period);
  const body = $('statsBody');
  if (!body) return;

  if (state.history.length === 0) {
    body.innerHTML = `<div class="stats-empty">${esc(t('stats_empty'))}</div>`;
    return;
  }
  if (filtered.length === 0) {
    body.innerHTML = `<div class="stats-empty">${esc(t('stats_empty_period'))}</div>`;
    return;
  }

  const groups = groupByCurrency(filtered);
  const ordered = Array.from(groups.entries())
    .map(([cur, list]) => ({ cur, list, kpi: computeKPIs(list) }))
    .sort((a, b) => b.kpi.total - a.kpi.total);

  // Compute YoY baselines per currency when enabled. Returns null when
  // the period doesn't support YoY (e.g. "all time").
  const prevWindow = state.yoyEnabled ? periodWindow(period, 1) : null;
  const yoyByCurrency = {};
  if (prevWindow) {
    for (const { cur } of ordered) {
      yoyByCurrency[cur] = computeYoYBaseline(cur, prevWindow, new Date().getFullYear() - 1);
    }
  }

  // Helper: render one KPI card with optional YoY arrow.
  // Tax KPI gets no arrow when the previous-period tax is zero (typical
  // for a freelancer with mostly reverse-charge — the comparison is
  // statistically empty).
  const kpiCard = (labelKey, value, sym, prev) => {
    let arrowHTML = '';
    if (state.yoyEnabled && prev !== undefined) {
      const d = yoyDelta(value, prev);
      arrowHTML = `<span class="yoy-arrow yoy-${d.cls}">${esc(d.glyph)}${d.pct ? ` <span class="yoy-pct">${esc(d.pct)}</span>` : ''}</span>`;
    }
    return `<div class="stats-kpi"><div class="stats-kpi-label">${esc(t(labelKey))}</div><div class="stats-kpi-value">${fmt(value)} ${esc(sym)}${arrowHTML}</div></div>`;
  };

  const blocks = ordered.map(({ cur, list, kpi }) => {
    const sym = currencySymbol(cur);
    const tops = topBuyers(list, 3);
    const months = monthlyTotals(list);
    const prev = yoyByCurrency[cur];

    const topsHTML = tops.length === 0 ? '' : `
      <div class="stats-tops">
        <div class="stats-subhead">${esc(t('stats_top_buyers'))}</div>
        <ol>
          ${tops.map(b => {
            const pct = kpi.total > 0 ? Math.round((b.total / kpi.total) * 100) : 0;
            return `<li><button class="stats-buyer-btn" type="button" data-buyer="${esc(b.name)}"><span class="stats-buyer-name">${esc(b.name)}</span><span class="stats-buyer-meta">${fmt(b.total)} ${esc(sym)} · ${pct}%</span></button></li>`;
          }).join('')}
        </ol>
      </div>`;

    const kpisHTML = `
      <div class="stats-kpis">
        ${kpiCard('stats_kpi_total', kpi.total, sym, prev ? prev.total : undefined)}
        ${kpiCard('stats_kpi_net',   kpi.net,   sym, prev ? prev.net   : undefined)}
        ${kpiCard('stats_kpi_tax',   kpi.tax,   sym, prev ? prev.tax   : undefined)}
        ${kpiCard('stats_kpi_avg',   kpi.avg,   sym, prev ? prev.avg   : undefined)}
      </div>`;

    return `
      <div class="stats-block">
        <div class="stats-block-head">${esc(cur)} <span class="stats-block-count">· ${kpi.count} ${esc(t(kpi.count === 1 ? 'stats_invoice' : 'stats_invoices'))}</span></div>
        ${kpisHTML}
        <div class="stats-chart-wrap">
          <div class="stats-subhead">${esc(t('stats_last_12_months'))}</div>
          ${renderMonthlyChartSVG(months, cur)}
        </div>
        ${topsHTML}
      </div>`;
  }).join('');

  // YoY hint banner: when toggle is on but there's no comparable data
  // anywhere (no history overlap AND no backfill), nudge the user to
  // backfill. Skip banner when YoY isn't supported by the period.
  let yoyBanner = '';
  if (state.yoyEnabled && prevWindow) {
    const anyData = ordered.some(({ cur }) => yoyByCurrency[cur] !== null);
    if (!anyData) {
      yoyBanner = `
        <div class="yoy-banner">
          <span>${esc(t('yoy_hint_no_data'))}</span>
          <button class="tiny-btn" id="yoyOpenBackfill" type="button" data-i18n="yoy_set_reference"></button>
        </div>`;
    }
  } else if (state.yoyEnabled && !prevWindow) {
    yoyBanner = `<div class="yoy-banner yoy-banner-info">${esc(t('yoy_hint_no_period'))}</div>`;
  }

  body.innerHTML = yoyBanner + blocks;
  attachChartTooltips();
  applyTranslations();
}

// Render the quarterly tax-breakdown view.
function renderStatisticsQuarters() {
  const body = $('statsBody');
  if (!body) return;

  if (state.history.length === 0) {
    body.innerHTML = `<div class="stats-empty">${esc(t('stats_empty'))}</div>`;
    return;
  }

  // Snapshots in the selected year only
  const inYear = state.history.filter(s => {
    if (!s.date) return false;
    const d = new Date(s.date);
    return !Number.isNaN(d.getTime()) && d.getFullYear() === statsYear;
  });

  if (inYear.length === 0) {
    body.innerHTML = `<div class="stats-empty">${esc(t('stats_empty_year'))}</div>`;
    return;
  }

  const groups = groupByCurrency(inYear);
  const ordered = Array.from(groups.entries())
    .map(([cur, list]) => ({ cur, list, breakdown: computeQuarterlyBreakdown(list, statsYear) }))
    .sort((a, b) => b.list.length - a.list.length);

  // Helper: render a value cell, falling back to "—" when 0.
  const cell = (val, sym) => val > 0
    ? `${fmt(val)} ${esc(sym)}`
    : `<span class="qb-zero">—</span>`;

  const blocks = ordered.map(({ cur, list, breakdown }) => {
    const sym = currencySymbol(cur);
    // Find which modes actually have data for this currency, so we don't
    // render empty columns. Always show 'S' even if zero.
    const modesWithData = new Set(['S']);
    for (const qb of breakdown.quarters) {
      if (qb.AE.net > 0) modesWithData.add('AE');
      if (qb.Z.net > 0)  modesWithData.add('Z');
      if (qb.E.net > 0)  modesWithData.add('E');
      if (qb.O.net > 0)  modesWithData.add('O');
    }
    const showAE = modesWithData.has('AE');
    const showZ  = modesWithData.has('Z');
    const showE  = modesWithData.has('E');
    const showO  = modesWithData.has('O');

    // Build header row: Quarter | Standard Net | Standard VAT | [Reverse Charge] | [Zero] | [Exempt] | [Out of Scope]
    const headers = [
      `<th>${esc(t('qb_quarter'))}</th>`,
      `<th class="num">${esc(t('qb_standard_net'))}</th>`,
      `<th class="num">${esc(t('qb_standard_vat'))}</th>`,
    ];
    if (showAE) headers.push(`<th class="num">${esc(t('qb_reverse_charge'))}</th>`);
    if (showZ)  headers.push(`<th class="num">${esc(t('qb_zero_rate'))}</th>`);
    if (showE)  headers.push(`<th class="num">${esc(t('qb_exempt'))}</th>`);
    if (showO)  headers.push(`<th class="num">${esc(t('qb_out_of_scope'))}</th>`);

    // Body rows
    const bodyRows = breakdown.quarters.map(qb => {
      const cells = [
        `<td>${esc(t('qb_q' + qb.q))}</td>`,
        `<td class="num">${cell(qb.S.net, sym)}</td>`,
        `<td class="num">${cell(qb.S.tax, sym)}</td>`,
      ];
      if (showAE) cells.push(`<td class="num">${cell(qb.AE.net, sym)}</td>`);
      if (showZ)  cells.push(`<td class="num">${cell(qb.Z.net,  sym)}</td>`);
      if (showE)  cells.push(`<td class="num">${cell(qb.E.net,  sym)}</td>`);
      if (showO)  cells.push(`<td class="num">${cell(qb.O.net,  sym)}</td>`);
      return `<tr>${cells.join('')}</tr>`;
    }).join('');

    // Total row
    const yt = breakdown.yearTotals;
    const totalCells = [
      `<td><strong>${esc(t('qb_year_total'))}</strong></td>`,
      `<td class="num"><strong>${cell(yt.S.net, sym)}</strong></td>`,
      `<td class="num"><strong>${cell(yt.S.tax, sym)}</strong></td>`,
    ];
    if (showAE) totalCells.push(`<td class="num"><strong>${cell(yt.AE.net, sym)}</strong></td>`);
    if (showZ)  totalCells.push(`<td class="num"><strong>${cell(yt.Z.net,  sym)}</strong></td>`);
    if (showE)  totalCells.push(`<td class="num"><strong>${cell(yt.E.net,  sym)}</strong></td>`);
    if (showO)  totalCells.push(`<td class="num"><strong>${cell(yt.O.net,  sym)}</strong></td>`);

    return `
      <div class="stats-block">
        <div class="stats-block-head">${esc(cur)} <span class="stats-block-count">· ${list.length} ${esc(t(list.length === 1 ? 'stats_invoice' : 'stats_invoices'))}</span></div>
        <div class="qb-table-wrap">
          <table class="qb-table">
            <thead><tr>${headers.join('')}</tr></thead>
            <tbody>${bodyRows}</tbody>
            <tfoot><tr class="qb-total">${totalCells.join('')}</tr></tfoot>
          </table>
        </div>
      </div>`;
  }).join('');

  body.innerHTML = blocks;
}

// Render a single-buyer drill-down view: all invoices for `buyerName`, plus
// per-buyer KPIs (count, total, avg, first/last invoice). Read-only — no
// cloning from this view.
function renderStatisticsBuyer(buyerName) {
  const body = $('statsBody');
  if (!body) return;

  // Match case-insensitively, trim — same logic as updateBuyerHistoryHint.
  const target = (buyerName || '').toLowerCase().trim();
  const matched = state.history.filter(s =>
    (s.buyerName || '').toLowerCase().trim() === target);

  if (matched.length === 0) {
    body.innerHTML = `
      <div class="stats-buyer-detail">
        <button class="tiny-btn stats-back-btn" id="statsBackBtn" type="button" data-i18n="stats_back"></button>
        <div class="stats-empty">${esc(t('stats_empty'))}</div>
      </div>`;
    applyTranslations();
    return;
  }

  // Group by currency since a buyer may have invoices in multiple
  const groups = groupByCurrency(matched);
  const ordered = Array.from(groups.entries())
    .map(([cur, list]) => ({ cur, list, kpi: computeKPIs(list) }))
    .sort((a, b) => b.kpi.total - a.kpi.total);

  // Date range across all currencies (first / last invoice for this buyer)
  const datedSorted = matched
    .filter(s => s.date)
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  const firstInv = datedSorted[0];
  const lastInv  = datedSorted[datedSorted.length - 1];

  const formatDate = (iso) => {
    if (!iso) return '';
    try { return new Date(iso).toLocaleDateString(CURRENT_LANG); } catch { return iso; }
  };

  const blocks = ordered.map(({ cur, list, kpi }) => {
    const sym = currencySymbol(cur);
    // Sort newest first for the invoice list
    const sortedList = list.slice().sort((a, b) => {
      const ta = a.date ? new Date(a.date).getTime() : a.ts;
      const tb = b.date ? new Date(b.date).getTime() : b.ts;
      return tb - ta;
    });
    const rows = sortedList.map(s => `
      <tr>
        <td>${esc(formatDate(s.date))}</td>
        <td>${esc(s.number || '—')}${s.imported ? ` <span class="qb-zero">(${esc(t('history_imported_marker'))})</span>` : ''}</td>
        <td class="num">${fmt(Number(s.total) || 0)} ${esc(sym)}</td>
      </tr>`).join('');

    return `
      <div class="stats-block">
        <div class="stats-block-head">${esc(cur)} <span class="stats-block-count">· ${kpi.count} ${esc(t(kpi.count === 1 ? 'stats_invoice' : 'stats_invoices'))}</span></div>
        <div class="stats-kpis">
          <div class="stats-kpi"><div class="stats-kpi-label">${esc(t('stats_kpi_total'))}</div><div class="stats-kpi-value">${fmt(kpi.total)} ${esc(sym)}</div></div>
          <div class="stats-kpi"><div class="stats-kpi-label">${esc(t('stats_kpi_avg'))}</div><div class="stats-kpi-value">${fmt(kpi.avg)} ${esc(sym)}</div></div>
          <div class="stats-kpi"><div class="stats-kpi-label">${esc(t('stats_buyer_first'))}</div><div class="stats-kpi-value">${esc(formatDate(firstInv && firstInv.date))}</div></div>
          <div class="stats-kpi"><div class="stats-kpi-label">${esc(t('stats_buyer_last'))}</div><div class="stats-kpi-value">${esc(formatDate(lastInv && lastInv.date))}</div></div>
        </div>
        <div class="qb-table-wrap">
          <table class="qb-table stats-buyer-invoices">
            <thead>
              <tr>
                <th>${esc(t('stats_buyer_col_date'))}</th>
                <th>${esc(t('stats_buyer_col_number'))}</th>
                <th class="num">${esc(t('stats_buyer_col_total'))}</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  }).join('');

  body.innerHTML = `
    <div class="stats-buyer-detail">
      <div class="stats-buyer-head">
        <button class="tiny-btn stats-back-btn" id="statsBackBtn" type="button" data-i18n="stats_back"></button>
        <h3 class="stats-buyer-title">${esc(buyerName)}</h3>
      </div>
      ${blocks}
    </div>`;
  applyTranslations();
}

// Update the visibility of the period-vs-year controls and the active-tab
// button styling based on statsView.
function updateStatsViewControls() {
  const periodWrap = $('statsPeriodWrap');
  const yearWrap   = $('statsYearWrap');
  const overviewBtn = $('statsTabOverview');
  const quartersBtn = $('statsTabQuarters');
  // Hide period/year selectors entirely while drilled into a buyer
  const inDrillDown = statsView === 'overview' && statsBuyerDrillDown !== null;
  if (periodWrap) periodWrap.style.display = (statsView === 'overview' && !inDrillDown) ? '' : 'none';
  if (yearWrap)   yearWrap.style.display   = statsView === 'quarters' ? '' : 'none';
  if (overviewBtn) overviewBtn.classList.toggle('active', statsView === 'overview');
  if (quartersBtn) quartersBtn.classList.toggle('active', statsView === 'quarters');
}

// Populate the year selector with years available in history.
function refreshStatsYearSelector() {
  const sel = $('statsYear');
  if (!sel) return;
  const years = availableYearsInHistory();
  if (!years.includes(statsYear)) statsYear = years[0];
  sel.innerHTML = years.map(y => `<option value="${y}"${y === statsYear ? ' selected' : ''}>${y}</option>`).join('');
}

// Dispatcher: routes to the appropriate view renderer.
function renderStatistics() {
  updateStatsViewControls();
  if (statsView === 'overview' && statsBuyerDrillDown) {
    renderStatisticsBuyer(statsBuyerDrillDown);
  } else if (statsView === 'overview') {
    renderStatisticsOverview();
  } else {
    renderStatisticsQuarters();
  }
}

function setStatsView(v) {
  if (v !== 'overview' && v !== 'quarters') return;
  statsView = v;
  // Switching tabs always exits drill-down mode
  statsBuyerDrillDown = null;
  if (v === 'quarters') refreshStatsYearSelector();
  renderStatistics();
}

function setStatsBuyerDrillDown(name) {
  statsBuyerDrillDown = name || null;
  renderStatistics();
}

// -------- YoY: toggle + backfill modal --------

async function setYoYEnabled(v) {
  state.yoyEnabled = !!v;
  await persistYoYEnabled();
  updateYoYToggleButton();
  renderStatistics();
}

function updateYoYToggleButton() {
  const btn = $('statsYoYToggle');
  if (!btn) return;
  btn.classList.toggle('active', state.yoyEnabled);
  btn.setAttribute('aria-pressed', state.yoyEnabled ? 'true' : 'false');
}

// Open the backfill modal for entering 12 monthly gross totals.
function openYoYBackfillModal() {
  const modal = $('yoyBackfillModal');
  if (!modal) return;

  // Year selector: previous year by default; allow the user to backfill
  // older years too. Show last 5 years.
  const thisYear = new Date().getFullYear();
  const yearSel = $('yoyBackfillYear');
  yearSel.innerHTML = '';
  for (let y = thisYear - 1; y >= thisYear - 5; y--) {
    yearSel.insertAdjacentHTML('beforeend', `<option value="${y}">${y}</option>`);
  }
  yearSel.value = String(thisYear - 1);

  // Currency selector: pre-fill with currencies present in history,
  // plus EUR as fallback. User can also type a custom 3-letter code.
  const curSel = $('yoyBackfillCurrency');
  const cursInHistory = new Set();
  for (const s of state.history) cursInHistory.add(s.currency || 'EUR');
  if (cursInHistory.size === 0) cursInHistory.add('EUR');
  curSel.innerHTML = '';
  for (const cur of cursInHistory) {
    curSel.insertAdjacentHTML('beforeend', `<option value="${esc(cur)}">${esc(cur)}</option>`);
  }

  // Hook year/currency change to repopulate the input fields with any
  // previously-saved data for that combination.
  const repopulate = () => {
    const cur = curSel.value;
    const yr = Number(yearSel.value);
    const arr = (state.yoyData[cur] && state.yoyData[cur][yr]) || new Array(12).fill(0);
    for (let i = 0; i < 12; i++) {
      const inp = $(`yoyMonth_${i}`);
      if (inp) inp.value = arr[i] ? String(arr[i]) : '';
    }
  };
  curSel.onchange = repopulate;
  yearSel.onchange = repopulate;
  repopulate();

  modal.classList.add('open');
  modal.removeAttribute('hidden');
}

function closeYoYBackfillModal() {
  const modal = $('yoyBackfillModal');
  if (!modal) return;
  modal.classList.remove('open');
  modal.setAttribute('hidden', '');
}

async function saveYoYBackfill() {
  const cur = $('yoyBackfillCurrency').value.trim().toUpperCase() || 'EUR';
  const yr = Number($('yoyBackfillYear').value);
  if (!yr || yr < 1900 || yr > 2200) { flash(t('msg_yoy_invalid_year'), 'err'); return; }
  const values = [];
  let anyNonZero = false;
  for (let i = 0; i < 12; i++) {
    const inp = $(`yoyMonth_${i}`);
    const v = parseFloat((inp && inp.value || '').replace(',', '.')) || 0;
    if (v < 0) { flash(t('msg_yoy_invalid_value'), 'err'); return; }
    values.push(v);
    if (v > 0) anyNonZero = true;
  }
  if (!anyNonZero) {
    // Saving all zeros = clear this year/currency combo
    await saveYoYYear(cur, yr, null);
    flash(t('msg_yoy_cleared'), 'ok');
  } else {
    await saveYoYYear(cur, yr, values);
    flash(t('msg_yoy_saved'), 'ok');
  }
  closeYoYBackfillModal();
  renderStatistics();
}

// -------- Stats: CSV export --------
//
// What gets exported is "what you see":
//   Overview tab        → all snapshots in current period filter
//   Quarters tab        → quarterly breakdown table for the selected year
//   Buyer drill-down    → all snapshots for that buyer, all currencies
//
// CSV format: UTF-8 with BOM (so Excel reads umlauts correctly), semicolon
// separators (so European Excel doesn't fight comma decimals), all fields
// quoted per RFC 4180.

// Quote a single CSV field: wrap in double quotes, escape internal quotes.
function csvField(v) {
  if (v === null || v === undefined) return '""';
  return '"' + String(v).replace(/"/g, '""') + '"';
}

// Build a CSV string from a header row + body rows.
function buildCSV(headers, rows) {
  const sep = ';';
  const lines = [headers.map(csvField).join(sep)];
  for (const row of rows) lines.push(row.map(csvField).join(sep));
  // BOM for Excel UTF-8 detection + CRLF line endings (RFC 4180)
  return '\ufeff' + lines.join('\r\n') + '\r\n';
}

// Reconstruct net + tax for a single snapshot (mirrors computeKPIs / quarter
// breakdown logic). Returns { net, tax }.
function snapshotNetTax(s) {
  const items = s.form && Array.isArray(s.form.items) ? s.form.items : [];
  const mode = s.form && s.form.taxmode;
  let net = 0, tax = 0;
  for (const it of items) {
    const line = (Number(it.qty) || 0) * (Number(it.price) || 0);
    net += line;
    if (mode === 'S') tax += line * (Number(it.vat) || 0) / 100;
  }
  if (net === 0) net = Number(s.total) || 0;
  return { net: round2(net), tax: round2(tax) };
}

// Format a number for CSV: decimal point, two fraction digits, no thousands.
function csvNum(n) {
  return (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
}

// Export the current overview view: all snapshots in the active period.
function exportOverviewCSV() {
  const period = $('statsPeriod').value;
  const filtered = filterByPeriod(state.history, period);
  if (filtered.length === 0) { flash(t('msg_csv_no_data'), 'err'); return; }
  // Newest first
  const sorted = filtered.slice().sort((a, b) => {
    const ta = a.date ? new Date(a.date).getTime() : a.ts;
    const tb = b.date ? new Date(b.date).getTime() : b.ts;
    return tb - ta;
  });
  const headers = ['Date', 'Number', 'Buyer', 'Currency', 'Net', 'VAT', 'Gross', 'Mode', 'Category', 'Project', 'Source'];
  const rows = sorted.map(s => {
    const { net, tax } = snapshotNetTax(s);
    return [
      s.date || '',
      s.number || '',
      s.buyerName || '',
      s.currency || 'EUR',
      csvNum(net),
      csvNum(tax),
      csvNum(s.total),
      (s.form && s.form.taxmode) || '',
      (s.form && s.form.category) || '',
      (s.form && s.form.project) || '',
      s.imported ? 'manual' : 'generated',
    ];
  });
  const csv = buildCSV(headers, rows);
  const ts = new Date().toISOString().slice(0, 10);
  const periodLabel = period.replace(/[^a-z0-9]/gi, '_');
  downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }),
    `erechnung-stats-${periodLabel}-${ts}.csv`);
  flash(t('msg_csv_exported'), 'ok');
}

// Export the quarterly tax breakdown for the selected year.
function exportQuartersCSV() {
  const inYear = state.history.filter(s => {
    if (!s.date) return false;
    const d = new Date(s.date);
    return !Number.isNaN(d.getTime()) && d.getFullYear() === statsYear;
  });
  if (inYear.length === 0) { flash(t('msg_csv_no_data'), 'err'); return; }
  const groups = groupByCurrency(inYear);
  const headers = ['Currency', 'Quarter',
    'Standard Net', 'Standard VAT',
    'Reverse Charge Net', 'Zero Rate Net', 'Exempt Net', 'Out of Scope Net'];
  const rows = [];
  for (const [cur, list] of groups.entries()) {
    const breakdown = computeQuarterlyBreakdown(list, statsYear);
    for (const qb of breakdown.quarters) {
      rows.push([
        cur, `Q${qb.q}`,
        csvNum(qb.S.net), csvNum(qb.S.tax),
        csvNum(qb.AE.net), csvNum(qb.Z.net), csvNum(qb.E.net), csvNum(qb.O.net),
      ]);
    }
    const yt = breakdown.yearTotals;
    rows.push([
      cur, `${statsYear} Total`,
      csvNum(yt.S.net), csvNum(yt.S.tax),
      csvNum(yt.AE.net), csvNum(yt.Z.net), csvNum(yt.E.net), csvNum(yt.O.net),
    ]);
  }
  const csv = buildCSV(headers, rows);
  downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }),
    `erechnung-quarters-${statsYear}.csv`);
  flash(t('msg_csv_exported'), 'ok');
}

// Export the buyer drill-down: all invoices for the currently-drilled buyer.
function exportBuyerCSV() {
  if (!statsBuyerDrillDown) { flash(t('msg_csv_no_data'), 'err'); return; }
  const target = statsBuyerDrillDown.toLowerCase().trim();
  const matched = state.history.filter(s =>
    (s.buyerName || '').toLowerCase().trim() === target);
  if (matched.length === 0) { flash(t('msg_csv_no_data'), 'err'); return; }
  const sorted = matched.slice().sort((a, b) => {
    const ta = a.date ? new Date(a.date).getTime() : a.ts;
    const tb = b.date ? new Date(b.date).getTime() : b.ts;
    return tb - ta;
  });
  const headers = ['Date', 'Number', 'Currency', 'Net', 'VAT', 'Gross', 'Mode', 'Category', 'Project', 'Source'];
  const rows = sorted.map(s => {
    const { net, tax } = snapshotNetTax(s);
    return [
      s.date || '',
      s.number || '',
      s.currency || 'EUR',
      csvNum(net),
      csvNum(tax),
      csvNum(s.total),
      (s.form && s.form.taxmode) || '',
      (s.form && s.form.category) || '',
      (s.form && s.form.project) || '',
      s.imported ? 'manual' : 'generated',
    ];
  });
  const csv = buildCSV(headers, rows);
  // Sanitize buyer name for filename
  const slug = statsBuyerDrillDown.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }),
    `erechnung-buyer-${slug || 'export'}.csv`);
  flash(t('msg_csv_exported'), 'ok');
}

// Dispatcher: exports based on the active stats view.
function exportStatsCSV() {
  if (state.history.length === 0) { flash(t('msg_csv_no_data'), 'err'); return; }
  if (statsView === 'quarters') {
    exportQuartersCSV();
  } else if (statsBuyerDrillDown) {
    exportBuyerCSV();
  } else {
    exportOverviewCSV();
  }
}

function openStatsModal() {
  const modal = $('statsModal');
  if (!modal) return;
  // Always start at overview, no drill-down
  statsBuyerDrillDown = null;
  statsView = 'overview';
  modal.classList.add('open');
  modal.removeAttribute('hidden');
  updateYoYToggleButton();
  renderStatistics();
}
function closeStatsModal() {
  const modal = $('statsModal');
  if (!modal) return;
  modal.classList.remove('open');
  modal.setAttribute('hidden', '');
}

// -------- Items --------
function addItem(data = {}) {
  const item = {
    id: crypto.randomUUID(),
    desc: data.desc || '',
    qty: data.qty ?? 1,
    unit: data.unit || 'C62',
    price: data.price ?? 0,
    vat: data.vat ?? 20,
  };
  state.items.push(item);
  renderItems();
}

function renderItems() {
  const container = $('items');
  // Remove all rows except head
  [...container.querySelectorAll('.row:not(.head)')].forEach(r => r.remove());

  for (const it of state.items) {
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.id = it.id;
    row.innerHTML = `
      <div class="cell desc" data-label="${esc(t('th_desc'))}">
        <input type="text" data-k="desc" value="${esc(it.desc)}" placeholder="${esc(t('item_placeholder'))}">
      </div>
      <div class="cell num" data-label="${esc(t('th_qty'))}">
        <input type="number" step="0.01" data-k="qty" value="${it.qty}">
      </div>
      <div class="cell num" data-label="${esc(t('th_price'))}">
        <input type="number" step="0.01" data-k="price" value="${it.price}">
      </div>
      <div class="cell num" data-label="${esc(t('th_vat'))}">
        <input type="number" step="0.1" data-k="vat" value="${it.vat}">
      </div>
      <div class="cell">
        <button class="remove" data-remove aria-label="${esc(t('aria_remove_item'))}">×</button>
      </div>
    `;
    container.appendChild(row);

    row.querySelectorAll('[data-k]').forEach(el => {
      el.addEventListener('input', () => {
        const k = el.dataset.k;
        let v = el.value;
        if (['qty','price','vat'].includes(k)) v = parseFloat(v) || 0;
        it[k] = v;
        calcTotals();
      });
    });
    row.querySelector('[data-remove]').addEventListener('click', () => {
      state.items = state.items.filter(x => x.id !== it.id);
      renderItems();
    });
  }
  calcTotals();
}

function calcTotals() {
  const mode = $('r_taxmode').value;
  let net = 0, tax = 0;
  for (const it of state.items) {
    const line = (Number(it.qty) || 0) * (Number(it.price) || 0);
    net += line;
    if (mode === 'S') tax += line * (Number(it.vat) || 0) / 100;
  }
  net = round2(net);
  tax = round2(tax);
  const grand = round2(net + tax);

  $('t_net').textContent = fmt(net);
  $('t_tax').textContent = fmt(tax);
  $('t_total').textContent = fmt(grand);

  $('t_tax_label').textContent = t('total_tax_' + mode) || t('total_tax_S');
  $('taxNote').textContent = mode === 'S' ? '' : t('rc_note' + (mode === 'AE' ? '' : '_' + mode));

  return { net, tax, grand };
}

// -------- PDF drop --------
const drop = $('drop');
const fileInput = $('file');

drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragover'); });
drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
drop.addEventListener('drop', e => {
  e.preventDefault();
  drop.classList.remove('dragover');
  if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', e => { if (e.target.files[0]) setFile(e.target.files[0]); });

function setFile(f) {
  if (!f.name.toLowerCase().endsWith('.pdf') && f.type !== 'application/pdf') {
    flash(t('msg_pdf_select_first'), 'err'); return;
  }
  state.pdfFile = f;
  drop.classList.add('has-file');
  $('fname').textContent = f.name;
}

// -------- Country normalization (ISO 3166-1 alpha-2) --------
// Originally declared inside buildXML(), which meant the alias map was
// rebuilt and re-frozen on every invoice render. They have no closure
// dependencies, so they live here at module scope.
const COUNTRY_ALIAS_MAP = Object.freeze({
  "ALLEMAGNE":"DE","AMERICA":"US","AMERIKA":"US","AT":"AT","AU":"AU",
  "AUSTRALIA":"AU","AUSTRALIE":"AU","AUSTRALIEN":"AU","AUSTRIA":"AT",
  "AUTRICHE":"AT","BE":"BE","BELGIE":"BE","BELGIEN":"BE","BELGIQUE":"BE",
  "BELGIUM":"BE","BELGIË":"BE","BG":"BG","BR":"BR","BRASIL":"BR",
  "BRASILIEN":"BR","BRAZIL":"BR","BRESIL":"BR","BRITAIN":"GB","BRÉSIL":"BR",
  "BULGARIA":"BG","BULGARIE":"BG","BULGARIEN":"BG","CA":"CA","CANADA":"CA",
  "CESKO":"CZ","CH":"CH","CHINA":"CN","CHYPRE":"CY","CN":"CN",
  "CROATIA":"HR","CROATIE":"HR","CY":"CY","CYPRUS":"CY","CZ":"CZ",
  "CZECH REPUBLIC":"CZ","CZECHIA":"CZ","DAENEMARK":"DK","DANEMARK":"DK",
  "DANMARK":"DK","DE":"DE","DENMARK":"DK","DEUTSCHLAND":"DE","DK":"DK",
  "DÄNEMARK":"DK","EE":"EE","EESTI":"EE","EIRE":"IE","EL":"GR",
  "ELLADA":"GR","ENGLAND":"GB","ES":"ES","ESPAGNE":"ES","ESPANA":"ES",
  "ESPAÑA":"ES","ESTLAND":"EE","ESTONIA":"EE","ESTONIE":"EE",
  "ETATS-UNIS":"US","FI":"FI","FINLAND":"FI","FINLANDE":"FI","FINNLAND":"FI",
  "FR":"FR","FRANCE":"FR","FRANKREICH":"FR","GB":"GB","GER":"DE",
  "GERMANY":"DE","GR":"GR","GREAT BRITAIN":"GB","GRECE":"GR","GREECE":"GR",
  "GRIECHENLAND":"GR","GROSSBRITANNIEN":"GB","GROßBRITANNIEN":"GB","GRÈCE":"GR",
  "HELLAS":"GR","HOLLAND":"NL","HONGRIE":"HU","HR":"HR","HRVATSKA":"HR",
  "HU":"HU","HUNGARY":"HU","ICELAND":"IS","IE":"IE","IN":"IN",
  "INDE":"IN","INDIA":"IN","INDIEN":"IN","IRELAND":"IE","IRLAND":"IE",
  "IRLANDE":"IE","IS":"IS","ISLAND":"IS","ISLANDE":"IS","IT":"IT",
  "ITALIA":"IT","ITALIE":"IT","ITALIEN":"IT","ITALY":"IT","JAPAN":"JP",
  "JAPON":"JP","JP":"JP","KANADA":"CA","KROATIEN":"HR","LATVIA":"LV",
  "LATVIJA":"LV","LETTLAND":"LV","LETTONIE":"LV","LI":"LI",
  "LIECHTENSTEIN":"LI","LIETUVA":"LT","LITAUEN":"LT","LITHUANIA":"LT",
  "LITUANIE":"LT","LT":"LT","LU":"LU","LUXEMBOURG":"LU","LUXEMBURG":"LU",
  "LV":"LV","MAGYARORSZAG":"HU","MAGYARORSZÁG":"HU","MALTA":"MT","MALTE":"MT",
  "MEXICO":"MX","MEXIKO":"MX","MEXIQUE":"MX","MT":"MT","MX":"MX",
  "NEDERLAND":"NL","NETHERLANDS":"NL","NEUSEELAND":"NZ","NEW ZEALAND":"NZ",
  "NIEDERLANDE":"NL","NL":"NL","NO":"NO","NORGE":"NO","NORTHERN IRELAND":"GB",
  "NORVEGE":"NO","NORVÈGE":"NO","NORWAY":"NO","NORWEGEN":"NO",
  "NOUVELLE-ZELANDE":"NZ","NOUVELLE-ZÉLANDE":"NZ","NZ":"NZ","OESTERREICH":"AT",
  "PAYS-BAS":"NL","PL":"PL","POLAND":"PL","POLEN":"PL","POLOGNE":"PL",
  "POLSKA":"PL","PORTUGAL":"PT","PT":"PT","RO":"RO","ROMANIA":"RO",
  "ROUMANIE":"RO","ROYAUME UNI":"GB","ROYAUME-UNI":"GB","RS":"RS",
  "RUMAENIEN":"RO","RUMÄNIEN":"RO","SCHWEDEN":"SE","SCHWEIZ":"CH",
  "SCOTLAND":"GB","SE":"SE","SERBIA":"RS","SERBIE":"RS","SERBIEN":"RS",
  "SI":"SI","SK":"SK","SLOVAKIA":"SK","SLOVAQUIE":"SK","SLOVENIA":"SI",
  "SLOVENIE":"SI","SLOVENIJA":"SI","SLOVENSKO":"SK","SLOVÉNIE":"SI",
  "SLOWAKEI":"SK","SLOWENIEN":"SI","SPAIN":"ES","SPANIEN":"ES","SRBIJA":"RS",
  "SUEDE":"SE","SUISSE":"CH","SUOMI":"FI","SUÈDE":"SE","SVERIGE":"SE",
  "SVIZZERA":"CH","SWEDEN":"SE","SWITZERLAND":"CH","THE NETHERLANDS":"NL",
  "TR":"TR","TSCHECHIEN":"CZ","TSCHECHISCHE REPUBLIK":"CZ","TUERKEI":"TR",
  "TURKEY":"TR","TURKIYE":"TR","TURQUIE":"TR","TÜRKEI":"TR","TÜRKIYE":"TR",
  "UA":"UA","UK":"GB","UKRAINE":"UA","UNGARN":"HU","UNITED KINGDOM":"GB",
  "UNITED STATES":"US","UNITED STATES OF AMERICA":"US","US":"US","USA":"US",
  "VEREINIGTE STAATEN":"US","VEREINIGTES KOENIGREICH":"GB",
  "VEREINIGTES KÖNIGREICH":"GB","WALES":"GB","ZYPERN":"CY","ÉIRE":"IE",
  "ÉTATS-UNIS":"US","ÖSTERREICH":"AT","ČESKO":"CZ",
});

function normalizeCountry(input) {
  if (!input || typeof input !== 'string') {
    throw new Error(t('err_country_required'));
  }
  const key = input.trim().toUpperCase().replace(/\s+/g, ' ').replace(/\.$/, '');
  if (key in COUNTRY_ALIAS_MAP) return COUNTRY_ALIAS_MAP[key];
  // Fall through: any unknown 2-letter uppercase code (e.g. exotic ISO codes)
  if (/^[A-Z]{2}$/.test(key)) return key;
  throw new Error(t('err_country_unknown', { input }));
}

// ISO code -> human-readable English name. Used by layout renderers to print
// "Germany" rather than "DE" on invoices. Falls back to the input if unknown.
const COUNTRY_NAMES = Object.freeze({
  DE: 'Germany', FR: 'France', AT: 'Austria', CH: 'Switzerland',
  IT: 'Italy', ES: 'Spain', NL: 'Netherlands', BE: 'Belgium',
  GB: 'United Kingdom', US: 'United States', LU: 'Luxembourg',
  DK: 'Denmark', SE: 'Sweden', NO: 'Norway', FI: 'Finland',
  PL: 'Poland', CZ: 'Czech Republic', PT: 'Portugal', IE: 'Ireland',
});

export function countryName(code) {
  return COUNTRY_NAMES[code?.toUpperCase()] || code;
}

// Validates business rules that depend on tax categories
function validateInvoiceForReverseCharge(seller, buyer, itemsXML, taxBreakdownXML) {
  const combined = String(itemsXML || '') + String(taxBreakdownXML || '');
  const usesReverseCharge = /<ram:CategoryCode>AE<\/ram:CategoryCode>/.test(combined);
  if (!usesReverseCharge) return;
  // BR-AE-02: Seller side
  if (!seller.vat && !seller.siret) {
    throw new Error(t('err_rc_seller_vat'));
  }
  // BR-AE-02: Buyer side
  if (!buyer.vat && !buyer.siret) {
    throw new Error(t('err_rc_buyer_vat'));
  }
}

// -------- XML generation (Factur-X EN 16931 / Comfort) --------
function buildXML() {
  const seller = collectSeller();
  const buyer = collectBuyer();
  const number = $('r_number').value.trim();
  const date = $('r_date').value;
  const delivery = $('r_delivery').value || date;
  const deliveryEnd = $('r_delivery_end').value;
  const due = $('r_due').value;
  const currency = $('r_currency').value;
  const mode = $('r_taxmode').value;
  const note = $('r_note').value.trim();

  if (!number) throw new Error(t('err_no_number'));
  if (!date) throw new Error(t('err_no_date'));
  if (!seller.name) throw new Error(t('err_no_seller_name'));
  if (!buyer.name) throw new Error(t('err_no_buyer_name'));
  if (state.items.length === 0) throw new Error(t('err_no_items'));

  const totals = calcTotals();

  // Group items by VAT rate for tax breakdown
  const taxGroups = {};
  for (const it of state.items) {
    const rate = mode === 'S' ? (Number(it.vat) || 0) : 0;
    const key = rate.toFixed(2);
    if (!taxGroups[key]) taxGroups[key] = { rate, basis: 0, amount: 0 };
    const line = round2((Number(it.qty) || 0) * (Number(it.price) || 0));
    taxGroups[key].basis = round2(taxGroups[key].basis + line);
    if (mode === 'S') taxGroups[key].amount = round2(taxGroups[key].amount + line * rate / 100);
  }

  const reverseChargeNote = mode === 'S' ? '' : tInvoice('rc_note' + (mode === 'AE' ? '' : '_' + mode));

  const guidelineID = 'urn:cen.eu:en16931:2017';

  // Build line items XML
  const itemsXML = state.items.map((it, i) => {
    const lineNet = round2((Number(it.qty) || 0) * (Number(it.price) || 0));
    const rate = mode === 'S' ? (Number(it.vat) || 0) : 0;
    return `
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument>
        <ram:LineID>${i + 1}</ram:LineID>
      </ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct>
        <ram:Name>${esc(it.desc || 'Leistung')}</ram:Name>
      </ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement>
        <ram:NetPriceProductTradePrice>
          <ram:ChargeAmount>${(Number(it.price) || 0).toFixed(2)}</ram:ChargeAmount>
        </ram:NetPriceProductTradePrice>
      </ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery>
        <ram:BilledQuantity unitCode="${esc(it.unit || 'C62')}">${(Number(it.qty) || 0).toFixed(2)}</ram:BilledQuantity>
      </ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax>
          <ram:TypeCode>VAT</ram:TypeCode>
          <ram:CategoryCode>${mode}</ram:CategoryCode>
          <ram:RateApplicablePercent>${rate.toFixed(2)}</ram:RateApplicablePercent>
        </ram:ApplicableTradeTax>
        <ram:SpecifiedTradeSettlementLineMonetarySummation>
          <ram:LineTotalAmount>${lineNet.toFixed(2)}</ram:LineTotalAmount>
        </ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>`;
  }).join('');

  // Exemption reason codes per VAT mode (EN 16931 / CEF VATEX list)
  const exemptionCodes = {
    AE: 'VATEX-EU-AE',
    Z: '',
    E: 'VATEX-EU-132',
    O: 'VATEX-EU-O',
  };

  // Tax breakdown XML
  const taxBreakdownXML = Object.values(taxGroups).map(g => `
      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>${g.amount.toFixed(2)}</ram:CalculatedAmount>
        <ram:TypeCode>VAT</ram:TypeCode>
        ${mode !== 'S' && reverseChargeNote ? `<ram:ExemptionReason>${esc(reverseChargeNote)}</ram:ExemptionReason>` : ''}
        <ram:BasisAmount>${g.basis.toFixed(2)}</ram:BasisAmount>
        <ram:CategoryCode>${mode}</ram:CategoryCode>
        ${exemptionCodes[mode] ? `<ram:ExemptionReasonCode>${exemptionCodes[mode]}</ram:ExemptionReasonCode>` : ''}
        <ram:RateApplicablePercent>${g.rate.toFixed(2)}</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>`).join('');

  const paymentMeansXML = seller.iban ? `
      <ram:SpecifiedTradeSettlementPaymentMeans>
        <ram:TypeCode>58</ram:TypeCode>
        <ram:Information>${esc(tInvoice('xml_sepa_info'))}</ram:Information>
        <ram:PayeePartyCreditorFinancialAccount>
          <ram:IBANID>${esc(seller.iban)}</ram:IBANID>
          ${seller.bank ? `<ram:AccountName>${esc(seller.bank)}</ram:AccountName>` : ''}
        </ram:PayeePartyCreditorFinancialAccount>
        ${seller.bic ? `<ram:PayeeSpecifiedCreditorFinancialInstitution><ram:BICID>${esc(seller.bic)}</ram:BICID></ram:PayeeSpecifiedCreditorFinancialInstitution>` : ''}
      </ram:SpecifiedTradeSettlementPaymentMeans>` : `
      <ram:SpecifiedTradeSettlementPaymentMeans>
        <ram:TypeCode>1</ram:TypeCode>
      </ram:SpecifiedTradeSettlementPaymentMeans>`;

  const notesXML = (mode !== 'S' || note) ? `
    <ram:IncludedNote>
      <ram:Content>${esc([note, reverseChargeNote].filter(Boolean).join(' · '))}</ram:Content>
      ${mode === 'AE' ? '<ram:SubjectCode>AAK</ram:SubjectCode>' : ''}
    </ram:IncludedNote>` : '';

    validateInvoiceForReverseCharge(seller, buyer, itemsXML, taxBreakdownXML);
  
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice
  xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"
  xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100"
  xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"
  xmlns:xs="http://www.w3.org/2001/XMLSchema"
  xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocumentContext>
    <ram:GuidelineSpecifiedDocumentContextParameter>
      <ram:ID>${guidelineID}</ram:ID>
    </ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>${esc(number)}</ram:ID>
    <ram:TypeCode>380</ram:TypeCode>
    <ram:IssueDateTime>
      <udt:DateTimeString format="102">${dateCompact(date)}</udt:DateTimeString>
    </ram:IssueDateTime>${notesXML}
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>${itemsXML}
    <ram:ApplicableHeaderTradeAgreement>
      ${buyer.reference ? `<ram:BuyerReference>${esc(buyer.reference)}</ram:BuyerReference>` : ''}
      <ram:SellerTradeParty>
        <ram:Name>${esc(seller.name)}</ram:Name>
        ${seller.siret ? `
        <ram:SpecifiedLegalOrganization>
          <ram:ID schemeID="${seller.siret.replace(/\s/g, '').length === 14 ? '0002' : '0009'}">${esc(seller.siret.replace(/\s/g, ''))}</ram:ID>
        </ram:SpecifiedLegalOrganization>` : ''}
        ${seller.phone || seller.email ? `
        <ram:DefinedTradeContact>
          <ram:PersonName>${esc(seller.name)}</ram:PersonName>
          ${seller.phone ? `<ram:TelephoneUniversalCommunication><ram:CompleteNumber>${esc(seller.phone)}</ram:CompleteNumber></ram:TelephoneUniversalCommunication>` : ''}
          ${seller.email ? `<ram:EmailURIUniversalCommunication><ram:URIID>${esc(seller.email)}</ram:URIID></ram:EmailURIUniversalCommunication>` : ''}
        </ram:DefinedTradeContact>` : ''}
        <ram:PostalTradeAddress>
          <ram:PostcodeCode>${esc(seller.zip)}</ram:PostcodeCode>
          <ram:LineOne>${esc(seller.line1)}</ram:LineOne>
          <ram:CityName>${esc(seller.city)}</ram:CityName>
          <ram:CountryID>${normalizeCountry(seller.country)}</ram:CountryID>
        </ram:PostalTradeAddress>
        ${seller.vat ? `
        <ram:SpecifiedTaxRegistration>
          <ram:ID schemeID="VA">${esc(seller.vat)}</ram:ID>
        </ram:SpecifiedTaxRegistration>` : ''}
      </ram:SellerTradeParty>
      <ram:BuyerTradeParty>
        <ram:Name>${esc(buyer.name)}</ram:Name>
        ${buyer.siret ? `
        <ram:SpecifiedLegalOrganization>
          <ram:ID schemeID="${buyer.siret.replace(/\s/g, '').length === 14 ? '0002' : '0009'}">${esc(buyer.siret.replace(/\s/g, ''))}</ram:ID>
        </ram:SpecifiedLegalOrganization>` : ''}
        <ram:PostalTradeAddress>
          <ram:PostcodeCode>${esc(buyer.zip)}</ram:PostcodeCode>
          <ram:LineOne>${esc(buyer.line1)}</ram:LineOne>
          <ram:CityName>${esc(buyer.city)}</ram:CityName>
          <ram:CountryID>${normalizeCountry(buyer.country)}</ram:CountryID>
        </ram:PostalTradeAddress>
        ${buyer.vat ? `
        <ram:SpecifiedTaxRegistration>
          <ram:ID schemeID="VA">${esc(buyer.vat)}</ram:ID>
        </ram:SpecifiedTaxRegistration>` : ''}
      </ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery>
      <ram:ActualDeliverySupplyChainEvent>
        <ram:OccurrenceDateTime>
          <udt:DateTimeString format="102">${dateCompact(delivery)}</udt:DateTimeString>
        </ram:OccurrenceDateTime>
      </ram:ActualDeliverySupplyChainEvent>
    </ram:ApplicableHeaderTradeDelivery>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>${esc(currency)}</ram:InvoiceCurrencyCode>${paymentMeansXML}${taxBreakdownXML}
      ${deliveryEnd && deliveryEnd !== delivery ? `
      <ram:BillingSpecifiedPeriod>
        <ram:StartDateTime>
          <udt:DateTimeString format="102">${dateCompact(delivery)}</udt:DateTimeString>
        </ram:StartDateTime>
        <ram:EndDateTime>
          <udt:DateTimeString format="102">${dateCompact(deliveryEnd)}</udt:DateTimeString>
        </ram:EndDateTime>
      </ram:BillingSpecifiedPeriod>` : ''}
      ${due ? `
      <ram:SpecifiedTradePaymentTerms>
        <ram:Description>${esc(tInvoice('xml_payable_by', { date: due }))}</ram:Description>
        <ram:DueDateDateTime>
          <udt:DateTimeString format="102">${dateCompact(due)}</udt:DateTimeString>
        </ram:DueDateDateTime>
      </ram:SpecifiedTradePaymentTerms>` : ''}
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>${totals.net.toFixed(2)}</ram:LineTotalAmount>
        <ram:TaxBasisTotalAmount>${totals.net.toFixed(2)}</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="${esc(currency)}">${totals.tax.toFixed(2)}</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>${totals.grand.toFixed(2)}</ram:GrandTotalAmount>
        <ram:DuePayableAmount>${totals.grand.toFixed(2)}</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`;

  return xml;
}

// -------- Actions --------
function flash(msg, kind = '') {
  const s = $('status');
  s.className = 'status show ' + (kind || '');
  s.textContent = msg;
  if (kind === 'ok') setTimeout(() => s.classList.remove('show'), 3500);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 200);
}

$('btnXML').addEventListener('click', () => {
  try {
    const xml = buildXML();
    const number = $('r_number').value.trim() || 'rechnung';
    downloadBlob(new Blob([xml], { type: 'application/xml' }), `${number}.xml`);
    flash(t('msg_xml_done'), 'ok');
  } catch (e) {
    flash(t('msg_error') + ' ' + e.message, 'err');
  }
});

$('btnValidate').addEventListener('click', () => {
  try {
    const xml = buildXML();
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'application/xml');
    const errNode = doc.querySelector('parsererror');
    if (errNode) throw new Error('XML-Syntaxfehler: ' + errNode.textContent);
    const nums = state.items.map(it => (Number(it.qty)||0) * (Number(it.price)||0));
    const mode = $('r_taxmode').value;
    const checks = [
      $('r_number').value.trim() ? null : 'Rechnungsnummer (BT-1) fehlt',
      $('r_date').value ? null : 'Rechnungsdatum (BT-2) fehlt',
      $('s_name').value.trim() ? null : 'Verkäufer-Name (BT-27) fehlt',
      $('b_name').value.trim() ? null : 'Käufer-Name (BT-44) fehlt',
      $('s_country').value.trim() ? null : 'Verkäufer-Land (BT-40) fehlt',
      $('b_country').value.trim() ? null : 'Käufer-Land (BT-55) fehlt',
      mode === 'AE' && !$('s_vat').value.trim() ? 'Reverse Charge: deine USt-IdNr (BT-31) ist Pflicht' : null,
      mode === 'AE' && !$('b_vat').value.trim() ? 'Reverse Charge: Käufer-USt-IdNr (BT-48) ist Pflicht' : null,
      mode === 'S' && !$('s_vat').value.trim() ? 'USt-IdNr Verkäufer (BT-31) empfohlen' : null,
      state.items.length > 0 ? null : 'Mindestens eine Position erforderlich',
      nums.every(x => x >= 0) ? null : 'Negative Summen in Positionen',
    ].filter(Boolean);
    if (checks.length === 0) {
      flash(t('msg_xml_valid'), 'ok');
    } else {
      flash(t('msg_xml_warnings') + '\n• ' + checks.join('\n• '), 'err');
    }
  } catch (e) {
    flash(t('msg_error') + ' ' + e.message, 'err');
  }
});

// -------- Font loader: 5 monospace options embedded as base64 --------
// All font data lives in FONT_DATA (defined at the bottom of this script).
// The tool runs fully offline; no network calls at runtime.
const FONT_OPTIONS = {
  'courier-prime':  { label: 'Courier Prime',  description: 'Klassische Schreibmaschine · classic typewriter' },
  'ibm-plex-mono':  { label: 'IBM Plex Mono',  description: 'Moderne Slab-Serifen · modern slab serifs' },
  'jetbrains-mono': { label: 'JetBrains Mono', description: 'Geometrisch · geometric, neutral' },
  'inconsolata':    { label: 'Inconsolata',    description: 'Schmal · narrow, clean' },
  'space-mono':     { label: 'Space Mono',     description: 'Retro-Geometrie · retro display' },
};
const DEFAULT_FONT_KEY = 'courier-prime';
const FONT_KEY = 'erechnung:font:v1';

// Per-font cache so repeated PDF generation doesn't re-decode the WOFF.
const _fontDataCache = {};

async function getCurrentFontKey() {
  const v = await store.get(FONT_KEY);
  return v && FONT_OPTIONS[v] ? v : DEFAULT_FONT_KEY;
}

// Decode a base64 string into a Uint8Array (browser-safe, no Buffer).
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function loadInvoiceFonts(pdfDoc) {
  const key = await getCurrentFontKey();
  if (!_fontDataCache[key]) {
    try {
      const data = (typeof FONT_DATA !== 'undefined') && FONT_DATA[key];
      if (!data) throw new Error('font data missing for ' + key);
      _fontDataCache[key] = {
        reg:  woffToSfnt(base64ToBytes(data.reg)),
        bold: woffToSfnt(base64ToBytes(data.bold)),
      };
    } catch (e) {
      console.warn(`Font "${key}" failed to decode, using Courier fallback:`, e);
      _fontDataCache[key] = false;
    }
  }
  const fontTables = _fontDataCache[key];
  if (fontTables && fontTables.reg) {
    pdfDoc.registerFontkit(fontkit);
    const mono     = await pdfDoc.embedFont(fontTables.reg,  { subset: true });
    const monoBold = await pdfDoc.embedFont(fontTables.bold, { subset: true });
    return { mono, monoBold, synthBold: false };
  }
  // Hard fallback: PDF built-in Courier (always available, no network).
  const mono     = await pdfDoc.embedFont(StandardFonts.Courier);
  const monoBold = await pdfDoc.embedFont(StandardFonts.CourierBold);
  return { mono, monoBold, synthBold: false };
}

// Minimal WOFF -> SFNT (TTF) decoder. WOFF1 wraps SFNT tables with optional
// zlib compression per table. We use DecompressionStream where available.
function woffToSfnt(woff) {
  const dv = new DataView(woff.buffer, woff.byteOffset, woff.byteLength);
  // WOFF header: signature 'wOFF' (0x774F4646)
  const sig = dv.getUint32(0, false);
  if (sig !== 0x774F4646) throw new Error('Not a WOFF file');
  const flavor = dv.getUint32(4, false);
  const numTables = dv.getUint16(12, false);
  // Compute SFNT header values
  const log2 = (n) => Math.floor(Math.log2(n));
  const entrySelector = log2(numTables);
  const searchRange = (1 << entrySelector) * 16;
  const rangeShift = numTables * 16 - searchRange;

  // Read WOFF table directory
  const tables = [];
  let woffOff = 44;
  for (let i = 0; i < numTables; i++) {
    const tag = dv.getUint32(woffOff, false);
    const offset = dv.getUint32(woffOff + 4, false);
    const compLength = dv.getUint32(woffOff + 8, false);
    const origLength = dv.getUint32(woffOff + 12, false);
    const origChecksum = dv.getUint32(woffOff + 16, false);
    tables.push({ tag, offset, compLength, origLength, origChecksum });
    woffOff += 20;
  }

  // Decompress tables synchronously? We need sync. Use pako-like via DecompressionStream
  // — but DecompressionStream is async. Use a small inflate implementation instead.
  // For simplicity here: use a tiny synchronous inflate (puff-like). To avoid bundling
  // a full inflater, we use the trick: most modern browsers also expose `pako` via CDN.
  // Cleaner: just refuse compressed tables and inflate via the global `pako` if present,
  // otherwise emit them as-is (which only works for uncompressed tables — rare).
const inflate = (compressed, originalLen) => {
  if (compressed.length === originalLen) return compressed;
  return pako.inflate(compressed);
};

  // Decompress and lay out SFNT
  const decompressed = [];
  for (const t of tables) {
    const compressed = woff.subarray(t.offset, t.offset + t.compLength);
    const data = t.compLength !== t.origLength ? inflate(compressed, t.origLength) : compressed;
    decompressed.push({ ...t, data });
  }

  // Build SFNT
  const sfntHeaderSize = 12;
  const sfntDirSize = 16 * numTables;
  let totalSize = sfntHeaderSize + sfntDirSize;
  for (const t of decompressed) totalSize += (t.origLength + 3) & ~3;

  const out = new Uint8Array(totalSize);
  const outDv = new DataView(out.buffer);
  outDv.setUint32(0, flavor, false);
  outDv.setUint16(4, numTables, false);
  outDv.setUint16(6, searchRange, false);
  outDv.setUint16(8, entrySelector, false);
  outDv.setUint16(10, rangeShift, false);

  // Sort tables by tag (SFNT requires this)
  decompressed.sort((a, b) => a.tag - b.tag);
  let dataOffset = sfntHeaderSize + sfntDirSize;
  let dirOffset = sfntHeaderSize;
  for (const t of decompressed) {
    outDv.setUint32(dirOffset, t.tag, false);
    outDv.setUint32(dirOffset + 4, t.origChecksum, false);
    outDv.setUint32(dirOffset + 8, dataOffset, false);
    outDv.setUint32(dirOffset + 12, t.origLength, false);
    dirOffset += 16;
    out.set(t.data, dataOffset);
    dataOffset += (t.origLength + 3) & ~3;
  }
  return out;
}

// -------- PDF generation: dispatcher --------
// generateInvoicePDF() prepares a shared invoice context, then hands off to
// the layout renderer chosen by the user. To add or modify layouts, edit
// the LAYOUT BLOCK at the bottom (search for "INVOICE LAYOUT BLOCK").

const LAYOUT_KEY = 'erechnung:layout:v1';

async function getCurrentLayout() {
  const v = await store.get(LAYOUT_KEY);
  return v && LAYOUTS[v] ? v : DEFAULT_LAYOUT;
}

async function generateInvoicePDF() {
  const pdfDoc = await PDFDocument.create();
  const ctx = await buildInvoiceContext(pdfDoc);
  const layoutKey = await getCurrentLayout();
  const renderer = (LAYOUTS[layoutKey] || LAYOUTS[DEFAULT_LAYOUT]).render;
  await renderer(pdfDoc, ctx);
  return pdfDoc;
}

// Collect every piece of data the layout renderers need: form values,
// totals, fonts, and a small kit of formatting/drawing helpers shared
// across all layouts.
async function buildInvoiceContext(pdfDoc) {
  const fonts = await loadInvoiceFonts(pdfDoc);

  const seller = collectSeller();
  const buyer = collectBuyer();
  const mode = $('r_taxmode').value;
  const number = $('r_number').value.trim();
  const date = $('r_date').value;
  const delivery = $('r_delivery').value || date;
  const deliveryEnd = $('r_delivery_end').value;
  const due = $('r_due').value;
  const currency = $('r_currency').value;
  const project = $('r_project').value.trim();
  const category = $('r_category').value.trim();
  const intro = $('r_intro').value.trim();
  const paymentNoteTpl = $('r_payment_note').value.trim();
  const greeting = $('r_greeting').value.trim();
  const signature = ($('r_signature').value.trim() || seller.name || '');
  const footnote = $('r_footnote').value.trim();
  const totals = calcTotals();
  const currencySym = { EUR: '\u20ac', USD: '$', GBP: '\u00a3', CHF: 'CHF' }[currency] || currency;

  const fmtDate = (iso) => {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    return `${d}.${m}.${y}`;
  };
  const fmtMoney = (n) => `${fmtPDF(n)} ${currencySym}`;
  const paymentNote = paymentNoteTpl.replace(/\{due\}/gi, due ? fmtDate(due) : '').replace(/  +/g, ' ');

  return {
    pdfDoc, fonts,
    seller, buyer,
    mode, number, date, delivery, deliveryEnd, due, currency, currencySym,
    project, category, intro, paymentNote, greeting, signature, footnote,
    items: state.items,
    totals,
    fmtDate, fmtMoney,
    countryName,
    tInvoice,
  };
}

// Drawing kit reused by every renderer. Returns a small object exposing
// a current-page handle plus draw helpers and constants.
export function makeDrawKit(pdfDoc, fonts, opts = {}) {
  const { mono, monoBold, synthBold } = fonts;
  const INK = rgb(0.08, 0.08, 0.08);
  const SOFT = rgb(0.25, 0.25, 0.25);
  const PAGE_W = opts.pageW || 595.28;
  const PAGE_H = opts.pageH || 841.89;

  let page = pdfDoc.addPage([PAGE_W, PAGE_H]);

  const widthAt = (text, font, size) => font.widthOfTextAtSize(String(text), size);

  function wrapText(text, font, size, maxWidth) {
    if (!text) return [];
    const paragraphs = String(text).split('\n');
    const result = [];
    for (const para of paragraphs) {
      if (!para) { result.push(''); continue; }
      const words = para.split(' ');
      let current = '';
      for (const word of words) {
        const test = current ? current + ' ' + word : word;
        if (widthAt(test, font, size) > maxWidth && current) {
          result.push(current);
          current = word;
        } else {
          current = test;
        }
      }
      if (current) result.push(current);
    }
    return result;
  }

  function drawText(text, x, y, font, size, color = INK) {
    if (text === undefined || text === null || text === '') return;
    page.drawText(String(text), { x, y, font, size, color });
    if (synthBold && font === monoBold) {
      page.drawText(String(text), { x: x + 0.35, y, font, size, color });
    }
  }
  function drawTextRight(text, xRight, y, font, size, color = INK) {
    if (text === undefined || text === null || text === '') return;
    const w = widthAt(text, font, size);
    drawText(text, xRight - w, y, font, size, color);
  }
  function drawTextCenter(text, y, font, size, color = INK) {
    if (!text) return;
    const w = widthAt(text, font, size);
    drawText(text, (PAGE_W - w) / 2, y, font, size, color);
  }
  function drawRule(y, thickness, x1, x2) {
    page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color: INK });
  }

  return { mono, monoBold, INK, SOFT, PAGE_W, PAGE_H, get page() { return page; },
    widthAt, wrapText, drawText, drawTextRight, drawTextCenter, drawRule };
}

// -------- PDF/A: sRGB ICC profile (IEC61966-2.1, 588 bytes) --------
const SRGB_ICC_PROFILE_B64 =
  'AAACTGxjbXMEQAAAbW50clJHQiBYWVogB+oABAAcABEAHwAkYWNzcEFQUEwAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1sY21zAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAALZGVzYwAAAQgAAAA2Y3BydAAAAUAAAABMd3RwdAAAAYwAAAAUY2hh' +
  'ZAAAAaAAAAAsclhZWgAAAcwAAAAUYlhZWgAAAeAAAAAUZ1hZWgAAAfQAAAAUclRSQwAAAggAAAAg' +
  'Z1RSQwAAAggAAAAgYlRSQwAAAggAAAAgY2hybQAAAigAAAAkbWx1YwAAAAAAAAABAAAADGVuVVMA' +
  'AAAaAAAAHABzAFIARwBCACAAYgB1AGkAbAB0AC0AaQBuAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAA' +
  'ADAAAAAcAE4AbwAgAGMAbwBwAHkAcgBpAGcAaAB0ACwAIAB1AHMAZQAgAGYAcgBlAGUAbAB5WFla' +
  'IAAAAAAAAPbWAAEAAAAA0y1zZjMyAAAAAAABDEIAAAXe///zJQAAB5MAAP2Q///7of///aIAAAPc' +
  'AADAblhZWiAAAAAAAABvoAAAOPUAAAOQWFlaIAAAAAAAACSfAAAPhAAAtsNYWVogAAAAAAAAYpcA' +
  'ALeHAAAY2XBhcmEAAAAAAAMAAAACZmYAAPKnAAANWQAAE9AAAApbY2hybQAAAAAAAwAAAACj1wAA' +
  'VHsAAEzNAACZmgAAJmYAAA9c';

function srgbIccBytes() {
  const bin = atob(SRGB_ICC_PROFILE_B64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Adds a PDF/A-compliant sRGB OutputIntent to the catalog
function addPDFAOutputIntent(pdfDoc) {  
  const iccBytes = srgbIccBytes();

  const iccStream = pdfDoc.context.flateStream(iccBytes, { N: 3 });
  const iccRef = pdfDoc.context.register(iccStream);

  const outputIntent = pdfDoc.context.obj({
    Type: 'OutputIntent',
    S: 'GTS_PDFA1',
    OutputConditionIdentifier: PDFString.of('sRGB IEC61966-2.1'),
    OutputCondition: PDFString.of(''),
    RegistryName: PDFString.of(''),
    Info: PDFString.of('sRGB IEC61966-2.1'),
    DestOutputProfile: iccRef,
  });
  const oiRef = pdfDoc.context.register(outputIntent);

  pdfDoc.catalog.set(PDFName.of('OutputIntents'), pdfDoc.context.obj([oiRef]));
}

// Sets a /ID entry in the trailer (required by PDF/A)
function setPDFTrailerID(pdfDoc) {
  const idBytes = new Uint8Array(16);
  crypto.getRandomValues(idBytes);
  const hex = Array.from(idBytes, b => b.toString(16).padStart(2, '0')).join('');
  const idObj = PDFHexString.of(hex);
  pdfDoc.context.trailerInfo.ID = pdfDoc.context.obj([idObj, idObj]);
}

// -------- PDF: embed XML into given pdfDoc --------
async function embedFacturXIntoPDF(pdfDoc, xml) {
  const xmlBytes = new TextEncoder().encode(xml);
  await pdfDoc.attach(xmlBytes, 'factur-x.xml', {
    mimeType: 'application/xml',
    description: 'Factur-X / ZUGFeRD Invoice (EN 16931)',
    creationDate: new Date(),
    modificationDate: new Date(),
    afRelationship: AFRelationship.Alternative,
  });

  const number = $('r_number').value.trim() || 'Rechnung';
  const sellerName = $('s_name').value.trim();
  pdfDoc.setTitle(`Rechnung ${number}`);
  pdfDoc.setAuthor(sellerName);
  pdfDoc.setSubject('Factur-X / ZUGFeRD EN 16931 E-Rechnung');
  pdfDoc.setKeywords(['factur-x', 'zugferd', 'einvoice', 'en16931', 'rechnung']);
  pdfDoc.setProducer('E-Rechnung Browser-Tool');
  pdfDoc.setCreator('E-Rechnung Browser-Tool');

  addPDFAOutputIntent(pdfDoc);                              // ← NEU

  try { injectFacturXMP(pdfDoc, 'EN 16931'); }
  catch (e) { console.warn('XMP injection skipped:', e); }
}

$('btnPDF').addEventListener('click', async () => {
  const btn = $('btnPDF');
  try {
    btn.disabled = true;
    btn.textContent = t('btn_create_pdf_progress');

    const xml = buildXML();
    const outName = resolveFilenamePattern($('r_filename').value) + '.pdf';
    const pdfDoc = await generateInvoicePDF();

    await embedFacturXIntoPDF(pdfDoc, xml);

    setPDFTrailerID(pdfDoc);

    const outBytes = await pdfDoc.save({ useObjectStreams: false });
    const blob = new Blob([outBytes], { type: 'application/pdf' });
    downloadBlob(blob, outName);
    // Record this invoice number so the next suggestion increments correctly
    await recordInvoiceNumber($('r_number').value);
    // Save snapshot to history (no-op when disabled)
    await recordHistoryEntry();
    flash(`${t('msg_pdf_done')} ${outName}\n${t('msg_pdf_done_2')}`, 'ok');
  } catch (e) {
    console.error(e);
    flash(t('msg_error') + ' ' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = t('btn_create_pdf');
  }
});

// Inject Factur-X conformance metadata into the PDF XMP stream
function injectFacturXMP(pdfDoc, conformance) {
  // pdf-lib exposes the metadata stream via the catalog
  // We build an XMP extension schema declaring Factur-X
  const xmp = `<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Factur-X Browser Tool">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"
      xmlns:dc="http://purl.org/dc/elements/1.1/"
      xmlns:pdf="http://ns.adobe.com/pdf/1.3/"
      xmlns:xmp="http://ns.adobe.com/xap/1.0/"
      xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/"
      xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#"
      xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#"
      xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#">
      <pdfaid:part>3</pdfaid:part>
      <pdfaid:conformance>B</pdfaid:conformance>
      <fx:DocumentType>INVOICE</fx:DocumentType>
      <fx:DocumentFileName>factur-x.xml</fx:DocumentFileName>
      <fx:Version>1.0</fx:Version>
      <fx:ConformanceLevel>${conformance}</fx:ConformanceLevel>
      <pdfaExtension:schemas>
        <rdf:Bag>
          <rdf:li rdf:parseType="Resource">
            <pdfaSchema:schema>Factur-X PDFA Extension Schema</pdfaSchema:schema>
            <pdfaSchema:namespaceURI>urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#</pdfaSchema:namespaceURI>
            <pdfaSchema:prefix>fx</pdfaSchema:prefix>
            <pdfaSchema:property>
              <rdf:Seq>
                <rdf:li rdf:parseType="Resource">
                  <pdfaProperty:name>DocumentFileName</pdfaProperty:name>
                  <pdfaProperty:valueType>Text</pdfaProperty:valueType>
                  <pdfaProperty:category>external</pdfaProperty:category>
                  <pdfaProperty:description>name of the embedded XML invoice file</pdfaProperty:description>
                </rdf:li>
                <rdf:li rdf:parseType="Resource">
                  <pdfaProperty:name>DocumentType</pdfaProperty:name>
                  <pdfaProperty:valueType>Text</pdfaProperty:valueType>
                  <pdfaProperty:category>external</pdfaProperty:category>
                  <pdfaProperty:description>INVOICE</pdfaProperty:description>
                </rdf:li>
                <rdf:li rdf:parseType="Resource">
                  <pdfaProperty:name>Version</pdfaProperty:name>
                  <pdfaProperty:valueType>Text</pdfaProperty:valueType>
                  <pdfaProperty:category>external</pdfaProperty:category>
                  <pdfaProperty:description>factur-x version</pdfaProperty:description>
                </rdf:li>
                <rdf:li rdf:parseType="Resource">
                  <pdfaProperty:name>ConformanceLevel</pdfaProperty:name>
                  <pdfaProperty:valueType>Text</pdfaProperty:valueType>
                  <pdfaProperty:category>external</pdfaProperty:category>
                  <pdfaProperty:description>Factur-X conformance level</pdfaProperty:description>
                </rdf:li>
              </rdf:Seq>
            </pdfaSchema:property>
          </rdf:li>
        </rdf:Bag>
      </pdfaExtension:schemas>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

  const { context, catalog } = pdfDoc;
  const metadataStream = context.flateStream(xmp, {
    Type: 'Metadata',
    Subtype: 'XML',
  });
  const metadataRef = context.register(metadataStream);
  catalog.set(PDFName.of('Metadata'), metadataRef);
}

// -------- Backup: export / import all persisted data --------
async function exportData() {
  const sellerJSON = await store.get(STORAGE_KEY);
  const boilerplateJSON = await store.get(BOILERPLATE_KEY);
  const buyersJSON = await store.get(BUYERS_KEY);
  const footnotesJSON = await store.get(FOOTNOTES_KEY);
  const lastInvoice = await store.get(COUNTER_KEY);
  const filenamePattern = await store.get(FILENAME_KEY);
  const fontKey = await store.get(FONT_KEY);
  const layoutKey = await store.get(LAYOUT_KEY);
  const payload = {
    format: 'erechnung-backup',
    version: 4,
    exported_at: new Date().toISOString(),
    seller: sellerJSON ? JSON.parse(sellerJSON) : null,
    boilerplate: boilerplateJSON ? JSON.parse(boilerplateJSON) : {},
    buyers: buyersJSON ? JSON.parse(buyersJSON) : [],
    footnotes: footnotesJSON ? JSON.parse(footnotesJSON) : [],
    last_invoice: lastInvoice || null,
    filename_pattern: filenamePattern || null,
    font: fontKey || null,
    layout: layoutKey || null,
    yoy_data: state.yoyData || {},
    yoy_enabled: state.yoyEnabled,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const ts = new Date().toISOString().slice(0, 10);
  downloadBlob(blob, `erechnung-backup-${ts}.json`);
  flash(`${t('msg_backup_export')} 1 ${t('msg_backup_seller')}, ${payload.buyers.length} ${t('msg_backup_buyers')}, ${payload.footnotes.length} ${t('msg_backup_footnotes')}.`, 'ok');
}

async function importData(file) {
  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    if (payload.format !== 'erechnung-backup') {
      throw new Error(t('msg_backup_invalid'));
    }
    const sellerCount = payload.seller ? 1 : 0;
    const buyerCount = Array.isArray(payload.buyers) ? payload.buyers.length : 0;
    const footnoteCount = Array.isArray(payload.footnotes) ? payload.footnotes.length : 0;
    const overwrite = confirm(
      t('msg_backup_import_confirm', { seller: String(sellerCount), buyers: String(buyerCount), footnotes: String(footnoteCount) })
    );
    if (!overwrite) return;

    if (payload.seller) {
      // Newer format: stammdaten only. Older format: merged seller+boilerplate.
      await store.set(STORAGE_KEY, JSON.stringify(payload.seller));
      applySellerStammdaten(payload.seller);
    }
    // Per-language boilerplate (v2)
    if (payload.boilerplate && typeof payload.boilerplate === 'object') {
      await store.set(BOILERPLATE_KEY, JSON.stringify(payload.boilerplate));
      await loadBoilerplateForLang(effectiveInvoiceLang());
    } else if (payload.seller && (payload.seller.intro !== undefined || payload.seller.payment_note !== undefined)) {
      // Legacy v1 backup: seller had boilerplate inside. Migrate to effective invoice language.
      const legacyBoilerplate = {
        intro: payload.seller.intro,
        payment_note: payload.seller.payment_note,
        greeting: payload.seller.greeting,
        signature: payload.seller.signature,
        footnote: payload.seller.footnote,
      };
      await store.set(BOILERPLATE_KEY, JSON.stringify({ [effectiveInvoiceLang()]: legacyBoilerplate }));
      applyBoilerplate(legacyBoilerplate);
    }
    if (Array.isArray(payload.buyers)) {
      state.buyers = payload.buyers;
      await store.set(BUYERS_KEY, JSON.stringify(state.buyers));
      renderBuyerPicker();
    }
    if (Array.isArray(payload.footnotes)) {
      state.footnotes = payload.footnotes;
      await store.set(FOOTNOTES_KEY, JSON.stringify(state.footnotes));
      renderFootnotePicker();
    }
    if (payload.last_invoice) {
      await store.set(COUNTER_KEY, payload.last_invoice);
    }
    if (payload.filename_pattern) {
      await store.set(FILENAME_KEY, payload.filename_pattern);
      $('r_filename').value = payload.filename_pattern;
      updateFilenamePreview();
    }
    if (payload.font && FONT_OPTIONS[payload.font]) {
      await store.set(FONT_KEY, payload.font);
      $('invoiceFontSelect').value = payload.font;
    }
    if (payload.layout && LAYOUTS[payload.layout]) {
      await store.set(LAYOUT_KEY, payload.layout);
      $('invoiceLayoutSelect').value = payload.layout;
    }
    // YoY backfill (v4+): restore both data and the toggle state.
    // Older backups won't have these keys; that's fine, leave defaults.
    if (payload.yoy_data && typeof payload.yoy_data === 'object') {
      state.yoyData = payload.yoy_data;
      await persistYoYData();
    }
    if (typeof payload.yoy_enabled === 'boolean') {
      state.yoyEnabled = payload.yoy_enabled;
      await persistYoYEnabled();
    }
    flash(`${t('msg_backup_import_done')} ${sellerCount} ${t('msg_backup_seller')}, ${buyerCount} ${t('msg_backup_buyers')}, ${footnoteCount} ${t('msg_backup_footnotes')}.`, 'ok');
  } catch (e) {
    flash(t('msg_backup_failed') + ' ' + e.message, 'err');
  }
}

// -------- Seller collapse/expand --------

// True if seller stammdaten contain enough data to be considered "configured"
// — at minimum a name and one of (address, city, country). When configured
// and no edit is active, the section can collapse to a one-line summary.
function isSellerConfigured() {
  const s = collectSellerStammdaten();
  return Boolean(s.name && (s.line1 || s.city || s.country));
}

// Build a compact summary line for the collapsed seller header.
// Pattern: "Name · VAT-or-SIRET · COUNTRY"
function buildSellerSummary() {
  const s = collectSellerStammdaten();
  const bits = [];
  if (s.name) bits.push(s.name);
  if (s.vat) bits.push(s.vat);
  else if (s.siret) bits.push(s.siret);
  if (s.country) bits.push(s.country);
  return bits.join(' \u00b7 ');
}

let sellerCollapsed = false;

async function loadSellerCollapsed() {
  try {
    const v = await store.get(SELLER_COLLAPSED_KEY);
    sellerCollapsed = v === 'true';
  } catch (e) { sellerCollapsed = false; }
}

async function setSellerCollapsed(v, persist = true) {
  sellerCollapsed = !!v;
  if (persist) {
    try { await store.set(SELLER_COLLAPSED_KEY, String(sellerCollapsed)); } catch (_) {}
  }
  applySellerCollapsedUI();
}

// Apply current sellerCollapsed state to the DOM. Also decides whether
// the toggle button should even be visible (only when seller has data).
function applySellerCollapsedUI() {
  const section = $('sellerSection');
  const body = $('sellerBody');
  const toggle = $('sellerToggle');
  const summary = $('sellerSummary');
  if (!section || !body || !toggle || !summary) return;

  const configured = isSellerConfigured();
  toggle.hidden = !configured;
  if (!configured) {
    // Force expanded — nothing to summarize
    body.hidden = false;
    section.classList.remove('collapsed');
    toggle.setAttribute('aria-expanded', 'true');
    return;
  }
  summary.textContent = buildSellerSummary();
  if (sellerCollapsed) {
    body.hidden = true;
    section.classList.add('collapsed');
    toggle.setAttribute('aria-expanded', 'false');
  } else {
    body.hidden = false;
    section.classList.remove('collapsed');
    toggle.setAttribute('aria-expanded', 'true');
  }
}


// -------- Help modal (renders bundled README via mini-markdown) --------
//
// We keep the README content as a string literal so the build stays
// single-file. A tiny Markdown renderer handles the subset used by the
// README: headings (#, ##, ###), unordered lists (- and *), inline code
// (`x`), bold (**x**), italic (*x*), links ([t](url)), paragraphs.

const HELP_README_TEXT = `# E-Invoice Generator

A self-contained, offline-first tool for creating ZUGFeRD- / Factur-X-compliant invoices. Runs fully offline in any modern browser, doesn't store anything on a server.

The motivation came from frustration that essentially all tools that can do this are paid. Adding XML to a PDF and making it compliant with the regulation didn't seem too hard to tackle, so this exists. It tries to have all the features I could ever need, plus customization options. The tool can also retrofit existing PDFs with an XML if you'd like to use another application for fancy layouts.

This is created with the help of AI; I'm not a finance expert, so use at your own risk. The created files pass current e-invoice viewers and the strict verapdf validation.

## Short description

Open the tool in a browser, fill in the invoice data, generate a PDF. The PDF carries machine-readable XML data per EN 16931 (ZUGFeRD 2.3 / Factur-X 1.0, Comfort profile) embedded inside it, making it compliant with German e-invoicing law (§14 UStG, in force since 2025) and a valid Factur-X document for French B2B reverse-charge invoicing.

## Layouts

Three layouts are available:

- **Modern** — minimal, magazine-style, single full-width column
- **DIN 5008** — German letterhead standard with window-envelope-positioned recipient
- **Typewriter** — monospace two-column header, tight monoBold body

All layouts support multi-page rendering when item lists overflow a single page.

## Features

### Seller profile
Stammdaten (name, address, tax IDs, banking) are saved locally. Boilerplate texts (intro, payment note, greeting, signature, footnote) are stored per invoice language (DE/EN/FR) so a language switch loads the right defaults.

### Customer database
Save buyers as named profiles, pick from a dropdown, save changes back to the profile.

### Invoice number with pattern
Auto-incrementing numbers in YYYY-NNNNN format (continuous, no annual reset). Manual override is always possible.

### Date fields
Invoice date, due date with quick-set chips (today, +7, +14, +30, +60), service date (single or range with end date).

### Tax modes
Standard (S) with VAT, Reverse Charge (AE), Zero-rated (Z), Exempt (E), Out of scope (O). The PDF text adapts; the XML follows EN 16931 BT-95/BT-96 codes.

### Line items
Description, quantity, unit price, VAT percent (only used in S mode). Multi-line descriptions are wrapped properly across all layouts and pages.

### Default texts (boilerplate)
Per-invoice-language storage so DE invoices reach for German default texts and EN invoices for English.

### Footnote presets
Save footnote variants as named presets, switch between them via dropdown.

### Language selectors
Three independent language axes: UI language, invoice content language, and (implicitly) buyer language inferred from the buyer country code.

### Fonts
Choose between Courier Prime, Inconsolata, IBM Plex Mono, or JetBrains Mono for the PDF body. UI font stays the same.

### Filename pattern
Token-based filename builder. Drop \`{nr}\`, \`{buyer}\`, \`{project}\`, \`{date}\`, \`{category}\`, \`{seller}\`, \`{layout}\` into a pattern; chips help insertion.

### History & Statistics
Every generated invoice is saved as a snapshot. Click the history icon to browse, clone, or remove past invoices. Click the chart icon for statistics: KPIs, monthly chart, top buyers, quarterly tax breakdown, year-over-year comparison, CSV export.

### Backup
Export everything (seller, buyers, footnotes, settings, YoY backfill) to a JSON file; import to restore. Format is forward-compatible.

### Theme
Dark / light toggle, persists across sessions, defaults to system preference.

## Compliance & standards

Generated PDFs pass:
- Quba Viewer
- Mustang Validator
- ELSTER E-Rechnungsviewer
- verapdf (strict PDF/A-3 conformance check)

XML follows EN 16931 BT numbering (Comfort profile). All required fields are populated; optional fields included where the tool collects them.

## Notes

This is a vibe-coded tool. No warranty for correctness, completeness or legal compliance of generated documents. Always validate with a certified validator before production use, and consult a tax advisor when in doubt.
`;

// Render a small subset of Markdown to HTML. Handles: # headings, lists,
// **bold**, *italic*, \`code\`, [link](url), and paragraphs.
function renderMarkdown(md) {
  const lines = md.split('\n');
  const out = [];
  let inList = false;
  let para = [];

  const flushPara = () => {
    if (para.length) {
      out.push('<p>' + inlineMD(para.join(' ').trim()) + '</p>');
      para = [];
    }
  };
  const closeList = () => {
    if (inList) { out.push('</ul>'); inList = false; }
  };

  for (let raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      flushPara();
      closeList();
      continue;
    }
    let m;
    if ((m = line.match(/^### (.+)$/))) {
      flushPara(); closeList();
      out.push('<h4>' + esc(m[1]) + '</h4>');
    } else if ((m = line.match(/^## (.+)$/))) {
      flushPara(); closeList();
      out.push('<h3>' + esc(m[1]) + '</h3>');
    } else if ((m = line.match(/^# (.+)$/))) {
      flushPara(); closeList();
      out.push('<h2 class="help-toptitle">' + esc(m[1]) + '</h2>');
    } else if ((m = line.match(/^[-*] (.+)$/))) {
      flushPara();
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push('<li>' + inlineMD(m[1]) + '</li>');
    } else {
      closeList();
      para.push(line);
    }
  }
  flushPara();
  closeList();
  return out.join('\n');
}

// Inline Markdown: **bold**, *italic*, \`code\`, [text](url).
function inlineMD(text) {
  let s = esc(text);
  // Code first so its content doesn't get further mangled
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold then italic (bold wraps double * which would otherwise eat italic)
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  // Links
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}


// Modal open / close

function openHelpModal() {
  const modal = $('helpModal');
  const body = $('helpBody');
  if (!modal || !body) return;
  // Render once on first open, reuse afterwards
  if (!body.dataset.rendered) {
    body.innerHTML = renderMarkdown(HELP_README_TEXT);
    body.dataset.rendered = '1';
  }
  modal.classList.add('open');
  modal.removeAttribute('hidden');
}
function closeHelpModal() {
  const modal = $('helpModal');
  if (!modal) return;
  modal.classList.remove('open');
  modal.setAttribute('hidden', '');
}


// -------- History modal --------

function openHistoryModal() {
  const modal = $('historyModal');
  if (!modal) return;
  modal.classList.add('open');
  modal.removeAttribute('hidden');
  renderHistoryPicker();
}
function closeHistoryModal() {
  const modal = $('historyModal');
  if (!modal) return;
  modal.classList.remove('open');
  modal.setAttribute('hidden', '');
}


// -------- Embed-XML modal --------

function openEmbedModal() {
  const modal = $('embedModal');
  if (!modal) return;
  modal.classList.add('open');
  modal.removeAttribute('hidden');
  // Reset previous selection
  state.pdfFile = null;
  $('fname').textContent = '';
}
function closeEmbedModal() {
  const modal = $('embedModal');
  if (!modal) return;
  modal.classList.remove('open');
  modal.setAttribute('hidden', '');
}

// Run the embed-XML-into-existing-PDF action. Used by the modal's
// "Embed" button. Skips PDF generation: just loads the user's PDF and
// embeds the current invoice's XML into it.
async function runEmbedXML() {
  if (!state.pdfFile) {
    flash(t('msg_pdf_select_first'), 'err');
    return;
  }
  const btn = $('btnEmbedRun');
  try {
    btn.disabled = true;
    btn.textContent = t('btn_embed_progress');

    const xml = buildXML();
    const pdfBytes = await state.pdfFile.arrayBuffer();
    const pdfDoc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
    await embedFacturXIntoPDF(pdfDoc, xml);
    setPDFTrailerID(pdfDoc);

    const outName = resolveFilenamePattern($('r_filename').value) + '.pdf';
    const finalBytes = await pdfDoc.save();
    const blob = new Blob([finalBytes], { type: 'application/pdf' });
    downloadBlob(blob, outName);

    saveHistorySnapshot();
    closeEmbedModal();
    flash(t('msg_embed_done'), 'ok');
  } catch (e) {
    console.error(e);
    flash(t('msg_embed_failed') + ' ' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = t('btn_embed_run');
  }
}


// -------- Init --------
document.getElementById('addItem').addEventListener('click', () => addItem());
document.getElementById('saveSeller').addEventListener('click', saveSeller);
$('clearSeller').addEventListener('click', clearSeller);
$('sellerToggle').addEventListener('click', () => setSellerCollapsed(!sellerCollapsed));

// Top-bar modal openers
$('openHistory').addEventListener('click', openHistoryModal);
$('openHelp').addEventListener('click', openHelpModal);
$('historyClose').addEventListener('click', closeHistoryModal);
$('historyModal').addEventListener('click', (e) => {
  if (e.target === $('historyModal')) closeHistoryModal();
});
$('helpClose').addEventListener('click', closeHelpModal);
$('helpModal').addEventListener('click', (e) => {
  if (e.target === $('helpModal')) closeHelpModal();
});

// Embed-XML modal (was the upload mode in the old output section)
$('btnEmbed').addEventListener('click', openEmbedModal);
$('embedClose').addEventListener('click', closeEmbedModal);
$('btnEmbedRun').addEventListener('click', runEmbedXML);
$('embedModal').addEventListener('click', (e) => {
  if (e.target === $('embedModal')) closeEmbedModal();
});

document.getElementById('r_taxmode').addEventListener('change', calcTotals);

// Buyer picker events
$('buyerPicker').addEventListener('change', (e) => {
  const idx = e.target.value;
  if (idx === '') {
    clearBuyer();
  } else if (state.buyers[idx]) {
    applyBuyer(state.buyers[idx]);
  }
  updateFilenamePreview();
  updateBuyerHistoryHint();
});
$('saveBuyer').addEventListener('click', saveBuyer);
$('deleteBuyer').addEventListener('click', deleteBuyer);
// Update history hint as the user types in the name field
$('b_name').addEventListener('input', updateBuyerHistoryHint);

// History picker events
$('historyClone').addEventListener('click', cloneFromHistory);
$('historyDelete').addEventListener('click', deleteHistoryEntry);
$('historyClearAll').addEventListener('click', clearAllHistory);
$('historyEnable').addEventListener('change', async (e) => {
  state.historyEnabled = e.target.checked;
  await persistHistoryEnabled();
});

// Past-invoice modal events
$('historyAddPast').addEventListener('click', openPastInvoiceModal);
$('pastSave').addEventListener('click', savePastInvoice);
$('pastCancel').addEventListener('click', closePastInvoiceModal);
$('past_buyer_select').addEventListener('change', applyPastBuyerSelection);
$('past_taxmode').addEventListener('change', togglePastVatRateVisibility);
$('pastInvoiceModal').addEventListener('click', (e) => {
  if (e.target === $('pastInvoiceModal')) closePastInvoiceModal();
});

// Statistics modal events
$('openStats').addEventListener('click', openStatsModal);
$('statsClose').addEventListener('click', closeStatsModal);
$('statsPeriod').addEventListener('change', renderStatistics);
$('statsTabOverview').addEventListener('click', () => setStatsView('overview'));
$('statsTabQuarters').addEventListener('click', () => setStatsView('quarters'));
$('statsYear').addEventListener('change', (e) => {
  statsYear = Number(e.target.value);
  renderStatistics();
});
$('statsExportCsv').addEventListener('click', exportStatsCSV);
$('statsYoYToggle').addEventListener('click', () => setYoYEnabled(!state.yoyEnabled));
$('yoyBackfillOpen').addEventListener('click', openYoYBackfillModal);
$('yoyBackfillCancel').addEventListener('click', closeYoYBackfillModal);
$('yoyBackfillSave').addEventListener('click', saveYoYBackfill);
$('yoyBackfillModal').addEventListener('click', (e) => {
  if (e.target === $('yoyBackfillModal')) closeYoYBackfillModal();
});
// Delegated click handler for the stats body: catches buyer-drill-down
// clicks in the top buyers list, the back button in the drill-down view,
// and the "set previous year reference" button in the YoY hint banner.
$('statsBody').addEventListener('click', (e) => {
  const buyerBtn = e.target.closest('.stats-buyer-btn');
  if (buyerBtn) {
    setStatsBuyerDrillDown(buyerBtn.getAttribute('data-buyer'));
    return;
  }
  const back = e.target.closest('#statsBackBtn');
  if (back) {
    setStatsBuyerDrillDown(null);
    return;
  }
  const yoyOpen = e.target.closest('#yoyOpenBackfill');
  if (yoyOpen) {
    openYoYBackfillModal();
  }
});
// Click backdrop or press Esc to close
$('statsModal').addEventListener('click', (e) => {
  if (e.target === $('statsModal')) closeStatsModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // Order: deepest/topmost modals first
  const ym = $('yoyBackfillModal');
  const pm = $('pastInvoiceModal');
  const em = $('embedModal');
  const hm = $('helpModal');
  const histm = $('historyModal');
  const sm = $('statsModal');
  if (ym && ym.classList.contains('open')) { closeYoYBackfillModal(); return; }
  if (pm && pm.classList.contains('open')) { closePastInvoiceModal(); return; }
  if (em && em.classList.contains('open')) { closeEmbedModal(); return; }
  if (hm && hm.classList.contains('open')) { closeHelpModal(); return; }
  if (histm && histm.classList.contains('open')) { closeHistoryModal(); return; }
  if (sm && sm.classList.contains('open')) {
    if (statsBuyerDrillDown) { setStatsBuyerDrillDown(null); return; }
    closeStatsModal();
  }
});

$('r_delivery_end').addEventListener('change', () => {
  const start = $('r_delivery').value;
  const end = $('r_delivery_end').value;
  if (start && end && start === end) {
    $('r_delivery_end').value = '';
  }
});

$('clearDeliveryEnd').addEventListener('click', () => {
  const el = $('r_delivery_end');
  el.value = '';
  el.defaultValue = '';
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
$('r_delivery').addEventListener('change', () => {
  const start = $('r_delivery').value;
  const end = $('r_delivery_end').value;
  if (start && end && start === end) {
    $('r_delivery_end').value = '';
  }
});

// Backup events
$('btnExport').addEventListener('click', exportData);
$('btnImport').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', (e) => {
  if (e.target.files[0]) {
    importData(e.target.files[0]);
    e.target.value = ''; // reset so re-import of same file works
  }
});

// Invoice number suggestion
$('suggestNumber').addEventListener('click', applyNextInvoiceNumber);

// Invoice number pattern editor
$('numberPatternChips').addEventListener('click', (e) => {
  const token = e.target.dataset?.token;
  if (!token) return;
  const input = $('r_number_pattern');
  const pos = input.selectionStart ?? input.value.length;
  input.value = input.value.slice(0, pos) + token + input.value.slice(pos);
  input.focus();
  input.setSelectionRange(pos + token.length, pos + token.length);
});
$('saveNumberPattern').addEventListener('click', async () => {
  const pattern = $('r_number_pattern').value.trim() || DEFAULT_NUMBER_PATTERN;
  await saveNumberPattern(pattern);
  // Rechnungsnummer-Feld auf das neue Pattern setzen
  const counter = await getCounterValue();
  $('r_number').value = resolveNumberPattern(pattern, counter + 1);
  // Chip-Vorschau und Dateinamen-Vorschau auch aktualisieren
  updateSuggestNumberChipPreview();
  updateFilenamePreview();
  flash(`${t('msg_pattern_saved')} ${pattern}`, 'ok');
});
async function updateSuggestNumberChipPreview() {
  const pattern = ($('r_number_pattern').value || '').trim() || DEFAULT_NUMBER_PATTERN;
  const counter = await getCounterValue();
  const preview = resolveNumberPattern(pattern, counter + 1);
  $('suggestNumber').textContent = `↻ ${preview}`;
}

// Live-Update: bei jeder Pattern-Änderung
$('r_number_pattern').addEventListener('input', updateSuggestNumberChipPreview);
// Auch nach Speichern aktualisieren
$('saveNumberPattern').addEventListener('click', () => setTimeout(updateSuggestNumberChipPreview, 50));

// Load pattern into the field on init
(async () => {
  $('r_number_pattern').value = await getNumberPattern();
})();

// Footnote preset events
$('footnotePicker').addEventListener('change', (e) => {
  const idx = e.target.value;
  if (idx !== '' && state.footnotes[idx]) {
    $('r_footnote').value = state.footnotes[idx].text;
  }
});
$('saveFootnote').addEventListener('click', saveFootnote);
$('deleteFootnote').addEventListener('click', deleteFootnote);

// Filename pattern: chips insert tokens at cursor, live preview updates on any field change
$('filenameChips').addEventListener('click', (e) => {
  const token = e.target.dataset?.token;
  if (!token) return;
  const input = $('r_filename');
  const pos = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, pos);
  const after = input.value.slice(pos);
  input.value = before + token + after;
  input.focus();
  input.setSelectionRange(pos + token.length, pos + token.length);
  updateFilenamePreview();
});
$('r_filename').addEventListener('input', updateFilenamePreview);
$('saveFilenamePattern').addEventListener('click', saveFilenamePattern);
// Also update preview when invoice fields change
['r_number', 'r_project', 'b_name', 'r_date', 'r_category', 's_name'].forEach(id => {
  $(id).addEventListener('input', updateFilenamePreview);
});

// Due-date quick-set chips: add N days to invoice date (or today if not set)
document.querySelectorAll('.due-chips button').forEach(btn => {
  btn.addEventListener('click', () => {
    const days = parseInt(btn.dataset.days, 10);
    const baseStr = $('r_date').value || new Date().toISOString().slice(0, 10);
    // Parse as local date to avoid timezone shifts
    const [y, m, d] = baseStr.split('-').map(Number);
    const base = new Date(y, m - 1, d);
    base.setDate(base.getDate() + days);
    const yy = base.getFullYear();
    const mm = String(base.getMonth() + 1).padStart(2, '0');
    const dd = String(base.getDate()).padStart(2, '0');
    $('r_due').value = `${yy}-${mm}-${dd}`;
  });
});

// === INVOICE LAYOUT START ===
// Layouts werden zur Buildzeit eingespielt — siehe vite.config.js
import { LAYOUTS, DEFAULT_LAYOUT } from './layouts.js';
// === INVOICE LAYOUT END ===

// Theme toggle: auto → light → dark → auto
function applyTheme(pref) {
  // pref: null = auto, 'light', 'dark'
  const isDark = pref === 'dark' || (pref === null && window.matchMedia('(prefers-color-scheme: dark)').matches);
  if (isDark) document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
  const icon = pref === 'light' ? '☀' : pref === 'dark' ? '☾' : 'A';
  const label = pref === 'dark' ? t('theme_dark') : pref === 'light' ? t('theme_light') : t('theme_auto');
  $('themeToggle').innerHTML = `<span class="icon">${icon}</span>`;
  $('themeToggle').title = label;
}
$('themeToggle').addEventListener('click', () => {
  const current = localStorage.getItem(THEME_KEY); // null, 'light', 'dark'
  let next;
  if (current === null) next = 'light';
  else if (current === 'light') next = 'dark';
  else next = null; // back to auto
  if (next === null) localStorage.removeItem(THEME_KEY);
  else localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
});
// Listen for system theme changes when in auto mode
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (!localStorage.getItem(THEME_KEY)) applyTheme(null);
});

// Language switcher
$('langSelect').addEventListener('change', (e) => setLang(e.target.value));

// Invoice output language — independent of UI
$('invoiceLangSelect').addEventListener('change', (e) => setInvoiceLang(e.target.value));

// Invoice font selector
$('invoiceFontSelect').addEventListener('change', async (e) => {
  await store.set(FONT_KEY, e.target.value);
});

// Invoice layout selector
$('invoiceLayoutSelect').addEventListener('change', async (e) => {
  await store.set(LAYOUT_KEY, e.target.value);
  updateFilenamePreview();
});


// -------- Bootstrap --------
// One place that wires up async startup work, in a defined order, with a
// single error path. Everything that needs to be ready before the user
// touches the UI happens here.
async function init() {
  // 1. Render-blocking visual state (no flash of wrong theme/language).
  applyTheme(localStorage.getItem(THEME_KEY));
  $('langSelect').value = CURRENT_LANG;
  $('invoiceLangSelect').value = INVOICE_LANG || '';
  applyTranslations();

  // 2. Defaults the user can immediately edit.
  $('r_date').value = new Date().toISOString().slice(0, 10);
  addItem({ desc: '', qty: 1, price: 0, vat: 20 });

  // 3. Populate the layout dropdown (its options come from LAYOUTS at runtime).
  const layoutSel = $('invoiceLayoutSelect');
  layoutSel.innerHTML = Object.entries(LAYOUTS)
    .map(([k, v]) => `<option value="${esc(k)}">${esc(v.label)}</option>`)
    .join('');

  // 4. Load persisted state in parallel — these are independent of each other.
  await Promise.all([
    loadSeller(),
    loadBuyers(),
    loadFootnotes(),
    loadHistory(),
    loadYoY(),
    loadSellerCollapsed(),
    loadFilenamePattern(),
    updateSuggestNumberChipPreview(),
    (async () => { $('invoiceFontSelect').value = await getCurrentFontKey(); })(),
    (async () => { layoutSel.value = await getCurrentLayout(); })(),
  ]);

  // 5. Auto-fill the invoice number if the field is still empty, then refresh
  //    the filename preview (which depends on the number).
  await applyNextInvoiceNumber();
  updateFilenamePreview();

  // 6. History UI — populate after translations + load are done so labels are correct.
  $('historyEnable').checked = state.historyEnabled;
  renderHistoryPicker();

  // 7. Apply seller-collapse UI based on whether stammdaten exist.
  applySellerCollapsedUI();
}

init().catch(err => {
  console.error('Init failed:', err);
  flash(t('msg_error') + ' ' + (err && err.message ? err.message : err), 'err');
});
