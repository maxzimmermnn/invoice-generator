import { rgb } from 'pdf-lib';
import { fmt, round2 } from './utils.js';
import { makeDrawKit, countryName } from './main.js';


export const DEFAULT_LAYOUT = 'modern';
export const LAYOUTS = {
  modern:  { label: 'Modern',            render: renderInvoiceModern },
  din5008: { label: 'DIN 5008 (German)', render: renderInvoiceDIN5008 },
};


//INVOICE DIN 5008 (GERMAN STANDARD)

async function renderInvoiceDIN5008(pdfDoc, ctx) {
  const kit = makeDrawKit(pdfDoc, ctx.fonts);
  const { mono, monoBold, INK, SOFT, PAGE_W, PAGE_H,
          widthAt, wrapText, drawText, drawTextRight, drawTextCenter, drawRule } = kit;
  const { seller, buyer, items, totals, mode, number, date, delivery, deliveryEnd, due,
          currency, currencySym, project, category, intro, paymentNote, greeting,
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
  let senderSize = SIZE_SMALL;
  while (widthAt(senderMini, mono, senderSize) > mm(85) && senderSize > 5.5) senderSize -= 0.25;
  drawText(senderMini, M_L, senderLineY, mono, senderSize, SOFT);
  drawRule(senderLineY - 2, 0.3, M_L, M_L + mm(85));

  // === Recipient block (DIN 5008 Form B: starts at 50mm from top, max 9 lines) ===
  let y = PAGE_H - mm(52);
  if (buyer.name)  { drawText(buyer.name,  M_L, y, mono, SIZE); y -= LINE; }
  if (buyer.line1) { drawText(buyer.line1, M_L, y, mono, SIZE); y -= LINE; }
  if (buyer.zip || buyer.city) { drawText(`${buyer.zip || ''} ${buyer.city || ''}`.trim(), M_L, y, mono, SIZE); y -= LINE; }
  if (buyer.country && buyer.country !== seller.country) { drawText(cn(buyer.country).toUpperCase(), M_L, y, mono, SIZE); y -= LINE; }

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
  if (seller.vat) drawInfo('USt-IdNr.', seller.vat);

  // === Subject line at fixed position (98mm from top) ===
  y = PAGE_H - mm(98);
  const subject = project
    ? (number ? `${tI('pdf_no')} ${number}: ${project}` : project)
    : (number ? `${tI('pdf_no')} ${number}` : 'Rechnung');
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
  drawText(tI('th_desc') || 'Beschreibung', descX, y, mono, SIZE, SOFT);
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
  drawRule(y, 0.4, M_L + mm(80), colRight);
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
  // Divider sits ABOVE the grand total line (y is currently the next-line baseline)
  drawRule(y + LINE * 0.7, 0.4, M_L + mm(80), colRight);
  y -= LINE * 0.4;
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
  const col2 = [seller.phone, seller.email, seller.vat ? `USt-IdNr.: ${seller.vat}` : '', seller.siret ? `SIRET: ${seller.siret}` : ''].filter(Boolean);
  const col3 = [seller.bank, seller.iban ? `IBAN: ${seller.iban.replace(/(.{4})/g, '$1 ').trim()}` : '', seller.bic ? `BIC: ${seller.bic}` : ''].filter(Boolean);
  const drawCol = (lines, x) => {
    let yy = footY + LINE * 0.8;
    for (const ln of lines) {
      // Per-line auto-shrink so long emails / addresses don't overflow into next column
      let s = SIZE_SMALL;
      while (widthAt(ln, mono, s) > colW - mm(4) && s > 5.5) s -= 0.25;
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
  const { mono, monoBold, INK, SOFT, PAGE_W, PAGE_H,
          widthAt, wrapText, drawText, drawTextRight, drawTextCenter, drawRule } = kit;
  const { seller, buyer, items, totals, mode, number, date, delivery, deliveryEnd, due,
          currency, currencySym, project, category, intro, paymentNote, greeting,
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
  drawText('INVOICE', M_L, y, monoBold, SIZE_LABEL, SOFT);
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

  const buyerLines = [
    buyer.line1,
    `${buyer.zip || ''} ${buyer.city || ''}`.trim(),
    buyer.country ? cn(buyer.country) : '',
    buyer.vat ? `VAT ${buyer.vat}` : '',
    buyer.siret ? `SIRET ${buyer.siret}` : '',
    buyer.reference ? `Ref ${buyer.reference}` : '',
  ].filter(Boolean);
  const sellerLines = [
    seller.line1,
    `${seller.zip || ''} ${seller.city || ''}`.trim(),
    seller.country ? cn(seller.country) : '',
    seller.email,
    seller.phone,
    seller.vat ? `VAT ${seller.vat}` : '',
    seller.siret ? `SIRET ${seller.siret}` : '',
  ].filter(Boolean);
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

  drawText(tI('th_desc') || 'Description',     M_L,          y, monoBold, SIZE_LABEL, SOFT);
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
  drawText('VAT', labelX, y, monoBold, SIZE_LABEL, SOFT);
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
    drawText(tI('pdf_payment') || 'PAYMENT', M_L, y, monoBold, SIZE_LABEL, SOFT);
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
  const bankParts = [
    seller.name,
    seller.bank,
    seller.iban ? `IBAN ${seller.iban.replace(/(.{4})/g, '$1 ').trim()}` : '',
    seller.bic ? `BIC ${seller.bic}` : '',
  ].filter(Boolean);
  const bankLine = bankParts.join('  \u00b7  ');
  let bankSize = SIZE_TINY;
  while (widthAt(bankLine, mono, bankSize) > contentW && bankSize > 5) bankSize -= 0.25;
  drawTextCenter(bankLine, footY, mono, bankSize, SOFT);
}
