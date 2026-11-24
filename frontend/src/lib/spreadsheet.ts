import Papa from 'papaparse';

export interface ParsedFile {
  columns: string[];
  rows: Record<string, string>[];
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Excel cells as the text a person sees: dates as YYYY-MM-DD, times as HH:MM. */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    const time = `${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}`;
    if (v.getUTCFullYear() < 1901) return time;
    const date = `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
    return time === '00:00' ? date : `${date} ${time}`;
  }
  // Phone numbers come back as numbers: never in scientific notation.
  if (typeof v === 'number' && Number.isInteger(v)) return v.toLocaleString('fullwide', { useGrouping: false });
  return String(v);
}

/** Reads a CSV or Excel (.xlsx) file whose first row is the column headings. */
export async function readSpreadsheet(file: File, maxRows: number): Promise<ParsedFile> {
  const isExcel = /\.xlsx$/i.test(file.name);
  if (/\.xls$/i.test(file.name)) throw new Error('This is an old Excel file. Save it as .xlsx or CSV and try again.');
  let table: string[][];
  if (isExcel) {
    const { default: readXlsxFile } = await import('read-excel-file');
    try {
      table = (await readXlsxFile(file)).map((r) => r.map(cellText));
    } catch {
      throw new Error('This Excel file could not be read. Save it again as .xlsx or CSV.');
    }
  } else {
    table = await new Promise<string[][]>((resolve, reject) => Papa.parse<string[]>(file, { skipEmptyLines: 'greedy', complete: (r) => resolve(r.data), error: (e) => reject(new Error(e.message)) }));
  }
  const header = (table[0] ?? []).map((h) => h.replace(/^﻿/, '').trim());
  const columns = [...new Set(header.filter(Boolean))];
  const rows = table
    .slice(1)
    .filter((r) => r.some((c) => c.trim()))
    .map((r) => {
      const row: Record<string, string> = {};
      header.forEach((h, i) => {
        if (h && !(h in row)) row[h] = (r[i] ?? '').trim().slice(0, 2000);
      });
      return row;
    });
  if (!columns.length || !rows.length) throw new Error('This file has no header row or no data.');
  if (rows.length > maxRows) throw new Error(`This file has ${rows.length} rows. Import at most ${maxRows} at a time.`);
  return { columns, rows };
}
