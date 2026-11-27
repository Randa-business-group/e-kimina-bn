/** RFC 4180 CSV with a UTF-8 BOM (opens correctly in Excel). */
export function toCsv(
  headers: string[],
  rows: (string | number | null | undefined)[][],
): Buffer {
  const cell = (v: string | number | null | undefined) => {
    if (v == null) return '';
    const s = typeof v === 'number' ? String(Math.round(v * 100) / 100) : v;
    // Neutralise spreadsheet formulas in user-provided text.
    const safe = /^[=+\-@]/.test(s) && typeof v !== 'number' ? `'${s}` : s;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = [headers, ...rows].map((r) => r.map(cell).join(','));
  return Buffer.from('﻿' + lines.join('\r\n') + '\r\n', 'utf8');
}
