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


// -------- Multi-page support --------
//
// Strategy: pre-compute item heights given the available width, then bucket
// them into pages so a page never starts an item it can't finish. The first
// page reserves more vertical space (header + meta + buyer/seller block);
// continuation pages get a leaner mini-header. The last page must reserve
// space for totals + payment + greeting + signature + footnote.
//
// The renderer calls paginateItems() once up front, then iterates the pages.
// On each page it draws the appropriate header, the table header, the items,
// and on the last page the closing block. Page numbers ("X / Y") render in
// the footer area only when there's more than one page.

// Measure how many vertical units (using `lineH`) an item needs given the
// description column width. Returns at least 1 line.
function measureItemLines(item, font, size, maxWidth, wrapText) {
  const lines = wrapText(item.desc || '', font, size, maxWidth);
  return Math.max(1, lines.length);
}

// Distribute items into page buckets, pixel-based.
//   firstPageBudget — vertical units available for items on page 1
//   midPageBudget   — vertical units available on continuation pages (no
//                     full header, just mini-header + table header)
//   lastPageReserve — vertical units the last page must keep free below
//                     the items for totals + closing block. If items don't
//                     finish before reaching this reserve on the planned
//                     last page, an extra page is added.
//
// Returns: array of { items: [...], indexFrom, indexTo }
function paginateItems(items, lineHeights, firstPageBudget, midPageBudget, lastPageReserve) {
  const pages = [];
  let cursor = 0;
  let pageItems = [];
  let pageHeight = 0;
  let isFirst = true;

  while (cursor < items.length) {
    const budget = isFirst ? firstPageBudget : midPageBudget;
    const itemH = lineHeights[cursor];
    if (pageHeight + itemH <= budget) {
      pageItems.push(items[cursor]);
      pageHeight += itemH;
      cursor++;
    } else if (pageItems.length === 0) {
      // Item doesn't fit even on a fresh page (extreme case): force it on.
      pageItems.push(items[cursor]);
      pageHeight += itemH;
      cursor++;
    } else {
      // Page full, flush and continue.
      pages.push({ items: pageItems, indexFrom: cursor - pageItems.length, indexTo: cursor - 1 });
      pageItems = [];
      pageHeight = 0;
      isFirst = false;
    }
  }
  if (pageItems.length > 0) {
    pages.push({ items: pageItems, indexFrom: cursor - pageItems.length, indexTo: cursor - 1 });
  }

  // Reserve check: does the last page have room for the closing block?
  // If the items on the last page consumed enough of the page that less
  // than `lastPageReserve` remains, we need one more page for the closing.
  // We approximate by saying: if the last page used > (its budget -
  // lastPageReserve), close-block goes to a fresh "tail" page.
  if (pages.length > 0) {
    const last = pages[pages.length - 1];
    const lastIsFirst = pages.length === 1;
    const lastBudget = lastIsFirst ? firstPageBudget : midPageBudget;
    const lastUsed = last.items.reduce((sum, _, i) => sum + lineHeights[last.indexFrom + i], 0);
    if (lastUsed > lastBudget - lastPageReserve) {
      // tail page for closing block only
      pages.push({ items: [], indexFrom: items.length, indexTo: items.length - 1, isTail: true });
    }
  } else {
    // 0 items: still need 1 page for header + closing
    pages.push({ items: [], indexFrom: 0, indexTo: -1 });
  }

  return pages;
}


//INVOICE DIN 5008 (GERMAN STANDARD)

async function renderInvoiceDIN5008(pdfDoc, ctx) {
  const kit = makeDrawKit(pdfDoc, ctx.fonts);
  const { mono, monoBold, SOFT, PAGE_W, PAGE_H,
          widthAt, wrapText, drawText, drawTextRight, drawTextCenter, drawRule, newPage } = kit;
  const { seller, buyer, items, totals, mode, number, date, delivery, deliveryEnd,
          currencySym, project, category, intro, paymentNote, greeting,
          signature, footnote, fmtDate, fmtMoney, countryName: cn, tInvoice: tI } = ctx;

  // DIN 5008 Form B measurements (mm → pt at 72dpi: mm * 2.8346)
  const mm = (n) => n * 2.83464567;
  const M_L = mm(25);
  const M_R = mm(20);
  const colRight = PAGE_W - M_R;
  const contentW = PAGE_W - M_L - M_R;

  const SIZE = 10.5;
  const SIZE_SMALL = 8;
  const SIZE_TITLE = 13;
  const LINE = 13;
  const LINE_TIGHT = 11;

  // Item-table column anchors (used on every page)
  const cPosRight    = M_L + mm(10);
  const cTotalRight  = colRight;
  const cAmountRight = colRight - mm(28);
  const cPriceRight  = colRight - mm(56);
  const descX        = cPosRight + mm(4);

  // ---- Page 1: full DIN 5008 header ----
  // Sender mini-line (visible above recipient through window envelope)
  const senderLineY = PAGE_H - mm(45);
  const senderMini = [seller.name, seller.line1, `${seller.zip || ''} ${seller.city || ''}`.trim()]
    .filter(Boolean).join(' \u00b7 ');
  const senderSize = shrinkToFit(senderMini, mono, mm(85), widthAt, SIZE_SMALL, 5.5);
  drawText(senderMini, M_L, senderLineY, mono, senderSize, SOFT);
  drawRule(senderLineY - 2, 0.3, M_L, M_L + mm(85));

  // Recipient block (Form B: starts at 50mm from top, max 9 lines)
  const recipientLines = [
    buyer.name,
    buyer.line1,
    `${buyer.zip || ''} ${buyer.city || ''}`.trim(),
    (buyer.country && buyer.country !== seller.country) ? cn(buyer.country).toUpperCase() : '',
  ].filter(Boolean);
  let y = PAGE_H - mm(52);
  for (const ln of recipientLines) { drawText(ln, M_L, y, mono, SIZE); y -= LINE; }

  // Info block on the right
  const infoLabelX = M_L + mm(110);
  const infoValueX = M_L + mm(125);
  let infoY = PAGE_H - mm(52);
  const drawInfo = (label, value) => {
    if (!value) return;
    drawText(label, infoLabelX, infoY, mono, SIZE_SMALL, SOFT);
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

  // Subject line at fixed position (98mm from top)
  y = PAGE_H - mm(98);
  const subject = project
    ? (number ? `${tI('pdf_no')} ${number}: ${project}` : project)
    : (number ? `${tI('pdf_no')} ${number}` : tI('pdf_invoice_label'));
  for (const ln of wrapText(subject, monoBold, SIZE_TITLE, contentW)) {
    drawText(ln, M_L, y, monoBold, SIZE_TITLE); y -= LINE * 1.4;
  }
  y -= LINE * 0.5;

  if (intro) {
    for (const ln of wrapText(intro, mono, 9, contentW)) { drawText(ln, M_L, y, mono, 9); y -= LINE * 0.85; }
    y -= LINE * 2;
  }
  if (category) { drawText(category, M_L, y, monoBold, SIZE); y -= LINE * 1.4; }

  // ---- Pagination plan ----
  // Measure each item against the description budget (which depends on the
  // price column width — we use a generous default since prices vary).
  const descBudget = cPriceRight - widthAt('9999.99', mono, SIZE) - descX - mm(6);
  const itemUnits = items.map(it => measureItemLines(it, mono, SIZE, descBudget, wrapText) * LINE);

  // Footer height in DIN5008 is fixed (3-column block at mm(20) + rule above)
  const FOOTER_TOP = mm(20) + LINE * 1.5;     // top of footer rule
  const PAGE_NUM_RESERVE = LINE * 0.7;
  const BOTTOM_LIMIT = FOOTER_TOP + PAGE_NUM_RESERVE;

  const TABLE_HEADER_H = LINE * 1.6;          // label row + rule
  const TABLE_END_RULE = LINE * 1.2;          // closing rule under last item

  const firstPageBudget = (y - BOTTOM_LIMIT) - TABLE_HEADER_H - TABLE_END_RULE;

  // Continuation pages: top is at PAGE_H - mm(30), mini-header takes ~LINE*3
  const MINI_HEADER_TOP = PAGE_H - mm(30);
  const MINI_HEADER_H = LINE * 3.2;
  const midPageBudget = (MINI_HEADER_TOP - BOTTOM_LIMIT) - MINI_HEADER_H - TABLE_HEADER_H - TABLE_END_RULE;

  // Last-page reserve: totals + VAT note + footnote + payment + greeting/signature
  let lastPageReserve = LINE * 5;  // base totals block (sum/vat/grand)
  if (mode !== 'S') lastPageReserve += LINE * 1.4;
  if (footnote)    lastPageReserve += LINE_TIGHT * Math.max(1, wrapText(footnote, mono, SIZE - 1, contentW).length) + LINE * 0.6;
  if (paymentNote) lastPageReserve += LINE * wrapText(paymentNote, mono, SIZE, contentW).length + LINE * 0.8;
  if (greeting)    lastPageReserve += LINE * 1.4;
  if (signature)   lastPageReserve += LINE;

  const pages = paginateItems(items, itemUnits, firstPageBudget, midPageBudget, lastPageReserve);
  const totalPages = pages.length;

  // Helper: draw the items table header (Pos | Desc | Qty | Price | Total)
  function drawTableHeader(yStart) {
    drawText('Pos.', M_L, yStart, mono, SIZE, SOFT);
    drawText(tI('th_desc'), descX, yStart, mono, SIZE, SOFT);
    drawTextRight(tI('pdf_amount'), cAmountRight, yStart, mono, SIZE, SOFT);
    drawTextRight(tI('pdf_price'),  cPriceRight,  yStart, mono, SIZE, SOFT);
    drawTextRight(tI('pdf_total'),  cTotalRight,  yStart, mono, SIZE, SOFT);
    let yy = yStart - LINE * 0.4;
    drawRule(yy, 0.4, M_L, colRight);
    yy -= LINE * 1.2;
    return yy;
  }

  // Helper: draw items, with continuous Pos numbering across pages
  function drawItems(pageItems, yStart, indexFrom) {
    let yy = yStart;
    for (let i = 0; i < pageItems.length; i++) {
      const it = pageItems[i];
      const qty = Number(it.qty) || 0;
      const price = Number(it.price) || 0;
      const lineTotal = round2(qty * price);
      const priceStr = fmtMoney(price);
      const itemDescBudget = cPriceRight - widthAt(priceStr, mono, SIZE) - descX - mm(6);
      const descLines = wrapText(it.desc || '', mono, SIZE, itemDescBudget);
      drawTextRight(String(indexFrom + i + 1), cPosRight, yy, mono, SIZE, SOFT);
      drawText(descLines[0] || '', descX, yy, mono, SIZE);
      drawTextRight(String(qty % 1 === 0 ? qty : fmt(qty)), cAmountRight, yy, mono, SIZE);
      drawTextRight(fmtMoney(price), cPriceRight, yy, mono, SIZE);
      drawTextRight(fmtMoney(lineTotal), cTotalRight, yy, mono, SIZE);
      yy -= LINE;
      for (let j = 1; j < descLines.length; j++) {
        drawText(descLines[j], descX, yy, mono, SIZE);
        yy -= LINE;
      }
    }
    return yy;
  }

  // Helper: draw the 3-column DIN 5008 footer (company / contact / banking)
  function drawPageFooter(pageNum) {
    const footY = mm(20);
    drawRule(footY + LINE * 1.5, 0.3, M_L, colRight);
    const colW = contentW / 3;
    const col1 = [seller.name, seller.line1, `${seller.zip || ''} ${seller.city || ''}`.trim(), seller.country ? cn(seller.country) : ''].filter(Boolean);
    const col2 = [seller.phone, seller.email, seller.vat ? `${tI('pdf_vat_id_label')}: ${seller.vat}` : '', seller.siret ? `SIRET: ${seller.siret}` : ''].filter(Boolean);
    const col3 = [seller.bank, seller.iban ? `IBAN: ${seller.iban.replace(/(.{4})/g, '$1 ').trim()}` : '', seller.bic ? `BIC: ${seller.bic}` : ''].filter(Boolean);
    const drawCol = (lines, x) => {
      let yy = footY + LINE * 0.8;
      for (const ln of lines) {
        const s = shrinkToFit(ln, mono, colW - mm(4), widthAt, SIZE_SMALL, 5.5);
        drawText(ln, x, yy, mono, s, SOFT);
        yy -= LINE_TIGHT * 0.85;
      }
    };
    drawCol(col1, M_L);
    drawCol(col2, M_L + colW);
    drawCol(col3, M_L + colW * 2);
    if (totalPages > 1) {
      const label = tI('pdf_page_of').replace('{n}', pageNum).replace('{total}', totalPages);
      drawTextCenter(label, mm(8), mono, SIZE_SMALL - 0.5, SOFT);
    }
  }

  // Helper: continuation mini-header for pages 2+
  function drawMiniHeader() {
    let yy = MINI_HEADER_TOP;
    const left = number ? `${tI('pdf_invoice_label')} ${number}` : tI('pdf_invoice_label');
    drawText(left, M_L, yy, monoBold, SIZE);
    const cont = tI('pdf_continued');
    if (buyer.name) {
      drawTextRight(`${buyer.name} \u00b7 ${cont}`, colRight, yy, mono, SIZE_SMALL, SOFT);
    } else {
      drawTextRight(cont, colRight, yy, mono, SIZE_SMALL, SOFT);
    }
    yy -= LINE * 0.5;
    drawRule(yy, 0.4, M_L, colRight);
    yy -= LINE * 1.6;
    return yy;
  }

  // Closing block: totals + VAT note + footnote + payment + greeting/signature
  function drawClosingBlock(yStart) {
    let yy = yStart;
    const totalLabelX = cAmountRight - mm(2);
    drawTextRight(tI('pdf_sum') + ':', totalLabelX, yy, mono, SIZE);
    drawTextRight(fmtMoney(totals.net), cTotalRight, yy, mono, SIZE);
    yy -= LINE;
    if (mode === 'S' && totals.tax) {
      drawTextRight(tI('total_tax_S') + ':', totalLabelX, yy, mono, SIZE);
      drawTextRight(fmtMoney(totals.tax), cTotalRight, yy, mono, SIZE);
      yy -= LINE;
    }
    drawRule(yy, 0.4, M_L + mm(80), colRight);
    yy -= LINE;
    drawTextRight(tI('pdf_grand_total') + ':', totalLabelX, yy, monoBold, SIZE);
    drawTextRight(fmtMoney(totals.grand), cTotalRight, yy, monoBold, SIZE);
    yy -= LINE * 2;

    if (mode !== 'S') {
      drawText(tI('pdf_vat_' + mode), M_L, yy, monoBold, SIZE); yy -= LINE * 1.4;
    }
    if (footnote) {
      for (const ln of wrapText(footnote, mono, SIZE - 1, contentW)) { drawText(ln, M_L, yy, mono, SIZE - 1, SOFT); yy -= LINE_TIGHT; }
      yy -= LINE * 0.6;
    }
    if (paymentNote) {
      for (const ln of wrapText(paymentNote, mono, SIZE, contentW)) { drawText(ln, M_L, yy, mono, SIZE); yy -= LINE; }
      yy -= LINE * 0.8;
    }
    if (greeting)  { drawText(greeting,  M_L, yy, mono, SIZE); yy -= LINE * 1.4; }
    if (signature) { drawText(signature, M_L, yy, mono, SIZE); yy -= LINE; }
    return yy;
  }

  // ---- Render each page ----
  // Page 1 has its full DIN 5008 header above. Now: table + items + footer.
  let pageY = y;
  pageY = drawTableHeader(pageY);
  if (pages[0].items.length > 0) {
    pageY = drawItems(pages[0].items, pageY, pages[0].indexFrom);
  }
  if (pages.length === 1) {
    pageY -= LINE * 0.4;
    drawRule(pageY, 0.4, M_L, colRight);
    pageY -= LINE * 1.2;
    pageY = drawClosingBlock(pageY);
  }
  drawPageFooter(1);

  // Pages 2..N
  for (let pi = 1; pi < pages.length; pi++) {
    newPage();
    let yy = drawMiniHeader();
    yy = drawTableHeader(yy);
    if (pages[pi].items.length > 0) {
      yy = drawItems(pages[pi].items, yy, pages[pi].indexFrom);
    }
    if (pi === pages.length - 1) {
      yy -= LINE * 0.4;
      drawRule(yy, 0.4, M_L, colRight);
      yy -= LINE * 1.2;
      yy = drawClosingBlock(yy);
    }
    drawPageFooter(pi + 1);
  }
}




//INVOICE MODERN (CLEAN, FLEXIBLE LAYOUT)



async function renderInvoiceModern(pdfDoc, ctx) {
  const kit = makeDrawKit(pdfDoc, ctx.fonts);
  const { mono, monoBold, SOFT, PAGE_W, PAGE_H,
          widthAt, wrapText, drawText, drawTextRight, drawTextCenter, drawRule, newPage } = kit;
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

  // Item-table column anchors — used by both the items loop and the table
  // header, on every page.
  const cTotalRight  = colRight;
  const cAmountRight = M_L + contentW * 0.62;
  const cPriceRight  = M_L + contentW * 0.82;
  const descColW     = cAmountRight - M_L - 16;

  // ---- Page 1: full header ----
  let y = PAGE_H - M_T;

  drawText(tI('pdf_invoice_label'), M_L, y, monoBold, SIZE_LABEL, SOFT);
  if (category) drawTextRight(category.toUpperCase(), colRight, y, monoBold, SIZE_LABEL, SOFT);
  y -= LINE * 0.5;
  drawRule(y, 0.4, M_L, colRight);
  y -= LINE * 2.4;

  if (project) {
    const projLines = wrapText(project, monoBold, SIZE_TITLE, contentW);
    for (const ln of projLines) { drawText(ln, M_L, y, monoBold, SIZE_TITLE); y -= LINE * 1.1; }
  } else if (number) {
    drawText(number, M_L, y, monoBold, SIZE_HEAD);
    y -= SIZE_HEAD * 1.15;
    y -= LINE * 0.4;
  }

  const meta = [];
  if (number) meta.push([tI('pdf_no'),    number]);
  if (date)   meta.push([tI('pdf_date'),  fmtDate(date)]);
  const svc = deliveryEnd && delivery && deliveryEnd !== delivery
    ? `${fmtDate(delivery)} \u2013 ${fmtDate(deliveryEnd)}`
    : (delivery ? fmtDate(delivery) : '');
  if (svc) meta.push([tI('pdf_service'), svc]);

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
  const buyerColW  = contentW * 0.55 - 12;
  const sellerColW = contentW * 0.45 - 12;
  for (const ln of buyerLines) {
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

  if (intro) {
    for (const ln of wrapText(intro, mono, 9, contentW)) { drawText(ln, M_L, y, mono, 9); y -= LINE * 0.85; }
    y -= LINE * 2;
  }

  // ---- Pagination plan ----
  // Measure each item in vertical units of LINE. One line = LINE units.
  const itemUnits = items.map(it => measureItemLines(it, mono, SIZE_BODY, descColW, wrapText) * LINE);
  // What's left on page 1 below intro for items? y is current cursor, footer
  // sits at M_B + ~LINE*1.2 (rule above bank line). Reserve also for the
  // table header itself and a short ending rule.
  const TABLE_HEADER_H = LINE * 1.7;     // label row + thin rule
  const TABLE_END_RULE = LINE * 1.4;     // closing rule under last item
  const FOOTER_RESERVE_PAGE_NUM = LINE * 0.7;  // for "Page X / Y"
  const FOOTER_RESERVE_BANK = LINE * 1.6;      // bank line + rule above
  const BOTTOM_LIMIT = M_B + FOOTER_RESERVE_BANK + FOOTER_RESERVE_PAGE_NUM;

  const firstPageBudget = (y - BOTTOM_LIMIT) - TABLE_HEADER_H - TABLE_END_RULE;

  // Continuation pages: top is M_T, mini-header takes ~LINE*2.4 plus rule.
  const MINI_HEADER_H = LINE * 3.4;
  const midPageBudget = (PAGE_H - M_T - BOTTOM_LIMIT) - MINI_HEADER_H - TABLE_HEADER_H - TABLE_END_RULE;

  // Last-page reserve for totals + footnote + payment + greeting + signature.
  // This is conservative; better an extra blank-ish tail page than collision.
  let lastPageReserve = LINE * 7;  // base: totals block
  if (footnote) lastPageReserve += LINE_TIGHT * Math.max(1, wrapText(footnote, mono, SIZE_BODY - 1.5, contentW).length) + LINE * 0.6;
  if (paymentNote) lastPageReserve += LINE + LINE * wrapText(paymentNote, mono, SIZE_BODY, contentW).length + LINE * 0.4;
  if (greeting)  lastPageReserve += LINE;
  if (signature) lastPageReserve += LINE;

  const pages = paginateItems(items, itemUnits, firstPageBudget, midPageBudget, lastPageReserve);
  const totalPages = pages.length;

  // Helper: draw the table header (label row + rule) at current y.
  // Returns the y after the header (where the first item should go).
  function drawTableHeader(yStart) {
    drawText(tI('th_desc'),         M_L,          yStart, monoBold, SIZE_LABEL, SOFT);
    drawTextRight(tI('pdf_amount'), cAmountRight, yStart, monoBold, SIZE_LABEL, SOFT);
    drawTextRight(tI('pdf_price'),  cPriceRight,  yStart, monoBold, SIZE_LABEL, SOFT);
    drawTextRight(tI('pdf_total'),  cTotalRight,  yStart, monoBold, SIZE_LABEL, SOFT);
    let yy = yStart - LINE * 0.5;
    drawRule(yy, 0.4, M_L, colRight);
    yy -= LINE * 1.2;
    return yy;
  }

  // Helper: draw items, returns final y.
  function drawItems(pageItems, yStart, indexFrom) {
    let yy = yStart;
    for (let i = 0; i < pageItems.length; i++) {
      const it = pageItems[i];
      const qty = Number(it.qty) || 0;
      const price = Number(it.price) || 0;
      const lineTotal = round2(qty * price);
      const descLines = wrapText(it.desc || '', mono, SIZE_BODY, descColW);
      drawText(descLines[0] || '', M_L, yy, mono, SIZE_BODY);
      drawTextRight(String(qty % 1 === 0 ? qty : fmt(qty)), cAmountRight, yy, mono, SIZE_BODY);
      drawTextRight(fmtMoney(price), cPriceRight, yy, mono, SIZE_BODY);
      drawTextRight(fmtMoney(lineTotal), cTotalRight, yy, mono, SIZE_BODY);
      yy -= LINE;
      for (let j = 1; j < descLines.length; j++) {
        drawText(descLines[j], M_L, yy, mono, SIZE_BODY, SOFT);
        yy -= LINE;
      }
    }
    return yy;
  }

  // Helper: draw the bottom-of-page elements (rule, bank line, page number).
  function drawPageFooter(pageNum) {
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
    if (totalPages > 1) {
      const label = tI('pdf_page_of').replace('{n}', pageNum).replace('{total}', totalPages);
      drawTextCenter(label, footY - LINE * 0.9, mono, SIZE_TINY - 0.5, SOFT);
    }
  }

  // Helper: draw the continuation mini-header on pages 2+.
  function drawMiniHeader() {
    let yy = PAGE_H - M_T;
    const left = number ? `${tI('pdf_invoice_label')} ${number}` : tI('pdf_invoice_label');
    drawText(left, M_L, yy, monoBold, SIZE_LABEL, SOFT);
    const cont = tI('pdf_continued');
    if (buyer.name) {
      drawTextRight(`${buyer.name} \u00b7 ${cont}`, colRight, yy, monoBold, SIZE_LABEL, SOFT);
    } else {
      drawTextRight(cont, colRight, yy, monoBold, SIZE_LABEL, SOFT);
    }
    yy -= LINE * 0.5;
    drawRule(yy, 0.4, M_L, colRight);
    yy -= LINE * 2.0;
    return yy;
  }

  // ---- Render each page ----
  // Page 1 already has its header above; finish it with table + items + footer.
  let pageY = y;
  pageY = drawTableHeader(pageY);
  if (pages[0].items.length > 0) {
    pageY = drawItems(pages[0].items, pageY, pages[0].indexFrom);
  }
  // If this is the last page, draw the closing block before the footer.
  if (pages.length === 1) {
    pageY -= LINE * 0.4;
    drawRule(pageY, 0.4, M_L, colRight);
    pageY -= LINE * 1.4;
    pageY = drawClosingBlock(pageY);
  }
  drawPageFooter(1);

  // Pages 2..N-1 (and possibly N): mini-header, table header, items, footer.
  for (let pi = 1; pi < pages.length; pi++) {
    newPage();
    let yy = drawMiniHeader();
    yy = drawTableHeader(yy);
    if (pages[pi].items.length > 0) {
      yy = drawItems(pages[pi].items, yy, pages[pi].indexFrom);
    }
    if (pi === pages.length - 1) {
      yy -= LINE * 0.4;
      drawRule(yy, 0.4, M_L, colRight);
      yy -= LINE * 1.4;
      yy = drawClosingBlock(yy);
    }
    drawPageFooter(pi + 1);
  }

  // Closing block: totals + footnote + payment + greeting + signature.
  // Returns the final y after drawing.
  function drawClosingBlock(yStart) {
    let yy = yStart;
    const labelX = M_L + contentW * 0.55;
    const valueXRight = colRight;
    drawText(tI('pdf_sum').toUpperCase(), labelX, yy, monoBold, SIZE_LABEL, SOFT);
    drawTextRight(fmtMoney(totals.net), valueXRight, yy, mono, SIZE_BODY);
    yy -= LINE * 1.1;
    drawText(tI('total_tax_S'), labelX, yy, monoBold, SIZE_LABEL, SOFT);
    if (mode === 'S' && totals.tax) {
      drawTextRight(fmtMoney(totals.tax), valueXRight, yy, mono, SIZE_BODY);
    } else {
      const vatNote = (tI('pdf_vat_' + mode) || '').replace(/^[^:]+:\s*/, '');
      drawTextRight(vatNote, valueXRight, yy, mono, SIZE_BODY - 1, SOFT);
    }
    yy -= LINE * 1.8;
    drawRule(yy + LINE * 0.7, 0.5, labelX, valueXRight);
    yy -= LINE * 0.9;
    drawText(tI('pdf_grand_total').toUpperCase(), labelX, yy, monoBold, SIZE_LABEL, SOFT);
    drawTextRight(fmtMoney(totals.grand), valueXRight, yy - LINE * 0.4, monoBold, SIZE_TITLE);
    yy -= LINE * 2.6;

    if (footnote) {
      for (const ln of wrapText(footnote, mono, SIZE_BODY - 1.5, contentW)) {
        drawText(ln, M_L, yy, mono, SIZE_BODY - 1.5, SOFT); yy -= LINE_TIGHT;
      }
      yy -= LINE * 0.6;
    }

    if (paymentNote) {
      drawText(tI('pdf_payment'), M_L, yy, monoBold, SIZE_LABEL, SOFT);
      yy -= LINE;
      for (const ln of wrapText(paymentNote, mono, SIZE_BODY, contentW)) {
        drawText(ln, M_L, yy, mono, SIZE_BODY); yy -= LINE;
      }
      yy -= LINE * 0.4;
    }
    if (greeting)  { drawText(greeting,  M_L, yy, mono, SIZE_BODY); yy -= LINE; }
    if (signature) { drawText(signature, M_L, yy, monoBold, SIZE_BODY); yy -= LINE; }
    return yy;
  }
}



//INVOICE TYPEWRITER (CENTERED, MONOSPACE-FORWARD)


async function renderInvoiceTypewriter(pdfDoc, ctx) {
  const kit = makeDrawKit(pdfDoc, ctx.fonts);
  const { mono, monoBold, SOFT, PAGE_W, PAGE_H,
          widthAt, wrapText, drawText, drawTextRight, drawTextCenter, drawRule, newPage } = kit;

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

  // Item-table column anchors (used on every page)
  const cTotalRight  = colRight;
  const cAmountRight = M_L + contentW * 0.75;
  const cPriceRight  = M_L + contentW * 0.55;

  function drawLabel(text, x, yy, align = 'left') {
    if (align === 'right') drawTextRight(text, x, yy, monoBold, LABEL_SIZE, SOFT);
    else drawText(text, x, yy, monoBold, LABEL_SIZE, SOFT);
  }

  // ---- Page 1: full Typewriter header (two-column buyer/seller block) ----
  let y = PAGE_H - M_T;
  const topY = y;

  const buyerAddr  = formatPartyAddress(buyer,  cn, { includeReference: true });
  const sellerAddr = formatPartyAddress(seller, cn, { includeContact: true });

  const colBuyerX = M_L;
  const colSellerX = colRight;

  drawLabel(tI('pdf_billed_to'), colBuyerX, topY);
  drawLabel(tI('pdf_from'), colSellerX, topY, 'right');

  let yBuyer = topY - RULE_NAME_GAP;
  let ySeller = topY - RULE_NAME_GAP;
  if (buyer.name)  { drawText(buyer.name, colBuyerX, yBuyer, monoBold, SIZE_BODY); yBuyer -= LINE_H; }
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

  // ---- Pagination plan ----
  // Description budget: items render in monoBold first line, depend on price width
  const descBudget = cPriceRight - M_L - widthAt('9999.99', monoBold, SIZE_BODY) - 20;
  const itemUnits = items.map(it => measureItemLines(it, monoBold, SIZE_BODY, descBudget, wrapText) * LINE_H);

  // Footer geometry: bank line at M_B, rule above at M_B + LINE_H + 6
  const FOOTER_TOP = M_B + LINE_H + 6;
  const PAGE_NUM_RESERVE = LINE_H * 0.9;
  const BOTTOM_LIMIT = FOOTER_TOP + PAGE_NUM_RESERVE;

  const TABLE_HEADER_H = LINE_H * 1.4;       // label row only (no rule above items in Typewriter)
  const TABLE_END_RULE = LINE_H * 1.5;       // strong rule below items

  const firstPageBudget = (y - BOTTOM_LIMIT) - TABLE_HEADER_H - TABLE_END_RULE;

  // Continuation pages: smaller mini-header
  const MINI_HEADER_TOP = PAGE_H - M_T;
  const MINI_HEADER_H = LINE_H * 3.0;
  const midPageBudget = (MINI_HEADER_TOP - BOTTOM_LIMIT) - MINI_HEADER_H - TABLE_HEADER_H - TABLE_END_RULE;

  // Last-page reserve: totals + VAT + footnote + payment + greeting/signature
  let lastPageReserve = LINE_H * 5;  // sum + grand total + spacing
  lastPageReserve += LINE_H * 1.8;    // VAT line
  if (footnote)    lastPageReserve += LINE_TIGHT * Math.max(1, wrapText(footnote, mono, SIZE_BODY - 1, contentW).length) + LINE_H * 0.8;
  if (paymentNote) lastPageReserve += LINE_H * wrapText(paymentNote, mono, SIZE_BODY, contentW).length + LINE_H * 0.8;
  if (greeting)    lastPageReserve += LINE_H;
  if (signature)   lastPageReserve += LINE_H;

  const pages = paginateItems(items, itemUnits, firstPageBudget, midPageBudget, lastPageReserve);
  const totalPages = pages.length;

  // Helper: draw the table header (Typewriter has no leading rule, just labels)
  function drawTableHeader(yStart) {
    drawTextRight(tI('pdf_price'),  cPriceRight,  yStart, mono, SIZE_BODY);
    drawTextRight(tI('pdf_amount'), cAmountRight, yStart, mono, SIZE_BODY);
    drawTextRight(tI('pdf_total'),  cTotalRight,  yStart, mono, SIZE_BODY);
    return yStart - LINE_H * 1.4;
  }

  // Helper: draw items (monoBold first line, mono for wrapped lines)
  function drawItems(pageItems, yStart) {
    let yy = yStart;
    for (const it of pageItems) {
      const qty = Number(it.qty) || 0;
      const price = Number(it.price) || 0;
      const lineTotal = round2(qty * price);
      const descLines = wrapText(it.desc || '', monoBold, SIZE_BODY,
        cPriceRight - M_L - widthAt(fmtMoney(price), monoBold, SIZE_BODY) - 20);
      drawText(descLines[0] || '', M_L, yy, monoBold, SIZE_BODY);
      drawTextRight(fmtMoney(price), cPriceRight, yy, monoBold, SIZE_BODY);
      drawTextRight(String(qty % 1 === 0 ? qty : fmt(qty)), cAmountRight, yy, monoBold, SIZE_BODY);
      drawTextRight(fmtMoney(lineTotal), cTotalRight, yy, monoBold, SIZE_BODY);
      yy -= LINE_H;
      for (let i = 1; i < descLines.length; i++) {
        drawText(descLines[i], M_L, yy, mono, SIZE_BODY);
        yy -= LINE_H;
      }
    }
    return yy;
  }

  // Helper: bottom-of-page elements (rule + centered bank line + page number)
  function drawPageFooter(pageNum) {
    drawRule(FOOTER_TOP, 0.6, M_L, colRight);
    drawCenteredBankLine(seller, kit, {
      y: M_B,
      font: monoBold,
      maxWidth: contentW,
      startSize: SIZE_BODY,
      minSize: 6,
    });
    if (totalPages > 1) {
      const label = tI('pdf_page_of').replace('{n}', pageNum).replace('{total}', totalPages);
      drawTextCenter(label, M_B - LINE_H * 1.8, mono, LABEL_SIZE - 0.5, SOFT);
    }
  }

  // Helper: continuation mini-header for pages 2+
  function drawMiniHeader() {
    let yy = MINI_HEADER_TOP;
    const left = number ? `${tI('pdf_invoice_label')} ${number}` : tI('pdf_invoice_label');
    drawText(left, M_L, yy, monoBold, LABEL_SIZE, SOFT);
    const cont = tI('pdf_continued');
    if (buyer.name) {
      drawTextRight(`${buyer.name} \u00b7 ${cont}`, colRight, yy, monoBold, LABEL_SIZE, SOFT);
    } else {
      drawTextRight(cont, colRight, yy, monoBold, LABEL_SIZE, SOFT);
    }
    yy -= LINE_H * 0.8;
    drawRule(yy, 0.4, M_L, colRight);
    yy -= LINE_H * 1.6;
    return yy;
  }

  // Closing block: totals + VAT + footnote + payment + greeting/signature
  function drawClosingBlock(yStart) {
    let yy = yStart;
    const sumLabel = tI('pdf_sum');
    drawText(sumLabel, cAmountRight - widthAt(sumLabel, mono, SIZE_BODY), yy, mono, SIZE_BODY);
    drawTextRight(fmtMoney(totals.net), cTotalRight, yy, mono, SIZE_BODY);
    yy -= LINE_H * 1.4;
    const grandLabel = tI('pdf_grand_total');
    drawText(grandLabel, cAmountRight - widthAt(grandLabel, monoBold, SIZE_BODY), yy, monoBold, SIZE_BODY);
    drawTextRight(fmtMoney(totals.grand), cTotalRight, yy, monoBold, SIZE_BODY);
    yy -= LINE_H * 2.2;

    const vatLabel = mode === 'S' && totals.tax
      ? `${tI('pdf_vat_label')} ${fmt(totals.tax)} ${currencySym} (${tI('pdf_vat_S').replace(/^[^:]+:\s*/, '')})`
      : tI('pdf_vat_' + mode);
    drawText(vatLabel || tI('pdf_vat_label'), M_L, yy, monoBold, SIZE_BODY);
    yy -= LINE_H * 1.8;

    if (footnote) {
      for (const ln of wrapText(footnote, mono, SIZE_BODY - 1, contentW)) {
        drawText(ln, M_L, yy, mono, SIZE_BODY - 1, SOFT); yy -= LINE_TIGHT;
      }
      yy -= LINE_H * 0.8;
    } else { yy -= LINE_H * 0.2; }

    if (paymentNote) {
      for (const ln of wrapText(paymentNote, mono, SIZE_BODY, contentW)) {
        drawText(ln, M_L, yy, mono, SIZE_BODY); yy -= LINE_H;
      }
      yy -= LINE_H * 0.8;
    }
    if (greeting)  { drawText(greeting,  M_L, yy, mono, SIZE_BODY); yy -= LINE_H; }
    if (signature) { drawText(signature, M_L, yy, mono, SIZE_BODY); yy -= LINE_H; }
    return yy;
  }

  // ---- Render each page ----
  // Page 1: header is already drawn. Now table + items + footer.
  let pageY = y;
  pageY = drawTableHeader(pageY);
  if (pages[0].items.length > 0) {
    pageY = drawItems(pages[0].items, pageY);
  }
  if (pages.length === 1) {
    drawRule(pageY, 0.8, M_L, colRight);
    pageY -= LINE_H * 1.5;
    pageY = drawClosingBlock(pageY);
  }
  drawPageFooter(1);

  // Pages 2..N
  for (let pi = 1; pi < pages.length; pi++) {
    newPage();
    let yy = drawMiniHeader();
    yy = drawTableHeader(yy);
    if (pages[pi].items.length > 0) {
      yy = drawItems(pages[pi].items, yy);
    }
    if (pi === pages.length - 1) {
      drawRule(yy, 0.8, M_L, colRight);
      yy -= LINE_H * 1.5;
      yy = drawClosingBlock(yy);
    }
    drawPageFooter(pi + 1);
  }
}
