/**
 * Convert email attachments into content the plan builder (Gemini) can use.
 * - PDFs pass through as base64 parts (Gemini reads them natively).
 * - Excel workbooks become CSV text (date cells normalized via UTC, the
 *   same convention as the schedule file import).
 * - CSV / plain text pass through as text.
 * - Word .docx files are extracted to raw text via mammoth.
 * Anything else (images, zips, legacy .doc, oversized files) is reported
 * in `notes` so the AI can ask for clarification instead of guessing.
 */
import * as XLSX from 'xlsx';
import mammoth from 'mammoth';
import type { ImapAttachment } from './gmailImap.js';

export interface AttachmentContent {
  textParts: { filename: string; text: string }[];
  pdfParts: { filename: string; base64: string }[];
  notes: string[];
}

const MAX_TEXT_PER_FILE = 30000;
const MAX_TEXT_TOTAL = 60000;
const MAX_PDFS = 3;

// Excel serial day number → YYYY-MM-DD (serials are pure calendar days).
function excelSerialToDate(serial: number): string {
  const d = new Date(Math.round((serial - 25569) * 86400000));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function sheetCellText(c: any): string {
  if (c instanceof Date && !isNaN(c.getTime())) {
    return `${c.getUTCFullYear()}-${String(c.getUTCMonth() + 1).padStart(2, '0')}-${String(c.getUTCDate()).padStart(2, '0')}`;
  }
  if (typeof c === 'number' && isFinite(c) && c >= 20000 && c <= 80000) return excelSerialToDate(c);
  return String(c ?? '');
}

function csvEscape(s: string): string {
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function workbookToText(buf: Buffer): string {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const chunks: string[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const grid: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
    const lines = grid
      .map((r) => (r || []).map((c) => csvEscape(sheetCellText(c).trim())).join(','))
      .filter((l) => l.replace(/,/g, '').trim() !== '');
    if (lines.length) chunks.push(`[Sheet: ${name}]\n${lines.join('\n')}`);
  }
  return chunks.join('\n\n');
}

export async function extractAttachmentContent(attachments: ImapAttachment[]): Promise<AttachmentContent> {
  const out: AttachmentContent = { textParts: [], pdfParts: [], notes: [] };
  let textBudget = MAX_TEXT_TOTAL;
  const pushText = (filename: string, text: string) => {
    const clean = String(text || '').trim();
    if (!clean) {
      out.notes.push(`${filename}: no readable text found`);
      return;
    }
    if (textBudget <= 0) {
      out.notes.push(`${filename}: skipped — too much attached text overall`);
      return;
    }
    const cap = Math.min(MAX_TEXT_PER_FILE, textBudget);
    const clipped = clean.slice(0, cap);
    textBudget -= clipped.length;
    out.textParts.push({ filename, text: clipped + (clipped.length < clean.length ? '\n[...truncated...]' : '') });
  };

  for (const att of attachments || []) {
    const fname = att.filename || 'attachment';
    const lower = fname.toLowerCase();
    if (!att.content) {
      out.notes.push(`${fname}: too large to read (over 8 MB) — skipped`);
      continue;
    }
    try {
      if (lower.endsWith('.pdf') || att.contentType === 'application/pdf') {
        if (out.pdfParts.length >= MAX_PDFS) {
          out.notes.push(`${fname}: skipped — at most ${MAX_PDFS} PDFs per email`);
          continue;
        }
        out.pdfParts.push({ filename: fname, base64: att.content.toString('base64') });
      } else if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
        pushText(fname, workbookToText(att.content));
      } else if (lower.endsWith('.csv') || lower.endsWith('.txt') || lower.endsWith('.md')) {
        pushText(fname, att.content.toString('utf8'));
      } else if (lower.endsWith('.docx')) {
        const r = await mammoth.extractRawText({ buffer: att.content });
        pushText(fname, r.value || '');
      } else {
        out.notes.push(`${fname}: file type not readable — supported: PDF, Excel (.xlsx/.xls), CSV, Word (.docx), text`);
      }
    } catch (e: any) {
      out.notes.push(`${fname}: could not be read (${String(e?.message || e).slice(0, 120)})`);
    }
  }
  return out;
}
