import type { ImportProblem, ImportRow } from "./types";

/** RFC 4180-ish reader: quoted cells, doubled quotes, CRLF, blank rows dropped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (c !== "\r") cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

type Column = "name" | "email" | "phone" | "company" | "jobTitle";

const HEADERS: Record<string, Column> = {
  name: "name",
  fullname: "name",
  contactname: "name",
  email: "email",
  emailaddress: "email",
  mail: "email",
  phone: "phone",
  phonenumber: "phone",
  mobile: "phone",
  company: "company",
  organisation: "company",
  organization: "company",
  jobtitle: "jobTitle",
  title: "jobTitle",
  role: "jobTitle"
};

function normalise(h: string) {
  return h.toLowerCase().replace(/[^a-z]/g, "");
}

/** Why the whole file cannot be used. Translated where it is shown. */
export type CsvError = "empty" | "missingColumns";

export interface CsvParseResult {
  rows: ImportRow[];
  /** Present when the file cannot be used at all. */
  error?: CsvError;
}

/**
 * Maps a CSV onto contact rows. Name and Email are required columns; phone,
 * company and job title are optional. Rows keep a `problem` code instead of
 * being dropped, so the preview can show what will be skipped.
 */
export function readContactsCsv(text: string): CsvParseResult {
  const table = parseCsv(text);
  if (!table.length) return { rows: [], error: "empty" };

  const header = table[0].map((h) => HEADERS[normalise(h)]);
  if (!header.includes("name") || !header.includes("email")) {
    return { rows: [], error: "missingColumns" };
  }

  const seen = new Set<string>();
  const rows: ImportRow[] = [];

  for (const line of table.slice(1)) {
    const rec: Partial<Record<Column, string>> = {};
    header.forEach((col, i) => {
      if (col) rec[col] = (line[i] ?? "").trim();
    });
    const email = (rec.email ?? "").toLowerCase().replace(/\s/g, "");
    const name = rec.name ?? "";
    let problem: ImportProblem | undefined;
    if (!email) problem = "noEmail";
    else if (!EMAIL.test(email)) problem = "invalidEmail";
    else if (!name) problem = "noName";
    else if (seen.has(email)) problem = "duplicate";
    if (!problem) seen.add(email);
    rows.push({
      name,
      email,
      phone: rec.phone || undefined,
      company: rec.company || undefined,
      jobTitle: rec.jobTitle || undefined,
      problem
    });
  }
  return { rows };
}
