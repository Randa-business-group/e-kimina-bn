/**
 * Minimal dependency-free PDF writer for text documents (statements, receipts).
 * A4 pages, Helvetica / Helvetica-Bold, automatic page breaks. Non-Latin-1 characters are
 * replaced by ASCII look-alikes.
 */
export interface PdfLine {
  text: string;
  size?: number;
  bold?: boolean;
  /** Extra space before the line (points). */
  gap?: number;
  /** Right-aligned columns: [x, text] pairs drawn on the same baseline. */
  columns?: [number, string][];
}

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 50;

function clean(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[…]/g, '...')
    .replace(/[×]/g, 'x')
    .replace(/[^\x20-\x7E]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

export function renderPdf(lines: PdfLine[], footer?: string): Buffer {
  const pages: string[] = [];
  let ops: string[] = [];
  let y = PAGE_H - MARGIN;
  const flush = () => {
    if (footer) {
      ops.push(
        `BT /F1 8 Tf ${MARGIN} 30 Td (${clean(footer)}  -  page ${pages.length + 1}) Tj ET`,
      );
    }
    pages.push(ops.join('\n'));
    ops = [];
    y = PAGE_H - MARGIN;
  };
  for (const l of lines) {
    const size = l.size ?? 10;
    const step = size * 1.45 + (l.gap ?? 0);
    if (y - step < MARGIN + 20) flush();
    y -= step;
    const font = l.bold ? 'F2' : 'F1';
    if (l.text)
      ops.push(
        `BT /${font} ${size} Tf ${MARGIN} ${y.toFixed(1)} Td (${clean(l.text)}) Tj ET`,
      );
    for (const [x, t] of l.columns ?? []) {
      ops.push(
        `BT /${font} ${size} Tf ${x} ${y.toFixed(1)} Td (${clean(t)}) Tj ET`,
      );
    }
  }
  flush();

  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  const catalogId = add('');
  const pagesId = add('');
  const f1 = add(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  );
  const f2 = add(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  );
  const pageIds: number[] = [];
  for (const content of pages) {
    const streamId = add(
      `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    );
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
          `/Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${streamId} 0 R >>`,
      ),
    );
  }
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
