export const fmt = (n) => (Math.round(n * 100) / 100).toLocaleString('de-DE', {
  minimumFractionDigits: 2, maximumFractionDigits: 2
});

export const round2 = (n) => Math.round(n * 100) / 100;