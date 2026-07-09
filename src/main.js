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
const TEXTPRESETS_KEY = 'erechnung:textpresets:v1';
const DUE_DAYS_KEY = 'erechnung:due_days:v1';

const state = {
  items: [],
  pdfFile: null,
  buyers: [],
  footnotes: [],
  // Text-block presets: { intro: [{id,name,text}], paymentNote: [...], footnote: [...] }
  // plus the currently selected preset id per block. Persisted under
  // TEXTPRESETS_KEY; legacy FOOTNOTES_KEY entries are migrated in on first load.
  textPresets: { intro: [], paymentNote: [], footnote: [] },
  selectedPreset: { intro: '', paymentNote: '', footnote: '' },
  dueDays: 14,            // active due-date chip (+N days on the issue date)
  history: [],            // array of invoice snapshots, newest first
  historyEnabled: true,   // user toggle; defaults to on
  yoyEnabled: false,      // year-over-year arrow visibility (default off)
  yoyData: {},            // backfill: { CUR: { YEAR: number[12] } }
};

// -------- Helpers --------
const $ = (id) => document.getElementById(id);
// Coerce nullish values to a default; everything else (including the empty
// string and 0) passes through as String(). Despite the short name, this is
// nullish-only — NOT a falsy check. Empty input fields stay empty.
const nz = (v, d = '') => (v === undefined || v === null) ? d : String(v);
const esc = (s) => nz(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const dateCompact = (iso) => iso ? iso.replace(/-/g, '') : '';
// Parse 'YYYY-MM-DD' as LOCAL midnight, not UTC.
// `new Date('YYYY-MM-DD')` parses as UTC, but .getFullYear/.getMonth/.getDate
// return LOCAL components — in negative UTC offsets that off-by-ones the day.
// Used by stats, YoY, history, and display formatting. Falsy/unparseable
// input returns an Invalid Date (mirrors `new Date(iso)`).
function parseInvoiceDate(iso) {
  if (!iso) return new Date(NaN);
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return new Date(iso);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
// Today as 'YYYY-MM-DD' in LOCAL time — the write-side counterpart of
// parseInvoiceDate. `new Date().toISOString()` is UTC, so in UTC+ timezones
// it yields yesterday between local midnight and the offset. Every "default
// to today" in the form must go through this.
function todayLocalISO(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
// Parse a money-like input. Accepts both German (1.234,56 / 1234,56) and
// English (1,234.56 / 1234.56) conventions, as well as bare integers. The
// LAST '.' or ',' is treated as the decimal separator, everything before it as
// thousand grouping. Exception: a single separator followed by exactly three
// digits is treated as a thousand separator ('1.234' → 1234), since money
// inputs in this app never have 3 decimal places. Non-numeric input → 0.
function parseMoneyInput(s) {
  const clean = String(s || '').trim().replace(/[^\d.,\-]/g, '');
  if (!clean) return 0;
  const lastDot = clean.lastIndexOf('.');
  const lastComma = clean.lastIndexOf(',');
  const lastSep = Math.max(lastDot, lastComma);
  if (lastSep === -1) return parseFloat(clean) || 0;
  const sepChar = clean[lastSep];
  const decPart = clean.slice(lastSep + 1);
  const intPart = clean.slice(0, lastSep);
  const otherSep = sepChar === '.' ? ',' : '.';
  const onlyOneSeparator = intPart.indexOf(sepChar) === -1 && intPart.indexOf(otherSep) === -1;
  if (onlyOneSeparator && /^\d{3}$/.test(decPart)) {
    return parseFloat(intPart + decPart) || 0;
  }
  return parseFloat(intPart.replace(/[.,]/g, '') + '.' + decPart) || 0;
}
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);
// Strict IBAN check: length 15–34, CC + check digits + alphanumeric body, MOD-97
// remainder of 1. Used by the validator (btnValidate) — does not block XML
// emission, since the spec only requires syntactic well-formedness and users
// may want to issue invoices with placeholder bank data.
function isValidIBAN(s) {
  const iban = String(s || '').replace(/\s+/g, '').toUpperCase();
  if (iban.length < 15 || iban.length > 34) return false;
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(iban)) return false;
  // MOD-97: move first 4 chars to end, map letters (A=10..Z=35), reduce mod 97.
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (let i = 0; i < rearranged.length; i++) {
    const c = rearranged.charCodeAt(i);
    // 0-9 → 48-57; A-Z → 65-90 mapped to 10-35
    const digits = c >= 65 ? String(c - 55) : String.fromCharCode(c);
    for (let j = 0; j < digits.length; j++) {
      remainder = (remainder * 10 + (digits.charCodeAt(j) - 48)) % 97;
    }
  }
  return remainder === 1;
}

// -------- Inline validation --------
// Non-blocking: validators run on input/blur and decorate the field with a
// red underline + .field-error span. They never abort save or PDF emission.

// Returns null if valid (or empty), else an i18n key for the error message.
function validateIBANInline(value) {
  const iban = String(value || '').replace(/\s+/g, '').toUpperCase();
  if (!iban) return null;
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(iban) || iban.length < 15 || iban.length > 34) {
    return 'err_iban_format';
  }
  return isValidIBAN(iban) ? null : 'err_iban_checksum';
}

// Returns null if valid (or empty). countryCode is the ISO-2 from the
// neighbouring country field; we only know strict patterns for DE and FR.
function validateVatInline(value, countryCode) {
  const v = String(value || '').replace(/\s+/g, '').toUpperCase();
  if (!v) return null;
  // Accept a not-yet-collapsed alpha-3 code (DEU/FRA) so the strict
  // per-country pattern still applies while the field awaits its blur.
  let cc = String(countryCode || '').trim().toUpperCase();
  if (cc.length === 3 && cc in ISO_ALPHA3_TO_ALPHA2) cc = ISO_ALPHA3_TO_ALPHA2[cc];
  if (cc === 'DE') return /^DE\d{9}$/.test(v) ? null : 'err_vat_format_de';
  if (cc === 'FR') return /^FR[A-Z0-9]{2}\d{9}$/.test(v) ? null : 'err_vat_format_fr';
  // Generic shape: country prefix + body of digits/letters, total 4-14 chars.
  return /^[A-Z]{2}[A-Z0-9]{2,12}$/.test(v) ? null : 'err_vat_format_generic';
}

// Helper: toggle invalid class + the field-error sibling. msgKey null → clear.
function setFieldError(input, msgKey) {
  if (!input) return;
  const id = input.id + 'Error';
  let span = input.parentElement && input.parentElement.querySelector(`.field-error[data-for="${input.id}"]`);
  if (msgKey) {
    input.classList.add('invalid');
    input.setAttribute('aria-invalid', 'true');
    if (!span) {
      span = document.createElement('span');
      span.className = 'field-error';
      span.dataset.for = input.id;
      span.id = id;
      // Insert after the input but keep it inside the same <label> so the hint
      // sits directly below the field.
      input.insertAdjacentElement('afterend', span);
    }
    span.textContent = t(msgKey);
  } else {
    input.classList.remove('invalid');
    input.removeAttribute('aria-invalid');
    if (span) span.remove();
  }
}

// Wire up validators. Called once at init and again on language change
// (re-renders existing error messages).
function setupInlineValidation() {
  const wire = (inputId, validator) => {
    const el = document.getElementById(inputId);
    if (!el) return;
    const run = () => setFieldError(el, validator());
    el.addEventListener('input', run);
    el.addEventListener('blur', run);
  };
  wire('s_iban', () => validateIBANInline($('s_iban').value));
  wire('s_vat',  () => validateVatInline($('s_vat').value, $('s_country').value));
  wire('b_vat',  () => validateVatInline($('b_vat').value, $('b_country').value));
  // Re-validate VAT when its country code changes.
  $('s_country')?.addEventListener('input', () => setFieldError($('s_vat'), validateVatInline($('s_vat').value, $('s_country').value)));
  $('b_country')?.addEventListener('input', () => setFieldError($('b_vat'), validateVatInline($('b_vat').value, $('b_country').value)));

  // Switching the seller country also retunes item VAT rates to that
  // country's standard rate (e.g. DE → 19, FR → 20). Triggered only on
  // explicit user input — programmatic value changes from loadSeller
  // don't fire 'input', so persisted state isn't clobbered.
  $('s_country')?.addEventListener('input', applyCountryDefaultVat);

  // Collapse a typed ISO 3166-1 alpha-3 code (DEU/FRA/USA…) to alpha-2 on
  // blur. EN 16931 CountryID is alpha-2, and downstream code expects 2
  // letters; this keeps what the user sees consistent with what gets saved.
  const collapseAlpha3 = (el) => {
    const v = el.value.trim().toUpperCase();
    if (v.length === 3 && v in ISO_ALPHA3_TO_ALPHA2) {
      el.value = ISO_ALPHA3_TO_ALPHA2[v];
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };
  $('s_country')?.addEventListener('blur', (e) => collapseAlpha3(e.target));
  $('b_country')?.addEventListener('blur', (e) => collapseAlpha3(e.target));

  // Soft date checks — chained re-evaluations because they share state.
  function checkDates() {
    const date = $('r_date').value;
    const due = $('r_due').value;
    const dStart = $('r_delivery').value;
    const dEnd = $('r_delivery_end').value;
    // Invoice date far in the future (> 1 year)
    let dateErr = null;
    if (date) {
      const d = parseInvoiceDate(date);
      const horizon = new Date();
      horizon.setFullYear(horizon.getFullYear() + 1);
      if (d.getTime() > horizon.getTime()) dateErr = 'err_date_future';
    }
    setFieldError($('r_date'), dateErr);
    setFieldError($('r_due'), (date && due && due < date) ? 'err_due_before_date' : null);
    setFieldError($('r_delivery_end'), (dStart && dEnd && dEnd < dStart) ? 'err_delivery_end_order' : null);
  }
  ['r_date', 'r_due', 'r_delivery', 'r_delivery_end'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', checkDates);
    el.addEventListener('blur', checkDates);
  });
}

// Refresh all currently visible inline-validation messages (after language
// change). Clears existing spans and re-runs validators against current vals.
function refreshInlineValidation() {
  ['s_iban', 's_vat', 'b_vat', 'r_date', 'r_due', 'r_delivery', 'r_delivery_end'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('invalid');
    const old = el.parentElement && el.parentElement.querySelector(`.field-error[data-for="${id}"]`);
    if (old) old.remove();
  });
  // Re-trigger validation via change-equivalent paths.
  ['s_iban', 's_vat', 'b_vat'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (id === 's_iban') setFieldError(el, validateIBANInline(el.value));
    if (id === 's_vat')  setFieldError(el, validateVatInline(el.value, $('s_country').value));
    if (id === 'b_vat')  setFieldError(el, validateVatInline(el.value, $('b_country').value));
  });
  // Date soft-checks — replicate logic from setupInlineValidation.checkDates.
  const date = $('r_date').value;
  const due = $('r_due').value;
  const dStart = $('r_delivery').value;
  const dEnd = $('r_delivery_end').value;
  let dateErr = null;
  if (date) {
    const d = parseInvoiceDate(date);
    const horizon = new Date();
    horizon.setFullYear(horizon.getFullYear() + 1);
    if (d.getTime() > horizon.getTime()) dateErr = 'err_date_future';
  }
  setFieldError($('r_date'), dateErr);
  setFieldError($('r_due'), (date && due && due < date) ? 'err_due_before_date' : null);
  setFieldError($('r_delivery_end'), (dStart && dEnd && dEnd < dStart) ? 'err_delivery_end_order' : null);
}

// -------- i18n: language dictionary --------
const I18N = {
  de: {
    // Redesign 1a: shell, tabs, seller chip, onboarding, presets, backup
    tab_buyer: 'Käufer',
    tab_items: 'Positionen',
    tab_details: 'Rechnungsdaten',
    label_history: 'Verlauf',
    label_stats: 'Statistik',
    btn_duplicate_short: 'Letzte duplizieren',
    menu_ui_language: 'UI-Sprache',
    menu_theme: 'Design',
    seg_light: 'Hell',
    seg_dark: 'Dunkel',
    seg_auto: 'Auto',
    menu_help: 'Hilfe & Doku',
    menu_backup: 'Backup / Wiederherstellen…',
    menu_rerun_setup: 'Ersteinrichtung ansehen…',
    seller_profile_caption: 'Verkäuferprofil',
    seller_edit_title: 'Verkäuferprofil bearbeiten',
    seller_chip_empty: 'Verkäufer einrichten…',
    f_vat_short: 'USt-IdNr.',
    btn_edit: 'Bearbeiten',
    btn_rerun_setup: 'Zurücksetzen & neu einrichten',
    btn_cancel: 'Abbrechen',
    btn_save: 'Speichern',
    recent_customers: 'Letzte Kunden',
    recent_customers_empty: 'Noch keine gespeicherten Kunden.',
    buyer_name_placeholder: 'Tippen — ergänzt aus früheren Käufern',
    buyer_more_summary: 'Mehr: Namenszeile 2, SIRET, Leitweg-ID',
    btn_save_customer: 'Als Kunde speichern',
    btn_update_customer: 'Kunde aktualisieren',
    btn_delete: 'Löschen',
    confirm_delete_customer: 'Diesen Kunden löschen?',
    confirm_yes: 'Ja',
    confirm_no: 'Nein',
    th_total: 'Summe',
    items_empty_hint: 'Noch keine Positionen — füge hinzu, was du abrechnest.',
    btn_add_first_line: '+ Erste Position',
    totals_net_at: 'Netto @ {rate}%',
    sec_numbering: 'Nummern & Termine',
    sec_project_category: 'Projekt & Kategorie',
    sec_text_blocks: 'Textbausteine',
    sec_currency_tax: 'Währung & Steuer',
    sec_layout: 'Layout',
    sec_filename: 'Dateimuster',
    btn_make_period: '+ Zeitraum daraus machen',
    btn_remove_period: 'Enddatum entfernen',
    preset_save_as: 'Als neues Preset speichern…',
    preset_name_placeholder: 'Preset-Name',
    preset_delete_title: 'Preset löschen',
    preset_name_standard: 'Standard',
    preset_name_short: 'Kurz',
    preset_name_net30: '30 Tage netto',
    preset_name_none: 'Ohne',
    preset_name_smallbiz: 'Kleinunternehmer (§19 UStG)',
    preset_text_intro_standard: 'Vielen Dank für die gute Zusammenarbeit. Wie vereinbart stelle ich Ihnen folgende Leistungen in Rechnung:',
    preset_text_intro_short: 'Anbei die Rechnung für die unten aufgeführten Leistungen.',
    preset_text_payment_standard: 'Zahlbar bis {due} per Überweisung auf das unten genannte Konto.',
    preset_text_payment_net30: 'Zahlbar innerhalb von 30 Tagen ab Rechnungsdatum per Überweisung.',
    preset_text_footnote_smallbiz: 'Als Kleinunternehmer im Sinne von §19 UStG wird keine Umsatzsteuer berechnet.',
    msg_preset_saved: 'Preset gespeichert',
    msg_preset_deleted: 'Preset gelöscht',
    filename_insert_label: 'Einfügen:',
    validate_title: 'Validierungs-Checkliste',
    validate_pass_xml: 'XML wohlgeformt',
    validate_pass_fields: 'Pflichtfelder vorhanden',
    validate_pass_iban: 'IBAN-Prüfsumme gültig',
    validate_footer: 'Nicht blockierend — Export ist trotzdem möglich.',
    history_autosave: 'Auto-Speichern',
    history_count_label: '{n} / {limit} gespeichert',
    th_number: 'Nr.',
    th_buyer: 'Käufer',
    th_date: 'Datum',
    th_total_col: 'Summe',
    btn_history_reload: 'Laden',
    confirm_delete_short: 'Löschen?',
    clear_all_confirm: 'Alle {count} Einträge löschen?',
    btn_yes_clear: 'Ja, löschen',
    stats_empty_title: 'Noch keine Rechnungen',
    stats_empty_cta: 'Erste Rechnung erstellen',
    backup_title: 'Backup & Wiederherstellung',
    backup_export_head: 'Export',
    backup_export_body: 'Lädt alles als eine JSON-Datei herunter: Verkäuferprofil, {buyers} Kundenprofil(e), {history} Rechnung(en) im Verlauf, Text-Presets und Einstellungen.',
    btn_download_backup: 'backup.json herunterladen',
    backup_import_head: 'Import',
    backup_import_body: 'Stellt Daten aus einer zuvor exportierten Backup-Datei wieder her. Ersetzt aktuelle Kunden, Verlauf und Presets.',
    backup_choose_file: 'backup.json auswählen…',
    backup_ready: 'Bereit zur Wiederherstellung:',
    backup_restore: 'Backup wiederherstellen',
    backup_seller_line: 'Verkäuferprofil: {name}',
    backup_buyers_line: '{n} Kundenprofil(e)',
    backup_history_line: '{n} Rechnung(en) im Verlauf',
    ob_step_1: 'Schritt 1 von 2',
    ob_step_2: 'Schritt 2 von 2',
    ob_title_seller: 'Verkäuferprofil einrichten',
    ob_body_seller: 'Deine Geschäftsdaten — sie erscheinen auf jeder Rechnung und werden nur einmal eingegeben.',
    ob_company_placeholder: 'z. B. Max Mustermann',
    ob_load_demo: 'Beispieldaten laden',
    ob_continue: 'Weiter →',
    ob_title_number: 'Rechnungsnummern festlegen',
    ob_body_number: 'Einmal ein Muster wählen — jede neue Rechnung nummeriert sich ab hier selbst.',
    ob_tokens_label: 'Bausteine:',
    ob_next_numbers: 'Nächste Nummern',
    ob_back: '← Zurück',
    ob_finish: 'Einrichtung abschließen',
    msg_setup_done: 'Einrichtung gespeichert',
    help_search_placeholder: 'Themen durchsuchen…',
    help_no_results: 'Keine Treffer.',
    f_buyer_reference_placeholder: 'für Behörden (Leitweg-ID)',
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
    // First-run setup card
    setup_card_title: 'Stammdaten einrichten',
    setup_card_intro: 'Bevor du Rechnungen erstellst, hinterlege deine Absender-Daten: Firma, Steuer-IDs, IBAN/BIC. Alles bleibt lokal im Browser.',
    setup_card_cta: 'Jetzt einrichten',
    setup_card_demo_cta: 'Mit Beispieldaten starten',
    msg_demo_loaded: 'Beispieldaten geladen · nichts gespeichert',
    number_setup_title: 'Nummern-Schema einrichten',
    number_setup_intro: 'Lege Format und Startwert deiner Rechnungsnummern fest. Spätere Anpassung jederzeit über die Rechnungsnummer im Formular.',
    number_setup_pattern_label: 'Format',
    number_setup_start_label: 'Startwert',
    number_setup_preview_label: 'Nächste Nummer',
    number_setup_cta: 'Übernehmen',
    number_setup_default: 'Default verwenden',
    msg_number_setup_done: 'Nummern-Schema gespeichert',
    msg_number_setup_start_invalid: 'Startwert muss eine positive Ganzzahl sein.',
    format_info_title: 'Was ist ZUGFeRD / Factur-X?',
    preview_title: 'Vorschau',
    preview_empty: 'Vorschau erscheint nach Eingabe.',
    preview_updating: 'Aktualisiere…',
    preview_toggle_label: 'Vorschau',
    aria_preview_toggle: 'Live-Vorschau umschalten',
    format_info_body: 'ZUGFeRD und Factur-X bezeichnen dasselbe hybride Format: eine PDF/A-3-Datei mit zusätzlich eingebettetem strukturierten XML nach EN 16931. Das PDF bleibt lesbar wie gewohnt, das XML erlaubt automatische Buchungsläufe beim Empfänger. Für B2B-Rechnungen in Deutschland ab 2025 (Empfang) bzw. 2027 (Versand) Pflicht.',
    format_info_link_label: 'Factur-X-Spezifikation (FNFE-MPE)',
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
    f_company2: 'Firmenname Zeile 2 (optional)',
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
    tip_delivery: 'Datum oder Zeitraum, an dem die Leistung erbracht wurde. Für Einzeltage reicht das Start-Datum; mit End-Datum wird daraus ein Zeitraum.',
    tip_taxmode: 'Inland mit Umsatzsteuer: Standard. EU-B2B-Kunde mit USt-IdNr.: Reverse Charge. Kleinunternehmer §19 oder echte Steuerbefreiung: Steuerbefreit. Nullsatz und Nicht steuerbar sind Sonderfälle.',
    tip_iban: 'IBAN ist Pflicht für SEPA. BIC ist optional bei reinen DE-DE-Zahlungen, aber empfohlen bei Auslandsüberweisungen.',
    aria_tooltip_open: 'Hilfe anzeigen',
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
    rc_legal_text: 'Steuerschuldnerschaft des Leistungsempfängers gemäß Art. 196 MwStSystRL, keine Umsatzsteuer ausgewiesen.',
    msg_rc_legal_added: 'Reverse-Charge-Hinweis ergänzt',
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
    msg_footnote_saved: 'gespeichert.',
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
    pdf_page_of: 'Seite {n} / {total}',
    pdf_continued: 'Fortsetzung',
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
    err_rc_seller_vat: 'Reverse-Charge: Verkäufer benötigt eine USt-IdNr (BT-31). SIRET / Handelsregister-Nr. allein genügt nicht.',
    err_rc_buyer_vat: 'Reverse-Charge: Käufer benötigt eine USt-IdNr (BT-48). SIRET / Handelsregister-Nr. allein genügt nicht.',
    // --- Inline validation (non-blocking) ---
    err_iban_format: 'IBAN-Format ungültig (2 Buchstaben + Ziffern, 15-34 Zeichen).',
    err_iban_checksum: 'IBAN-Prüfsumme stimmt nicht.',
    err_vat_format_de: 'Format: DE + 9 Ziffern.',
    err_vat_format_fr: 'Format: FR + 2 Zeichen + 9 Ziffern.',
    err_vat_format_generic: 'USt-IdNr.-Format ungültig (Länderkürzel + Ziffern/Buchstaben).',
    err_date_future: 'Rechnungsdatum liegt weit in der Zukunft.',
    err_due_before_date: 'Fälligkeit liegt vor dem Rechnungsdatum.',
    err_delivery_end_order: 'Endedatum liegt vor dem Startdatum.',
    // --- XML validator checklist (btnValidate) ---
    validate_xml_syntax_error: 'XML-Syntaxfehler: ',
    validate_missing_number: 'Rechnungsnummer (BT-1) fehlt',
    validate_missing_date: 'Rechnungsdatum (BT-2) fehlt',
    validate_missing_seller_name: 'Verkäufer-Name (BT-27) fehlt',
    validate_missing_buyer_name: 'Käufer-Name (BT-44) fehlt',
    validate_missing_seller_country: 'Verkäufer-Land (BT-40) fehlt',
    validate_missing_buyer_country: 'Käufer-Land (BT-55) fehlt',
    validate_rc_seller_vat: 'Reverse Charge: deine USt-IdNr (BT-31) ist Pflicht',
    validate_rc_buyer_vat: 'Reverse Charge: Käufer-USt-IdNr (BT-48) ist Pflicht',
    validate_recommend_seller_vat: 'USt-IdNr Verkäufer (BT-31) empfohlen',
    validate_missing_items: 'Mindestens eine Position erforderlich',
    validate_negative_amounts: 'Negative Summen in Positionen',
    validate_invalid_iban: 'IBAN ungültig (BT-84) — Prüfsumme oder Format stimmt nicht',
    validate_o_vat_ids: 'Nicht steuerbar (O): USt-IdNrn. von Verkäufer/Käufer dürfen laut EN 16931 (BR-O) nicht angegeben werden',
    // --- PDF metadata (Info dictionary + XMP) ---
    pdf_doc_title: 'Rechnung',
    pdf_doc_subject: 'Factur-X / ZUGFeRD EN 16931 E-Rechnung',
    pdf_doc_producer: 'E-Rechnung Browser-Tool',
    aria_remove_item: 'Position entfernen',
    aria_remove_confirm: 'Löschen bestätigen',
    item_remove_confirm_text: 'löschen?',
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
    history_search_placeholder: 'Suche: Empfänger, Nummer, Betrag, Projekt…',
    history_no_match: 'Keine Treffer für Filter',
    msg_history_saved: 'Im Verlauf gespeichert.',
    msg_history_cloned: 'Aus Verlauf geklont.',
    msg_history_deleted: 'Eintrag gelöscht.',
    msg_history_no_select: 'Keinen Verlaufseintrag ausgewählt.',
    msg_history_cleared: 'Verlauf geleert.',
    // --- Past invoice entry ---
    // Keys that the later "UI restructure" block (see below) redefines with
    // different wording are intentionally omitted here.
    past_modal_title: 'Alte Rechnung hinzufügen',
    past_modal_hint: 'Manuell erfasste Rechnungen erscheinen im Verlauf und in der Statistik. Klonen funktioniert eingeschränkt, da nur Grunddaten erfasst werden.',
    past_field_date: 'Rechnungsdatum',
    past_field_buyer: 'Käufer',
    past_field_buyer_new: 'Oder neuen Namen eingeben',
    past_field_total: 'Gesamtbetrag (brutto)',
    past_field_currency: 'Währung',
    past_field_taxmode: 'Steuermodus',
    past_field_number: 'Rechnungsnr. (optional)',
    past_save: 'Hinzufügen',
    past_cancel: 'Abbrechen',
    msg_history_added: 'Im Verlauf gespeichert.',
    msg_history_clone_partial: 'Geklont – einige Felder leer (manueller Eintrag).',
    history_imported_marker: 'manuell',
    history_status_draft: 'Entwurf',
    history_status_exported: 'Exportiert',
    empty_history_title: 'Noch kein Verlauf',
    empty_history_body: 'Sobald du eine Rechnung generierst, taucht sie hier auf.',
    empty_history_cta: 'Erste Rechnung anlegen',
    empty_filter_title: 'Keine Treffer',
    empty_filter_body: 'Kein Verlaufseintrag passt zum aktuellen Filter.',
    empty_filter_cta: 'Filter zurücksetzen',
    fresh_form_hint: 'Bei null anfangen?',
    fresh_form_cta: 'Letzte Rechnung duplizieren',
    // --- Statistics + buyer history hint ---
    btn_open_stats: 'Statistik',
    stats_title: 'Statistik',
    stats_close: 'Schließen',
    stats_period_label: 'Zeitraum',
    stats_period_last_month: 'Letzte 30 Tage',
    stats_period_last3: 'Letzte 3 Monate',
    stats_period_last6: 'Letzte 6 Monate',
    stats_period_ytd: 'Aktuelles Jahr',
    stats_period_last_year: 'Letztes Jahr',
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
    btn_duplicate_last: 'Letzte Rechnung duplizieren',
    msg_duplicated_last: 'Letzte Rechnung dupliziert · Nummer & Datum aktualisiert',
    msg_duplicate_no_history: 'Noch keine Rechnung im Verlauf zum Duplizieren.',
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
    // Redesign 1a: shell, tabs, seller chip, onboarding, presets, backup
    tab_buyer: 'Buyer',
    tab_items: 'Items',
    tab_details: 'Invoice info',
    label_history: 'History',
    label_stats: 'Stats',
    btn_duplicate_short: 'Duplicate last',
    menu_ui_language: 'UI language',
    menu_theme: 'Theme',
    seg_light: 'Light',
    seg_dark: 'Dark',
    seg_auto: 'Auto',
    menu_help: 'Help & docs',
    menu_backup: 'Backup / restore data…',
    menu_rerun_setup: 'Preview first-run setup…',
    seller_profile_caption: 'Seller profile',
    seller_edit_title: 'Edit seller profile',
    seller_chip_empty: 'Set up seller…',
    f_vat_short: 'VAT ID',
    btn_edit: 'Edit',
    btn_rerun_setup: 'Reset & re-run setup',
    btn_cancel: 'Cancel',
    btn_save: 'Save',
    recent_customers: 'Recent customers',
    recent_customers_empty: 'No saved customers yet.',
    buyer_name_placeholder: 'Start typing — autocompletes from past buyers',
    buyer_more_summary: 'More: name line 2, SIRET, buyer reference / Leitweg-ID',
    btn_save_customer: 'Save as customer',
    btn_update_customer: 'Update customer',
    btn_delete: 'Delete',
    confirm_delete_customer: 'Delete this customer?',
    confirm_yes: 'Yes',
    confirm_no: 'No',
    th_total: 'Total',
    items_empty_hint: 'No line items yet — add what you\'re billing for.',
    btn_add_first_line: '+ Add first line',
    totals_net_at: 'Net @ {rate}%',
    sec_numbering: 'Numbering & dates',
    sec_project_category: 'Project & category',
    sec_text_blocks: 'Text blocks',
    sec_currency_tax: 'Currency & tax',
    sec_layout: 'Layout',
    sec_filename: 'Filename pattern',
    btn_make_period: '+ Make it a period',
    btn_remove_period: 'Remove end date',
    preset_save_as: 'Save as new preset…',
    preset_name_placeholder: 'Preset name',
    preset_delete_title: 'Delete preset',
    preset_name_standard: 'Standard',
    preset_name_short: 'Short',
    preset_name_net30: 'Net 30',
    preset_name_none: 'None',
    preset_name_smallbiz: 'Small business note (§19 UStG)',
    preset_text_intro_standard: 'Thank you for the good cooperation and, as agreed, I will invoice you for the following services:',
    preset_text_intro_short: 'Please find the invoice for the services below.',
    preset_text_payment_standard: 'Payment due until {due} by money transfer only to the account found at the bottom of the invoice.',
    preset_text_payment_net30: 'Payment due within 30 days of the invoice date via bank transfer.',
    preset_text_footnote_smallbiz: 'As a small business owner, I do not charge VAT according to §19 UStG.',
    msg_preset_saved: 'Preset saved',
    msg_preset_deleted: 'Preset deleted',
    filename_insert_label: 'Insert:',
    validate_title: 'Validation checklist',
    validate_pass_xml: 'XML well-formed',
    validate_pass_fields: 'Required fields present',
    validate_pass_iban: 'IBAN checksum valid',
    validate_footer: 'Non-blocking — you can still export.',
    history_autosave: 'Auto-save',
    history_count_label: '{n} / {limit} saved',
    th_number: 'No.',
    th_buyer: 'Buyer',
    th_date: 'Date',
    th_total_col: 'Total',
    btn_history_reload: 'Reload',
    confirm_delete_short: 'Delete?',
    clear_all_confirm: 'Delete all {count} snapshots?',
    btn_yes_clear: 'Yes, clear',
    stats_empty_title: 'No invoices yet',
    stats_empty_cta: 'Create your first invoice',
    backup_title: 'Backup & restore',
    backup_export_head: 'Export',
    backup_export_body: 'Downloads everything as one JSON file: seller profile, {buyers} buyer profile(s), {history} invoice(s) in history, text presets, and settings.',
    btn_download_backup: 'Download backup.json',
    backup_import_head: 'Import',
    backup_import_body: 'Restores data from a previously exported backup file. This replaces your current buyers, history, and presets.',
    backup_choose_file: 'Choose a backup.json file…',
    backup_ready: 'Ready to restore:',
    backup_restore: 'Restore backup',
    backup_seller_line: 'Seller profile: {name}',
    backup_buyers_line: '{n} buyer profile(s)',
    backup_history_line: '{n} invoice(s) in history',
    ob_step_1: 'Step 1 of 2',
    ob_step_2: 'Step 2 of 2',
    ob_title_seller: 'Set up your seller profile',
    ob_body_seller: 'This is your business info — it appears on every invoice and only needs to be entered once.',
    ob_company_placeholder: 'e.g. Max Mustermann',
    ob_load_demo: 'Load demo data',
    ob_continue: 'Continue →',
    ob_title_number: 'Choose your invoice numbering',
    ob_body_number: 'Pick a pattern once — every new invoice numbers itself from here.',
    ob_tokens_label: 'Tokens:',
    ob_next_numbers: 'Next numbers',
    ob_back: '← Back',
    ob_finish: 'Finish setup',
    msg_setup_done: 'Setup saved',
    help_search_placeholder: 'Search topics…',
    help_no_results: 'No topics match.',
    f_buyer_reference_placeholder: 'government clients (Leitweg-ID)',
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
    setup_card_title: 'Set up your master data',
    setup_card_intro: 'Before creating invoices, enter your sender details: company, tax IDs, IBAN/BIC. Everything stays local in your browser.',
    setup_card_cta: 'Set up now',
    setup_card_demo_cta: 'Start with demo data',
    msg_demo_loaded: 'Demo data loaded · nothing saved',
    number_setup_title: 'Set up your invoice numbers',
    number_setup_intro: 'Choose the format and starting value for invoice numbers. You can tweak it any time via the number field in the form.',
    number_setup_pattern_label: 'Format',
    number_setup_start_label: 'Start value',
    number_setup_preview_label: 'Next number',
    number_setup_cta: 'Apply',
    number_setup_default: 'Use default',
    msg_number_setup_done: 'Number scheme saved',
    msg_number_setup_start_invalid: 'Start value must be a positive integer.',
    format_info_title: 'What is ZUGFeRD / Factur-X?',
    preview_title: 'Preview',
    preview_empty: 'Preview shows up once you start filling the form.',
    preview_updating: 'Updating…',
    preview_toggle_label: 'Preview',
    aria_preview_toggle: 'Toggle live preview',
    format_info_body: 'ZUGFeRD and Factur-X are the same hybrid format: a PDF/A-3 file with structured XML (EN 16931) embedded inside. The PDF stays readable for humans; the XML lets the recipient post the invoice automatically. Mandatory for German B2B from 2025 (receiving) and 2027 (sending).',
    format_info_link_label: 'Factur-X specification (FNFE-MPE)',
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
    f_company2: 'Company name line 2 (optional)',
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
    tip_delivery: 'The date (or period) when the service was actually delivered. For a single day, the start date alone is enough; add an end date for a range.',
    tip_taxmode: 'Domestic with VAT: Standard. EU B2B customer with a VAT ID: Reverse Charge. Small-business or true exemption: Exempt. Zero rate and Out of scope are edge cases.',
    tip_iban: 'IBAN is required for SEPA transfers. BIC is optional for domestic payments but expected for cross-border transfers.',
    aria_tooltip_open: 'Show help',
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
    rc_legal_text: 'Reverse charge applies: VAT to be accounted for by the recipient under Art. 196 of Council Directive 2006/112/EC.',
    msg_rc_legal_added: 'Reverse-charge note added',
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
    msg_footnote_saved: 'saved.',
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
    pdf_page_of: 'Page {n} / {total}',
    pdf_continued: 'continued',
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
    err_rc_seller_vat: 'Reverse charge requires a Seller VAT ID (BT-31). SIRET / legal-registration ID alone is not sufficient.',
    err_rc_buyer_vat: 'Reverse charge requires a Buyer VAT ID (BT-48). SIRET / legal-registration ID alone is not sufficient.',
    // --- Inline validation (non-blocking) ---
    err_iban_format: 'IBAN format invalid (2 letters + digits, 15-34 chars).',
    err_iban_checksum: 'IBAN checksum mismatch.',
    err_vat_format_de: 'Format: DE + 9 digits.',
    err_vat_format_fr: 'Format: FR + 2 chars + 9 digits.',
    err_vat_format_generic: 'VAT ID format invalid (country prefix + digits/letters).',
    err_date_future: 'Invoice date is far in the future.',
    err_due_before_date: 'Due date is before invoice date.',
    err_delivery_end_order: 'End date is before start date.',
    // --- XML validator checklist (btnValidate) ---
    validate_xml_syntax_error: 'XML syntax error: ',
    validate_missing_number: 'Invoice number (BT-1) is missing',
    validate_missing_date: 'Invoice date (BT-2) is missing',
    validate_missing_seller_name: 'Seller name (BT-27) is missing',
    validate_missing_buyer_name: 'Buyer name (BT-44) is missing',
    validate_missing_seller_country: 'Seller country (BT-40) is missing',
    validate_missing_buyer_country: 'Buyer country (BT-55) is missing',
    validate_rc_seller_vat: 'Reverse charge: your VAT ID (BT-31) is required',
    validate_rc_buyer_vat: 'Reverse charge: buyer VAT ID (BT-48) is required',
    validate_recommend_seller_vat: 'Seller VAT ID (BT-31) recommended',
    validate_missing_items: 'At least one line item is required',
    validate_negative_amounts: 'Negative amounts in line items',
    validate_invalid_iban: 'IBAN looks invalid (BT-84) — checksum or format mismatch',
    validate_o_vat_ids: 'Out of scope (O): seller/buyer VAT IDs must not be present per EN 16931 (BR-O rules)',
    // --- PDF metadata (Info dictionary + XMP) ---
    pdf_doc_title: 'Invoice',
    pdf_doc_subject: 'Factur-X / ZUGFeRD EN 16931 e-invoice',
    pdf_doc_producer: 'E-Invoice Browser Tool',
    aria_remove_item: 'Remove line item',
    aria_remove_confirm: 'Confirm delete',
    item_remove_confirm_text: 'delete?',
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
    history_search_placeholder: 'Search: buyer, number, total, project…',
    history_no_match: 'No matches for current filter',
    msg_history_saved: 'Saved to history.',
    msg_history_cloned: 'Cloned from history.',
    msg_history_deleted: 'Entry deleted.',
    msg_history_no_select: 'No history entry selected.',
    msg_history_cleared: 'History cleared.',
    // --- Past invoice entry ---
    // Keys that the later "UI restructure" block (see below) redefines with
    // different wording are intentionally omitted here.
    past_modal_title: 'Add past invoice',
    past_modal_hint: 'Manually entered invoices appear in history and statistics. Cloning works partially since only basic fields are captured.',
    past_field_date: 'Invoice date',
    past_field_buyer: 'Buyer',
    past_field_buyer_new: 'Or enter a new name',
    past_field_total: 'Total (gross)',
    past_field_currency: 'Currency',
    past_field_taxmode: 'Tax mode',
    past_field_number: 'Invoice no. (optional)',
    past_save: 'Add',
    past_cancel: 'Cancel',
    msg_history_added: 'Saved to history.',
    msg_history_clone_partial: 'Cloned with partial data (manual entry).',
    history_imported_marker: 'manual',
    history_status_draft: 'Draft',
    history_status_exported: 'Exported',
    empty_history_title: 'No history yet',
    empty_history_body: 'Generated invoices will show up here.',
    empty_history_cta: 'Create your first invoice',
    empty_filter_title: 'No matches',
    empty_filter_body: 'No history entry fits the current filter.',
    empty_filter_cta: 'Reset filters',
    fresh_form_hint: 'Start from scratch?',
    fresh_form_cta: 'Duplicate last invoice',
    // --- Statistics + buyer history hint ---
    btn_open_stats: 'Statistics',
    stats_title: 'Statistics',
    stats_close: 'Close',
    stats_period_label: 'Period',
    stats_period_last_month: 'Last 30 days',
    stats_period_last3: 'Last 3 months',
    stats_period_last6: 'Last 6 months',
    stats_period_ytd: 'This year',
    stats_period_last_year: 'Last year',
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
    btn_duplicate_last: 'Duplicate last invoice',
    msg_duplicated_last: 'Last invoice duplicated · number & date refreshed',
    msg_duplicate_no_history: 'No history entry yet to duplicate.',
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
    // Redesign 1a: shell, tabs, seller chip, onboarding, presets, backup
    tab_buyer: 'Client',
    tab_items: 'Lignes',
    tab_details: 'Infos facture',
    label_history: 'Historique',
    label_stats: 'Stats',
    btn_duplicate_short: 'Dupliquer la dernière',
    menu_ui_language: 'Langue de l\'interface',
    menu_theme: 'Thème',
    seg_light: 'Clair',
    seg_dark: 'Sombre',
    seg_auto: 'Auto',
    menu_help: 'Aide & docs',
    menu_backup: 'Sauvegarde / restauration…',
    menu_rerun_setup: 'Revoir la configuration initiale…',
    seller_profile_caption: 'Profil vendeur',
    seller_edit_title: 'Modifier le profil vendeur',
    seller_chip_empty: 'Configurer le vendeur…',
    f_vat_short: 'N° TVA',
    btn_edit: 'Modifier',
    btn_rerun_setup: 'Réinitialiser & reconfigurer',
    btn_cancel: 'Annuler',
    btn_save: 'Enregistrer',
    recent_customers: 'Clients récents',
    recent_customers_empty: 'Aucun client enregistré pour l\'instant.',
    buyer_name_placeholder: 'Saisir — complété depuis les clients passés',
    buyer_more_summary: 'Plus : 2e ligne de nom, SIRET, référence acheteur / Leitweg-ID',
    btn_save_customer: 'Enregistrer comme client',
    btn_update_customer: 'Mettre à jour le client',
    btn_delete: 'Supprimer',
    confirm_delete_customer: 'Supprimer ce client ?',
    confirm_yes: 'Oui',
    confirm_no: 'Non',
    th_total: 'Total',
    items_empty_hint: 'Aucune ligne pour l\'instant — ajoutez ce que vous facturez.',
    btn_add_first_line: '+ Ajouter une première ligne',
    totals_net_at: 'HT @ {rate}%',
    sec_numbering: 'Numérotation & dates',
    sec_project_category: 'Projet & catégorie',
    sec_text_blocks: 'Blocs de texte',
    sec_currency_tax: 'Devise & TVA',
    sec_layout: 'Mise en page',
    sec_filename: 'Modèle de nom de fichier',
    btn_make_period: '+ Transformer en période',
    btn_remove_period: 'Supprimer la date de fin',
    preset_save_as: 'Enregistrer comme nouveau preset…',
    preset_name_placeholder: 'Nom du preset',
    preset_delete_title: 'Supprimer le preset',
    preset_name_standard: 'Standard',
    preset_name_short: 'Court',
    preset_name_net30: '30 jours nets',
    preset_name_none: 'Aucune',
    preset_name_smallbiz: 'Franchise en base (§19 UStG)',
    preset_text_intro_standard: 'Merci pour la bonne collaboration. Comme convenu, je vous facture les prestations suivantes :',
    preset_text_intro_short: 'Veuillez trouver ci-dessous la facture des prestations.',
    preset_text_payment_standard: 'Paiement attendu pour le {due} par virement sur le compte indiqué en bas de la facture.',
    preset_text_payment_net30: 'Paiement à 30 jours à compter de la date de facture, par virement.',
    preset_text_footnote_smallbiz: 'En tant que micro-entrepreneur au sens du §19 UStG, la TVA n\'est pas facturée.',
    msg_preset_saved: 'Preset enregistré',
    msg_preset_deleted: 'Preset supprimé',
    filename_insert_label: 'Insérer :',
    validate_title: 'Liste de vérification',
    validate_pass_xml: 'XML bien formé',
    validate_pass_fields: 'Champs obligatoires présents',
    validate_pass_iban: 'Somme de contrôle IBAN valide',
    validate_footer: 'Non bloquant — l\'export reste possible.',
    history_autosave: 'Sauvegarde auto',
    history_count_label: '{n} / {limit} enregistrées',
    th_number: 'N°',
    th_buyer: 'Client',
    th_date: 'Date',
    th_total_col: 'Total',
    btn_history_reload: 'Recharger',
    confirm_delete_short: 'Supprimer ?',
    clear_all_confirm: 'Supprimer les {count} entrées ?',
    btn_yes_clear: 'Oui, tout effacer',
    stats_empty_title: 'Pas encore de factures',
    stats_empty_cta: 'Créer votre première facture',
    backup_title: 'Sauvegarde & restauration',
    backup_export_head: 'Export',
    backup_export_body: 'Télécharge tout dans un seul fichier JSON : profil vendeur, {buyers} profil(s) client, {history} facture(s) dans l\'historique, presets de texte et réglages.',
    btn_download_backup: 'Télécharger backup.json',
    backup_import_head: 'Import',
    backup_import_body: 'Restaure les données d\'un fichier de sauvegarde exporté auparavant. Remplace vos clients, votre historique et vos presets actuels.',
    backup_choose_file: 'Choisir un fichier backup.json…',
    backup_ready: 'Prêt à restaurer :',
    backup_restore: 'Restaurer la sauvegarde',
    backup_seller_line: 'Profil vendeur : {name}',
    backup_buyers_line: '{n} profil(s) client',
    backup_history_line: '{n} facture(s) dans l\'historique',
    ob_step_1: 'Étape 1 sur 2',
    ob_step_2: 'Étape 2 sur 2',
    ob_title_seller: 'Configurer votre profil vendeur',
    ob_body_seller: 'Vos informations professionnelles — elles figurent sur chaque facture et ne se saisissent qu\'une fois.',
    ob_company_placeholder: 'ex. Max Mustermann',
    ob_load_demo: 'Charger des données de démo',
    ob_continue: 'Continuer →',
    ob_title_number: 'Choisir votre numérotation',
    ob_body_number: 'Choisissez un modèle une fois — chaque nouvelle facture se numérote ensuite toute seule.',
    ob_tokens_label: 'Jetons :',
    ob_next_numbers: 'Prochains numéros',
    ob_back: '← Retour',
    ob_finish: 'Terminer la configuration',
    msg_setup_done: 'Configuration enregistrée',
    help_search_placeholder: 'Rechercher un sujet…',
    help_no_results: 'Aucun sujet ne correspond.',
    f_buyer_reference_placeholder: 'clients publics (Leitweg-ID)',
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
    setup_card_title: 'Configurer vos données',
    setup_card_intro: 'Avant de créer des factures, renseignez votre profil émetteur : société, numéros fiscaux, IBAN/BIC. Tout reste local dans le navigateur.',
    setup_card_cta: 'Configurer maintenant',
    setup_card_demo_cta: 'Démarrer avec un exemple',
    msg_demo_loaded: 'Données de démo chargées · rien enregistré',
    number_setup_title: 'Configurer la numérotation',
    number_setup_intro: 'Choisissez le format et le numéro de départ. Ajustable à tout moment depuis le champ numéro dans le formulaire.',
    number_setup_pattern_label: 'Format',
    number_setup_start_label: 'Numéro de départ',
    number_setup_preview_label: 'Prochain numéro',
    number_setup_cta: 'Appliquer',
    number_setup_default: 'Utiliser la valeur par défaut',
    msg_number_setup_done: 'Schéma de numérotation enregistré',
    msg_number_setup_start_invalid: 'Le numéro de départ doit être un entier positif.',
    format_info_title: 'Qu\'est-ce que ZUGFeRD / Factur-X ?',
    preview_title: 'Aperçu',
    preview_empty: 'L\'aperçu apparaîtra dès que vous remplirez le formulaire.',
    preview_updating: 'Mise à jour…',
    preview_toggle_label: 'Aperçu',
    aria_preview_toggle: 'Basculer l\'aperçu en direct',
    format_info_body: 'ZUGFeRD et Factur-X désignent le même format hybride : un PDF/A-3 avec un XML structuré (EN 16931) intégré. Le PDF reste lisible normalement ; le XML permet le traitement automatique chez le destinataire. Obligatoire pour le B2B allemand à partir de 2025 (réception) et 2027 (émission).',
    format_info_link_label: 'Spécification Factur-X (FNFE-MPE)',
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
    f_company2: 'Société ligne 2 (optionnel)',
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
    tip_delivery: 'Date ou période où la prestation a été effectivement réalisée. Pour une seule journée, la date de début suffit ; ajoutez une fin pour un intervalle.',
    tip_taxmode: 'National avec TVA : Standard. Client UE B2B avec n° TVA : Autoliquidation. Micro-entrepreneur ou exonération réelle : Exonéré. Taux zéro et Hors champ sont des cas particuliers.',
    tip_iban: 'L\'IBAN est obligatoire pour les virements SEPA. Le BIC est facultatif pour les paiements domestiques, recommandé pour l\'international.',
    aria_tooltip_open: 'Afficher l\'aide',
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
    rc_legal_text: 'Autoliquidation par le preneur : TVA due par le destinataire conformément à l\'art. 196 de la directive 2006/112/CE.',
    msg_rc_legal_added: 'Mention d\'autoliquidation ajoutée',
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
    msg_footnote_saved: 'enregistrée.',
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
    pdf_page_of: 'Page {n} / {total}',
    pdf_continued: 'suite',
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
    err_rc_seller_vat: 'Autoliquidation : numéro de TVA vendeur requis (BT-31). Le SIRET seul ne suffit pas.',
    err_rc_buyer_vat: 'Autoliquidation : numéro de TVA acheteur requis (BT-48). Le SIRET seul ne suffit pas.',
    // --- Inline validation (non-blocking) ---
    err_iban_format: 'Format IBAN invalide (2 lettres + chiffres, 15-34 caractères).',
    err_iban_checksum: 'Somme de contrôle IBAN incorrecte.',
    err_vat_format_de: 'Format : DE + 9 chiffres.',
    err_vat_format_fr: 'Format : FR + 2 caractères + 9 chiffres.',
    err_vat_format_generic: 'Format numéro de TVA invalide (préfixe pays + chiffres/lettres).',
    err_date_future: 'Date de facture loin dans le futur.',
    err_due_before_date: 'Échéance avant la date de facture.',
    err_delivery_end_order: 'Date de fin avant la date de début.',
    // --- XML validator checklist (btnValidate) ---
    validate_xml_syntax_error: 'Erreur de syntaxe XML : ',
    validate_missing_number: 'Numéro de facture (BT-1) manquant',
    validate_missing_date: 'Date de facture (BT-2) manquante',
    validate_missing_seller_name: 'Nom du vendeur (BT-27) manquant',
    validate_missing_buyer_name: 'Nom de l\'acheteur (BT-44) manquant',
    validate_missing_seller_country: 'Pays du vendeur (BT-40) manquant',
    validate_missing_buyer_country: 'Pays de l\'acheteur (BT-55) manquant',
    validate_rc_seller_vat: 'Autoliquidation : votre n° de TVA (BT-31) est obligatoire',
    validate_rc_buyer_vat: 'Autoliquidation : n° de TVA acheteur (BT-48) obligatoire',
    validate_recommend_seller_vat: 'N° de TVA vendeur (BT-31) recommandé',
    validate_missing_items: 'Au moins une ligne est requise',
    validate_negative_amounts: 'Montants négatifs dans les lignes',
    validate_invalid_iban: 'IBAN invalide (BT-84) — somme de contrôle ou format incorrect',
    validate_o_vat_ids: 'Hors champ (O) : les n° TVA vendeur/acheteur ne doivent pas figurer selon EN 16931 (règles BR-O)',
    // --- PDF metadata (Info dictionary + XMP) ---
    pdf_doc_title: 'Facture',
    pdf_doc_subject: 'Facture électronique Factur-X / ZUGFeRD EN 16931',
    pdf_doc_producer: 'Outil de facturation électronique (navigateur)',
    aria_remove_item: 'Supprimer la ligne',
    aria_remove_confirm: 'Confirmer la suppression',
    item_remove_confirm_text: 'supprimer ?',
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
    history_search_placeholder: 'Rechercher : client, numéro, montant, projet…',
    history_no_match: 'Aucun résultat pour ce filtre',
    msg_history_saved: 'Enregistré dans l\'historique.',
    msg_history_cloned: 'Cloné depuis l\'historique.',
    msg_history_deleted: 'Entrée supprimée.',
    msg_history_no_select: 'Aucune entrée de l\'historique sélectionnée.',
    msg_history_cleared: 'Historique effacé.',
    // --- Past invoice entry ---
    // Keys that the later "UI restructure" block (see below) redefines with
    // different wording are intentionally omitted here.
    past_modal_title: 'Ajouter ancienne facture',
    past_modal_hint: 'Les factures saisies manuellement apparaissent dans l\'historique et les statistiques. Le clonage fonctionne partiellement car seuls les champs de base sont saisis.',
    past_field_date: 'Date de facture',
    past_field_buyer: 'Acheteur',
    past_field_buyer_new: 'Ou saisir un nouveau nom',
    past_field_total: 'Total (TTC)',
    past_field_currency: 'Devise',
    past_field_taxmode: 'Mode de TVA',
    past_field_number: 'N° de facture (facultatif)',
    past_save: 'Ajouter',
    past_cancel: 'Annuler',
    msg_history_added: 'Enregistré dans l\'historique.',
    msg_history_clone_partial: 'Cloné avec données partielles (saisie manuelle).',
    history_imported_marker: 'manuel',
    history_status_draft: 'Brouillon',
    history_status_exported: 'Exporté',
    empty_history_title: 'Pas encore d\'historique',
    empty_history_body: 'Les factures générées apparaîtront ici.',
    empty_history_cta: 'Créer la première facture',
    empty_filter_title: 'Aucun résultat',
    empty_filter_body: 'Aucune entrée ne correspond au filtre actuel.',
    empty_filter_cta: 'Réinitialiser les filtres',
    fresh_form_hint: 'Repartir de zéro ?',
    fresh_form_cta: 'Dupliquer la dernière facture',
    // --- Statistics + buyer history hint ---
    btn_open_stats: 'Statistiques',
    stats_title: 'Statistiques',
    stats_close: 'Fermer',
    stats_period_label: 'Période',
    stats_period_last_month: '30 derniers jours',
    stats_period_last3: '3 derniers mois',
    stats_period_last6: '6 derniers mois',
    stats_period_ytd: 'Cette année',
    stats_period_last_year: 'Année dernière',
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
    btn_duplicate_last: 'Dupliquer la dernière facture',
    msg_duplicated_last: 'Dernière facture dupliquée · numéro et date mis à jour',
    msg_duplicate_no_history: 'Aucune facture dans l\'historique à dupliquer.',
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

const LANG_KEY = 'erechnung:lang:v1';
const INVOICE_LANG_KEY = 'erechnung:invoice_lang:v1';
const THEME_KEY = 'erechnung:theme:v1';

// One-time storage-key migration helper. The convention is `erechnung:<name>:v1`
// (see CLAUDE.md). Use this when you bump a key version OR rename a key
// (e.g. v1 → v2 schema change): pass the old and new names, plus an optional
// `transform` to convert old-shape values to the new schema. Idempotent —
// the migration is a no-op once the new key has been written.
//
// Synchronous because the three keys below (lang/invoice_lang/theme) are read
// synchronously at init to avoid theme/language flashes.
function migrateLocalStorageKey(oldKey, newKey, transform) {
  try {
    if (localStorage.getItem(newKey) !== null) return;
    const v = localStorage.getItem(oldKey);
    if (v === null) return;
    const next = transform ? transform(v) : v;
    if (next !== null && next !== undefined) localStorage.setItem(newKey, next);
    localStorage.removeItem(oldKey);
  } catch (_) { /* quota/security errors — ignore */ }
}
// v1.5.4: align lang/invoice_lang/theme with the :v1 convention used by every
// other key in this app. Pure rename — no value transformation.
migrateLocalStorageKey('erechnung:lang', LANG_KEY);
migrateLocalStorageKey('erechnung:invoice_lang', INVOICE_LANG_KEY);
migrateLocalStorageKey('erechnung:theme', THEME_KEY);
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

// Resolve every `data-i18n*` attribute under `root` (default: document).
// Callers that just freshly injected innerHTML containing data-i18n nodes
// should pass that container — sweeping the whole document is wasteful when
// only a small subtree needs translating. Page-wide effects (the <title> tag,
// the lang attribute, full re-render of pickers/totals) only fire on the
// global call.
function applyTranslations(root) {
  const scope = root || document;
  scope.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  scope.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
  });
  scope.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
  });
  scope.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
    el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label')));
  });
  if (root) return;
  // Global pass: page-wide side effects.
  const titleEl = document.querySelector('title');
  if (titleEl) titleEl.textContent = t('title');
  document.documentElement.lang = CURRENT_LANG;
  // re-render dynamic UI (totals labels depend on tax mode + lang)
  if (typeof calcTotals === 'function') calcTotals();
  if (typeof renderBuyerPicker === 'function') renderBuyerPicker();
  if (typeof renderTextPresetSelects === 'function') renderTextPresetSelects();
  if (typeof renderHistoryPicker === 'function') renderHistoryPicker();
  if (typeof updateBuyerHistoryHint === 'function') updateBuyerHistoryHint();
  if (typeof renderItems === 'function') renderItems();
  if (typeof updateFilenamePreview === 'function') updateFilenamePreview();
  if (typeof updateBuyerActionUI === 'function') updateBuyerActionUI();
  if (typeof updateSellerChip === 'function') updateSellerChip();
  if (typeof updateDueDateUI === 'function') updateDueDateUI();
  if (typeof updateHistoryCountLabel === 'function') updateHistoryCountLabel();
  if (typeof updateBackupExportSummary === 'function') updateBackupExportSummary();
  if (typeof renderHelpTopics === 'function') renderHelpTopics();
  if (typeof updateSuggestNumberChipPreview === 'function') updateSuggestNumberChipPreview();
}

function setLang(lang) {
  if (!I18N[lang]) lang = 'en';
  CURRENT_LANG = lang;
  localStorage.setItem(LANG_KEY, lang);
  applyTranslations();
  if (typeof updateLangSegment === 'function') updateLangSegment();
  if (typeof refreshInlineValidation === 'function') refreshInlineValidation();
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
    try { localStorage.setItem(key, value); return true; } catch (e) {
      // Most common: QuotaExceededError when history + yoy + buyers approach 5 MB.
      console.warn(`[erechnung] localStorage.setItem(${key}) failed:`, e?.message || e);
    }
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
  } catch (e) { console.warn('[erechnung] Failed to load seller profile:', e?.message || e); }
  // Load boilerplate for currently effective invoice language
  await loadBoilerplateForLang(effectiveInvoiceLang());
  updateSellerChip();
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
  } catch (e) {
    console.warn('[erechnung] Failed to read existing boilerplate map; current language will overwrite:', e?.message || e);
  }
  bMap[effectiveInvoiceLang()] = boilerplate;
  const ok2 = await store.set(BOILERPLATE_KEY, JSON.stringify(bMap));
  if (ok1 && ok2) {
    toast(t('msg_seller_saved'), 'ok');
    updateSellerChip();
  } else {
    toast(t('msg_save_failed'), 'err');
  }
}
function collectSellerStammdaten() {
  return {
    name: $('s_name').value.trim(),
    name2: $('s_name2').value.trim(),
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
  $('s_name2').value = nz(s.name2);
  $('s_line1').value = nz(s.line1);
  $('s_zip').value = nz(s.zip);
  $('s_city').value = nz(s.city);
  // Asymmetric defaults are deliberate: this app was originally tailored to a
  // German seller billing French clients. Seller defaults to DE, buyer (see
  // applyBuyer) defaults to FR. Users from elsewhere overwrite both on first use.
  $('s_country').value = nz(s.country, 'DE');
  $('s_vat').value = nz(s.vat);
  $('s_siret').value = nz(s.siret);
  $('s_email').value = nz(s.email);
  $('s_phone').value = nz(s.phone);
  $('s_iban').value = nz(s.iban);
  $('s_bic').value = nz(s.bic);
  $('s_bank').value = nz(s.bank);
  if (typeof refreshInlineValidation === 'function') refreshInlineValidation();
  if (typeof schedulePreviewRender === 'function') schedulePreviewRender();
}
function applyBoilerplate(b) {
  $('r_intro').value = nz(b.intro);
  $('r_payment_note').value = nz(b.payment_note);
  $('r_greeting').value = nz(b.greeting);
  $('r_signature').value = nz(b.signature);
  $('r_footnote').value = nz(b.footnote);
  if (typeof updateTextBlockDirtyUI === 'function') {
    TEXT_BLOCKS.forEach(updateTextBlockDirtyUI);
  }
}
function applySeller(s) {
  // Legacy entry point for backups that still have boilerplate inside the seller object.
  applySellerStammdaten(s);
  if (s.intro !== undefined || s.payment_note !== undefined || s.greeting !== undefined ||
      s.signature !== undefined || s.footnote !== undefined) {
    applyBoilerplate(s);
  }
}

// Per-language boilerplate
async function loadBoilerplateForLang(lang) {
  let bMap = {};
  try {
    const raw = await store.get(BOILERPLATE_KEY);
    if (raw) bMap = JSON.parse(raw) || {};
  } catch (e) {
    console.warn('[erechnung] Failed to load boilerplate:', e?.message || e);
  }
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
    name2: $('b_name2').value.trim(),
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
  $('b_name2').value = nz(b.name2);
  $('b_line1').value = nz(b.line1);
  $('b_zip').value = nz(b.zip);
  $('b_city').value = nz(b.city);
  $('b_country').value = nz(b.country, 'FR');
  $('b_vat').value = nz(b.vat);
  $('b_siret').value = nz(b.siret);
  $('b_reference').value = nz(b.reference);
  if (typeof refreshInlineValidation === 'function') refreshInlineValidation();
  if (typeof schedulePreviewRender === 'function') schedulePreviewRender();
}
function clearBuyer() {
  $('b_name').value = '';
  $('b_name2').value = '';
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
  } catch (e) {
    console.warn('[erechnung] Failed to load buyers:', e?.message || e);
    state.buyers = [];
  }
  renderBuyerPicker();
}
async function persistBuyers() {
  const ok = await store.set(BUYERS_KEY, JSON.stringify(state.buyers));
  if (!ok) toast(t('msg_save_failed'), 'err');
}
function renderBuyerPicker() {
  const picker = $('buyerPicker');
  const current = picker.value;
  picker.innerHTML = `<option value="">${esc(t('f_buyer_picker'))}</option>` +
    state.buyers
      .map((b, i) => `<option value="${i}">${esc(b.name || t('msg_buyer_unnamed'))}${b.city ? ' · ' + esc(b.city) : ''}</option>`)
      .join('');
  if (current && state.buyers[current]) picker.value = current;
  renderRecentCustomerChips();
  updateBuyerActionUI();
}

// Pill chips above the profile select — the last four saved buyers,
// most-recently-added first, active when selected. Clicking a chip is the
// fast path for "same customer again".
function renderRecentCustomerChips() {
  const row = document.getElementById('recentCustomers');
  if (!row) return;
  if (state.buyers.length === 0) {
    row.innerHTML = `<span class="chip-row-empty">${esc(t('recent_customers_empty'))}</span>`;
    return;
  }
  const current = $('buyerPicker').value;
  row.innerHTML = state.buyers
    .map((b, i) => ({ b, i }))
    .slice(-4)
    .reverse()
    .map(({ b, i }) => `<button type="button" class="buyer-chip${String(i) === current ? ' active' : ''}" data-idx="${i}">${esc(b.name || t('msg_buyer_unnamed'))}</button>`)
    .join('');
  row.querySelectorAll('.buyer-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = btn.dataset.idx;
      const picker = $('buyerPicker');
      picker.value = picker.value === idx ? '' : idx;
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
}

// Save-button label ("Save as customer" vs "Update customer") and delete
// visibility both key off whether a profile is selected.
function updateBuyerActionUI() {
  const picker = document.getElementById('buyerPicker');
  const saveBtn = document.getElementById('saveBuyer');
  const delBtn = document.getElementById('deleteBuyer');
  const confirmRow = document.getElementById('buyerDeleteConfirm');
  if (!picker || !saveBtn || !delBtn) return;
  const hasSelection = picker.value !== '' && state.buyers[picker.value];
  saveBtn.textContent = t(hasSelection ? 'btn_update_customer' : 'btn_save_customer');
  delBtn.hidden = !hasSelection || !confirmRow.hidden;
  if (!hasSelection && confirmRow) confirmRow.hidden = true;
}

// Datalist suggestions for the buyer name input, derived live from history.
// Deduplicated by lowercased name, most recent first, capped at 20.
const BUYER_MEMORY_LIMIT = 20;
function renderBuyerNamesMemory() {
  const dl = document.getElementById('buyerNamesMemory');
  if (!dl) return;
  const seen = new Set();
  const opts = [];
  for (const s of state.history) {
    const name = (s.buyerName || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const city = (s.form && s.form.buyer && s.form.buyer.city) ? s.form.buyer.city : '';
    const label = city ? `${name} · ${city}` : name;
    opts.push(`<option value="${esc(name)}" label="${esc(label)}"></option>`);
    if (opts.length >= BUYER_MEMORY_LIMIT) break;
  }
  dl.innerHTML = opts.join('');
}

// Find the most recent history snapshot whose buyer name matches exactly
// (case-insensitive). Returns the form.buyer object or null.
function findHistoryBuyerByName(name) {
  const target = (name || '').toLowerCase().trim();
  if (!target) return null;
  for (const s of state.history) {
    if ((s.buyerName || '').toLowerCase().trim() === target) {
      return (s.form && s.form.buyer) ? s.form.buyer : null;
    }
  }
  return null;
}

// True iff every buyer address field except the name is empty. Used to
// decide whether a datalist pick should autofill without clobbering input.
function buyerAddressEmpty() {
  return !$('b_name2').value.trim()
    && !$('b_line1').value.trim()
    && !$('b_zip').value.trim()
    && !$('b_city').value.trim()
    && !$('b_vat').value.trim()
    && !$('b_siret').value.trim()
    && !$('b_reference').value.trim();
}
async function saveBuyer() {
  const data = collectBuyer();
  if (!data.name) { toast(t('msg_buyer_no_name'), 'err'); return; }
  const picker = $('buyerPicker');
  const idx = picker.value;
  if (idx !== '' && state.buyers[idx]) {
    state.buyers[idx] = data;
    toast(`"${data.name}" ${t('msg_buyer_updated')}`, 'ok');
  } else {
    const existing = state.buyers.findIndex(b => b.name.toLowerCase() === data.name.toLowerCase());
    if (existing >= 0) {
      state.buyers[existing] = data;
      toast(`"${data.name}" ${t('msg_buyer_updated')}`, 'ok');
      await persistBuyers();
      renderBuyerPicker();
      $('buyerPicker').value = existing;
      renderRecentCustomerChips();
      updateBuyerActionUI();
      return;
    }
    state.buyers.push(data);
    toast(`"${data.name}" ${t('msg_buyer_saved')}`, 'ok');
  }
  await persistBuyers();
  renderBuyerPicker();
  // select the newly saved item, then refresh the chips/action row so the
  // active chip and "Update customer" label reflect the new selection.
  const newIdx = state.buyers.findIndex(b => b.name === data.name);
  if (newIdx >= 0) $('buyerPicker').value = newIdx;
  renderRecentCustomerChips();
  updateBuyerActionUI();
}
// Actual deletion — reached only via the inline confirm-arm row
// ("Delete this customer? Yes / No") wired in the redesign shell section.
async function deleteBuyer() {
  const picker = $('buyerPicker');
  const idx = picker.value;
  if (idx === '' || !state.buyers[idx]) { toast(t('msg_buyer_no_select'), 'err'); return; }
  state.buyers.splice(idx, 1);
  await persistBuyers();
  renderBuyerPicker();
  // renderBuyerPicker re-selects the old index, which now points at the NEXT
  // buyer in the list — a later "save as customer" would overwrite that one.
  // Force the placeholder so the cleared form matches an empty selection.
  picker.value = '';
  clearBuyer();
  renderRecentCustomerChips();
  updateBuyerActionUI();
  toast(t('msg_deleted'), 'ok');
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

// Build a regex that matches numbers conforming to the saved pattern,
// capturing the counter value. Used by recordInvoiceNumber to avoid mistaking
// an unrelated trailing number (e.g. the "-V2" in "INV-2026-00042-V2") for the
// counter. Returns null if the pattern has no {counter} token.
function patternToCounterRegex(pattern) {
  const p = pattern || DEFAULT_NUMBER_PATTERN;
  const escape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let out = '';
  let i = 0;
  let hasCounter = false;
  while (i < p.length) {
    if (p[i] === '{') {
      const close = p.indexOf('}', i);
      if (close === -1) { out += escape('{'); i++; continue; }
      const tok = p.slice(i + 1, close);
      i = close + 1;
      if (tok === 'yyyy') out += '\\d{4}';
      else if (tok === 'yy' || tok === 'mm' || tok === 'dd') out += '\\d{2}';
      else if (tok === 'counter') { out += '(\\d+)'; hasCounter = true; }
      else if (tok.startsWith('counter:')) {
        const n = parseInt(tok.slice('counter:'.length), 10);
        // {counter:N} pads to N digits but never truncates, so once the
        // counter outgrows N the number is longer than N digits — match
        // "at least N" or the counter would silently stop advancing.
        out += Number.isFinite(n) && n > 0 ? `(\\d{${n},})` : '(\\d+)';
        hasCounter = true;
      } else {
        out += escape('{' + tok + '}');
      }
    } else {
      out += escape(p[i]);
      i++;
    }
  }
  return hasCounter ? new RegExp('^' + out + '$') : null;
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

// Record after successful PDF: extract the counter value if (and only if) the
// typed number conforms to the saved pattern. Avoids being fooled by trailing
// numbers in custom suffixes like "INV-2026-00042-V2" which previously reset
// the counter to 2.
async function recordInvoiceNumber(num) {
  const pattern = await getNumberPattern();
  const re = patternToCounterRegex(pattern);
  if (!re) return;
  const m = String(num).trim().match(re);
  if (!m || !m[1]) return;
  const value = parseInt(m[1], 10);
  if (!Number.isFinite(value)) return;
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
  };
  // Legacy German tokens ({verkäufer}, {projekt}, ...) are rewritten to the
  // English form by migrateLegacyFilenameTokens at the only two entry points
  // (loadFilenamePattern, importData), so the resolver never sees them.
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
    if (v) $('r_filename').value = migrateLegacyFilenameTokens(v);
  } catch (e) {
    console.warn('[erechnung] Failed to load filename pattern:', e?.message || e);
  }
  updateFilenamePreview();
}

// Some early versions of the tool stored filename patterns with German
// token names ({verkäufer}, {projekt}, {kunde}, {kategorie}, {datum}).
// Rewrite to canonical English tokens on load so the input field shows
// the documented form. The resolver itself only knows the English tokens,
// so every entry point (loadFilenamePattern, importData) must migrate.
function migrateLegacyFilenameTokens(pattern) {
  return pattern
    .replaceAll('{verkäufer}', '{seller}')
    .replaceAll('{projekt}',   '{project}')
    .replaceAll('{kunde}',     '{buyer}')
    .replaceAll('{kategorie}', '{category}')
    .replaceAll('{datum}',     '{date}');
}

// -------- Text-block presets (intro / payment note / footnote) --------
// Each block owns a named list of presets plus a selected id. The textarea
// is the live value; when it diverges from the selected preset's stored
// text, the block is "dirty" and offers "Save as new preset…". Legacy
// footnote presets (FOOTNOTES_KEY) are migrated into the footnote block
// on first load; FOOTNOTES_KEY itself is left untouched for old backups.

const TEXT_BLOCKS = ['intro', 'paymentNote', 'footnote'];
const TEXT_BLOCK_FIELD = { intro: 'r_intro', paymentNote: 'r_payment_note', footnote: 'r_footnote' };

// Reverse-charge heuristic: when a picked footnote preset reads like an RC
// note but lacks the precise legal sentence, prepend it (in the invoice
// language).
const RC_HEURISTIC = /reverse\s*charge|autoliquidation|steuerschuldnerschaft/i;
const RC_LEGAL_PRESENT = /art\.\s*196/i;

function presetSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    + '-' + Date.now().toString(36).slice(-4);
}

function defaultTextPresets() {
  return {
    intro: [
      { id: 'standard', name: t('preset_name_standard'), text: t('preset_text_intro_standard') },
      { id: 'short',    name: t('preset_name_short'),    text: t('preset_text_intro_short') },
    ],
    paymentNote: [
      { id: 'standard', name: t('preset_name_standard'), text: t('preset_text_payment_standard') },
      { id: 'net30',    name: t('preset_name_net30'),    text: t('preset_text_payment_net30') },
    ],
    footnote: [
      { id: 'none',     name: t('preset_name_none'),     text: '' },
      { id: 'smallbiz', name: t('preset_name_smallbiz'), text: t('preset_text_footnote_smallbiz') },
    ],
  };
}

// Validate an imported/parsed presets object down to the known shape.
function sanitizeTextPresets(raw) {
  const out = { intro: [], paymentNote: [], footnote: [] };
  if (!isPlainObject(raw)) return null;
  for (const key of TEXT_BLOCKS) {
    const list = raw[key];
    if (!Array.isArray(list)) return null;
    out[key] = list
      .filter(p => isPlainObject(p) && typeof p.name === 'string' && typeof p.text === 'string')
      .map(p => ({ id: typeof p.id === 'string' && p.id ? p.id : presetSlug(p.name), name: p.name, text: p.text }));
    if (out[key].length === 0) return null;
  }
  return out;
}

async function loadTextPresets() {
  let loaded = null;
  try {
    const v = await store.get(TEXTPRESETS_KEY);
    if (v) {
      const parsed = JSON.parse(v);
      const presets = sanitizeTextPresets(parsed.presets);
      if (presets) {
        loaded = presets;
        if (isPlainObject(parsed.selected)) {
          for (const key of TEXT_BLOCKS) {
            if (typeof parsed.selected[key] === 'string') state.selectedPreset[key] = parsed.selected[key];
          }
        }
      }
    }
  } catch (e) { console.warn('[erechnung] Failed to load text presets:', e?.message || e); }

  if (!loaded) {
    // First run: seed defaults, then fold in legacy footnote presets.
    loaded = defaultTextPresets();
    try {
      const legacy = await store.get(FOOTNOTES_KEY);
      const list = legacy ? JSON.parse(legacy) : [];
      if (Array.isArray(list)) {
        for (const f of list) {
          if (isPlainObject(f) && typeof f.name === 'string' && typeof f.text === 'string') {
            loaded.footnote.push({ id: presetSlug(f.name), name: f.name, text: f.text });
          }
        }
      }
    } catch (_) {}
    state.selectedPreset = { intro: 'standard', paymentNote: 'standard', footnote: 'none' };
    state.textPresets = loaded;
    await persistTextPresets();
  } else {
    state.textPresets = loaded;
  }
  // Clamp selections to existing presets.
  for (const key of TEXT_BLOCKS) {
    if (!state.textPresets[key].some(p => p.id === state.selectedPreset[key])) {
      state.selectedPreset[key] = state.textPresets[key][0]?.id || '';
    }
  }
  renderTextPresetSelects();
}

async function persistTextPresets() {
  const ok = await store.set(TEXTPRESETS_KEY, JSON.stringify({
    presets: state.textPresets,
    selected: state.selectedPreset,
  }));
  if (!ok) toast(t('msg_save_failed'), 'err');
}

function renderTextPresetSelects() {
  for (const key of TEXT_BLOCKS) {
    const sel = $('presetSelect_' + key);
    if (!sel) continue;
    sel.innerHTML = state.textPresets[key]
      .map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`)
      .join('');
    sel.value = state.selectedPreset[key];
    const del = $('presetDelete_' + key);
    if (del) del.hidden = state.textPresets[key].length <= 1;
    updateTextBlockDirtyUI(key);
  }
}

function selectedPresetOf(key) {
  return state.textPresets[key].find(p => p.id === state.selectedPreset[key]) || null;
}

// Dirty = textarea diverges from the selected preset's stored text.
// Shows/hides the "Save as new preset…" affordance.
function updateTextBlockDirtyUI(key) {
  const field = $(TEXT_BLOCK_FIELD[key]);
  const row = $('presetSaveRow_' + key);
  if (!field || !row) return;
  const preset = selectedPresetOf(key);
  const dirty = !preset || preset.text !== field.value;
  row.hidden = !dirty;
  if (!dirty) {
    const naming = $('presetNaming_' + key);
    const link = $('presetSaveLink_' + key);
    if (naming) naming.hidden = true;
    if (link) link.hidden = false;
  }
}

async function selectTextPreset(key, presetId) {
  const preset = state.textPresets[key].find(p => p.id === presetId);
  if (!preset) return;
  state.selectedPreset[key] = presetId;
  let text = preset.text;
  if (key === 'footnote' && RC_HEURISTIC.test(text) && !RC_LEGAL_PRESENT.test(text)) {
    text = tInvoice('rc_legal_text') + '\n\n' + text;
    toast(t('msg_rc_legal_added'), 'ok');
  }
  const field = $(TEXT_BLOCK_FIELD[key]);
  field.value = text;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await persistTextPresets();
  updateTextBlockDirtyUI(key);
}

async function saveTextPresetAs(key) {
  const nameInput = $('presetName_' + key);
  const name = (nameInput?.value || '').trim();
  if (!name) return;
  const preset = { id: presetSlug(name), name, text: $(TEXT_BLOCK_FIELD[key]).value };
  state.textPresets[key].push(preset);
  state.selectedPreset[key] = preset.id;
  await persistTextPresets();
  renderTextPresetSelects();
  nameInput.value = '';
  toast(t('msg_preset_saved'), 'ok');
}

async function deleteSelectedTextPreset(key) {
  const remaining = state.textPresets[key].filter(p => p.id !== state.selectedPreset[key]);
  if (remaining.length === 0) return;
  state.textPresets[key] = remaining;
  state.selectedPreset[key] = remaining[0].id;
  const field = $(TEXT_BLOCK_FIELD[key]);
  field.value = remaining[0].text;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await persistTextPresets();
  renderTextPresetSelects();
  toast(t('msg_preset_deleted'), 'ok');
}

function setupTextPresetUI() {
  for (const key of TEXT_BLOCKS) {
    $('presetSelect_' + key)?.addEventListener('change', (e) => selectTextPreset(key, e.target.value));
    $('presetDelete_' + key)?.addEventListener('click', () => deleteSelectedTextPreset(key));
    $('presetSaveLink_' + key)?.addEventListener('click', () => {
      $('presetSaveLink_' + key).hidden = true;
      $('presetNaming_' + key).hidden = false;
      $('presetName_' + key)?.focus();
    });
    $('presetNameCancel_' + key)?.addEventListener('click', () => {
      $('presetNaming_' + key).hidden = true;
      $('presetSaveLink_' + key).hidden = false;
    });
    $('presetNameSave_' + key)?.addEventListener('click', () => saveTextPresetAs(key));
    $('presetName_' + key)?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveTextPresetAs(key); }
    });
    $(TEXT_BLOCK_FIELD[key])?.addEventListener('input', () => updateTextBlockDirtyUI(key));
  }
}

// First-run nicety: an empty text block adopts its selected preset's text
// so the form doesn't start with three "dirty" blocks. Runs after both the
// presets and the per-language boilerplate have loaded; never overwrites
// existing user text.
function applyPresetTextsIfEmpty() {
  for (const key of TEXT_BLOCKS) {
    const field = $(TEXT_BLOCK_FIELD[key]);
    if (!field || field.value.trim()) continue;
    const preset = selectedPresetOf(key);
    if (preset && preset.text) field.value = preset.text;
    updateTextBlockDirtyUI(key);
  }
}

// Legacy footnote presets — still loaded so backup export keeps carrying
// them for older app versions; the UI itself uses the text-block system.
async function loadFootnotes() {
  try {
    const v = await store.get(FOOTNOTES_KEY);
    if (v) state.footnotes = JSON.parse(v) || [];
  } catch (e) {
    console.warn('[erechnung] Failed to load footnotes:', e?.message || e);
    state.footnotes = [];
  }
}

// Boilerplate autosave: the five default-text fields persist (debounced)
// into the per-invoice-language boilerplate map. Replaces the removed
// "save seller template" button as the write path for texts.
let _boilerplateSaveTimer = null;
function scheduleBoilerplateSave() {
  if (_boilerplateSaveTimer) clearTimeout(_boilerplateSaveTimer);
  _boilerplateSaveTimer = setTimeout(async () => {
    _boilerplateSaveTimer = null;
    let bMap = {};
    try {
      const raw = await store.get(BOILERPLATE_KEY);
      if (raw) bMap = JSON.parse(raw) || {};
    } catch (_) {}
    bMap[effectiveInvoiceLang()] = collectBoilerplate();
    await store.set(BOILERPLATE_KEY, JSON.stringify(bMap));
  }, 800);
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
  } catch (e) {
    console.warn('[erechnung] Failed to load history:', e?.message || e);
    state.history = [];
  }
  // Enabled flag
  try {
    const v = await store.get(HISTORY_ENABLED_KEY);
    state.historyEnabled = v === null || v === undefined ? true : v !== 'false';
  } catch (e) {
    console.warn('[erechnung] Failed to load history-enabled flag:', e?.message || e);
    state.historyEnabled = true;
  }
  renderBuyerNamesMemory();
  updateDuplicateLastVisibility();
  if (typeof updateItemsFreshHint === 'function') updateItemsFreshHint();
}

async function persistHistory() {
  const ok = await store.set(HISTORY_KEY, JSON.stringify(state.history));
  if (!ok) toast(t('msg_save_failed'), 'err');
  return ok;
}

async function persistHistoryEnabled() {
  const ok = await store.set(HISTORY_ENABLED_KEY, String(state.historyEnabled));
  if (!ok) toast(t('msg_save_failed'), 'err');
  return ok;
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
  } catch (e) {
    console.warn('[erechnung] Failed to load YoY-enabled flag:', e?.message || e);
    state.yoyEnabled = false;
  }
  try {
    const v = await store.get(YOY_DATA_KEY);
    state.yoyData = v ? (JSON.parse(v) || {}) : {};
  } catch (e) {
    console.warn('[erechnung] Failed to load YoY data:', e?.message || e);
    state.yoyData = {};
  }
}

async function persistYoYEnabled() {
  const ok = await store.set(YOY_ENABLED_KEY, String(state.yoyEnabled));
  if (!ok) toast(t('msg_save_failed'), 'err');
  return ok;
}

async function persistYoYData() {
  const ok = await store.set(YOY_DATA_KEY, JSON.stringify(state.yoyData));
  if (!ok) toast(t('msg_save_failed'), 'err');
  return ok;
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
// `mode` becomes the snapshot's status; both the generate path (btnPDF) and
// the embed path (runEmbedXML) record the default 'exported'. Past-invoice
// manual entries build their own snapshot with status 'draft'.
async function recordHistoryEntry(mode = 'exported') {
  if (!state.historyEnabled) return;
  const snap = buildHistorySnapshot();
  snap.status = mode;
  state.history.unshift(snap);
  if (state.history.length > HISTORY_LIMIT) {
    state.history.length = HISTORY_LIMIT;
  }
  await persistHistory();
  renderHistoryPicker();
  renderBuyerNamesMemory();
  updateDuplicateLastVisibility();
  if (typeof updateItemsFreshHint === 'function') updateItemsFreshHint();
}

// Currency code → display symbol. Used by history picker and statistics.
const CURRENCY_SYMBOLS = Object.freeze({
  EUR: '€', USD: '$', GBP: '£', CHF: 'CHF',
});
function currencySymbol(code) {
  return CURRENCY_SYMBOLS[code] || code || '';
}

// History modal filter state. Survives modal close; reset only on backup
// import or explicit user click on the "Reset filters" empty-state CTA.
const historyFilter = { search: '', period: 'all' };

function resetHistoryFilter() {
  historyFilter.search = '';
  historyFilter.period = 'all';
  const s = document.getElementById('historySearch');
  const p = document.getElementById('historyPeriod');
  if (s) s.value = '';
  if (p) p.value = 'all';
  renderHistoryPicker();
}

// Derive a snapshot's status from the new `status` field, falling back to
// the legacy `imported` flag for backwards compatibility. Current values:
// 'draft' | 'exported'. Schema reserves room for future stages (e.g. 'paid').
function getSnapshotStatus(snap) {
  if (snap.status === 'draft' || snap.status === 'exported') return snap.status;
  return snap.imported ? 'draft' : 'exported';
}

// Pre-render formatted total + date strings once per snapshot so the search
// can match against the same text the user sees in the option label.
function snapshotSearchHaystack(s) {
  const parts = [
    s.number || '',
    s.date || '',
    s.buyerName || '',
    `${fmt(s.total)} ${currencySymbol(s.currency)}`,
    s.form?.project || '',
    s.form?.category || '',
  ];
  return parts.join(' ').toLowerCase();
}

// Apply period + text filter. Returns array of {snap, idx} keeping the
// original index so clone/delete still operate on state.history[idx].
function getFilteredHistory() {
  const period = historyFilter.period || 'all';
  const tokens = (historyFilter.search || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  const indexed = state.history.map((snap, idx) => ({ snap, idx }));
  let out = indexed;
  if (period !== 'all') {
    const allowed = new Set(filterByPeriod(state.history, period));
    out = out.filter(({ snap }) => allowed.has(snap));
  }
  if (tokens.length) {
    out = out.filter(({ snap }) => {
      const hay = snapshotSearchHaystack(snap);
      return tokens.every(tok => hay.includes(tok));
    });
  }
  return out;
}

// Render the history list. Each row shows number/date/buyer/total plus
// per-row Clone + Delete actions. Reuses the inline-confirm pattern
// (armRemoveConfirm) for the delete button.
// Live count caption in the history modal header ("N / 1000 saved").
function updateHistoryCountLabel() {
  const el = document.getElementById('historyCount');
  if (!el) return;
  el.textContent = t('history_count_label', {
    n: String(state.history.length),
    limit: String(HISTORY_LIMIT),
  });
}

// Index of the row currently showing the inline "Delete? Yes / No" confirm.
let _historyConfirmIdx = null;

function renderHistoryPicker() {
  const list = $('historyList');
  if (!list) return;
  updateHistoryCountLabel();
  list.innerHTML = '';
  if (state.history.length === 0) {
    _historyConfirmIdx = null;
    list.innerHTML = `<li class="history-row-empty">
      <div class="empty-state">
        <h3>${esc(t('empty_history_title'))}</h3>
        <p>${esc(t('empty_history_body'))}</p>
        <button type="button" class="primary" id="emptyHistoryCta">${esc(t('empty_history_cta'))}</button>
      </div>
    </li>`;
    document.getElementById('emptyHistoryCta')?.addEventListener('click', closeHistoryModal);
    return;
  }
  const filtered = getFilteredHistory();
  if (filtered.length === 0) {
    list.innerHTML = `<li class="history-row-empty">
      <div class="empty-state">
        <h3>${esc(t('empty_filter_title'))}</h3>
        <p>${esc(t('empty_filter_body'))}</p>
        <button type="button" class="tiny-btn" id="emptyFilterCta">${esc(t('empty_filter_cta'))}</button>
      </div>
    </li>`;
    document.getElementById('emptyFilterCta')?.addEventListener('click', resetHistoryFilter);
    return;
  }
  const formatTotal = (n, currency) => `${fmt(n)} ${currencySymbol(currency)}`.trim();
  const formatDate = (iso) => {
    if (!iso) return '';
    try { return parseInvoiceDate(iso).toLocaleDateString(CURRENT_LANG); } catch { return iso; }
  };
  for (const { snap: e, idx: i } of filtered) {
    const li = document.createElement('li');
    li.className = 'history-row';
    li.dataset.idx = String(i);
    const status = getSnapshotStatus(e);
    const statusLabel = t('history_status_' + status);
    const confirming = _historyConfirmIdx === i;
    const actions = confirming
      ? `<span class="note-small">${esc(t('confirm_delete_short'))}</span>
         <button class="link-accent history-delete-yes" type="button" data-idx="${i}">${esc(t('confirm_yes'))}</button>
         <button class="link-muted history-delete-no" type="button" data-idx="${i}">${esc(t('confirm_no'))}</button>`
      : `<button class="link-accent history-reload-btn" type="button" data-idx="${i}">${esc(t('btn_history_reload'))}</button>
         <button class="link-faint history-delete-btn" type="button" data-idx="${i}">${esc(t('btn_delete'))}</button>`;
    li.innerHTML = `
      <div class="h-num">${esc(e.number || '—')}</div>
      <div class="h-buyer">${esc(e.buyerName || '—')}<span class="status-pill ${status}">${esc(statusLabel)}</span></div>
      <div class="h-date">${esc(formatDate(e.date))}</div>
      <div class="h-total">${esc(formatTotal(e.total, e.currency))}</div>
      <div class="history-row-actions">${actions}</div>
    `;
    list.appendChild(li);
  }
  list.querySelectorAll('.history-reload-btn').forEach(btn => {
    btn.addEventListener('click', () => cloneFromHistory(Number(btn.dataset.idx)));
  });
  list.querySelectorAll('.history-delete-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _historyConfirmIdx = Number(btn.dataset.idx);
      renderHistoryPicker();
    });
  });
  list.querySelectorAll('.history-delete-no').forEach(btn => {
    btn.addEventListener('click', () => {
      _historyConfirmIdx = null;
      renderHistoryPicker();
    });
  });
  list.querySelectorAll('.history-delete-yes').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = Number(btn.dataset.idx);
      _historyConfirmIdx = null;
      await deleteHistoryEntry(idx);
    });
  });
}

// Apply a history snapshot back into the form. All fields from the snapshot
// are applied, including the buyer (overwrites whatever is currently there).
// The invoice date resets to today; delivery and due dates stay empty so the
// user fills them explicitly. Invoice number is auto-assigned via
// applyNextInvoiceNumber.
async function applyHistorySnapshot(snap) {
  const f = snap.form || {};

  // Buyer — full overwrite. Also point the profile picker at the matching
  // saved profile (by name, case-insensitive) so the chips/save-button
  // reflect the loaded customer; fall back to "new customer".
  applyBuyer(f.buyer || {});
  const loadedName = ((f.buyer && f.buyer.name) || '').toLowerCase().trim();
  const matchIdx = state.buyers.findIndex(b => (b.name || '').toLowerCase().trim() === loadedName);
  $('buyerPicker').value = matchIdx >= 0 ? String(matchIdx) : '';

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

  // Project / category / mode / currency
  $('r_project').value = nz(f.project);
  $('r_category').value = nz(f.category);
  if (f.taxmode) $('r_taxmode').value = f.taxmode;
  if (f.currency) $('r_currency').value = f.currency;

  // Boilerplate texts
  $('r_intro').value = nz(f.intro);
  $('r_payment_note').value = nz(f.paymentNote);
  $('r_greeting').value = nz(f.greeting);
  $('r_signature').value = nz(f.signature);
  $('r_footnote').value = nz(f.footnote);

  // Invoice settings. Setting a <select>'s value programmatically doesn't
  // fire its change handler, so persist explicitly — generation reads the
  // store (font/layout) and the INVOICE_LANG global (tInvoice), not the DOM.
  // Don't route through setInvoiceLang() here: it reloads the per-language
  // boilerplate, which would clobber the snapshot texts applied above.
  if (f.invoiceLang !== undefined) {
    const lang = (f.invoiceLang && I18N[f.invoiceLang]) ? f.invoiceLang : '';
    $('invoiceLangSelect').value = lang;
    INVOICE_LANG = lang || null;
    if (lang) localStorage.setItem(INVOICE_LANG_KEY, lang);
    else localStorage.removeItem(INVOICE_LANG_KEY);
  }
  if (f.font && FONT_OPTIONS[f.font]) {
    $('invoiceFontSelect').value = f.font;
    await store.set(FONT_KEY, f.font);
  }
  if (f.layout && LAYOUTS[f.layout]) {
    $('invoiceLayoutSelect').value = f.layout;
    await store.set(LAYOUT_KEY, f.layout);
  }

  // Invoice date resets to today; delivery stays empty for explicit entry.
  // The due date is chip-driven (issue date + dueDays) and recomputes below.
  $('r_number').value = '';
  $('r_date').value = todayLocalISO();
  $('r_delivery').value = '';
  $('r_delivery_end').value = '';

  // Auto-assign the next invoice number
  await applyNextInvoiceNumber();

  calcTotals();
  updateFilenamePreview();
  updateBuyerHistoryHint();
  if (typeof applyDueDays === 'function') applyDueDays();
  if (typeof updateDeliveryPeriodUI === 'function') updateDeliveryPeriodUI();
  if (typeof updateBuyerActionUI === 'function') updateBuyerActionUI();
  if (typeof renderRecentCustomerChips === 'function') renderRecentCustomerChips();
  if (typeof updateSummaryValues === 'function') updateSummaryValues();
}

async function cloneFromHistory(idx) {
  if (idx === undefined || !state.history[idx]) {
    toast(t('msg_history_no_select'), 'err'); return;
  }
  const snap = state.history[idx];
  await applyHistorySnapshot(snap);
  // Auto-close the history modal so the user is back at the form, ready to edit.
  closeHistoryModal();
  toast(snap.imported ? t('msg_history_clone_partial') : t('msg_history_cloned'), 'ok');
}

// One-click duplicate of the most recent history entry. No modal involvement.
async function duplicateLastInvoice() {
  if (state.history.length === 0) {
    toast(t('msg_duplicate_no_history'), 'err');
    return;
  }
  await applyHistorySnapshot(state.history[0]);
  if (typeof setActiveTab === 'function') setActiveTab('buyer');
  toast(t('msg_duplicated_last'), 'ok');
}

// Dim the top-bar duplicate button when there's nothing to duplicate.
// It stays clickable so the click can explain why (toast above).
function updateDuplicateLastVisibility() {
  const btn = document.getElementById('duplicateLast');
  if (!btn) return;
  btn.setAttribute('aria-disabled', String(state.history.length === 0));
}

async function deleteHistoryEntry(idx) {
  if (idx === undefined || !state.history[idx]) {
    toast(t('msg_history_no_select'), 'err'); return;
  }
  state.history.splice(idx, 1);
  await persistHistory();
  renderHistoryPicker();
  renderBuyerNamesMemory();
  updateDuplicateLastVisibility();
  if (typeof updateItemsFreshHint === 'function') updateItemsFreshHint();
  toast(t('msg_history_deleted'), 'ok');
}

// Actual clear — reached only via the inline confirm-arm row in the
// history modal footer ("Delete all N snapshots? Yes, clear / Cancel").
async function clearAllHistory() {
  if (state.history.length === 0) return;
  state.history = [];
  await persistHistory();
  renderHistoryPicker();
  renderBuyerNamesMemory();
  updateDuplicateLastVisibility();
  if (typeof updateItemsFreshHint === 'function') updateItemsFreshHint();
  toast(t('msg_history_cleared'), 'ok');
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
  $('past_date').value = todayLocalISO();
  $('past_buyer_text').value = '';
  $('past_total').value = '';
  $('past_currency').value = $('r_currency').value || 'EUR';
  $('past_taxmode').value = $('r_taxmode').value || 'S';
  $('past_vat_rate').value = String(defaultVatForCountry($('s_country').value));
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

  if (!date)         { toast(t('past_err_no_date'), 'err'); return; }
  if (!buyerName)    { toast(t('past_err_no_buyer'), 'err'); return; }
  if (!Number.isFinite(total) || total <= 0) { toast(t('past_err_no_total'), 'err'); return; }

  // Build a minimal-but-valid snapshot. To make statistics' net/tax math
  // work, we synthesize a single line item that sums to the gross total.
  // For mode 'S': net = gross / (1 + vatRate/100); for others: net = gross.
  const net = taxmode === 'S' && vatRate > 0
    ? round2(total / (1 + vatRate / 100))
    : round2(total);

  const buyerIdx = $('past_buyer_select').value;
  // Shallow spread is intentional: buyer records are flat objects of string
  // primitives (see collectBuyer). If that schema ever grows nested fields,
  // switch to structuredClone(state.buyers[buyerIdx]) to avoid sharing refs
  // between the live buyer and the snapshot stored in history.
  const buyerData = (buyerIdx !== '' && state.buyers[buyerIdx])
    ? { ...state.buyers[buyerIdx], name: buyerName }
    : { name: buyerName };

  const snap = {
    v: 1,
    ts: Date.now(),
    imported: true,             // flag for UI marker + partial-clone warning
    status: 'draft',
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
  renderBuyerNamesMemory();
  updateDuplicateLastVisibility();
  if (typeof updateItemsFreshHint === 'function') updateItemsFreshHint();
  closePastInvoiceModal();
  toast(t('msg_history_added'), 'ok');
}

// -------- Statistics --------
// Statistics derived from history. Pure functions over state.history,
// grouped per currency since invoices come in EUR/USD/GBP/CHF.
//
// Period filters: 'ytd' (current year), 'last12' (rolling 12 months),
// 'all' (everything). Per-currency results are returned as a Map keyed
// by currency code.

// Filter snapshots by period. Uses snapshot.date (invoice date), falling
// back to ts (timestamp of save) for entries without a date.
//
// Period semantics:
//   last_month — rolling 30 days back from today
//   last3      — the last 3 calendar months including the current one
//   last6      — the last 6 calendar months including the current one
//   ytd        — start of current year through today
//   last_year  — full previous calendar year (Jan 1 to Dec 31)
//   last12     — the last 12 calendar months including the current one
//   all        — everything
function filterByPeriod(snapshots, period) {
  if (period === 'all') return snapshots.slice();
  if (period === 'last_year') {
    // Full previous calendar year: filter on date.getFullYear() rather
    // than a cutoff, so a Dec 2024 snapshot read in March 2026 still
    // counts as "last year" only when current year is 2025.
    const yr = new Date().getFullYear() - 1;
    return snapshots.filter(s => {
      const ts = s.date ? parseInvoiceDate(s.date).getTime() : s.ts;
      if (!Number.isFinite(ts)) return false;
      return new Date(ts).getFullYear() === yr;
    });
  }
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
    const ts = s.date ? parseInvoiceDate(s.date).getTime() : s.ts;
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

// -------- YoY computation --------
//
// Given the current period and the resulting filtered snapshots (per
// currency), compute a comparable KPI bundle from one year earlier and
// derive percent-change arrows.
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
  if (period === 'last_year') {
    // last_year = previous full calendar year. yearShift=0 -> last year,
    // yearShift=1 -> the year before that (used as YoY baseline).
    const targetYr = now.getFullYear() - 1 - yearShift;
    const start = new Date(targetYr, 0, 1).getTime();
    const end = new Date(targetYr, 11, 31, 23, 59, 59, 999).getTime();
    return [start, end];
  }
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
    const ts = s.date ? parseInvoiceDate(s.date).getTime() : s.ts;
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
    const d = parseInvoiceDate(s.date);
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
    const fromD = parseInvoiceDate(from);
    const toD = parseInvoiceDate(to);
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
// Build a 12-month bucket array. The window depends on the period:
//   ytd        — Jan-Dec of the current calendar year (months not yet
//                reached are still shown but stay at 0)
//   last_year  — Jan-Dec of the previous calendar year
//   anything   — rolling 12 months ending in the current month
//   else
// Aligning ytd and last_year to the calendar year keeps the chart
// consistent with the period-filtered KPIs and the user's mental model
// of "this year" / "last year" as Jan-Dec.
function monthlyTotals(snapshots, period = null) {
  const buckets = new Map();
  const now = new Date();
  let firstY, firstM;
  if (period === 'last_year') {
    firstY = now.getFullYear() - 1;
    firstM = 0;
  } else if (period === 'ytd') {
    firstY = now.getFullYear();
    firstM = 0;
  } else {
    const start = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    firstY = start.getFullYear();
    firstM = start.getMonth();
  }
  for (let i = 0; i < 12; i++) {
    const d = new Date(firstY, firstM + i, 1);
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    buckets.set(ym, {
      ym,
      label: d.toLocaleDateString(CURRENT_LANG, { month: 'short' }),
      total: 0,
    });
  }
  for (const s of snapshots) {
    if (!s.date) continue;
    const d = parseInvoiceDate(s.date);
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
    const d = parseInvoiceDate(s.date);
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
//
// When state.yoyEnabled is true, each month also renders a thin outlined
// bar for the same month one year earlier (sourced from history first,
// then YoY backfill). The two bars share the slot: current year on the
// left half, previous year on the right half, both at half the normal
// width. The Y-axis is scaled to include both years' max so neither
// gets clipped. The previous-year bar uses fill="none" + stroke so it
// reads as a comparative reference rather than an equally-weighted bar.
function renderMonthlyChartSVG(months, currency) {
  const W = 560, H = 140, P_TOP = 16, P_BOT = 28, P_LEFT = 8, P_RIGHT = 8;
  const yoyOn = state.yoyEnabled;

  // Pre-compute previous-year values once so we can both scale and draw.
  const prevByIdx = months.map(m => yoyOn ? monthYoYValue(currency, m.ym) : null);

  // Scale must include previous-year peaks too, otherwise they'd clip
  // when the previous year was a stronger month than anything current.
  const allValues = months.map(m => m.total).concat(prevByIdx.filter(v => v !== null));
  const max = Math.max(1, ...allValues);

  const innerW = W - P_LEFT - P_RIGHT;
  const innerH = H - P_TOP - P_BOT;
  const slot = innerW / months.length;
  // When YoY bars are visible, narrow the bars and place them side by
  // side; otherwise use the original wider single-bar layout.
  const barW = yoyOn ? Math.max(2, slot * 0.225) : Math.max(3, slot * 0.45);
  const sym = currencySymbol(currency);

  const bars = months.map((m, i) => {
    const h = (m.total / max) * innerH;
    // Current-year bar: left of slot center if YoY visible, else centered.
    const xCur = yoyOn
      ? P_LEFT + i * slot + (slot / 2 - barW - 1)
      : P_LEFT + i * slot + (slot - barW) / 2;
    const yCur = P_TOP + (innerH - h);

    let prevBarSVG = '';
    let tip = `${m.label}: ${fmt(m.total)} ${sym}`;
    if (yoyOn) {
      const prev = prevByIdx[i];
      if (prev !== null) {
        const delta = yoyDelta(m.total, prev);
        const arrowText = delta.pct ? `${delta.glyph} ${delta.pct}` : delta.glyph;
        const prevYear = Number(m.ym.split('-')[0]) - 1;
        tip += `\u2002\u00b7\u2002vs. ${prevYear}: ${fmt(prev)} ${sym} ${arrowText}`;
        // Outlined bar for the previous year. SVG strokes are drawn
        // centered on the path, so to keep the outer dimensions of the
        // outline identical to the filled bar we inset the path by
        // stroke-width/2 on each side. Without the inset the stroke
        // would extend half a pixel below the chart baseline (which
        // looked like the outline "sat too low").
        const STROKE = 1;
        const hPrev = (prev / max) * innerH;
        if (hPrev > 0) {
          const hPath = Math.max(0, hPrev - STROKE);
          const xPath = P_LEFT + i * slot + (slot / 2 + 1) + STROKE / 2;
          const yPath = P_TOP + (innerH - hPrev) + STROKE / 2;
          const wPath = Math.max(0, barW - STROKE);
          prevBarSVG = `<rect x="${xPath.toFixed(1)}" y="${yPath.toFixed(1)}" width="${wPath.toFixed(1)}" height="${hPath.toFixed(1)}" fill="none" stroke="currentColor" stroke-width="${STROKE}" opacity="0.6"></rect>`;
        }
      }
    }
    // Full-slot transparent hitbox so the tooltip works even between bars.
    const hitX = P_LEFT + i * slot;
    const labelX = P_LEFT + i * slot + slot / 2;
    return `<g>` +
      `<rect x="${xCur.toFixed(1)}" y="${yCur.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="currentColor" opacity="0.7"></rect>` +
      prevBarSVG +
      `<text x="${labelX.toFixed(1)}" y="${(H - 8).toFixed(1)}" text-anchor="middle" font-size="8" fill="currentColor" opacity="0.55">${esc(m.label)}</text>` +
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
  if (!last) { hint.textContent = ''; hint.hidden = true; return; }
  hint.hidden = false;
  // Days since last invoice
  let daysAgo = null;
  if (last.date) {
    const diff = Date.now() - parseInvoiceDate(last.date).getTime();
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
    const d = parseInvoiceDate(s.date);
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
    const d = parseInvoiceDate(s.date);
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
    body.innerHTML = `
      <div class="stats-empty-cta-wrap">
        <h3>${esc(t('stats_empty_title'))}</h3>
        <p>${esc(t('stats_empty'))}</p>
        <button type="button" class="btn-accent-soft" id="statsEmptyCta">${esc(t('stats_empty_cta'))}</button>
      </div>`;
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
    const months = monthlyTotals(list, period);
    const prev = yoyByCurrency[cur];
    const chartHeading = period === 'last_year'
      ? String(new Date().getFullYear() - 1)
      : period === 'ytd'
      ? String(new Date().getFullYear())
      : t('stats_last_12_months');

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
          <div class="stats-subhead">${esc(chartHeading)}</div>
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
  // Scope to the freshly injected subtree — the global pass re-renders
  // items/pickers/totals page-wide, which is wasted work here.
  applyTranslations(body);
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
    const d = parseInvoiceDate(s.date);
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
    applyTranslations(body);
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
    .sort((a, b) => parseInvoiceDate(a.date).getTime() - parseInvoiceDate(b.date).getTime());
  const firstInv = datedSorted[0];
  const lastInv  = datedSorted[datedSorted.length - 1];

  const formatDate = (iso) => {
    if (!iso) return '';
    try { return parseInvoiceDate(iso).toLocaleDateString(CURRENT_LANG); } catch { return iso; }
  };

  const blocks = ordered.map(({ cur, list, kpi }) => {
    const sym = currencySymbol(cur);
    // Sort newest first for the invoice list
    const sortedList = list.slice().sort((a, b) => {
      const ta = a.date ? parseInvoiceDate(a.date).getTime() : a.ts;
      const tb = b.date ? parseInvoiceDate(b.date).getTime() : b.ts;
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
  applyTranslations(body);
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
  if (!yr || yr < 1900 || yr > 2200) { toast(t('msg_yoy_invalid_year'), 'err'); return; }
  const values = [];
  let anyNonZero = false;
  for (let i = 0; i < 12; i++) {
    const inp = $(`yoyMonth_${i}`);
    const v = parseMoneyInput(inp && inp.value);
    if (v < 0) { toast(t('msg_yoy_invalid_value'), 'err'); return; }
    values.push(v);
    if (v > 0) anyNonZero = true;
  }
  if (!anyNonZero) {
    // Saving all zeros = clear this year/currency combo
    await saveYoYYear(cur, yr, null);
    toast(t('msg_yoy_cleared'), 'ok');
  } else {
    await saveYoYYear(cur, yr, values);
    toast(t('msg_yoy_saved'), 'ok');
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
  if (filtered.length === 0) { toast(t('msg_csv_no_data'), 'err'); return; }
  // Newest first
  const sorted = filtered.slice().sort((a, b) => {
    const ta = a.date ? parseInvoiceDate(a.date).getTime() : a.ts;
    const tb = b.date ? parseInvoiceDate(b.date).getTime() : b.ts;
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
  const ts = todayLocalISO();
  const periodLabel = period.replace(/[^a-z0-9]/gi, '_');
  downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }),
    `erechnung-stats-${periodLabel}-${ts}.csv`);
  toast(t('msg_csv_exported'), 'ok');
}

// Export the quarterly tax breakdown for the selected year.
function exportQuartersCSV() {
  const inYear = state.history.filter(s => {
    if (!s.date) return false;
    const d = parseInvoiceDate(s.date);
    return !Number.isNaN(d.getTime()) && d.getFullYear() === statsYear;
  });
  if (inYear.length === 0) { toast(t('msg_csv_no_data'), 'err'); return; }
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
  toast(t('msg_csv_exported'), 'ok');
}

// Export the buyer drill-down: all invoices for the currently-drilled buyer.
function exportBuyerCSV() {
  if (!statsBuyerDrillDown) { toast(t('msg_csv_no_data'), 'err'); return; }
  const target = statsBuyerDrillDown.toLowerCase().trim();
  const matched = state.history.filter(s =>
    (s.buyerName || '').toLowerCase().trim() === target);
  if (matched.length === 0) { toast(t('msg_csv_no_data'), 'err'); return; }
  const sorted = matched.slice().sort((a, b) => {
    const ta = a.date ? parseInvoiceDate(a.date).getTime() : a.ts;
    const tb = b.date ? parseInvoiceDate(b.date).getTime() : b.ts;
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
  toast(t('msg_csv_exported'), 'ok');
}

// Dispatcher: exports based on the active stats view.
function exportStatsCSV() {
  if (state.history.length === 0) { toast(t('msg_csv_no_data'), 'err'); return; }
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
    vat: data.vat ?? defaultVatForCountry($('s_country')?.value),
  };
  state.items.push(item);
  renderItems();
}

// Insert a new line item directly after the given index. Returns the new
// item's id so callers can focus its first input after the re-render.
function addItemAfter(idx, data = {}) {
  const item = {
    id: crypto.randomUUID(),
    desc: data.desc || '',
    qty: data.qty ?? 1,
    unit: data.unit || 'C62',
    price: data.price ?? 0,
    vat: data.vat ?? defaultVatForCountry($('s_country')?.value),
  };
  state.items.splice(idx + 1, 0, item);
  renderItems();
  return item.id;
}

// Rewrite every item's VAT rate to the standard rate of the current seller
// country. Called from the s_country input listener. Items are overwritten
// unconditionally — switching country is an explicit signal and the per-item
// rate is cheap to re-edit if a line really needs a custom percentage.
function applyCountryDefaultVat() {
  const rate = defaultVatForCountry($('s_country').value);
  if (!state.items.length) return;
  let changed = false;
  for (const it of state.items) {
    if (Number(it.vat) !== rate) { it.vat = rate; changed = true; }
  }
  if (changed) renderItems();
}

// Inline-delete-confirmation state. At most one row is ever in the
// confirming state; tracked here so Escape and outside-click can clear it.
const REMOVE_CONFIRM_TIMEOUT_MS = 3000;
let _removeConfirmBtn = null;
let _removeConfirmTimer = null;
function resetRemoveConfirm() {
  if (_removeConfirmTimer) { clearTimeout(_removeConfirmTimer); _removeConfirmTimer = null; }
  const btn = _removeConfirmBtn;
  _removeConfirmBtn = null;
  if (btn && btn.isConnected) {
    btn.classList.remove('confirming');
    btn.textContent = '✕';
    btn.setAttribute('aria-label', t('aria_remove_item'));
  }
}
function armRemoveConfirm(btn) {
  if (_removeConfirmBtn && _removeConfirmBtn !== btn) resetRemoveConfirm();
  _removeConfirmBtn = btn;
  btn.classList.add('confirming');
  btn.textContent = t('item_remove_confirm_text');
  btn.setAttribute('aria-label', t('aria_remove_confirm'));
  if (_removeConfirmTimer) clearTimeout(_removeConfirmTimer);
  _removeConfirmTimer = setTimeout(resetRemoveConfirm, REMOVE_CONFIRM_TIMEOUT_MS);
}

// Standard VAT-rate choices for the per-line select. If a line carries a
// rate outside this list (history clone, country default like 5.5%), an
// extra option is added for it so the select still shows the truth.
const VAT_SELECT_RATES = [0, 7, 19, 20, 21];

function renderItems() {
  const container = $('items');
  if (!container) return;
  container.innerHTML = '';

  // Empty state: hide the column header + totals + add-line button, show
  // the centered hint card with its own "+ Add first line" CTA instead.
  const empty = state.items.length === 0;
  const head = document.getElementById('itemsHead');
  const emptyCard = document.getElementById('itemsEmpty');
  const addBtn = document.getElementById('addItem');
  const totalsBlock = document.querySelector('.totals-block');
  if (head) head.hidden = empty;
  if (emptyCard) emptyCard.hidden = !empty;
  if (addBtn) addBtn.hidden = empty;
  if (totalsBlock) totalsBlock.hidden = empty;

  for (const it of state.items) {
    const row = document.createElement('div');
    row.className = 'item-row';
    row.dataset.id = it.id;
    const rates = VAT_SELECT_RATES.includes(Number(it.vat))
      ? VAT_SELECT_RATES
      : [...VAT_SELECT_RATES, Number(it.vat)].sort((a, b) => a - b);
    const vatOptions = rates
      .map(r => `<option value="${r}"${Number(it.vat) === r ? ' selected' : ''}>${r}%</option>`)
      .join('');
    row.innerHTML = `
      <input type="text" class="cell-desc" data-k="desc" value="${esc(it.desc)}" placeholder="${esc(t('item_placeholder'))}">
      <input type="number" class="num" step="0.01" data-k="price" value="${it.price}">
      <input type="number" class="num" step="0.01" data-k="qty" value="${it.qty}">
      <select data-k="vat">${vatOptions}</select>
      <div class="line-total" data-line-total></div>
      <button class="remove" data-remove aria-label="${esc(t('aria_remove_item'))}">✕</button>
    `;
    container.appendChild(row);

    row.querySelectorAll('[data-k]').forEach(el => {
      const isNumeric = (k) => k === 'qty' || k === 'price' || k === 'vat';
      // On every keystroke, update from a finite number — skip mid-edit
      // invalid states (empty / lone minus / trailing dot) so the on-screen
      // totals don't flicker to 0 between digits.
      el.addEventListener('input', () => {
        const k = el.dataset.k;
        if (isNumeric(k)) {
          const n = el.tagName === 'SELECT' ? Number(el.value) : el.valueAsNumber;
          if (!Number.isFinite(n)) return;
          it[k] = n;
        } else {
          it[k] = el.value;
        }
        calcTotals();
        updateItemsFreshHint();
      });
      // On commit (blur / Enter), force a final value so an intentionally
      // cleared field becomes 0 instead of carrying the previous number.
      el.addEventListener('change', () => {
        const k = el.dataset.k;
        if (!isNumeric(k)) return;
        const n = el.tagName === 'SELECT' ? Number(el.value) : el.valueAsNumber;
        it[k] = Number.isFinite(n) ? n : 0;
        calcTotals();
      });
      // Enter on the VAT select inserts a new row right after and jumps
      // focus to its description input.
      el.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter' || el.dataset.k !== 'vat') return;
        ev.preventDefault();
        const idx = state.items.findIndex(x => x.id === it.id);
        if (idx < 0) return;
        const newId = addItemAfter(idx);
        const newRow = $('items').querySelector(`.item-row[data-id="${newId}"]`);
        const target = newRow && newRow.querySelector('input[data-k="desc"]');
        if (target) target.focus();
      });
    });
    const removeBtn = row.querySelector('[data-remove]');
    removeBtn.addEventListener('click', () => {
      if (removeBtn.classList.contains('confirming')) {
        resetRemoveConfirm();
        state.items = state.items.filter(x => x.id !== it.id);
        renderItems();
      } else {
        armRemoveConfirm(removeBtn);
        // Force focus to the button so Esc reaches our reset logic and not
        // the previously-focused input (macOS Safari/Firefox don't auto-focus
        // buttons on mouse-click, which otherwise causes a date/number input
        // to receive native Esc behavior and blur).
        removeBtn.focus();
      }
    });
  }
  calcTotals();
  updateItemsFreshHint();
  if (typeof schedulePreviewRender === 'function') schedulePreviewRender();
}

// Show the fresh-form hint only when the items area is in its pristine
// default (one empty row) AND there is at least one history entry to
// duplicate from. Hidden otherwise.
function updateItemsFreshHint() {
  const hint = document.getElementById('itemsFreshHint');
  if (!hint) return;
  const fresh = state.items.length === 1
    && !(state.items[0].desc || '').trim()
    && (Number(state.items[0].price) || 0) === 0;
  hint.hidden = !(fresh && state.history.length > 0);
}

function calcTotals() {
  // EN 16931 canonical computation. Single source of truth for the screen
  // totals, history snapshots, the XML monetary summation, and the PDF.
  //   1. Per line: lineNet = round(qty * price)               [BR-CO-22]
  //   2. Per VAT group: basis = sum(lineNet);
  //      categoryTax = round(basis * rate / 100)              [BR-CO-17]
  //   3. Header line total = sum(lineNet) = sum(basis); tax total = sum(categoryTax);
  //      grand = lineTotal + taxTotal.
  // Defensive round2() on running sums absorbs FP drift on already-rounded inputs.
  const mode = $('r_taxmode').value;
  const groups = {};
  let net = 0;
  for (const it of state.items) {
    const qty = Number(it.qty) || 0;
    const price = Number(it.price) || 0;
    const rate = mode === 'S' ? (Number(it.vat) || 0) : 0;
    const lineNet = round2(qty * price);
    const key = rate.toFixed(2);
    if (!groups[key]) groups[key] = { rate, basis: 0, amount: 0 };
    groups[key].basis = round2(groups[key].basis + lineNet);
    net = round2(net + lineNet);
  }
  let tax = 0;
  for (const g of Object.values(groups)) {
    g.amount = round2(g.basis * g.rate / 100);
    tax = round2(tax + g.amount);
  }
  const grand = round2(net + tax);

  const sym = currencySymbol($('r_currency')?.value || 'EUR');

  // Per-rate net rows ("Net @ 19%") sorted by rate. In non-standard tax
  // modes all lines collapse into the 0% group, so a single net row shows.
  const vatRows = document.getElementById('vatRows');
  if (vatRows) {
    vatRows.innerHTML = Object.values(groups)
      .sort((a, b) => a.rate - b.rate)
      .map(g => `<div class="vat-row"><span>${esc(t('totals_net_at', { rate: String(g.rate) }))}</span><span>${fmt(g.basis)} ${esc(sym)}</span></div>`)
      .join('');
  }

  const taxEl = $('t_tax');
  const totalEl = $('t_total');
  if (taxEl) taxEl.textContent = `${fmt(tax)} ${sym}`;
  if (totalEl) totalEl.textContent = `${fmt(grand)} ${sym}`;

  const taxLabel = $('t_tax_label');
  if (taxLabel) taxLabel.textContent = t('total_tax_' + mode) || t('total_tax_S');

  // Amber tax-mode note (Items tab): visible only for non-standard modes.
  const noteEl = $('taxNote');
  const noteBox = document.getElementById('taxNoteBox');
  const noteText = mode === 'S' ? '' : t('rc_note' + (mode === 'AE' ? '' : '_' + mode));
  if (noteEl) noteEl.textContent = noteText;
  if (noteBox) noteBox.hidden = !noteText || state.items.length === 0;

  // Per-line totals (gross in standard mode, net otherwise).
  const itemsHost = document.getElementById('items');
  if (itemsHost) {
    for (const rowEl of itemsHost.querySelectorAll('.item-row')) {
      const it = state.items.find(x => x.id === rowEl.dataset.id);
      const cell = rowEl.querySelector('[data-line-total]');
      if (!it || !cell) continue;
      const lineNet = round2((Number(it.qty) || 0) * (Number(it.price) || 0));
      const lineGross = mode === 'S' ? round2(lineNet * (1 + (Number(it.vat) || 0) / 100)) : lineNet;
      cell.textContent = `${fmt(lineGross)} ${sym}`;
    }
  }

  return { net, tax, grand, groups };
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
    toast(t('msg_pdf_select_first'), 'err'); return;
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

// ISO 3166-1 alpha-3 → alpha-2. EN 16931 / Factur-X CountryID is alpha-2 only,
// so user-typed alpha-3 input is converted before XML emission.
const ISO_ALPHA3_TO_ALPHA2 = Object.freeze({
  AFG:'AF',ALA:'AX',ALB:'AL',DZA:'DZ',ASM:'AS',AND:'AD',AGO:'AO',AIA:'AI',
  ATA:'AQ',ATG:'AG',ARG:'AR',ARM:'AM',ABW:'AW',AUS:'AU',AUT:'AT',AZE:'AZ',
  BHS:'BS',BHR:'BH',BGD:'BD',BRB:'BB',BLR:'BY',BEL:'BE',BLZ:'BZ',BEN:'BJ',
  BMU:'BM',BTN:'BT',BOL:'BO',BES:'BQ',BIH:'BA',BWA:'BW',BVT:'BV',BRA:'BR',
  IOT:'IO',BRN:'BN',BGR:'BG',BFA:'BF',BDI:'BI',CPV:'CV',KHM:'KH',CMR:'CM',
  CAN:'CA',CYM:'KY',CAF:'CF',TCD:'TD',CHL:'CL',CHN:'CN',CXR:'CX',CCK:'CC',
  COL:'CO',COM:'KM',COG:'CG',COD:'CD',COK:'CK',CRI:'CR',CIV:'CI',HRV:'HR',
  CUB:'CU',CUW:'CW',CYP:'CY',CZE:'CZ',DNK:'DK',DJI:'DJ',DMA:'DM',DOM:'DO',
  ECU:'EC',EGY:'EG',SLV:'SV',GNQ:'GQ',ERI:'ER',EST:'EE',SWZ:'SZ',ETH:'ET',
  FLK:'FK',FRO:'FO',FJI:'FJ',FIN:'FI',FRA:'FR',GUF:'GF',PYF:'PF',ATF:'TF',
  GAB:'GA',GMB:'GM',GEO:'GE',DEU:'DE',GHA:'GH',GIB:'GI',GRC:'GR',GRL:'GL',
  GRD:'GD',GLP:'GP',GUM:'GU',GTM:'GT',GGY:'GG',GIN:'GN',GNB:'GW',GUY:'GY',
  HTI:'HT',HMD:'HM',VAT:'VA',HND:'HN',HKG:'HK',HUN:'HU',ISL:'IS',IND:'IN',
  IDN:'ID',IRN:'IR',IRQ:'IQ',IRL:'IE',IMN:'IM',ISR:'IL',ITA:'IT',JAM:'JM',
  JPN:'JP',JEY:'JE',JOR:'JO',KAZ:'KZ',KEN:'KE',KIR:'KI',PRK:'KP',KOR:'KR',
  KWT:'KW',KGZ:'KG',LAO:'LA',LVA:'LV',LBN:'LB',LSO:'LS',LBR:'LR',LBY:'LY',
  LIE:'LI',LTU:'LT',LUX:'LU',MAC:'MO',MKD:'MK',MDG:'MG',MWI:'MW',MYS:'MY',
  MDV:'MV',MLI:'ML',MLT:'MT',MHL:'MH',MTQ:'MQ',MRT:'MR',MUS:'MU',MYT:'YT',
  MEX:'MX',FSM:'FM',MDA:'MD',MCO:'MC',MNG:'MN',MNE:'ME',MSR:'MS',MAR:'MA',
  MOZ:'MZ',MMR:'MM',NAM:'NA',NRU:'NR',NPL:'NP',NLD:'NL',NCL:'NC',NZL:'NZ',
  NIC:'NI',NER:'NE',NGA:'NG',NIU:'NU',NFK:'NF',MNP:'MP',NOR:'NO',OMN:'OM',
  PAK:'PK',PLW:'PW',PSE:'PS',PAN:'PA',PNG:'PG',PRY:'PY',PER:'PE',PHL:'PH',
  PCN:'PN',POL:'PL',PRT:'PT',PRI:'PR',QAT:'QA',REU:'RE',ROU:'RO',RUS:'RU',
  RWA:'RW',BLM:'BL',SHN:'SH',KNA:'KN',LCA:'LC',MAF:'MF',SPM:'PM',VCT:'VC',
  WSM:'WS',SMR:'SM',STP:'ST',SAU:'SA',SEN:'SN',SRB:'RS',SYC:'SC',SLE:'SL',
  SGP:'SG',SXM:'SX',SVK:'SK',SVN:'SI',SLB:'SB',SOM:'SO',ZAF:'ZA',SGS:'GS',
  SSD:'SS',ESP:'ES',LKA:'LK',SDN:'SD',SUR:'SR',SJM:'SJ',SWE:'SE',CHE:'CH',
  SYR:'SY',TWN:'TW',TJK:'TJ',TZA:'TZ',THA:'TH',TLS:'TL',TGO:'TG',TKL:'TK',
  TON:'TO',TTO:'TT',TUN:'TN',TUR:'TR',TKM:'TM',TCA:'TC',TUV:'TV',UGA:'UG',
  UKR:'UA',ARE:'AE',GBR:'GB',USA:'US',UMI:'UM',URY:'UY',UZB:'UZ',VUT:'VU',
  VEN:'VE',VNM:'VN',VGB:'VG',VIR:'VI',WLF:'WF',ESH:'EH',YEM:'YE',ZMB:'ZM',
  ZWE:'ZW',
});

function normalizeCountry(input) {
  if (!input || typeof input !== 'string') {
    throw new Error(t('err_country_required'));
  }
  const key = input.trim().toUpperCase().replace(/\s+/g, ' ').replace(/\.$/, '');
  if (key in COUNTRY_ALIAS_MAP) return COUNTRY_ALIAS_MAP[key];
  if (key in ISO_ALPHA3_TO_ALPHA2) return ISO_ALPHA3_TO_ALPHA2[key];
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
  GR: 'Greece', BG: 'Bulgaria', HR: 'Croatia', CY: 'Cyprus',
  EE: 'Estonia', HU: 'Hungary', LV: 'Latvia', LT: 'Lithuania',
  MT: 'Malta', RO: 'Romania', SK: 'Slovakia', SI: 'Slovenia',
  IS: 'Iceland', LI: 'Liechtenstein', RS: 'Serbia', TR: 'Türkiye',
  UA: 'Ukraine', CA: 'Canada', MX: 'Mexico', BR: 'Brazil',
  AU: 'Australia', NZ: 'New Zealand', JP: 'Japan', CN: 'China',
  IN: 'India',
});

export function countryName(code) {
  return COUNTRY_NAMES[code?.toUpperCase()] || code;
}

// Default standard VAT rate per seller country, used to pre-fill item VAT
// fields when the user switches the seller's country. Anything not listed
// falls back to 20 (the most common EU rate).
const DEFAULT_VAT_BY_COUNTRY = Object.freeze({
  DE: 19, AT: 20, FR: 20, BE: 21, NL: 21, ES: 21, IT: 22, LU: 17,
  PT: 23, IE: 23, DK: 25, SE: 25, FI: 25.5, PL: 23, CZ: 21, HU: 27,
  GR: 24, RO: 19, BG: 20, HR: 25, SK: 23, SI: 22, EE: 22, LV: 21,
  LT: 21, MT: 18, CY: 19, GB: 20, NO: 25, CH: 8.1, IS: 24, LI: 8.1,
});
function defaultVatForCountry(cc) {
  let k = String(cc || '').trim().toUpperCase();
  if (k.length === 3 && k in ISO_ALPHA3_TO_ALPHA2) k = ISO_ALPHA3_TO_ALPHA2[k];
  return DEFAULT_VAT_BY_COUNTRY[k] ?? 20;
}

// Validates business rules that depend on tax categories
function validateInvoiceForReverseCharge(seller, buyer, itemsXML, taxBreakdownXML) {
  const combined = String(itemsXML || '') + String(taxBreakdownXML || '');
  const usesReverseCharge = /<ram:CategoryCode>AE<\/ram:CategoryCode>/.test(combined);
  if (!usesReverseCharge) return;
  // BR-AE-02: Seller VAT identifier (BT-31) is required on reverse-charge invoices.
  // BT-32 (Seller tax registration ID) and BT-63 (tax representative VAT ID) are
  // also acceptable substitutes per the rule, but this app doesn't have UI fields
  // for them — SIRET maps to BT-30 (legal registration), which is NOT a substitute.
  if (!seller.vat) {
    throw new Error(t('err_rc_seller_vat'));
  }
  // BR-AE-04: Buyer VAT identifier (BT-48) is required — no substitute permitted.
  if (!buyer.vat) {
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
  // VAT-rate groups are computed canonically inside calcTotals (BR-CO-17 etc.);
  // reuse them so the breakdown is consistent with the header monetary summation.
  const taxGroups = totals.groups;

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
          <ram:CategoryCode>${mode}</ram:CategoryCode>${mode === 'O' ? '' : `
          <ram:RateApplicablePercent>${rate.toFixed(2)}</ram:RateApplicablePercent>`}
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

  // Tax breakdown XML. Category quirks per EN 16931:
  //   Z (BR-Z-10): must NOT carry an exemption reason text or code.
  //   O (BR-O-5 + breakdown counterpart): must NOT carry a VAT rate at all,
  //     but DOES need an exemption reason (VATEX-EU-O covers the code).
  const taxBreakdownXML = Object.values(taxGroups).map(g => `
      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>${g.amount.toFixed(2)}</ram:CalculatedAmount>
        <ram:TypeCode>VAT</ram:TypeCode>
        ${mode !== 'S' && mode !== 'Z' && reverseChargeNote ? `<ram:ExemptionReason>${esc(reverseChargeNote)}</ram:ExemptionReason>` : ''}
        <ram:BasisAmount>${g.basis.toFixed(2)}</ram:BasisAmount>
        <ram:CategoryCode>${mode}</ram:CategoryCode>
        ${exemptionCodes[mode] ? `<ram:ExemptionReasonCode>${exemptionCodes[mode]}</ram:ExemptionReasonCode>` : ''}${mode === 'O' ? '' : `
        <ram:RateApplicablePercent>${g.rate.toFixed(2)}</ram:RateApplicablePercent>`}
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
        ${(seller.siret || seller.name2) ? `
        <ram:SpecifiedLegalOrganization>${seller.siret ? `
          <ram:ID schemeID="${seller.siret.replace(/\s/g, '').length === 14 ? '0002' : '0009'}">${esc(seller.siret.replace(/\s/g, ''))}</ram:ID>` : ''}${seller.name2 ? `
          <ram:TradingBusinessName>${esc(seller.name2)}</ram:TradingBusinessName>` : ''}
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
        ${(buyer.siret || buyer.name2) ? `
        <ram:SpecifiedLegalOrganization>${buyer.siret ? `
          <ram:ID schemeID="${buyer.siret.replace(/\s/g, '').length === 14 ? '0002' : '0009'}">${esc(buyer.siret.replace(/\s/g, ''))}</ram:ID>` : ''}${buyer.name2 ? `
          <ram:TradingBusinessName>${esc(buyer.name2)}</ram:TradingBusinessName>` : ''}
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

// -------- Field tooltips --------
// Single shared popover positioned next to whichever .tooltip-btn was clicked.
// Closes on Esc, outside-click, or re-click of the same button.
let _tipOwner = null;
function showTooltip(btn) {
  const pop = document.getElementById('tooltipPopover');
  if (!pop) return;
  const key = btn.getAttribute('data-tip-key');
  pop.textContent = t(key);
  pop.hidden = false;
  // Position after layout so we have measured dimensions.
  const rect = btn.getBoundingClientRect();
  const popW = pop.offsetWidth;
  const popH = pop.offsetHeight;
  let left = rect.left;
  let top = rect.bottom + 6;
  // Clamp into viewport with a small margin.
  const margin = 8;
  if (left + popW > window.innerWidth - margin) left = window.innerWidth - popW - margin;
  if (left < margin) left = margin;
  if (top + popH > window.innerHeight - margin) top = rect.top - popH - 6;
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
  btn.setAttribute('aria-expanded', 'true');
  _tipOwner = btn;
}
function hideTooltip() {
  const pop = document.getElementById('tooltipPopover');
  if (pop) pop.hidden = true;
  if (_tipOwner) _tipOwner.setAttribute('aria-expanded', 'false');
  _tipOwner = null;
}
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.tooltip-btn');
  if (btn) {
    // Don't let the surrounding <label> focus its associated input.
    e.preventDefault();
    e.stopPropagation();
    if (_tipOwner === btn) { hideTooltip(); return; }
    showTooltip(btn);
    return;
  }
  // Click outside an active tooltip dismisses it.
  if (_tipOwner && !e.target.closest('#tooltipPopover')) hideTooltip();
});

// -------- Actions --------

// Toast — transient feedback in the top-right stack. Replaces the legacy
// bottom-bar status. kind ∈ {'', 'ok', 'err'}; errors linger longer so
// they're actually readable. Stack is capped at TOAST_MAX_VISIBLE; oldest
// is evicted when full.
const TOAST_MAX_VISIBLE = 4;
const TOAST_DURATION = { ok: 2000, err: 5000, '': 2500 };
function toast(msg, kind = '') {
  const host = document.getElementById('toastHost');
  if (!host) return;
  // Evict oldest if at capacity (newest is prepended, so oldest is last child).
  while (host.children.length >= TOAST_MAX_VISIBLE) {
    host.lastElementChild?.remove();
  }
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  el.textContent = msg;
  host.prepend(el);
  // Enter on next frame so the transition runs.
  requestAnimationFrame(() => el.classList.add('toast--visible'));
  const dismissAfter = TOAST_DURATION[kind] ?? TOAST_DURATION[''];
  setTimeout(() => {
    el.classList.add('toast--leaving');
    el.classList.remove('toast--visible');
    setTimeout(() => el.remove(), 220);
  }, dismissAfter);
}

// -------- Live preview --------
const PREVIEW_ENABLED_KEY = 'erechnung:preview_enabled:v1';

// Side-by-side iframe preview of the rendered PDF, refreshed on a 300 ms
// debounce after any form change. Re-renders are paused while the cursor
// is over the preview pane so the user can scroll inside the PDF viewer
// without the iframe reloading underneath them.
const PREVIEW_DEBOUNCE_MS = 300;
const PREVIEW_MEDIA_QUERY = window.matchMedia('(min-width: 1024px)');
let previewBlobUrl = null;
let previewRenderTimer = null;
let previewInFlight = false;
let previewPending = false;
let previewHovering = false;
let previewEnabled = true; // wired to a toolbar toggle in the next step

function isPreviewActive() {
  return previewEnabled && PREVIEW_MEDIA_QUERY.matches;
}

function schedulePreviewRender() {
  if (!isPreviewActive()) return;
  if (previewHovering) { previewPending = true; return; }
  if (previewRenderTimer) clearTimeout(previewRenderTimer);
  previewRenderTimer = setTimeout(() => {
    previewRenderTimer = null;
    renderPreviewNow();
  }, PREVIEW_DEBOUNCE_MS);
}

async function renderPreviewNow() {
  if (!isPreviewActive()) return;
  if (previewInFlight) { previewPending = true; return; }
  previewInFlight = true;
  previewPending = false;
  const statusEl = document.getElementById('previewStatus');
  if (statusEl) statusEl.hidden = false;
  try {
    const bytes = await generatePreviewPDFBytes();
    // If the user toggled the preview off while the render was in flight,
    // skip applying the result and free the bytes immediately.
    if (!previewEnabled) return;
    const blob = new Blob([bytes], { type: 'application/pdf' });
    if (previewBlobUrl) URL.revokeObjectURL(previewBlobUrl);
    previewBlobUrl = URL.createObjectURL(blob);
    const iframe = document.getElementById('previewFrame');
    const empty = document.getElementById('previewEmpty');
    if (iframe) {
      // #view=Fit forces the embedded PDF viewer (Chrome, Safari, Firefox)
      // to scale the page to fit the iframe instead of opening at 100 %.
      iframe.src = previewBlobUrl + '#view=Fit';
      iframe.hidden = false;
    }
    if (empty) empty.hidden = true;
  } catch (e) {
    console.warn('[preview] render failed:', e?.message || e);
  } finally {
    previewInFlight = false;
    if (statusEl) statusEl.hidden = true;
    // If a change came in during the in-flight render, run again.
    if (previewPending && !previewHovering) schedulePreviewRender();
  }
}

function setupPreviewListeners() {
  const formScope = document.querySelector('.wrap');
  if (formScope) {
    formScope.addEventListener('input', schedulePreviewRender);
    formScope.addEventListener('change', schedulePreviewRender);
  }
  const pane = document.getElementById('previewPane');
  if (pane) {
    pane.addEventListener('mouseenter', () => { previewHovering = true; });
    pane.addEventListener('mouseleave', () => {
      previewHovering = false;
      if (previewPending) schedulePreviewRender();
    });
  }
  // Re-evaluate when the viewport crosses the 1024 px threshold.
  PREVIEW_MEDIA_QUERY.addEventListener('change', () => {
    if (isPreviewActive()) schedulePreviewRender();
  });
  const toggle = document.getElementById('previewToggle');
  if (toggle) toggle.addEventListener('click', () => setPreviewEnabled(!previewEnabled));
}

async function loadPreviewEnabled() {
  try {
    const v = await store.get(PREVIEW_ENABLED_KEY);
    previewEnabled = v === null || v === undefined ? true : v !== 'false';
  } catch (e) {
    console.warn('[erechnung] Failed to load preview-enabled flag:', e?.message || e);
    previewEnabled = true;
  }
  applyPreviewEnabledUI();
}

async function setPreviewEnabled(v) {
  previewEnabled = !!v;
  try { await store.set(PREVIEW_ENABLED_KEY, String(previewEnabled)); } catch (_) {}
  applyPreviewEnabledUI();
  if (previewEnabled) {
    schedulePreviewRender();
  } else {
    // Tear down current iframe content and free the blob.
    if (previewRenderTimer) { clearTimeout(previewRenderTimer); previewRenderTimer = null; }
    const iframe = document.getElementById('previewFrame');
    if (iframe) { iframe.src = 'about:blank'; iframe.hidden = true; }
    const empty = document.getElementById('previewEmpty');
    if (empty) empty.hidden = false;
    if (previewBlobUrl) { URL.revokeObjectURL(previewBlobUrl); previewBlobUrl = null; }
  }
}

function applyPreviewEnabledUI() {
  const card = document.getElementById('appCard');
  const btn = document.getElementById('previewToggle');
  if (card) card.classList.toggle('preview-off', !previewEnabled);
  if (btn) btn.setAttribute('aria-pressed', String(previewEnabled));
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
    toast(t('msg_xml_done'), 'ok');
  } catch (e) {
    toast(t('msg_error') + ' ' + e.message, 'err');
  }
});

// Validate popover: a checklist above the button showing ✓ passes and
// ⚠ warnings. Non-blocking — export always stays possible.
function closeValidatePopover() {
  const pop = document.getElementById('validatePopover');
  if (pop) pop.hidden = true;
}
function isValidatePopoverOpen() {
  const pop = document.getElementById('validatePopover');
  return pop && !pop.hidden;
}

$('btnValidate').addEventListener('click', () => {
  const pop = document.getElementById('validatePopover');
  if (!pop) return;
  if (!pop.hidden) { pop.hidden = true; return; }

  const lines = [];
  const okLine = (msg) => lines.push(`<div class="v-ok">✓ ${esc(msg)}</div>`);
  const warnLine = (msg) => lines.push(`<div class="v-warn">⚠ ${esc(msg)}</div>`);

  // 1. XML well-formedness
  try {
    const xml = buildXML();
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'application/xml');
    // Firefox emits <parsererror> in a non-default namespace; querySelector
    // without explicit namespace syntax won't match it. getElementsByTagName
    // is namespace-agnostic and catches all engines.
    const errNode = doc.getElementsByTagName('parsererror')[0]
      || (doc.documentElement && doc.documentElement.tagName === 'parsererror' ? doc.documentElement : null);
    if (errNode) warnLine(t('validate_xml_syntax_error') + ' ' + errNode.textContent);
    else okLine(t('validate_pass_xml'));
  } catch (e) {
    warnLine(t('msg_error') + ' ' + e.message);
  }

  // 2. Required / recommended field checks (same rules as before, now
  //    rendered as individual checklist entries).
  const nums = state.items.map(it => (Number(it.qty)||0) * (Number(it.price)||0));
  const mode = $('r_taxmode').value;
  const fieldProblems = [
    $('r_number').value.trim() ? null : t('validate_missing_number'),
    $('r_date').value ? null : t('validate_missing_date'),
    $('s_name').value.trim() ? null : t('validate_missing_seller_name'),
    $('b_name').value.trim() ? null : t('validate_missing_buyer_name'),
    $('s_country').value.trim() ? null : t('validate_missing_seller_country'),
    $('b_country').value.trim() ? null : t('validate_missing_buyer_country'),
    mode === 'AE' && !$('s_vat').value.trim() ? t('validate_rc_seller_vat') : null,
    mode === 'AE' && !$('b_vat').value.trim() ? t('validate_rc_buyer_vat') : null,
    mode === 'S' && !$('s_vat').value.trim() ? t('validate_recommend_seller_vat') : null,
    // BR-O-2/-3/-4: an invoice that is entirely out of scope must not carry
    // seller or buyer VAT identifiers. Soft warning — emission isn't blocked.
    mode === 'O' && ($('s_vat').value.trim() || $('b_vat').value.trim()) ? t('validate_o_vat_ids') : null,
    state.items.length > 0 ? null : t('validate_missing_items'),
    nums.every(x => x >= 0) ? null : t('validate_negative_amounts'),
  ].filter(Boolean);
  if (fieldProblems.length === 0) okLine(t('validate_pass_fields'));
  else fieldProblems.forEach(warnLine);

  // 3. IBAN: only flag when present-but-malformed — leaving it blank is fine
  //    (the XML then emits payment-means type 1 instead of SEPA).
  const iban = $('s_iban').value.trim();
  if (iban && !isValidIBAN(iban)) warnLine(t('validate_invalid_iban'));
  else if (iban) okLine(t('validate_pass_iban'));

  pop.innerHTML = `<div class="v-title">${esc(t('validate_title'))}</div>`
    + lines.join('')
    + `<div class="v-foot">${esc(t('validate_footer'))}</div>`;
  pop.hidden = false;
});

// -------- Font loader: 5 monospace options embedded as base64 --------
// All font data lives in FONT_DATA (defined at the bottom of this script).
// The tool runs fully offline; no network calls at runtime.
// Descriptions are deliberately bilingual (German · English) so the font
// dropdown is readable to both audiences without expanding the i18n surface
// for what is essentially a marketing blurb.
const FONT_OPTIONS = {
  'courier-prime':  { label: 'Courier Prime',  description: 'Klassische Schreibmaschine · classic typewriter' },
  'ibm-plex-mono':  { label: 'IBM Plex Mono',  description: 'Moderne Slab-Serifen · modern slab serifs' },
  'jetbrains-mono': { label: 'JetBrains Mono', description: 'Geometrisch · geometric, neutral' },
  'inconsolata':    { label: 'Inconsolata',    description: 'Schmal · narrow, clean' },
  'space-mono':     { label: 'Space Mono',     description: 'Retro-Geometrie · retro display' },
};
const DEFAULT_FONT_KEY = 'courier-prime';
const FONT_KEY = 'erechnung:font:v1';

// Per-font cache of decoded SFNT byte buffers (~50–80 KB each). Bounded by
// the 5 entries in FONT_OPTIONS, so at worst ~300 KB resident if the user
// previews every font in a session. Not actively evicted — acceptable for a
// browser app that re-reads on reload; revisit if this ever runs in an
// embedded / constrained environment.
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

// Lightweight preview-only render. Skips XML embedding, PDF/A-3 output
// intent, XMP injection, and the deterministic trailer ID — purely the
// layout output, ready to be displayed in the side-by-side iframe.
// Returns raw PDF bytes.
async function generatePreviewPDFBytes() {
  const pdfDoc = await generateInvoicePDF();
  return pdfDoc.save({ useObjectStreams: false });
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
  const currencySym = currencySymbol(currency) || currency;

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

  // Start a fresh page; all draw helpers target it from here on. The `page`
  // getter below is what keeps renderers seeing the current page.
  function newPage() {
    page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    return page;
  }

  return { mono, monoBold, INK, SOFT, PAGE_W, PAGE_H, get page() { return page; },
    widthAt, wrapText, drawText, drawTextRight, drawTextCenter, drawRule, newPage };
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

  const docTitleWord = tInvoice('pdf_doc_title');
  const number = $('r_number').value.trim() || docTitleWord;
  const sellerName = $('s_name').value.trim();
  const producer = tInvoice('pdf_doc_producer');
  pdfDoc.setTitle(`${docTitleWord} ${number}`);
  pdfDoc.setAuthor(sellerName);
  pdfDoc.setSubject(tInvoice('pdf_doc_subject'));
  pdfDoc.setKeywords(['factur-x', 'zugferd', 'einvoice', 'en16931', 'rechnung']);
  pdfDoc.setProducer(producer);
  pdfDoc.setCreator(producer);

  addPDFAOutputIntent(pdfDoc);                              // ← NEU

  try {
    injectFacturXMP(pdfDoc, 'EN 16931', {
      title: `${docTitleWord} ${number}`,
      creator: sellerName,
      producer,
    });
  } catch (e) { console.warn('XMP injection skipped:', e); }
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
    toast(`${t('msg_pdf_done')} ${outName}\n${t('msg_pdf_done_2')}`, 'ok');
  } catch (e) {
    console.error(e);
    toast(t('msg_error') + ' ' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = t('btn_create_pdf');
  }
});

// Inject Factur-X conformance metadata into the PDF XMP stream
function injectFacturXMP(pdfDoc, conformance, meta = {}) {
  // pdf-lib exposes the metadata stream via the catalog. We build an XMP
  // packet that declares Factur-X compliance AND mirrors the Info dictionary
  // (dc:title, dc:creator, xmp:CreateDate, pdf:Producer) \u2014 strict PDF/A-3
  // verifiers expect the standard Dublin Core / XMP basic schema fields
  // present in XMP, not only in the legacy Info dictionary.
  const xmpEsc = (s) => String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const isoDate = (d) => {
    const pad = (n) => String(n).padStart(2, '0');
    const tzMin = -d.getTimezoneOffset();
    const sign = tzMin >= 0 ? '+' : '-';
    const abs = Math.abs(tzMin);
    const tz = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
      `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${tz}`;
  };
  const now = meta.modifyDate || new Date();
  const created = meta.createDate || now;
  const title = xmpEsc(meta.title || '');
  const creator = xmpEsc(meta.creator || '');
  const producer = xmpEsc(meta.producer || 'Factur-X Browser Tool');
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
      <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${title}</rdf:li></rdf:Alt></dc:title>
      <dc:creator><rdf:Seq><rdf:li>${creator}</rdf:li></rdf:Seq></dc:creator>
      <xmp:CreateDate>${isoDate(created)}</xmp:CreateDate>
      <xmp:ModifyDate>${isoDate(now)}</xmp:ModifyDate>
      <pdf:Producer>${producer}</pdf:Producer>
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
  const numberPattern = await store.get(NUMBER_PATTERN_KEY);
  const payload = {
    format: 'erechnung-backup',
    version: 7,
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
    // v5+
    history: Array.isArray(state.history) ? state.history : [],
    history_enabled: state.historyEnabled,
    number_pattern: numberPattern || null,
    lang: localStorage.getItem(LANG_KEY),
    invoice_lang: localStorage.getItem(INVOICE_LANG_KEY),
    theme: localStorage.getItem(THEME_KEY),
    // v6+
    preview_enabled: previewEnabled,
    // v7+ (redesign 1a)
    text_presets: state.textPresets,
    selected_presets: state.selectedPreset,
    due_days: state.dueDays,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const ts = todayLocalISO();
  downloadBlob(blob, `erechnung-backup-${ts}.json`);
  toast(`${t('msg_backup_export')} 1 ${t('msg_backup_seller')}, ${payload.buyers.length} ${t('msg_backup_buyers')}, ${payload.footnotes.length} ${t('msg_backup_footnotes')}.`, 'ok');
}

// Validate every section of a backup payload before it touches storage or
// state. Returns a sanitized copy (sections with wrong shape are dropped,
// arrays are filtered to well-formed entries) plus an `issues` list for
// console diagnostics. The shape checks here are about preventing crashes
// downstream — they don't try to validate semantic correctness.
function sanitizeBackupPayload(raw) {
  const issues = [];
  const clean = { format: raw.format };
  if (isFiniteNum(raw.version)) clean.version = raw.version;
  if (raw.exported_at !== undefined) clean.exported_at = raw.exported_at;
  // seller: flat object of string fields.
  if (raw.seller !== undefined && raw.seller !== null) {
    if (isPlainObject(raw.seller)) clean.seller = raw.seller;
    else issues.push('seller');
  }
  // boilerplate: { lang: { intro, payment_note, greeting, signature, footnote } }
  if (raw.boilerplate !== undefined) {
    if (isPlainObject(raw.boilerplate)) {
      const out = {};
      for (const [lang, body] of Object.entries(raw.boilerplate)) {
        if (isPlainObject(body)) out[lang] = body;
      }
      clean.boilerplate = out;
    } else issues.push('boilerplate');
  }
  // buyers: array of objects with at least a string `name`.
  if (raw.buyers !== undefined) {
    if (Array.isArray(raw.buyers)) {
      clean.buyers = raw.buyers.filter(b => isPlainObject(b) && typeof b.name === 'string');
      if (clean.buyers.length !== raw.buyers.length) issues.push('buyers (partial)');
    } else issues.push('buyers');
  }
  // footnotes: array of { name: string, text: string }.
  if (raw.footnotes !== undefined) {
    if (Array.isArray(raw.footnotes)) {
      clean.footnotes = raw.footnotes.filter(f =>
        isPlainObject(f) && typeof f.name === 'string' && typeof f.text === 'string'
      );
      if (clean.footnotes.length !== raw.footnotes.length) issues.push('footnotes (partial)');
    } else issues.push('footnotes');
  }
  // last_invoice: stringified counter (or legacy full invoice number).
  if (raw.last_invoice !== undefined && raw.last_invoice !== null) {
    if (typeof raw.last_invoice === 'string' || isFiniteNum(raw.last_invoice)) {
      clean.last_invoice = String(raw.last_invoice);
    } else issues.push('last_invoice');
  }
  if (raw.filename_pattern !== undefined && raw.filename_pattern !== null) {
    if (typeof raw.filename_pattern === 'string') clean.filename_pattern = raw.filename_pattern;
    else issues.push('filename_pattern');
  }
  // font / layout: enum-check happens at restore time, just forward.
  if (raw.font !== undefined) clean.font = raw.font;
  if (raw.layout !== undefined) clean.layout = raw.layout;
  // yoy_data: { CUR: { YEAR: number[12] } }
  if (raw.yoy_data !== undefined) {
    if (isPlainObject(raw.yoy_data)) {
      const out = {};
      let droppedAny = false;
      for (const [cur, yearMap] of Object.entries(raw.yoy_data)) {
        if (!isPlainObject(yearMap)) { droppedAny = true; continue; }
        const years = {};
        for (const [yr, vals] of Object.entries(yearMap)) {
          if (Array.isArray(vals) && vals.length === 12 &&
              vals.every(v => v == null || isFiniteNum(v))) {
            years[yr] = vals.map(v => v == null ? 0 : v);
          } else {
            droppedAny = true;
          }
        }
        if (Object.keys(years).length) out[cur] = years;
      }
      clean.yoy_data = out;
      if (droppedAny) issues.push('yoy_data (partial)');
    } else issues.push('yoy_data');
  }
  if (typeof raw.yoy_enabled === 'boolean') clean.yoy_enabled = raw.yoy_enabled;
  // history: array of snapshots; require ts (number) and form (object).
  if (raw.history !== undefined) {
    if (Array.isArray(raw.history)) {
      clean.history = raw.history.filter(h =>
        isPlainObject(h) && isPlainObject(h.form) && isFiniteNum(h.ts)
      );
      if (clean.history.length !== raw.history.length) issues.push('history (partial)');
    } else issues.push('history');
  }
  if (typeof raw.history_enabled === 'boolean') clean.history_enabled = raw.history_enabled;
  if (typeof raw.preview_enabled === 'boolean') clean.preview_enabled = raw.preview_enabled;
  // text_presets (v7): validated down to the known three-block shape.
  if (raw.text_presets !== undefined) {
    const presets = sanitizeTextPresets(raw.text_presets);
    if (presets) {
      clean.text_presets = presets;
      if (isPlainObject(raw.selected_presets)) clean.selected_presets = raw.selected_presets;
    } else {
      issues.push('text_presets');
    }
  }
  if (raw.due_days !== undefined) {
    if ([14, 30, 60, 90].includes(raw.due_days)) clean.due_days = raw.due_days;
    else issues.push('due_days');
  }
  if (raw.number_pattern !== undefined && raw.number_pattern !== null) {
    if (typeof raw.number_pattern === 'string') clean.number_pattern = raw.number_pattern;
    else issues.push('number_pattern');
  }
  // lang / invoice_lang / theme: enum/null checks happen at restore time.
  if (raw.lang !== undefined) clean.lang = raw.lang;
  if (raw.invoice_lang !== undefined) clean.invoice_lang = raw.invoice_lang;
  if (Object.prototype.hasOwnProperty.call(raw, 'theme')) clean.theme = raw.theme;
  return { payload: clean, issues };
}

// Staged import: file selection only parses + sanitizes and shows a
// confirmation summary in the backup modal. Nothing is applied until the
// user explicitly clicks "Restore backup".
let _pendingBackup = null;

async function stageBackupImport(file) {
  const errBox = document.getElementById('backupImportError');
  const pendingBox = document.getElementById('backupPending');
  const dropLabel = document.getElementById('backupDropLabel');
  try {
    const text = await file.text();
    const raw = JSON.parse(text);
    if (!isPlainObject(raw) || raw.format !== 'erechnung-backup') {
      throw new Error(t('msg_backup_invalid'));
    }
    const { payload, issues } = sanitizeBackupPayload(raw);
    _pendingBackup = { payload, issues };
    // Summary lines
    const summary = document.getElementById('backupPendingSummary');
    if (summary) {
      const sellerName = (payload.seller && payload.seller.name) || '—';
      const buyerCount = Array.isArray(payload.buyers) ? payload.buyers.length : 0;
      const historyCount = Array.isArray(payload.history) ? payload.history.length : 0;
      summary.innerHTML = [
        esc(t('backup_seller_line', { name: sellerName })),
        esc(t('backup_buyers_line', { n: String(buyerCount) })),
        esc(t('backup_history_line', { n: String(historyCount) })),
      ].map(s => `<div>${s}</div>`).join('');
    }
    const warnBox = document.getElementById('backupPendingWarnings');
    if (warnBox) {
      warnBox.hidden = issues.length === 0;
      warnBox.textContent = issues.join(' · ');
    }
    if (errBox) errBox.hidden = true;
    if (pendingBox) pendingBox.hidden = false;
    if (dropLabel) dropLabel.hidden = true;
  } catch (e) {
    _pendingBackup = null;
    if (pendingBox) pendingBox.hidden = true;
    if (dropLabel) dropLabel.hidden = false;
    if (errBox) {
      errBox.textContent = t('msg_backup_failed') + ' ' + e.message;
      errBox.hidden = false;
    }
  }
}

function cancelBackupImport() {
  _pendingBackup = null;
  const pendingBox = document.getElementById('backupPending');
  const dropLabel = document.getElementById('backupDropLabel');
  const errBox = document.getElementById('backupImportError');
  if (pendingBox) pendingBox.hidden = true;
  if (dropLabel) dropLabel.hidden = false;
  if (errBox) errBox.hidden = true;
}

async function confirmBackupImport() {
  if (!_pendingBackup) return;
  const { payload, issues } = _pendingBackup;
  await applyBackupPayload(payload, issues);
  cancelBackupImport();
  updateBackupExportSummary();
}

async function applyBackupPayload(payload, issues) {
  try {
    const sellerCount = payload.seller ? 1 : 0;
    const buyerCount = Array.isArray(payload.buyers) ? payload.buyers.length : 0;
    const footnoteCount = Array.isArray(payload.footnotes) ? payload.footnotes.length : 0;

    if (payload.seller) {
      // Newer format: stammdaten only. Older format: merged seller+boilerplate.
      await store.set(STORAGE_KEY, JSON.stringify(payload.seller));
      applySellerStammdaten(payload.seller);
      updateSellerChip();
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
    }
    // Text-block presets (v7). Backups older than v7 keep the current
    // presets; their legacy footnotes were already stored above.
    if (payload.text_presets) {
      state.textPresets = payload.text_presets;
      if (isPlainObject(payload.selected_presets)) {
        for (const key of TEXT_BLOCKS) {
          if (typeof payload.selected_presets[key] === 'string') {
            state.selectedPreset[key] = payload.selected_presets[key];
          }
        }
      }
      for (const key of TEXT_BLOCKS) {
        if (!state.textPresets[key].some(p => p.id === state.selectedPreset[key])) {
          state.selectedPreset[key] = state.textPresets[key][0]?.id || '';
        }
      }
      await persistTextPresets();
      renderTextPresetSelects();
    }
    if (typeof payload.due_days === 'number') {
      state.dueDays = payload.due_days;
      await store.set(DUE_DAYS_KEY, String(state.dueDays));
      if (typeof applyDueDays === 'function') applyDueDays();
    }
    if (payload.last_invoice) {
      await store.set(COUNTER_KEY, payload.last_invoice);
    }
    if (payload.filename_pattern) {
      const migrated = migrateLegacyFilenameTokens(payload.filename_pattern);
      await store.set(FILENAME_KEY, migrated);
      $('r_filename').value = migrated;
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
    // History, history-toggle, number pattern, lang, theme (v5+).
    // Older backups won't have these keys; leave existing values untouched.
    if (Array.isArray(payload.history)) {
      state.history = payload.history;
      await persistHistory();
      renderBuyerNamesMemory();
  updateDuplicateLastVisibility();
  if (typeof updateItemsFreshHint === 'function') updateItemsFreshHint();
    }
    if (typeof payload.history_enabled === 'boolean') {
      state.historyEnabled = payload.history_enabled;
      await persistHistoryEnabled();
      const cb = document.getElementById('historyEnable');
      if (cb) cb.checked = state.historyEnabled;
    }
    if (typeof payload.number_pattern === 'string' && payload.number_pattern) {
      await store.set(NUMBER_PATTERN_KEY, payload.number_pattern);
      const inp = $('r_number_pattern');
      if (inp) inp.value = payload.number_pattern;
      if (typeof updateSuggestNumberChipPreview === 'function') {
        await updateSuggestNumberChipPreview();
      }
    }
    if (typeof payload.lang === 'string' && I18N[payload.lang]) {
      setLang(payload.lang);
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'invoice_lang')) {
      const v = payload.invoice_lang;
      const next = (typeof v === 'string' && I18N[v]) ? v : '';
      $('invoiceLangSelect').value = next;
      setInvoiceLang(next);
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'theme')) {
      if (payload.theme === null) {
        localStorage.removeItem(THEME_KEY);
        applyTheme(null);
      } else if (typeof payload.theme === 'string') {
        localStorage.setItem(THEME_KEY, payload.theme);
        applyTheme(payload.theme);
      }
    }
    // Preview toggle (v6+). The setter persists and applies UI in one go.
    // (v6 backups may also carry seller_collapsed — the collapsible seller
    // section no longer exists, so that flag is ignored.)
    if (typeof payload.preview_enabled === 'boolean') {
      await setPreviewEnabled(payload.preview_enabled);
    }
    toast(`${t('msg_backup_import_done')} ${sellerCount} ${t('msg_backup_seller')}, ${buyerCount} ${t('msg_backup_buyers')}, ${footnoteCount} ${t('msg_backup_footnotes')}.`, 'ok');
    if (issues.length) {
      console.warn('[erechnung] Backup import: malformed sections were skipped or partially loaded:', issues);
    }
  } catch (e) {
    toast(t('msg_backup_failed') + ' ' + e.message, 'err');
  }
}

// -------- Seller configured check --------

// True if seller stammdaten contain enough data to be considered "configured"
// — at minimum a name and one of (address, city, country). Gates first-run
// onboarding and the seller-chip empty label.
function isSellerConfigured() {
  const s = collectSellerStammdaten();
  return Boolean(s.name && (s.line1 || s.city || s.country));
}


// -------- Help modal: bundled README rendering --------
//
// We keep the README content as a string literal so the build stays
// single-file. A tiny Markdown renderer handles the subset used by the
// README: headings (#, ##, ###), unordered lists (- and *), inline code
// (`x`), bold (**x**), italic (*x*), links ([t](url)), paragraphs.

// Help topics: eight searchable entries rendered into the two-pane help
// modal. English-only by design — translating the docs would multiply the
// bundle size, so the help body stays English even when the UI is de/fr.
// The "Keyboard shortcuts" topic must stay in sync with the actual keydown
// bindings in setupKeyboardShortcuts().
const HELP_TOPICS = [
  { id: 'start', title: 'Getting started', md: `Set up your seller profile once — it appears on every invoice you create. It lives behind the identity chip at the top of the form.

Pick a buyer (or add a new one), add line items, and hit Create PDF. The XML is embedded automatically for ZUGFeRD 2.3 / Factur-X (EN 16931 Comfort) compliance.

Everything runs offline in your browser. All data stays in \`localStorage\`; nothing is uploaded anywhere.` },
  { id: 'profiles', title: 'Seller & buyer profiles', md: `Your seller profile is a single business identity — edit it any time from the chip at the top of the form. Master data (address, VAT ID, IBAN, BIC, bank, optional SIRET) is stored locally.

Buyers are saved as reusable profiles. Save, update, or delete them from the Buyer tab; recent customers appear as one-click chips. An optional second name line prints below the buyer name (BT-45), and the buyer reference / Leitweg-ID (BT-10) is required for German government clients.

When you pick a buyer the tool shows the date and amount of the most recent invoice you sent them.` },
  { id: 'numbering', title: 'Invoice numbering', md: `Numbers follow a pattern with tokens, set during first-run setup. Default: \`{yyyy}-{counter:5}\` e.g. \`2026-00042\`. An internal counter increments after each invoice.

- Available tokens: \`{yyyy}\`, \`{yy}\`, \`{mm}\`, \`{dd}\`, \`{counter}\`, \`{counter:N}\`.
- Change the pattern any time from Invoice info → Numbering & dates → edit pattern.
- The ↻ chip always previews the next number before you apply it.` },
  { id: 'tax', title: 'Tax modes', md: `Choose Standard (S), Reverse charge (AE), Zero-rated (Z), Exempt (E), or Out of scope (O) in Invoice info → Currency & tax.

Non-standard modes replace the per-line VAT calculation with a contextual note printed on the invoice and encoded in the XML (EN 16931 BT-95/BT-96). For reverse charge, the legal note per Art. 196 of Council Directive 2006/112/EC is inserted automatically into both PDF and XML.` },
  { id: 'compliance', title: 'PDF/A-3 & Factur-X', md: `Every generated PDF embeds a machine-readable Factur-X XML attachment (\`factur-x.xml\`) and conforms to PDF/A-3 for long-term archiving. Profile: EN 16931 (Comfort), \`urn:cen.eu:en16931:2017\`.

Use Validate XML before sending to check required fields, IBAN checksum, and VAT-ID plausibility — validation never blocks export.

Already have a designed PDF (e.g. from InDesign)? Embed XML… retrofits it with the invoice XML. Generated files pass Quba Viewer, Mustang, ELSTER, and strict verapdf validation.` },
  { id: 'filenames', title: 'Filename patterns', md: `Build your own filename using tokens in Invoice info → Filename pattern. The pattern is a real text field — type freely, or click a token chip to append one.

- Tokens: \`{nr}\`, \`{buyer}\`, \`{project}\`, \`{date}\`, \`{category}\`, \`{seller}\`, \`{layout}\`.
- A live preview below shows the resolved filename with its \`.pdf\` suffix.
- The pattern is saved automatically as you type.` },
  { id: 'history', title: 'History & statistics', md: `Every generated invoice is saved automatically (up to 1000 entries, oldest dropped first) — toggleable via the Auto-save switch in the History modal.

- **Reload** a past invoice back into the form. All fields including buyer, items, tax mode, language, font and layout are restored; the number is auto-assigned.
- **Add past invoice** backfills records that predate this tool so statistics cover full periods.
- Statistics summarizes revenue, invoice counts, averages, a monthly chart and top buyers (click one to drill down), per currency. The Quarters tab shows Q1–Q4 with a year selector, and YoY comparison can be backfilled manually.
- Export CSV dumps the current view as UTF-8 with semicolon separators.` },
  { id: 'shortcuts', title: 'Keyboard shortcuts', md: `Shortcuts work anywhere in the app except while typing in a field (Esc always works).

- ⌘/Ctrl + Enter — Create PDF
- ⌘/Ctrl + D — Duplicate last invoice
- 1 / 2 / 3 — Jump to Buyer / Items / Invoice info
- ? — Open this Help panel
- Esc — Close the current menu, modal, or panel` },
];


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

// Allow http(s), mailto, tel, anchors, and relative paths; reject everything
// else (javascript:, data:, vbscript:, file:, ...). The markdown body is bundled
// today, so this is prophylactic — if any user-controlled text ever flows in,
// `[click](javascript:alert(1))` won't become a working XSS vector.
function isSafeHref(url) {
  const normalized = String(url || '').trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith('#')) return true;
  if (normalized.startsWith('/') || normalized.startsWith('./') || normalized.startsWith('../')) return true;
  const schemeMatch = normalized.match(/^([a-z][a-z0-9+\-.]*):/);
  if (!schemeMatch) return true; // scheme-less → treated as relative
  const scheme = schemeMatch[1];
  return scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'tel';
}

// Inline Markdown: **bold**, *italic*, \`code\`, [text](url).
function inlineMD(text) {
  let s = esc(text);
  // Code first so its content doesn't get further mangled
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold then italic (bold wraps double * which would otherwise eat italic)
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  // Links — sanitize URL schemes; unsafe hrefs collapse to '#'.
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    const href = isSafeHref(url) ? url : '#';
    return `<a href="${href}" target="_blank" rel="noopener">${label}</a>`;
  });
  return s;
}


// -------- Help modal (two-pane: searchable topics + content) --------

let helpTopicId = 'start';
let helpSearchTerm = '';

function filteredHelpTopics() {
  const term = helpSearchTerm.trim().toLowerCase();
  if (!term) return HELP_TOPICS;
  return HELP_TOPICS.filter(tp =>
    tp.title.toLowerCase().includes(term) || tp.md.toLowerCase().includes(term));
}

function renderHelpTopics() {
  const host = document.getElementById('helpTopics');
  const noResults = document.getElementById('helpNoResults');
  if (!host) return;
  const topics = filteredHelpTopics();
  // If the active topic fell out of the filter, activate the first match.
  const active = topics.find(tp => tp.id === helpTopicId) || topics[0] || null;
  if (active) helpTopicId = active.id;
  host.innerHTML = topics
    .map(tp => `<button type="button" class="help-topic${tp.id === helpTopicId ? ' active' : ''}" data-topic="${esc(tp.id)}">${esc(tp.title)}</button>`)
    .join('');
  if (noResults) noResults.hidden = topics.length > 0;
  host.querySelectorAll('.help-topic').forEach(btn => {
    btn.addEventListener('click', () => {
      helpTopicId = btn.dataset.topic;
      renderHelpTopics();
    });
  });
  renderHelpContent(active);
}

function renderHelpContent(topic) {
  const title = document.getElementById('helpTopicTitle');
  const body = document.getElementById('helpBody');
  if (!title || !body) return;
  title.textContent = topic ? topic.title : '';
  body.innerHTML = topic ? renderMarkdown(topic.md) : '';
}

function openHelpModal() {
  const modal = $('helpModal');
  if (!modal) return;
  renderHelpTopics();
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


// -------- Embed-XML modal (was "upload mode" in the output section) --------

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
    toast(t('msg_pdf_select_first'), 'err');
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
    // Same save options as the generate path (btnPDF) so both outputs get
    // identical PDF structure for downstream validators.
    const finalBytes = await pdfDoc.save({ useObjectStreams: false });
    const blob = new Blob([finalBytes], { type: 'application/pdf' });
    downloadBlob(blob, outName);

    await recordHistoryEntry();
    closeEmbedModal();
    toast(t('msg_embed_done'), 'ok');
  } catch (e) {
    console.error(e);
    toast(t('msg_embed_failed') + ' ' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = t('btn_embed_run');
  }
}


// -------- Redesign shell: fonts, tabs, menus, seller chip, onboarding --------

// UI font: IBM Plex Mono, reusing the WOFF data already embedded for the
// PDF pipeline (FONT_DATA). Injected as @font-face at runtime so the app
// stays a single offline file with no CDN fetch. Weight 700 comes from the
// bold cut; intermediate weights fall back to browser synthesis.
function injectUIFontFaces() {
  try {
    const data = FONT_DATA['ibm-plex-mono'];
    if (!data) return;
    const style = document.createElement('style');
    style.textContent = `
      @font-face {
        font-family: 'IBM Plex Mono';
        font-weight: 100 500;
        font-style: normal;
        src: url(data:font/woff;base64,${data.reg}) format('woff');
      }
      @font-face {
        font-family: 'IBM Plex Mono';
        font-weight: 600 900;
        font-style: normal;
        src: url(data:font/woff;base64,${data.bold}) format('woff');
      }`;
    document.head.appendChild(style);
  } catch (e) {
    console.warn('[erechnung] UI font injection failed:', e?.message || e);
  }
}

// --- Tabs (Buyer / Items / Invoice info) ---
function setActiveTab(key) {
  document.querySelectorAll('#tabs .tab').forEach(btn => {
    const active = btn.dataset.tab === key;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  ['buyer', 'items', 'details'].forEach(k => {
    const panel = document.getElementById('tab-' + k);
    if (panel) panel.hidden = k !== key;
  });
}
document.querySelectorAll('#tabs .tab').forEach(btn => {
  btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
});

// --- Overflow menu (⋯) ---
function isOverflowMenuOpen() {
  const m = document.getElementById('overflowMenu');
  return m && !m.hidden;
}
function closeOverflowMenu() {
  const m = document.getElementById('overflowMenu');
  if (m) m.hidden = true;
  document.getElementById('overflowToggle')?.setAttribute('aria-expanded', 'false');
}
document.getElementById('overflowToggle').addEventListener('click', () => {
  const m = document.getElementById('overflowMenu');
  const open = m.hidden;
  m.hidden = !open;
  document.getElementById('overflowToggle').setAttribute('aria-expanded', String(open));
  if (open) closeSellerMenu();
});

// --- Seller identity chip + dropdown ---
function sellerInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '–';
  const first = parts[0][0] || '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : (parts[0][1] || '');
  return (first + last).toUpperCase();
}

// Refresh the chip label/avatar and the read-mode key/value list from the
// current s_* field values. Called after load, save, import, onboarding.
function updateSellerChip() {
  const s = collectSellerStammdaten();
  const initials = sellerInitials(s.name);
  const label = s.name
    ? [s.name, s.vat].filter(Boolean).join(' · ')
    : t('seller_chip_empty');
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('sellerAvatar', initials);
  set('sellerAvatarLg', initials);
  set('sellerChipLabel', label);
  set('sellerReadName', s.name || '—');
  const name2El = document.getElementById('sellerReadName2');
  if (name2El) {
    name2El.textContent = s.name2 || '';
    name2El.hidden = !s.name2;
  }
  set('sellerReadVat', s.vat || '—');
  set('sellerReadCountry', s.country || '—');
  set('sellerReadEmail', s.email || '—');
  set('sellerReadPhone', s.phone || '—');
  set('sellerReadIban', s.iban || '—');
  set('sellerReadBic', s.bic || '—');
}

function isSellerMenuOpen() {
  const m = document.getElementById('sellerMenu');
  return m && !m.hidden;
}
function closeSellerMenu() {
  const m = document.getElementById('sellerMenu');
  if (!m || m.hidden) return;
  // Leaving while editing = cancel (restore the pre-edit snapshot).
  if (!document.getElementById('sellerEdit').hidden) cancelSellerEdit();
  m.hidden = true;
  document.getElementById('sellerChip')?.setAttribute('aria-expanded', 'false');
}
document.getElementById('sellerChip').addEventListener('click', () => {
  const m = document.getElementById('sellerMenu');
  if (m.hidden) {
    updateSellerChip();
    document.getElementById('sellerRead').hidden = false;
    document.getElementById('sellerEdit').hidden = true;
    m.hidden = false;
    document.getElementById('sellerChip').setAttribute('aria-expanded', 'true');
    closeOverflowMenu();
  } else {
    closeSellerMenu();
  }
});

// Edit mode keeps the live s_* inputs (the pipeline reads them by id), so
// Cancel restores a snapshot taken when editing started.
let _sellerEditSnapshot = null;
function startSellerEdit() {
  _sellerEditSnapshot = collectSellerStammdaten();
  document.getElementById('sellerRead').hidden = true;
  document.getElementById('sellerEdit').hidden = false;
  $('s_name').focus();
}
function cancelSellerEdit() {
  if (_sellerEditSnapshot) applySellerStammdaten(_sellerEditSnapshot);
  _sellerEditSnapshot = null;
  document.getElementById('sellerEdit').hidden = true;
  document.getElementById('sellerRead').hidden = false;
  updateSellerChip();
}
document.getElementById('sellerEditBtn').addEventListener('click', startSellerEdit);
document.getElementById('sellerCancelBtn').addEventListener('click', cancelSellerEdit);
document.getElementById('saveSeller').addEventListener('click', async () => {
  await saveSeller();
  _sellerEditSnapshot = null;
  document.getElementById('sellerEdit').hidden = true;
  document.getElementById('sellerRead').hidden = false;
  updateSellerChip();
});
document.getElementById('sellerRerunBtn').addEventListener('click', () => {
  closeSellerMenu();
  openOnboarding();
});

// Close floating layers on outside click.
document.addEventListener('click', (e) => {
  if (isOverflowMenuOpen() && !e.target.closest('#overflowMenu') && !e.target.closest('#overflowToggle')) {
    closeOverflowMenu();
  }
  if (isSellerMenuOpen() && !e.target.closest('#sellerMenu') && !e.target.closest('#sellerChip')) {
    closeSellerMenu();
  }
  if (isValidatePopoverOpen() && !e.target.closest('#validatePopover') && !e.target.closest('#btnValidate')) {
    closeValidatePopover();
  }
});

// --- Due-date chips (+14d / +30d / +60d / +90d, single-select) ---
// The hidden r_due input stays the single source the XML/PDF pipeline
// reads; it is always issue date + dueDays.
async function loadDueDays() {
  try {
    const v = await store.get(DUE_DAYS_KEY);
    const n = parseInt(v, 10);
    if ([14, 30, 60, 90].includes(n)) state.dueDays = n;
  } catch (_) {}
}

function applyDueDays() {
  const baseStr = $('r_date').value || todayLocalISO();
  const [y, m, d] = baseStr.split('-').map(Number);
  const base = new Date(y, m - 1, d);
  base.setDate(base.getDate() + state.dueDays);
  const pad = (n) => String(n).padStart(2, '0');
  $('r_due').value = `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}`;
  updateDueDateUI();
  if (typeof schedulePreviewRender === 'function') schedulePreviewRender();
}

function updateDueDateUI() {
  document.querySelectorAll('#dueChips button').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.days, 10) === state.dueDays);
  });
  const display = document.getElementById('dueDateDisplay');
  if (display) {
    const due = $('r_due')?.value;
    let text = '';
    if (due) {
      try { text = '→ ' + parseInvoiceDate(due).toLocaleDateString(CURRENT_LANG); }
      catch { text = '→ ' + due; }
    }
    display.textContent = text;
  }
}

document.querySelectorAll('#dueChips button').forEach(btn => {
  btn.addEventListener('click', async () => {
    state.dueDays = parseInt(btn.dataset.days, 10);
    try { await store.set(DUE_DAYS_KEY, String(state.dueDays)); } catch (_) {}
    applyDueDays();
  });
});
$('r_date').addEventListener('change', applyDueDays);

// --- Delivery date: optional period ("+ Make it a period") ---
function updateDeliveryPeriodUI() {
  const hasEnd = Boolean($('r_delivery_end').value);
  $('r_delivery_end').hidden = !hasEnd;
  document.getElementById('deliveryArrow').hidden = !hasEnd;
  $('clearDeliveryEnd').hidden = !hasEnd;
  document.getElementById('addDeliveryEnd').hidden = hasEnd;
}
document.getElementById('addDeliveryEnd').addEventListener('click', () => {
  $('r_delivery_end').value = $('r_delivery').value || todayLocalISO();
  updateDeliveryPeriodUI();
  $('r_delivery_end').focus();
  if (typeof schedulePreviewRender === 'function') schedulePreviewRender();
});
$('clearDeliveryEnd').addEventListener('click', () => {
  const el = $('r_delivery_end');
  el.value = '';
  el.defaultValue = '';
  el.dispatchEvent(new Event('change', { bubbles: true }));
  updateDeliveryPeriodUI();
});

// --- Collapsible-section summaries + layout segmented control ---
function updateSummaryValues() {
  const cur = document.getElementById('currencySummary');
  if (cur) cur.textContent = $('r_currency').value;
  const lay = document.getElementById('layoutSummary');
  if (lay) {
    const key = $('invoiceLayoutSelect').value;
    lay.textContent = (LAYOUTS[key] && LAYOUTS[key].label) || key;
  }
}

function renderLayoutSegment() {
  const host = document.getElementById('layoutSegment');
  if (!host) return;
  const current = $('invoiceLayoutSelect').value;
  host.innerHTML = Object.entries(LAYOUTS)
    .map(([k, v]) => `<button type="button" data-layout="${esc(k)}"${k === current ? ' class="active"' : ''}>${esc(v.label)}</button>`)
    .join('');
  host.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      const sel = $('invoiceLayoutSelect');
      sel.value = btn.dataset.layout;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      renderLayoutSegment();
      updateSummaryValues();
      if (typeof schedulePreviewRender === 'function') schedulePreviewRender();
    });
  });
}

// --- Onboarding (two-step first-run setup) ---
let onboardingStep = 0;

function renderOnboardingStep() {
  document.getElementById('obStep1').hidden = onboardingStep !== 0;
  document.getElementById('obStep2').hidden = onboardingStep !== 1;
  document.getElementById('obDot1').classList.toggle('active', onboardingStep === 0);
  document.getElementById('obDot2').classList.toggle('active', onboardingStep === 1);
  document.getElementById('obStepLabel').textContent = t(onboardingStep === 0 ? 'ob_step_1' : 'ob_step_2');
  if (onboardingStep === 1) updateObNumberPreview();
}

function openOnboarding() {
  onboardingStep = 0;
  // Pre-clear (fresh-eyes preview); an existing profile stays untouched
  // until "Finish setup" writes the new values.
  ['ob_company', 'ob_vat', 'ob_country', 'ob_iban'].forEach(id => { $(id).value = ''; });
  $('ob_pattern').value = DEFAULT_NUMBER_PATTERN;
  $('ob_start').value = '1';
  renderOnboardingStep();
  const modal = $('onboardingModal');
  modal.classList.add('open');
  modal.removeAttribute('hidden');
}
function closeOnboarding() {
  const modal = $('onboardingModal');
  modal.classList.remove('open');
  modal.setAttribute('hidden', '');
}

function updateObNumberPreview() {
  const pattern = ($('ob_pattern').value || '').trim() || DEFAULT_NUMBER_PATTERN;
  const start = Math.max(1, parseInt($('ob_start').value, 10) || 1);
  const host = document.getElementById('obNumberPreview');
  if (!host) return;
  host.innerHTML = [0, 1, 2]
    .map(i => `<div>${esc(resolveNumberPattern(pattern, start + i))}</div>`)
    .join('');
}

document.getElementById('obLoadDemo').addEventListener('click', () => {
  $('ob_company').value = 'Demo Beratung GmbH';
  $('ob_vat').value = 'DE123456789';
  $('ob_country').value = 'DE';
  // Placeholder IBAN: all-zero body with mod-97 checksum (36) so it
  // validates structurally but cannot map to any real account.
  $('ob_iban').value = 'DE36000000000000000000';
});
document.getElementById('obContinue').addEventListener('click', () => {
  onboardingStep = 1;
  renderOnboardingStep();
});
document.getElementById('obBack').addEventListener('click', () => {
  onboardingStep = 0;
  renderOnboardingStep();
});
$('ob_pattern').addEventListener('input', updateObNumberPreview);
$('ob_start').addEventListener('input', updateObNumberPreview);
document.getElementById('obTokenChips').addEventListener('click', (e) => {
  const token = e.target.closest('[data-token]')?.dataset.token;
  if (!token) return;
  $('ob_pattern').value += token;
  updateObNumberPreview();
});
document.getElementById('obFinish').addEventListener('click', async () => {
  const start = parseInt($('ob_start').value, 10);
  if (!Number.isFinite(start) || start < 1) {
    toast(t('msg_number_setup_start_invalid'), 'err');
    return;
  }
  // Step 1 values → seller fields (other master data stays editable via
  // the seller chip). Only overwrite what the user actually entered.
  if ($('ob_company').value.trim()) $('s_name').value = $('ob_company').value.trim();
  if ($('ob_vat').value.trim())     $('s_vat').value = $('ob_vat').value.trim();
  if ($('ob_country').value.trim()) $('s_country').value = $('ob_country').value.trim().toUpperCase();
  if ($('ob_iban').value.trim())    $('s_iban').value = $('ob_iban').value.trim();
  await store.set(STORAGE_KEY, JSON.stringify(collectSellerStammdaten()));

  // Step 2 values → number pattern + counter. Counter stores "last used",
  // so persist start - 1 to make the very next invoice equal `start`.
  const pattern = ($('ob_pattern').value || '').trim() || DEFAULT_NUMBER_PATTERN;
  await store.set(NUMBER_PATTERN_KEY, pattern);
  await setCounterValue(start - 1);
  $('r_number_pattern').value = pattern;
  // Clear the field first so the next number comes from the new pattern +
  // counter instead of incrementing whatever the init default put there.
  $('r_number').value = '';
  await applyNextInvoiceNumber();
  await updateSuggestNumberChipPreview();
  updateFilenamePreview();
  updateSellerChip();
  refreshInlineValidation();
  closeOnboarding();
  toast(t('msg_setup_done'), 'ok');
});

// --- Overflow menu items ---
document.getElementById('rerunSetup').addEventListener('click', () => {
  closeOverflowMenu();
  openOnboarding();
});

// --- Backup & restore modal ---
function updateBackupExportSummary() {
  const el = document.getElementById('backupExportSummary');
  if (!el) return;
  el.textContent = t('backup_export_body', {
    buyers: String(state.buyers.length),
    history: String(state.history.length),
  });
}
function openBackupModal() {
  cancelBackupImport();
  updateBackupExportSummary();
  const modal = $('backupModal');
  modal.classList.add('open');
  modal.removeAttribute('hidden');
}
function closeBackupModal() {
  const modal = $('backupModal');
  modal.classList.remove('open');
  modal.setAttribute('hidden', '');
}
document.getElementById('openBackup').addEventListener('click', () => {
  closeOverflowMenu();
  openBackupModal();
});
document.getElementById('backupClose').addEventListener('click', closeBackupModal);
$('backupModal').addEventListener('click', (e) => {
  if (e.target === $('backupModal')) closeBackupModal();
});
$('btnExport').addEventListener('click', exportData);
$('importFile').addEventListener('change', (e) => {
  if (e.target.files[0]) {
    stageBackupImport(e.target.files[0]);
    e.target.value = ''; // reset so re-import of same file works
  }
});
document.getElementById('backupCancelImport').addEventListener('click', cancelBackupImport);
document.getElementById('backupConfirmImport').addEventListener('click', confirmBackupImport);

// --- Help search ---
document.getElementById('helpSearch').addEventListener('input', (e) => {
  helpSearchTerm = e.target.value;
  renderHelpTopics();
});

// --- Boilerplate autosave (intro / payment note / greeting / signature /
//     footnote persist per invoice language as the user types) ---
['r_intro', 'r_payment_note', 'r_greeting', 'r_signature', 'r_footnote'].forEach(id => {
  $(id).addEventListener('input', scheduleBoilerplateSave);
});

// -------- Init --------
document.getElementById('addItem').addEventListener('click', () => addItem());
document.getElementById('addFirstLine').addEventListener('click', () => addItem());

// Top-bar modal openers
$('openHistory').addEventListener('click', openHistoryModal);
$('duplicateLast').addEventListener('click', duplicateLastInvoice);
$('openHelp').addEventListener('click', () => {
  closeOverflowMenu();
  openHelpModal();
});
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
document.getElementById('r_currency').addEventListener('change', () => {
  calcTotals();
  updateSummaryValues();
});

// Buyer picker events
$('buyerPicker').addEventListener('change', (e) => {
  const idx = e.target.value;
  if (idx === '') {
    clearBuyer();
  } else if (state.buyers[idx]) {
    applyBuyer(state.buyers[idx]);
  }
  const confirmRow = document.getElementById('buyerDeleteConfirm');
  if (confirmRow) confirmRow.hidden = true;
  renderRecentCustomerChips();
  updateBuyerActionUI();
  updateFilenamePreview();
  updateBuyerHistoryHint();
});
$('saveBuyer').addEventListener('click', saveBuyer);
// Delete uses the confirm-arm pattern: first click reveals an inline
// "Delete this customer? Yes / No" row, only Yes actually deletes.
$('deleteBuyer').addEventListener('click', () => {
  $('deleteBuyer').hidden = true;
  $('buyerDeleteConfirm').hidden = false;
});
$('buyerDeleteYes').addEventListener('click', async () => {
  $('buyerDeleteConfirm').hidden = true;
  await deleteBuyer();
});
$('buyerDeleteNo').addEventListener('click', () => {
  $('buyerDeleteConfirm').hidden = true;
  updateBuyerActionUI();
});
// Update history hint as the user types in the name field. If the typed
// (or datalist-picked) value matches a past buyer exactly and the rest of
// the address block is still empty, autofill the remaining fields from the
// most recent matching history snapshot. Never overwrites existing input.
$('b_name').addEventListener('input', () => {
  const name = $('b_name').value.trim();
  if (name && buyerAddressEmpty()) {
    const past = findHistoryBuyerByName(name);
    if (past) {
      applyBuyer({ ...past, name });
      updateFilenamePreview();
    }
  }
  updateBuyerHistoryHint();
});

// History picker events. "Clear all" arms an inline confirm row instead
// of deleting immediately.
$('historyClearAll').addEventListener('click', () => {
  if (state.history.length === 0) return;
  $('historyClearAll').hidden = true;
  const label = document.getElementById('historyClearConfirmLabel');
  if (label) label.textContent = t('clear_all_confirm', { count: String(state.history.length) });
  $('historyClearConfirm').hidden = false;
});
$('historyClearYes').addEventListener('click', async () => {
  $('historyClearConfirm').hidden = true;
  $('historyClearAll').hidden = false;
  await clearAllHistory();
});
$('historyClearNo').addEventListener('click', () => {
  $('historyClearConfirm').hidden = true;
  $('historyClearAll').hidden = false;
});
$('historySearch').addEventListener('input', (e) => {
  historyFilter.search = e.target.value;
  renderHistoryPicker();
});
$('historyPeriod').addEventListener('change', (e) => {
  historyFilter.period = e.target.value;
  renderHistoryPicker();
});
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
    return;
  }
  // Empty-state CTA: "Create your first invoice" just closes the modal.
  if (e.target.closest('#statsEmptyCta')) closeStatsModal();
});
// Click backdrop or press Esc to close
$('statsModal').addEventListener('click', (e) => {
  if (e.target === $('statsModal')) closeStatsModal();
});
// Global keyboard shortcuts. Esc always works; ⌘/Ctrl combos work anywhere;
// bare keys (1/2/3, ?) only when focus is not inside a form field. This
// list is documented in Help → "Keyboard shortcuts" — keep both in sync.
document.addEventListener('keydown', (e) => {
  const tag = ((e.target && e.target.tagName) || '').toLowerCase();
  const isTyping = tag === 'input' || tag === 'textarea' || tag === 'select';
  const mod = e.metaKey || e.ctrlKey;

  if (e.key === 'Escape') {
    // Tooltips are the lightest layer — close first if open.
    if (_tipOwner) { hideTooltip(); return; }
    // Order: deepest/topmost layers first.
    const isOpen = (id) => { const m = $(id); return m && m.classList.contains('open'); };
    if (isOpen('embedModal')) { closeEmbedModal(); return; }
    if (isValidatePopoverOpen()) { closeValidatePopover(); return; }
    if (typeof isOverflowMenuOpen === 'function' && isOverflowMenuOpen()) { closeOverflowMenu(); return; }
    if (typeof isSellerMenuOpen === 'function' && isSellerMenuOpen()) { closeSellerMenu(); return; }
    if (isOpen('onboardingModal')) { closeOnboarding(); return; }
    if (isOpen('backupModal')) { closeBackupModal(); return; }
    if (isOpen('yoyBackfillModal')) { closeYoYBackfillModal(); return; }
    if (isOpen('pastInvoiceModal')) { closePastInvoiceModal(); return; }
    if (isOpen('helpModal')) { closeHelpModal(); return; }
    if (isOpen('statsModal')) {
      if (statsBuyerDrillDown) { setStatsBuyerDrillDown(null); return; }
      closeStatsModal();
      return;
    }
    if (isOpen('historyModal')) { closeHistoryModal(); return; }
    // No layer open — Esc clears any pending inline-delete confirmation.
    if (_removeConfirmBtn) resetRemoveConfirm();
    return;
  }
  if (mod && e.key === 'Enter') {
    e.preventDefault();
    $('btnPDF').click();
    return;
  }
  if (mod && (e.key === 'd' || e.key === 'D')) {
    e.preventDefault();
    duplicateLastInvoice();
    return;
  }
  if (e.key === '?' && !isTyping) {
    e.preventDefault();
    openHelpModal();
    return;
  }
  if (!isTyping && !mod && (e.key === '1' || e.key === '2' || e.key === '3')) {
    const map = { 1: 'buyer', 2: 'items', 3: 'details' };
    setActiveTab(map[e.key]);
  }
});

// Invoice number suggestion
$('suggestNumber').addEventListener('click', applyNextInvoiceNumber);

// Invoice number pattern editor
$('numberPatternChips').addEventListener('click', (e) => {
  // closest() lets the chip have child markup (icon, span) without breaking
  // the handler — e.target would otherwise resolve to the inner node.
  const token = e.target.closest('[data-token]')?.dataset.token;
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
  toast(`${t('msg_pattern_saved')} ${pattern}`, 'ok');
});
async function updateSuggestNumberChipPreview() {
  const pattern = ($('r_number_pattern').value || '').trim() || DEFAULT_NUMBER_PATTERN;
  const counter = await getCounterValue();
  const preview = resolveNumberPattern(pattern, counter + 1);
  $('suggestNumber').textContent = `↻ ${preview}`;
}

// Live-Update: bei jeder Pattern-Änderung
$('r_number_pattern').addEventListener('input', updateSuggestNumberChipPreview);

// "edit pattern" link toggles the inline pattern editor.
$('numberPatternToggle').addEventListener('click', () => {
  const body = $('numberPatternBody');
  body.hidden = !body.hidden;
});

// Load pattern into the field on init
(async () => {
  $('r_number_pattern').value = await getNumberPattern();
})();

// Filename pattern: chips insert tokens at cursor, live preview updates on
// any field change. The pattern autosaves (debounced) — no explicit button.
let _filenameSaveTimer = null;
function scheduleFilenamePatternSave() {
  if (_filenameSaveTimer) clearTimeout(_filenameSaveTimer);
  _filenameSaveTimer = setTimeout(() => {
    _filenameSaveTimer = null;
    store.set(FILENAME_KEY, $('r_filename').value);
  }, 600);
}
$('filenameChips').addEventListener('click', (e) => {
  const token = e.target.closest('[data-token]')?.dataset.token;
  if (!token) return;
  const input = $('r_filename');
  const pos = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, pos);
  const after = input.value.slice(pos);
  input.value = before + token + after;
  input.focus();
  input.setSelectionRange(pos + token.length, pos + token.length);
  updateFilenamePreview();
  scheduleFilenamePatternSave();
});
$('r_filename').addEventListener('input', () => {
  updateFilenamePreview();
  scheduleFilenamePatternSave();
});
// Also update preview when invoice fields change
['r_number', 'r_project', 'b_name', 'r_date', 'r_category', 's_name'].forEach(id => {
  $(id).addEventListener('input', updateFilenamePreview);
});

// === INVOICE LAYOUT START ===
// Layouts werden zur Buildzeit eingespielt — siehe vite.config.js
import { LAYOUTS, DEFAULT_LAYOUT } from './layouts.js';
// === INVOICE LAYOUT END ===

// Theme: Light / Dark / Auto segmented control in the overflow menu.
// pref: null = auto, 'light', 'dark'. Stored preference stays the same
// (absence of THEME_KEY = auto) so older backups keep working.
function applyTheme(pref) {
  const isDark = pref === 'dark' || (pref === null && window.matchMedia('(prefers-color-scheme: dark)').matches);
  if (isDark) document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
  const active = pref === 'dark' ? 'dark' : pref === 'light' ? 'light' : 'auto';
  document.querySelectorAll('#themeSegment button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.themePref === active);
  });
}
document.querySelectorAll('#themeSegment button').forEach(btn => {
  btn.addEventListener('click', () => {
    const pref = btn.dataset.themePref === 'auto' ? null : btn.dataset.themePref;
    if (pref === null) localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, pref);
    applyTheme(pref);
  });
});
// Listen for system theme changes when in auto mode
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (!localStorage.getItem(THEME_KEY)) applyTheme(null);
});

// UI language: DE / EN / FR segmented control in the overflow menu.
function updateLangSegment() {
  document.querySelectorAll('#langSegment button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === CURRENT_LANG);
  });
}
document.querySelectorAll('#langSegment button').forEach(btn => {
  btn.addEventListener('click', () => {
    setLang(btn.dataset.lang);
    updateLangSegment();
  });
});

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
  // 1. Render-blocking visual state (no flash of wrong theme/language/font).
  injectUIFontFaces();
  applyTheme(localStorage.getItem(THEME_KEY));
  updateLangSegment();
  $('invoiceLangSelect').value = INVOICE_LANG || '';
  applyTranslations();

  // 2. Defaults the user can immediately edit.
  $('r_date').value = todayLocalISO();
  addItem({ desc: '', qty: 1, price: 0 });
  setActiveTab('buyer');

  // 3. Populate the (hidden) layout dropdown; the visible segmented control
  //    renders from it after the persisted value is loaded below.
  const layoutSel = $('invoiceLayoutSelect');
  layoutSel.innerHTML = Object.entries(LAYOUTS)
    .map(([k, v]) => `<option value="${esc(k)}">${esc(v.label)}</option>`)
    .join('');

  // 4. Load persisted state in parallel — these are independent of each other.
  await Promise.all([
    loadSeller(),
    loadBuyers(),
    loadFootnotes(),
    loadTextPresets(),
    loadHistory(),
    loadYoY(),
    loadDueDays(),
    loadFilenamePattern(),
    updateSuggestNumberChipPreview(),
    (async () => { $('invoiceFontSelect').value = await getCurrentFontKey(); })(),
    (async () => { layoutSel.value = await getCurrentLayout(); })(),
  ]);

  // 5. Sync the default item's VAT rate to the (now-loaded) seller country.
  //    The initial addItem ran before loadSeller, so a persisted non-DE
  //    seller would otherwise show 19% by accident.
  applyCountryDefaultVat();

  // 6. Auto-fill the invoice number if the field is still empty, then refresh
  //    the filename preview (which depends on the number).
  await applyNextInvoiceNumber();
  updateFilenamePreview();

  // 7. History + buyer UI — after translations + load so labels are correct.
  $('historyEnable').checked = state.historyEnabled;
  renderHistoryPicker();
  renderBuyerPicker();
  updateBuyerHistoryHint();

  // 8. Shell state derived from loaded values: seller chip, due chips,
  //    delivery period, layout segment, section summaries, preset UI.
  updateSellerChip();
  applyDueDays();
  updateDeliveryPeriodUI();
  renderLayoutSegment();
  updateSummaryValues();
  setupTextPresetUI();
  applyPresetTextsIfEmpty();

  // 9. Wire up inline-validation listeners and run once over current state.
  setupInlineValidation();
  refreshInlineValidation();

  // 10. First-run gate: no configured seller → open the two-step onboarding.
  if (!isSellerConfigured()) openOnboarding();

  // 11. Live preview pane: load persisted toggle, attach listeners, render.
  await loadPreviewEnabled();
  setupPreviewListeners();
  schedulePreviewRender();
}

init().catch(err => {
  console.error('Init failed:', err);
  toast(t('msg_error') + ' ' + (err && err.message ? err.message : err), 'err');
});
