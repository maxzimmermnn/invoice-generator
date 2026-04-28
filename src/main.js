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
import { fmt, round2 } from './utils.js';


// -------- State --------
const STORAGE_KEY = 'erechnung:seller:v1';
const BOILERPLATE_KEY = 'erechnung:boilerplate:v1';
const BUYERS_KEY = 'erechnung:buyers:v1';
const COUNTER_KEY = 'erechnung:last_invoice:v1';
const FOOTNOTES_KEY = 'erechnung:footnotes:v1';

const state = {
  items: [],
  pdfFile: null,
  buyers: [],
  footnotes: [],
  outputMode: 'generate', // 'generate' | 'upload'
};

// -------- Helpers --------
const $ = (id) => document.getElementById(id);
// PDF formatter without thousand separators, matching Max's invoice style ("1800,00" not "1.800,00")
const fmtPDF = (n) => {
  const v = Math.round(n * 100) / 100;
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  const int = Math.floor(abs);
  const dec = Math.round((abs - int) * 100);
  return `${sign}${int},${String(dec).padStart(2, '0')}`;
};
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
    f_filename_pattern: 'Dateiname-Muster',
    // Footer
    footer_main: 'Format: ZUGFeRD 2.3 / Factur-X 1.0 · Profil: EN 16931 (Comfort) · Konform mit §14 UStG und deutscher E-Rechnungspflicht seit 2025. XML nach BT-Nummern der EN 16931. Validierung z.B. mit Quba-Viewer, Mustang oder ELSTER E-Rechnungsviewer.',
    footer_disclaimer: 'Kostenloses Tool, gevibecoded. Keine Gewähr für Richtigkeit, Vollständigkeit oder rechtliche Konformität der erzeugten Dokumente. Nutzung auf eigene Verantwortung. Keine Haftung für entgangenen Gewinn, Schäden oder Folgeschäden aus der Nutzung. Vor produktivem Einsatz unbedingt mit einem zugelassenen Validator prüfen und im Zweifel steuerlich beraten lassen.',
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
    // XML / legal notes
    rc_note: 'Steuerschuldnerschaft des Leistungsempfängers. Reverse charge nach Art. 196 Richtlinie 2006/112/EG.',
    rc_note_Z: 'Steuersatz 0%.',
    rc_note_E: 'Umsatzsteuerbefreit.',
    rc_note_O: 'Nicht im Anwendungsbereich der Umsatzsteuer.',
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
    f_filename_pattern: 'Filename pattern',
    footer_main: 'Format: ZUGFeRD 2.3 / Factur-X 1.0 · Profile: EN 16931 (Comfort) · Compliant with German e-invoicing law (§14 UStG, in force since 2025). XML follows EN 16931 BT numbering. Validate e.g. with Quba Viewer, Mustang, or ELSTER E-Rechnungsviewer.',
    footer_disclaimer: 'Free, vibe-coded tool. No warranty for correctness, completeness or legal compliance of generated documents. Use at your own risk. No liability for lost profit, damages or consequential damages from use. Always validate with a certified validator before production use, and consult a tax advisor when in doubt.',
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
    rc_note: 'Reverse charge: recipient liable for VAT under Art. 196 of Council Directive 2006/112/EC.',
    rc_note_Z: 'VAT 0%.',
    rc_note_E: 'VAT exempt.',
    rc_note_O: 'Out of scope of VAT.',
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
    f_filename_pattern: 'Modèle de nom de fichier',
    footer_main: 'Format : ZUGFeRD 2.3 / Factur-X 1.0 · Profil : EN 16931 (Comfort) · Conforme à la loi allemande sur la facture électronique (§14 UStG, en vigueur depuis 2025). XML suivant la numérotation BT de la EN 16931. Validation possible avec Quba Viewer, Mustang ou ELSTER E-Rechnungsviewer.',
    footer_disclaimer: 'Outil gratuit, vibecodé. Aucune garantie sur l\'exactitude, l\'exhaustivité ou la conformité légale des documents générés. Utilisation à vos propres risques. Aucune responsabilité pour pertes de profit, dommages ou dommages consécutifs résultant de l\'utilisation. Avant toute utilisation en production, valider avec un validateur certifié et consulter un conseiller fiscal en cas de doute.',
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
    rc_note: 'Autoliquidation : TVA due par le preneur conformément à l\'art. 196 de la directive 2006/112/CE.',
    rc_note_Z: 'TVA 0%.',
    rc_note_E: 'Exonéré de TVA.',
    rc_note_O: 'Hors champ d\'application de la TVA.',
  },
};

const LANG_KEY = 'erechnung:lang';
const INVOICE_LANG_KEY = 'erechnung:invoice_lang';
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
  if (typeof renderItems === 'function') renderItems();
  if (typeof updateFilenamePreview === 'function') updateFilenamePreview();
  // re-apply theme so its title gets re-translated
  if (typeof applyTheme === 'function') applyTheme(localStorage.getItem('erechnung:theme'));
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
  if (ok1 && ok2) flash(t('msg_seller_saved'), 'ok');
  else flash(t('msg_save_failed'), 'err');
}
async function clearSeller() {
  await store.del(STORAGE_KEY);
  await store.del(BOILERPLATE_KEY);
  ['s_name','s_line1','s_zip','s_city','s_country','s_vat','s_siret','s_email','s_phone','s_iban','s_bic','s_bank',
   'r_intro','r_payment_note','r_greeting','r_signature','r_footnote']
    .forEach(id => $(id).value = id === 's_country' ? 'DE' : '');
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
  } catch (_) {}
  if (bMap[lang]) {
    applyBoilerplate(bMap[lang]);
  } else {
    // No saved boilerplate for this language → clear the boilerplate fields
    applyBoilerplate({});
  }
}

// Save current boilerplate field state back to its language bucket
// (used during language switch so unsaved edits aren't lost between switches).
async function persistCurrentBoilerplateInMemory(lang) {
  // Note: This intentionally does NOT save to storage — only used
  // implicitly by saveSeller(). The user must hit "save as template"
  // to persist boilerplate per language.
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

// -------- Items --------
function addItem(data = {}) {
  const item = {
    id: Math.random().toString(36).slice(2, 9),
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
      <div class="cell desc" data-label="Beschreibung">
        <input type="text" data-k="desc" value="${esc(it.desc)}" placeholder="${esc(t('item_placeholder'))}">
      </div>
      <div class="cell num" data-label="Menge">
        <input type="number" step="0.01" data-k="qty" value="${it.qty}">
      </div>
      <div class="cell num" data-label="Einzelpreis">
        <input type="number" step="0.01" data-k="price" value="${it.price}">
      </div>
      <div class="cell num" data-label="MwSt %">
        <input type="number" step="0.1" data-k="vat" value="${it.vat}">
      </div>
      <div class="cell">
        <button class="remove" data-remove aria-label="entfernen">×</button>
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

// -------- XML generation (Factur-X EN 16931 / Comfort) --------
function buildXML() {
  const seller = collectSeller();
  const buyer = {
    name: $('b_name').value.trim(),
    line1: $('b_line1').value.trim(),
    zip: $('b_zip').value.trim(),
    city: $('b_city').value.trim(),
    country: $('b_country').value.trim().toUpperCase(),
    vat: $('b_vat').value.trim(),
    reference: $('b_reference').value.trim(),
  };
  const number = $('r_number').value.trim();
  const date = $('r_date').value;
  const delivery = $('r_delivery').value || date;
  const deliveryEnd = $('r_delivery_end').value;
  const due = $('r_due').value;
  const currency = $('r_currency').value;
  const mode = $('r_taxmode').value;
  const note = $('r_note').value.trim();

  if (!number) throw new Error('Rechnungsnummer fehlt.');
  if (!date) throw new Error('Rechnungsdatum fehlt.');
  if (!seller.name) throw new Error('Verkäufer-Name fehlt.');
  if (!buyer.name) throw new Error('Käufer-Name fehlt.');
  if (state.items.length === 0) throw new Error('Mindestens eine Position erforderlich.');

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

  // -------- Country normalization (ISO 3166-1 alpha-2) --------
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
    throw new Error('Country is required (use ISO code like DE, FR, GB)');
  }
  const key = input.trim().toUpperCase().replace(/\s+/g, ' ').replace(/\.$/, '');
  if (key in COUNTRY_ALIAS_MAP) return COUNTRY_ALIAS_MAP[key];
  // Fall through: any unknown 2-letter uppercase code (e.g. exotic ISO codes)
  if (/^[A-Z]{2}$/.test(key)) return key;
  throw new Error(`Unknown country: "${input}". Use ISO 3166-1 alpha-2 (e.g. DE, FR, GB).`);
}

// Validates business rules that depend on tax categories
function validateInvoiceForReverseCharge(seller, buyer, itemsXML, taxBreakdownXML) {
  const combined = String(itemsXML || '') + String(taxBreakdownXML || '');
  const usesReverseCharge = /<ram:CategoryCode>AE<\/ram:CategoryCode>/.test(combined);
  if (!usesReverseCharge) return;
  // BR-AE-02: Seller side
  if (!seller.vat && !seller.siret) {
    throw new Error('Reverse charge requires a Seller VAT ID (or legal registration / tax representative).');
  }
  // BR-AE-02: Buyer side
  if (!buyer.vat && !buyer.siret) {
    throw new Error('Reverse charge requires a Buyer VAT ID (or legal registration ID).');
  }
}

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
        <ram:Information>SEPA-Überweisung</ram:Information>
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
        <ram:Description>Zahlbar bis ${esc(due)}</ram:Description>
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

// Simple country code to name mapping for common cases
export function countryName(code) {
  const map = {
    DE: 'Germany', FR: 'France', AT: 'Austria', CH: 'Switzerland',
    IT: 'Italy', ES: 'Spain', NL: 'Netherlands', BE: 'Belgium',
    GB: 'United Kingdom', US: 'United States', LU: 'Luxembourg',
    DK: 'Denmark', SE: 'Sweden', NO: 'Norway', FI: 'Finland',
    PL: 'Poland', CZ: 'Czech Republic', PT: 'Portugal', IE: 'Ireland',
  };
  return map[code?.toUpperCase()] || code;
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
    let pdfDoc;
    const outName = resolveFilenamePattern($('r_filename').value) + '.pdf';

    if (state.outputMode === 'upload') {
      if (!state.pdfFile) throw new Error(t('msg_pdf_select_first'));
      const pdfBytes = await state.pdfFile.arrayBuffer();
      pdfDoc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
    } else {
      pdfDoc = await generateInvoicePDF();
    }

    await embedFacturXIntoPDF(pdfDoc, xml);

    setPDFTrailerID(pdfDoc);

    const outBytes = await pdfDoc.save({ useObjectStreams: false });
    const blob = new Blob([outBytes], { type: 'application/pdf' });
    downloadBlob(blob, outName);
    // Record this invoice number so the next suggestion increments correctly
    await recordInvoiceNumber($('r_number').value);
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
    version: 2,
    exported_at: new Date().toISOString(),
    seller: sellerJSON ? JSON.parse(sellerJSON) : null,
    boilerplate: boilerplateJSON ? JSON.parse(boilerplateJSON) : {},
    buyers: buyersJSON ? JSON.parse(buyersJSON) : [],
    footnotes: footnotesJSON ? JSON.parse(footnotesJSON) : [],
    last_invoice: lastInvoice || null,
    filename_pattern: filenamePattern || null,
    font: fontKey || null,
    layout: layoutKey || null,
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
    flash(`${t('msg_backup_import_done')} ${sellerCount} ${t('msg_backup_seller')}, ${buyerCount} ${t('msg_backup_buyers')}, ${footnoteCount} ${t('msg_backup_footnotes')}.`, 'ok');
  } catch (e) {
    flash(t('msg_backup_failed') + ' ' + e.message, 'err');
  }
}

// -------- Init --------
document.getElementById('addItem').addEventListener('click', () => addItem());
document.getElementById('saveSeller').addEventListener('click', saveSeller);
document.getElementById('clearSeller').addEventListener('click', clearSeller);
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
});
$('saveBuyer').addEventListener('click', saveBuyer);
$('deleteBuyer').addEventListener('click', deleteBuyer);

$('clearDeliveryEnd').addEventListener('click', () => {
  $('r_delivery_end').value = '';
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

// Mode toggle
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.mode;
    state.outputMode = mode;
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b === btn));
    $('mode-generate').style.display = mode === 'generate' ? '' : 'none';
    $('mode-upload').style.display = mode === 'upload' ? '' : 'none';
  });
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
const THEME_KEY = 'erechnung:theme';
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
applyTheme(localStorage.getItem(THEME_KEY));

// Language switcher
$('langSelect').value = CURRENT_LANG;
$('langSelect').addEventListener('change', (e) => setLang(e.target.value));

// Invoice output language — independent of UI
$('invoiceLangSelect').value = INVOICE_LANG || '';
$('invoiceLangSelect').addEventListener('change', (e) => setInvoiceLang(e.target.value));

// Invoice font selector
(async () => {
  $('invoiceFontSelect').value = await getCurrentFontKey();
})();
$('invoiceFontSelect').addEventListener('change', async (e) => {
  await store.set(FONT_KEY, e.target.value);
});

// Invoice layout selector — populated from LAYOUTS map at runtime
(async () => {
  const sel = $('invoiceLayoutSelect');
  sel.innerHTML = Object.entries(LAYOUTS)
    .map(([k, v]) => `<option value="${esc(k)}">${esc(v.label)}</option>`)
    .join('');
  sel.value = await getCurrentLayout();
})();
$('invoiceLayoutSelect').addEventListener('change', async (e) => {
  await store.set(LAYOUT_KEY, e.target.value);
});
applyTranslations();

// default date = today
$('r_date').value = new Date().toISOString().slice(0, 10);

// seed with one item
addItem({ desc: '', qty: 1, price: 0, vat: 20 });

loadSeller();
loadBuyers();
loadFootnotes();
loadFilenamePattern();
updateSuggestNumberChipPreview();
// Auto-fill invoice number on load if empty
applyNextInvoiceNumber().then(() => updateFilenamePreview());
