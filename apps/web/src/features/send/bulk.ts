/** CSV parsing and row helpers for bulk send. */
import type { BulkRow } from "./types";

/** Minimal RFC-4180 style parser: quoted fields, escaped quotes, CR/LF rows. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v.trim())) rows.push(row);
  return rows;
}

let seq = 0;
function rowKey(): string {
  seq += 1;
  return `bulk-${seq}`;
}

export function emptyBulkRow(name = "", email = "", phone?: string): BulkRow {
  return { key: rowKey(), name, email, phone };
}

/** Columns are name, email and optional phone, with or without a header row. */
export function rowsFromCsv(text: string): BulkRow[] {
  const table = parseCsv(text);
  if (!table.length) return [];
  let index = { name: 0, email: 1, phone: 2 };
  let start = 0;
  const header = table[0].map((h) => h.trim().toLowerCase());
  if (header.some((h) => h === "email" || h === "e-mail")) {
    index = {
      name: header.findIndex((h) => h === "name" || h === "full name"),
      email: header.findIndex((h) => h === "email" || h === "e-mail"),
      phone: header.findIndex((h) => h === "phone" || h === "mobile")
    };
    start = 1;
  }
  const out: BulkRow[] = [];
  for (let i = start; i < table.length; i++) {
    const cells = table[i];
    const email = (index.email >= 0 ? cells[index.email] : "")?.trim() ?? "";
    const name = (index.name >= 0 ? cells[index.name] : "")?.trim() ?? "";
    const phone = (index.phone >= 0 ? cells[index.phone] : "")?.trim() ?? "";
    if (!email && !name) continue;
    out.push(emptyBulkRow(name, email, phone || undefined));
  }
  return out;
}
