// Number formatting helpers used across the invoice UI and PDF rendering.
// Keep this file dependency-free so it stays cheap to import anywhere.

export const round2 = (n) => Math.round(n * 100) / 100;

export const fmt = (n, locale = 'de-DE') => {
  const num = Number(n);
  if (!Number.isFinite(num)) return '0,00';
  return round2(num).toLocaleString(locale, {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  });
};

export const fmtPDF = (n) => {
  const num = Number(n);
  if (!Number.isFinite(num)) return '0,00';
  const v = round2(num);
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  const int = Math.floor(abs);
  const dec = Math.round((abs - int) * 100);
  return `${sign}${int},${String(dec).padStart(2, '0')}`;
};