import { fmt, round2 } from './utils.js';
import { makeDrawKit } from './main.js';


export const DEFAULT_LAYOUT = 'modern';
export const LAYOUTS = {
  modern:     { label: 'Modern',            render: renderInvoiceModern },
  din5008:    { label: 'DIN 5008 (German)', render: renderInvoiceDIN5008 },
  typewriter: { label: 'Typewriter',        render: renderInvoiceTypewriter },
};


// -------- Shared layout helpers --------

// Auto-shrink a font size until `text` fits within `maxWidth`. Returns the
// largest size in [min, start] (stepping down by `step`) that fits, or `min`
// if even that doesn't. Used for sender mini-lines and footer bank lines.
function shrinkToFit(text, font, maxWidth, widthAt, start, min = 5, step = 0.25) {
  let size = start;
  while (widthAt(text, font, size) > maxWidth && size > min) size -= step;
  return size;
}

// Format a party (seller or buyer) into an array of address lines for display.
// Empty fields drop out. `cn` resolves ISO country codes to a human name.
// Field order is canonical across Modern and Typewriter:
//   line1, zip+city, country, [email, phone], VAT, SIRET, [reference]
// DIN 5008 doesn't use this — it has its own postal-format address block.
function formatPartyAddress(p, cn, { includeContact = false, includeReference = false } = {}) {
  return [
    p.line1,
    `${p.zip || ''} ${p.city || ''}`.trim(),
    p.country ? cn(p.country) : '',
    includeContact ? p.email : '',
    includeContact ? p.phone : '',
    p.vat ? `VAT: ${p.vat}` : '',
    p.siret ? `SIRET: ${p.siret}` : '',
    includeReference && p.reference ? `Ref: ${p.reference}` : '',
  ].filter(Boolean);
}

// Draw a centered single-line bank/contact footer that auto-shrinks to fit.
// Used by Modern and Typewriter; DIN 5008 has its own 3-column footer.
// Default separator is a mid-dot for clean typography across both layouts;
// override `separator` in opts if a layout wants something different.
function drawCenteredBankLine(seller, kit, { y, font, maxWidth, separator = '  \u00b7  ', startSize, minSize, color }) {
  const { drawTextCenter, widthAt } = kit;
  const parts = [
    seller.name,
    seller.bank,
    seller.iban ? `IBAN: ${seller.iban.replace(/(.{4})/g, '$1 ').trim()}` : '',
    seller.bic ? `BIC: ${seller.bic}` : '',
  ].filter(Boolean);
  const line = parts.join(separator);
  const size = shrinkToFit(line, font, maxWidth, widthAt, startSize, minSize);
  drawTextCenter(line, y, font, size, color);
}


//INVOICE DIN 5008 (GERMAN STANDARD)

async function renderInvoiceDIN5008(pdfDoc, ctx) {
  const kit = makeDrawKit(pdfDoc, ctx.fonts);
  const { mono, monoBold, SOFT, PAGE_W, PAGE_H,
          widthAt, wrapText, drawText, drawTextRight, drawTextCenter, drawRule } = kit;
  const { seller, buyer, items, totals, mode, number, date, delivery, deliveryEnd,
          currencySym, project, category, intro, paymentNote, greeting,
          signature, footnote, fmtDate, fmtMoney, countryName: cn, tInvoice: tI } = ctx;

  // DIN 5008 Form B measurements (mm → pt at 72dpi: mm * 2.8346)
  const mm = (n) => n * 2.83464567;
  const M_L = mm(25);                  // left margin
  const M_R = mm(20);                  // right margin
  const colRight = PAGE_W - M_R;
  const contentW = PAGE_W - M_L - M_R;

  const SIZE = 10.5;
  const SIZE_SMALL = 8;
  const SIZE_TITLE = 13;
  const LINE = 13;
  const LINE_TIGHT = 11;

  // === Sender mini-line (visible above recipient through window envelope) ===
  // DIN 5008 places this at 45mm from top, single line, small font, underlined.
  const senderLineY = PAGE_H - mm(45);
  const senderMini = [seller.name, seller.line1, `${seller.zip || ''} ${seller.city || ''}`.trim()]
    .filter(Boolean).join(' · ');
  // Auto-shrink sender mini-line if it would overflow the underline width
  const senderSize = shrinkToFit(senderMini, mono, mm(85), widthAt, SIZE_SMALL, 5.5);
  drawText(senderMini, M_L, senderLineY, mono, senderSize, SOFT);
  drawRule(senderLineY - 2, 0.3, M_L, M_L + mm(85));

  // === Recipient block (DIN 5008 Form B: starts at 50mm from top, max 9 lines) ===
  // Country printed UPPERCASE only when buyer is in a different country than seller (postal convention).
  const recipientLines = [
    buyer.name,
    buyer.line1,
    `${buyer.zip || ''} ${buyer.city || ''}`.trim(),
    (buyer.country && buyer.country !== seller.country) ? cn(buyer.country).toUpperCase() : '',
  ].filter(Boolean);
  let y = PAGE_H - mm(52);
  for (const ln of recipientLines) { drawText(ln, M_L, y, mono, SIZE); y -= LINE; }

  // === Info block on the right side (reference fields) ===
  // DIN 5008 places this aligned with the recipient block, in two columns.
  const infoLabelX = M_L + mm(110);
  const infoValueX = M_L + mm(125);
  let infoY = PAGE_H - mm(52);
  const infoLabelSize = SIZE_SMALL;
  const drawInfo = (label, value) => {
    if (!value) return;
    drawText(label, infoLabelX, infoY, mono, infoLabelSize, SOFT);
    drawText(value, infoValueX, infoY, mono, SIZE);
    infoY -= LINE;
  };
  drawInfo(tI('pdf_no'),   number);
  drawInfo(tI('pdf_date'), fmtDate(date));
  if (delivery) {
    const svc = deliveryEnd && deliveryEnd !== delivery
      ? `${fmtDate(delivery)} \u2013 ${fmtDate(deliveryEnd)}` : fmtDate(delivery);
    drawInfo(tI('pdf_service'), svc);
  }
  if (seller.vat) drawInfo(tI('pdf_vat_id_label'), seller.vat);

  // === Subject line at fixed position (98mm from top) ===
  y = PAGE_H - mm(98);
  const subject = project
    ? (number ? `${tI('pdf_no')} ${number}: ${project}` : project)
    : (number ? `${tI('pdf_no')} ${number}` : tI('pdf_invoice_label'));
  for (const ln of wrapText(subject, monoBold, SIZE_TITLE, contentW)) {
    drawText(ln, M_L, y, monoBold, SIZE_TITLE); y -= LINE * 1.4;
  }
  y -= LINE * 0.5;

  // === Body: intro, items table, totals, VAT, footnote, payment note, greeting ===
  if (intro) {
    for (const ln of wrapText(intro, mono, 9, contentW)) { drawText(ln, M_L, y, mono, 9); y -= LINE * 0.85; }
    y -= LINE * 2;
  }
  if (category) { drawText(category, M_L, y, monoBold, SIZE); y -= LINE * 1.4; }

  // Items table — DIN 5008 typical: pos | desc | qty | price | total
  const cPosRight    = M_L + mm(10);
  const cTotalRight  = colRight;
  const cAmountRight = colRight - mm(28);
  const cPriceRight  = colRight - mm(56);
  const descX        = cPosRight + mm(4);

  drawText('Pos.', M_L, y, mono, SIZE, SOFT);
  drawText(tI('th_desc'), descX, y, mono, SIZE, SOFT);
  drawTextRight(tI('pdf_amount'), cAmountRight, y, mono, SIZE, SOFT);
  drawTextRight(tI('pdf_price'),  cPriceRight,  y, mono, SIZE, SOFT);
  drawTextRight(tI('pdf_total'),  cTotalRight,  y, mono, SIZE, SOFT);
  y -= LINE * 0.4;
  drawRule(y, 0.4, M_L, colRight);
  y -= LINE * 1.2;

  let pos = 1;
  for (const it of items) {
    const qty = Number(it.qty) || 0;
    const price = Number(it.price) || 0;
    const lineTotal = round2(qty * price);
    const priceStr = fmtMoney(price);
    const descBudget = cPriceRight - widthAt(priceStr, mono, SIZE) - descX - mm(6);
    const descLines = wrapText(it.desc || '', mono, SIZE, descBudget);
    drawTextRight(String(pos++), cPosRight, y, mono, SIZE, SOFT);
    drawText(descLines[0] || '', descX, y, mono, SIZE);
    drawTextRight(String(qty % 1 === 0 ? qty : fmt(qty)), cAmountRight, y, mono, SIZE);
    drawTextRight(fmtMoney(price), cPriceRight, y, mono, SIZE);
    drawTextRight(fmtMoney(lineTotal), cTotalRight, y, mono, SIZE);
    y -= LINE;
    for (let i = 1; i < descLines.length; i++) { drawText(descLines[i], descX, y, mono, SIZE); y -= LINE; }
  }
  y -= LINE * 0.4;
  drawRule(y, 0.4, M_L, colRight);
  y -= LINE * 1.2;

  // Totals — right-aligned block under the table
  const totalLabelX = cAmountRight - mm(2);
  drawTextRight(tI('pdf_sum') + ':', totalLabelX, y, mono, SIZE);
  drawTextRight(fmtMoney(totals.net), cTotalRight, y, mono, SIZE);
  y -= LINE;
  if (mode === 'S' && totals.tax) {
    drawTextRight(tI('total_tax_S') + ':', totalLabelX, y, mono, SIZE);
    drawTextRight(fmtMoney(totals.tax), cTotalRight, y, mono, SIZE);
    y -= LINE;
  }
  // Divider sits exactly between the Sum/VAT row and the grand-total row,
  // with a full LINE of breathing room on each side.
  drawRule(y, 0.4, M_L + mm(80), colRight);
  y -= LINE;
  drawTextRight(tI('pdf_grand_total') + ':', totalLabelX, y, monoBold, SIZE);
  drawTextRight(fmtMoney(totals.grand), cTotalRight, y, monoBold, SIZE);
  y -= LINE * 2;

  // VAT note
  if (mode !== 'S') {
    drawText(tI('pdf_vat_' + mode), M_L, y, monoBold, SIZE); y -= LINE * 1.4;
  }
  if (footnote) {
    for (const ln of wrapText(footnote, mono, SIZE - 1, contentW)) { drawText(ln, M_L, y, mono, SIZE - 1, SOFT); y -= LINE_TIGHT; }
    y -= LINE * 0.6;
  }
  if (paymentNote) {
    for (const ln of wrapText(paymentNote, mono, SIZE, contentW)) { drawText(ln, M_L, y, mono, SIZE); y -= LINE; }
    y -= LINE * 0.8;
  }
  if (greeting)  { drawText(greeting,  M_L, y, mono, SIZE); y -= LINE * 1.4; }
  if (signature) { drawText(signature, M_L, y, mono, SIZE); y -= LINE; }

  // === Footer (DIN 5008 typically has 3-column footer: company/contact/banking) ===
  const footY = mm(20);
  drawRule(footY + LINE * 1.5, 0.3, M_L, colRight);
  const colW = contentW / 3;
  const col1 = [seller.name, seller.line1, `${seller.zip || ''} ${seller.city || ''}`.trim(), seller.country ? cn(seller.country) : ''].filter(Boolean);
  const col2 = [seller.phone, seller.email, seller.vat ? `${tI('pdf_vat_id_label')}: ${seller.vat}` : '', seller.siret ? `SIRET: ${seller.siret}` : ''].filter(Boolean);
  const col3 = [seller.bank, seller.iban ? `IBAN: ${seller.iban.replace(/(.{4})/g, '$1 ').trim()}` : '', seller.bic ? `BIC: ${seller.bic}` : ''].filter(Boolean);
  const drawCol = (lines, x) => {
    let yy = footY + LINE * 0.8;
    for (const ln of lines) {
      // Per-line auto-shrink so long emails / addresses don't overflow into next column
      const s = shrinkToFit(ln, mono, colW - mm(4), widthAt, SIZE_SMALL, 5.5);
      drawText(ln, x, yy, mono, s, SOFT);
      yy -= LINE_TIGHT * 0.85;
    }
  };
  drawCol(col1, M_L);
  drawCol(col2, M_L + colW);
  drawCol(col3, M_L + colW * 2);
}




//INVOICE MODERN (CLEAN, FLEXIBLE LAYOUT)



async function renderInvoiceModern(pdfDoc, ctx) {
  const kit = makeDrawKit(pdfDoc, ctx.fonts);
  const { mono, monoBold, SOFT, PAGE_W, PAGE_H,
          widthAt, wrapText, drawText, drawTextRight, drawTextCenter, drawRule } = kit;
  const { seller, buyer, items, totals, mode, number, date, delivery, deliveryEnd,
          currencySym, project, category, intro, paymentNote, greeting,
          signature, footnote, fmtDate, fmtMoney, countryName: cn, tInvoice: tI } = ctx;

  const M_L = 56, M_R = 56, M_T = 64, M_B = 56;
  const colRight = PAGE_W - M_R;
  const contentW = PAGE_W - M_L - M_R;

  const SIZE_TINY = 7.5;
  const SIZE_LABEL = 8.5;
  const SIZE_BODY = 10.5;
  const SIZE_HEAD = 16;
  const SIZE_TITLE = 16;
  const LINE = 14;
  const LINE_TIGHT = 12;

  let y = PAGE_H - M_T;

  // Top label + thin rule
  drawText(tI('pdf_invoice_label'), M_L, y, monoBold, SIZE_LABEL, SOFT);
  if (category) drawTextRight(category.toUpperCase(), colRight, y, monoBold, SIZE_LABEL, SOFT);
  y -= LINE * 0.5;
  drawRule(y, 0.4, M_L, colRight);
  y -= LINE * 2.4;

  // Big project headline
  if (project) {
    const projLines = wrapText(project, monoBold, SIZE_TITLE, contentW);
for (const ln of projLines) { drawText(ln, M_L, y, monoBold, SIZE_TITLE); y -= LINE * 1.1; }
    

  } else if (number) {
    drawText(number, M_L, y, monoBold, SIZE_HEAD);
    y -= SIZE_HEAD * 1.15;
    y -= LINE * 0.4;
  }

  // Meta row: small caps labels above values, evenly spaced
  // Limited to 3 slots so long date ranges don't overflow.
  const meta = [];
  if (number)   meta.push([tI('pdf_no'),    number]);
  if (date)     meta.push([tI('pdf_date'),  fmtDate(date)]);
  const svc = deliveryEnd && delivery && deliveryEnd !== delivery
    ? `${fmtDate(delivery)} \u2013 ${fmtDate(deliveryEnd)}`
    : (delivery ? fmtDate(delivery) : '');
  if (svc)      meta.push([tI('pdf_service'), svc]);
  // (Due date appears in the payment note section below; keeping it out of the
  // meta row prevents overflow when the service date is a range.)

  if (meta.length) {
    const slotW = contentW / meta.length;
    const yL = y;
    const yV = y - LINE * 1.05;
    for (let i = 0; i < meta.length; i++) {
      const [lbl, val] = meta[i];
      const x = M_L + i * slotW;
      drawText(lbl, x, yL, monoBold, SIZE_LABEL, SOFT);
      drawText(val, x, yV, mono, SIZE_BODY);
    }
    y = yV - LINE * 2.6;
  }

  // Two-column address block
  const colL = M_L;
  const colR = M_L + contentW * 0.55;
  drawText(tI('pdf_billed_to'), colL, y, monoBold, SIZE_LABEL, SOFT);
  drawText(tI('pdf_from'),      colR, y, monoBold, SIZE_LABEL, SOFT);
  y -= LINE * 1.2;

  let yL2 = y, yR2 = y;
  if (buyer.name)  { drawText(buyer.name,  colL, yL2, monoBold, SIZE_BODY); yL2 -= LINE; }
  if (seller.name) { drawText(seller.name, colR, yR2, monoBold, SIZE_BODY); yR2 -= LINE; }

  const buyerLines  = formatPartyAddress(buyer,  cn, { includeReference: true });
  const sellerLines = formatPartyAddress(seller, cn, { includeContact: true });
  // Wrap long address lines so they don't bleed into the next column / off the page
  const buyerColW  = contentW * 0.55 - 12;
  const sellerColW = contentW * 0.45 - 12;
  for (const ln of buyerLines)  {
    for (const w of wrapText(ln, mono, SIZE_BODY, buyerColW)) {
      drawText(w, colL, yL2, mono, SIZE_BODY, SOFT); yL2 -= LINE_TIGHT;
    }
  }
  for (const ln of sellerLines) {
    for (const w of wrapText(ln, mono, SIZE_BODY, sellerColW)) {
      drawText(w, colR, yR2, mono, SIZE_BODY, SOFT); yR2 -= LINE_TIGHT;
    }
  }
  y = Math.min(yL2, yR2) - LINE * 1.6;

  // Intro
  if (intro) {
    for (const ln of wrapText(intro, mono, 9, contentW)) { drawText(ln, M_L, y, mono, 9); y -= LINE * 0.85; }
    y -= LINE * 2;
  }

  // Items table — minimal hairlines
  const cTotalRight  = colRight;
  const cAmountRight = M_L + contentW * 0.62;
  const cPriceRight  = M_L + contentW * 0.82;

  drawText(tI('th_desc'),     M_L,          y, monoBold, SIZE_LABEL, SOFT);
  drawTextRight(tI('pdf_amount'), cAmountRight, y, monoBold, SIZE_LABEL, SOFT);
  drawTextRight(tI('pdf_price'),  cPriceRight,  y, monoBold, SIZE_LABEL, SOFT);
  drawTextRight(tI('pdf_total'),  cTotalRight,  y, monoBold, SIZE_LABEL, SOFT);
  y -= LINE * 0.5;
  drawRule(y, 0.4, M_L, colRight);
  y -= LINE * 1.2;

  for (const it of items) {
    const qty = Number(it.qty) || 0;
    const price = Number(it.price) || 0;
    const lineTotal = round2(qty * price);
    const descLines = wrapText(it.desc || '', mono, SIZE_BODY, cAmountRight - M_L - 16);
    drawText(descLines[0] || '', M_L, y, mono, SIZE_BODY);
    drawTextRight(String(qty % 1 === 0 ? qty : fmt(qty)), cAmountRight, y, mono, SIZE_BODY);
    drawTextRight(fmtMoney(price), cPriceRight, y, mono, SIZE_BODY);
    drawTextRight(fmtMoney(lineTotal), cTotalRight, y, mono, SIZE_BODY);
    y -= LINE;
    for (let i = 1; i < descLines.length; i++) { drawText(descLines[i], M_L, y, mono, SIZE_BODY, SOFT); y -= LINE; }
  }
  y -= LINE * 0.4;
  drawRule(y, 0.4, M_L, colRight);
  y -= LINE * 1.4;

  // Totals — right-aligned block, big grand total
  const labelX = M_L + contentW * 0.55;
  const valueXRight = colRight;
  drawText(tI('pdf_sum').toUpperCase(), labelX, y, monoBold, SIZE_LABEL, SOFT);
  drawTextRight(fmtMoney(totals.net), valueXRight, y, mono, SIZE_BODY);
  y -= LINE * 1.1;
  drawText(tI('total_tax_S'), labelX, y, monoBold, SIZE_LABEL, SOFT);
  if (mode === 'S' && totals.tax) {
    drawTextRight(fmtMoney(totals.tax), valueXRight, y, mono, SIZE_BODY);
  } else {
    const vatNote = (tI('pdf_vat_' + mode) || '').replace(/^[^:]+:\s*/, '');
    drawTextRight(vatNote, valueXRight, y, mono, SIZE_BODY - 1, SOFT);
  }
  y -= LINE * 1.8;
  drawRule(y + LINE * 0.7, 0.5, labelX, valueXRight);
  y -= LINE * 0.9;
  drawText(tI('pdf_grand_total').toUpperCase(), labelX, y, monoBold, SIZE_LABEL, SOFT);
  drawTextRight(fmtMoney(totals.grand), valueXRight, y - LINE * 0.4, monoBold, SIZE_TITLE);
  y -= LINE * 2.6;

  // Footnote (small, soft)
  if (footnote) {
    for (const ln of wrapText(footnote, mono, SIZE_BODY - 1.5, contentW)) {
      drawText(ln, M_L, y, mono, SIZE_BODY - 1.5, SOFT); y -= LINE_TIGHT;
    }
    y -= LINE * 0.6;
  }

  // Payment block
  if (paymentNote) {
    drawText(tI('pdf_payment'), M_L, y, monoBold, SIZE_LABEL, SOFT);
    y -= LINE;
    for (const ln of wrapText(paymentNote, mono, SIZE_BODY, contentW)) {
      drawText(ln, M_L, y, mono, SIZE_BODY); y -= LINE;
    }
    y -= LINE * 0.4;
  }
  if (greeting)  { drawText(greeting,  M_L, y, mono, SIZE_BODY); y -= LINE; }
  if (signature) { drawText(signature, M_L, y, monoBold, SIZE_BODY); y -= LINE; }

  // Footer — subtle single-line bank info
  const footY = M_B;
  drawRule(footY + LINE * 1.2, 0.3, M_L, colRight);
  drawCenteredBankLine(seller, kit, {
    y: footY,
    font: mono,
    maxWidth: contentW,
    startSize: SIZE_TINY,
    minSize: 5,
    color: SOFT,
  });
}



//INVOICE TYPEWRITER (CENTERED, MONOSPACE-FORWARD)


async function renderInvoiceTypewriter(pdfDoc, ctx) {
  const kit = makeDrawKit(pdfDoc, ctx.fonts);
  const { mono, monoBold, SOFT, PAGE_W, PAGE_H,
          widthAt, wrapText, drawText, drawTextRight, drawTextCenter, drawRule } = kit;

  const { seller, buyer, items, totals, mode, number, date, delivery, deliveryEnd,
          currencySym, project, category, intro, paymentNote, greeting,
          signature, footnote, fmtDate, fmtMoney, countryName: cn, tInvoice: tI } = ctx;

  const M_L = 70, M_R = 70, M_T = 72, M_B = 56;
  const colRight = PAGE_W - M_R;
  const contentW = PAGE_W - M_L - M_R;
  const SIZE_BODY = 10.5;
  const SIZE_TITLE = 16;
  const LINE_H = 14;
  const LINE_TIGHT = 12;
  const LABEL_SIZE = 8;
  const RULE_NAME_GAP = 14;

  let y = PAGE_H - M_T;
  const topY = y;

  function drawLabel(text, x, yy, align = 'left') {
    if (align === 'right') drawTextRight(text, x, yy, monoBold, LABEL_SIZE, SOFT);
    else drawText(text, x, yy, monoBold, LABEL_SIZE, SOFT);
  }

  // Build address arrays (name rendered separately as anchor)
  const buyerAddr  = formatPartyAddress(buyer,  cn, { includeReference: true });
  const sellerAddr = formatPartyAddress(seller, cn, { includeContact: true });

  const colBuyerX = M_L;
  const colSellerX = colRight;

  drawLabel(tI('pdf_billed_to'), colBuyerX, topY);
  drawLabel(tI('pdf_from'), colSellerX, topY, 'right');

  let yBuyer = topY - RULE_NAME_GAP;
  let ySeller = topY - RULE_NAME_GAP;
  if (buyer.name) { drawText(buyer.name, colBuyerX, yBuyer, monoBold, SIZE_BODY); yBuyer -= LINE_H; }
  if (seller.name) { drawTextRight(seller.name, colSellerX, ySeller, monoBold, SIZE_BODY); ySeller -= LINE_H; }
  for (const ln of buyerAddr)  { drawText(ln, colBuyerX, yBuyer, mono, SIZE_BODY); yBuyer -= LINE_TIGHT; }
  for (const ln of sellerAddr) { drawTextRight(ln, colSellerX, ySeller, mono, SIZE_BODY); ySeller -= LINE_TIGHT; }

  const headerBottom = Math.min(yBuyer, ySeller) - 14;
  drawRule(headerBottom, 0.4, M_L, colRight);

  // Meta row: NO. / DATE / SERVICE
  const serviceText = deliveryEnd && delivery && deliveryEnd !== delivery
    ? `${fmtDate(delivery)} \u2013 ${fmtDate(deliveryEnd)}`
    : (delivery ? fmtDate(delivery) : '');
  const metaRow = [];
  if (number) metaRow.push([tI('pdf_no'), number]);
  if (date) metaRow.push([tI('pdf_date'), fmtDate(date)]);
  if (serviceText) metaRow.push([tI('pdf_service'), serviceText]);

  const metaY = headerBottom - LINE_H * 1.6;
  if (metaRow.length > 0) {
    const slotWidth = contentW / metaRow.length;
    for (let i = 0; i < metaRow.length; i++) {
      const [lbl, val] = metaRow[i];
      const slotX = M_L + i * slotWidth;
      drawText(lbl, slotX, metaY, monoBold, LABEL_SIZE, SOFT);
      drawText(val, slotX, metaY - LINE_H, mono, SIZE_BODY);
    }
  }
  y = metaY - LINE_H * 3.4;

  // Project title
  if (project) {
    const projLines = wrapText(project, monoBold, SIZE_TITLE, contentW);
    for (const ln of projLines) { drawText(ln, M_L, y, monoBold, SIZE_TITLE); y -= LINE_H * 1.4; }
    y -= LINE_H * 0.6;
  }
  // Intro
  if (intro) {
    for (const ln of wrapText(intro, mono, 9, contentW)) { drawText(ln, M_L, y, mono, 9); y -= LINE_H * 0.85; }
    y -= LINE_H * 0.8;
  }
  // Category
  if (category) { drawText(category, M_L, y, monoBold, SIZE_BODY); y -= LINE_H * 1.6; } else { y -= LINE_H * 0.5; }

  // Items table
  const cTotalRight = colRight;
  const cAmountRight = M_L + contentW * 0.75;
  const cPriceRight = M_L + contentW * 0.55;

  drawTextRight(tI('pdf_price'),  cPriceRight,  y, mono, SIZE_BODY);
  drawTextRight(tI('pdf_amount'), cAmountRight, y, mono, SIZE_BODY);
  drawTextRight(tI('pdf_total'),  cTotalRight,  y, mono, SIZE_BODY);
  y -= LINE_H * 1.4;

  for (const it of items) {
    const qty = Number(it.qty) || 0;
    const price = Number(it.price) || 0;
    const lineTotal = round2(qty * price);
    const descLines = wrapText(it.desc || '', monoBold, SIZE_BODY,
      cPriceRight - M_L - widthAt(fmtMoney(price), monoBold, SIZE_BODY) - 20);
    drawText(descLines[0] || '', M_L, y, monoBold, SIZE_BODY);
    drawTextRight(fmtMoney(price), cPriceRight, y, monoBold, SIZE_BODY);
    drawTextRight(String(qty % 1 === 0 ? qty : fmt(qty)), cAmountRight, y, monoBold, SIZE_BODY);
    drawTextRight(fmtMoney(lineTotal), cTotalRight, y, monoBold, SIZE_BODY);
    y -= LINE_H;
    for (let i = 1; i < descLines.length; i++) { drawText(descLines[i], M_L, y, mono, SIZE_BODY); y -= LINE_H; }
  }

  drawRule(y, 0.8, M_L, colRight);
  y -= LINE_H * 1.5;

  const sumLabel = tI('pdf_sum');
  drawText(sumLabel, cAmountRight - widthAt(sumLabel, mono, SIZE_BODY), y, mono, SIZE_BODY);
  drawTextRight(fmtMoney(totals.net), cTotalRight, y, mono, SIZE_BODY);
  y -= LINE_H * 1.4;
  const grandLabel = tI('pdf_grand_total');
  drawText(grandLabel, cAmountRight - widthAt(grandLabel, monoBold, SIZE_BODY), y, monoBold, SIZE_BODY);
  drawTextRight(fmtMoney(totals.grand), cTotalRight, y, monoBold, SIZE_BODY);
  y -= LINE_H * 2.2;

  // VAT line
  const vatLabel = mode === 'S' && totals.tax
    ? `${tI('pdf_vat_label')} ${fmt(totals.tax)} ${currencySym} (${tI('pdf_vat_S').replace(/^[^:]+:\s*/, '')})`
    : tI('pdf_vat_' + mode);
  drawText(vatLabel || tI('pdf_vat_label'), M_L, y, monoBold, SIZE_BODY);
  y -= LINE_H * 1.8;

  if (footnote) {
    for (const ln of wrapText(footnote, mono, SIZE_BODY - 1, contentW)) {
      drawText(ln, M_L, y, mono, SIZE_BODY - 1, SOFT); y -= LINE_TIGHT;
    }
    y -= LINE_H * 0.8;
  } else { y -= LINE_H * 0.2; }

  if (paymentNote) {
    for (const ln of wrapText(paymentNote, mono, SIZE_BODY, contentW)) {
      drawText(ln, M_L, y, mono, SIZE_BODY); y -= LINE_H;
    }
    y -= LINE_H * 0.8;
  }
  if (greeting)  { drawText(greeting,  M_L, y, mono, SIZE_BODY); y -= LINE_H; }
  if (signature) { drawText(signature, M_L, y, mono, SIZE_BODY); y -= LINE_H; }

  // Footer: rule + bank line
  const footerY = M_B + LINE_H + 6;
  drawRule(footerY, 0.6, M_L, colRight);
  drawCenteredBankLine(seller, kit, {
    y: M_B,
    font: monoBold,
    maxWidth: contentW,
    startSize: SIZE_BODY,
    minSize: 6,
  });
}