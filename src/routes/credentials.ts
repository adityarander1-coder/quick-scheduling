// routes/credentials.ts — /api/credentials, scoped to the session company.
//
// Credential tracker (Deepika 2026-11-04): owners/schedulers keep each
// team member's licenses & certifications with expiry dates. Categories
// are company-defined: the list is seeded with defaults on first use and
// grows from the credential form itself ("+ New category" posts here).
// Employees have no access — this is a schedule-builders' tool.

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { isGeminiConfigured, parseCredentialDocument } from '../util/gemini';

const router = Router();
router.use(requireAuth);

export const DEFAULT_CREDENTIAL_CATEGORIES = [
  'Licenses', 'Registrations', 'Certifications', 'Insurance', 'Training & Compliance', 'Other',
];

async function ensureCategories(companyId: string): Promise<string[]> {
  const { rows } = await query(
    'SELECT name FROM credential_categories WHERE company_id = $1 ORDER BY created_at, name', [companyId]);
  if (rows.length) return rows.map((r: any) => r.name);
  for (const name of DEFAULT_CREDENTIAL_CATEGORIES) {
    await query('INSERT INTO credential_categories (id, company_id, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [crypto.randomUUID(), companyId, name]);
  }
  const again = await query(
    'SELECT name FROM credential_categories WHERE company_id = $1 ORDER BY created_at, name', [companyId]);
  return again.rows.map((r: any) => r.name);
}

async function findOrCreateCategory(companyId: string, raw: string): Promise<string> {
  const name = String(raw || '').trim().slice(0, 60);
  if (!name) return 'Other';
  const { rows } = await query(
    'SELECT name FROM credential_categories WHERE company_id = $1 AND lower(name) = lower($2)', [companyId, name]);
  if (rows.length) return rows[0].name;
  await query('INSERT INTO credential_categories (id, company_id, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [crypto.randomUUID(), companyId, name]);
  return name;
}

function publicCredential(r: any) {
  return {
    id: r.id,
    userId: r.user_id,
    userName: (((r.first_name || '') + ' ' + (r.last_name || '')).trim() || 'Team member'),
    name: r.name,
    category: r.category,
    number: r.number || null,
    expiryDate: r.expiry_date,
    hasDocument: !!r.document_name,
    documentName: r.document_name || null,
  };
}

const CRED_SQL = `SELECT c.id, c.user_id, c.name, c.category, c.number, c.expiry_date::text AS expiry_date,
                         u.first_name, u.last_name, d.filename AS document_name
                  FROM credentials c JOIN users u ON u.id = c.user_id
                  LEFT JOIN LATERAL (SELECT filename FROM credential_documents
                                     WHERE credential_id = c.id ORDER BY created_at DESC LIMIT 1) d ON true`;

// Uploaded credential documents ride as JSON { filename, dataBase64 } —
// the same pattern as the schedule import (no multipart middleware).
// Type is sniffed from the bytes, never trusted from the client.
const DOC_MAX_BYTES = 8 * 1024 * 1024;
function sniffDocMime(b: Buffer): string | null {
  if (b.length > 4 && b.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  if (b.length > 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
function decodeDoc(body: any): { buf: Buffer; mime: string; filename: string } | { error: string; status: number } {
  const dataBase64 = body?.dataBase64;
  if (!dataBase64 || typeof dataBase64 !== 'string') return { error: 'No file data was received.', status: 400 };
  const buf = Buffer.from(dataBase64, 'base64');
  if (!buf.length) return { error: 'That file appears to be empty.', status: 400 };
  if (buf.length > DOC_MAX_BYTES) return { error: 'That file is too large (max 8 MB).', status: 413 };
  const mime = sniffDocMime(buf);
  if (!mime) return { error: "That file type can't be used — upload a PDF or a photo (PNG, JPG, or WEBP).", status: 415 };
  const filename = String(body?.filename || 'document').replace(/["\r\n]/g, '').slice(0, 160) || 'document';
  return { buf, mime, filename };
}

function validDate(s: any): boolean {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T12:00:00');
  return !isNaN(d.getTime());
}

// GET /api/credentials — list (owner/scheduler), soonest expiry first.
router.get('/', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const categories = await ensureCategories(companyId);
    const { rows } = await query(`${CRED_SQL} WHERE c.company_id = $1 ORDER BY c.expiry_date ASC, u.last_name ASC`, [companyId]);
    res.json({ credentials: rows.map(publicCredential), categories });
  } catch (err) {
    console.error('[credentials] list failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/credentials/categories — create a category (owner/scheduler).
router.post('/categories', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const name = String(req.body?.name || '').trim().slice(0, 60);
    if (!name) { res.status(400).json({ error: 'A category name is required.' }); return; }
    const canonical = await findOrCreateCategory(companyId, name);
    res.status(201).json({ name: canonical });
  } catch (err) {
    console.error('[credentials] create category failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/credentials/read — read an uploaded credential document with
// the AI and return the form fields it found. NOTHING is saved here; the
// client pre-fills the form and the user confirms. When the AI is not
// configured or can't read the file, this returns 422 and the client
// falls back to manual entry (the file is still attached on save).
router.post('/read', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const doc = decodeDoc(req.body);
    if ('error' in doc) { res.status(doc.status).json({ error: doc.error }); return; }
    if (!isGeminiConfigured()) {
      res.status(422).json({ error: 'The AI reader is not available right now — fill the form in by hand. The document will still be attached when you save.' });
      return;
    }
    const categories = await ensureCategories(companyId);
    const { rows: memRows } = await query(
      'SELECT id, first_name, last_name FROM users WHERE company_id = $1 AND is_active = true', [companyId]);
    const members = memRows.map((u: any) => ({ id: u.id, name: ((u.first_name || '') + ' ' + (u.last_name || '')).trim() }));
    try {
      const fields = await parseCredentialDocument({
        base64: doc.buf.toString('base64'), mimeType: doc.mime, members, categories,
        today: new Date().toISOString().slice(0, 10),
      });
      res.json({ fields });
    } catch (err) {
      console.error('[credentials] AI read failed:', err);
      res.status(422).json({ error: "The AI reader couldn't read this document — fill the form in by hand. It will still be attached when you save." });
    }
  } catch (err) {
    console.error('[credentials] read failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/credentials/:id/document — attach (or replace) the document.
router.post('/:id/document', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rows: cred } = await query('SELECT id FROM credentials WHERE id = $1 AND company_id = $2', [req.params.id, companyId]);
    if (!cred.length) { res.status(404).json({ error: 'Credential not found.' }); return; }
    const doc = decodeDoc(req.body);
    if ('error' in doc) { res.status(doc.status).json({ error: doc.error }); return; }
    await query('DELETE FROM credential_documents WHERE credential_id = $1', [req.params.id]);
    await query(
      'INSERT INTO credential_documents (id, company_id, credential_id, filename, mime, size_bytes, data, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [crypto.randomUUID(), companyId, req.params.id, doc.filename, doc.mime, doc.buf.length, doc.buf, req.session.userId]);
    res.status(201).json({ ok: true, filename: doc.filename, size: doc.buf.length });
  } catch (err) {
    console.error('[credentials] attach document failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /api/credentials/:id/document — view/download the current document.
router.get('/:id/document', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rows } = await query(
      `SELECT d.filename, d.mime, d.data FROM credential_documents d
       JOIN credentials c ON c.id = d.credential_id AND c.company_id = $2
       WHERE d.credential_id = $1 ORDER BY d.created_at DESC LIMIT 1`,
      [req.params.id, companyId]);
    if (!rows.length) { res.status(404).json({ error: 'No document attached.' }); return; }
    const row = rows[0];
    res.setHeader('Content-Type', row.mime);
    res.setHeader('Content-Disposition', `inline; filename="${String(row.filename || 'document').replace(/"/g, '')}"`);
    res.send(Buffer.from(row.data));
  } catch (err) {
    console.error('[credentials] get document failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// DELETE /api/credentials/:id/document — remove the attached document.
router.delete('/:id/document', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rows: cred } = await query('SELECT id FROM credentials WHERE id = $1 AND company_id = $2', [req.params.id, companyId]);
    if (!cred.length) { res.status(404).json({ error: 'Credential not found.' }); return; }
    await query('DELETE FROM credential_documents WHERE credential_id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[credentials] delete document failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

async function readBody(req: Request, companyId: string) {
  const { userId, name, category, newCategory, number, expiryDate } = req.body ?? {};
  if (!userId || !String(name || '').trim() || !validDate(expiryDate)) return { error: 'Person, credential name, and a valid expiry date are required.' };
  const { rows: urows } = await query('SELECT id FROM users WHERE id = $1 AND company_id = $2 AND is_active = true', [userId, companyId]);
  if (!urows.length) return { error: 'That team member was not found.' };
  const cat = newCategory && String(newCategory).trim()
    ? await findOrCreateCategory(companyId, newCategory)
    : await findOrCreateCategory(companyId, category || 'Other');
  return {
    userId, name: String(name).trim().slice(0, 120), category: cat,
    number: number ? String(number).trim().slice(0, 80) : null, expiryDate,
  };
}

// POST /api/credentials — create (owner/scheduler).
router.post('/', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const body = await readBody(req, companyId);
    if ('error' in body) { res.status(400).json({ error: body.error }); return; }
    const id = crypto.randomUUID();
    await query(
      'INSERT INTO credentials (id, company_id, user_id, name, category, number, expiry_date, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [id, companyId, body.userId, body.name, body.category, body.number, body.expiryDate, req.session.userId]);
    const { rows } = await query(`${CRED_SQL} WHERE c.id = $1`, [id]);
    res.status(201).json({ credential: publicCredential(rows[0]) });
  } catch (err) {
    console.error('[credentials] create failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// PUT /api/credentials/:id — update / mark renewed (owner/scheduler).
router.put('/:id', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const body = await readBody(req, companyId);
    if ('error' in body) { res.status(400).json({ error: body.error }); return; }
    const { rows: updated } = await query(
      `UPDATE credentials SET user_id = $1, name = $2, category = $3, number = $4, expiry_date = $5, updated_at = now()
       WHERE id = $6 AND company_id = $7 RETURNING id`,
      [body.userId, body.name, body.category, body.number, body.expiryDate, req.params.id, companyId]);
    if (!updated.length) { res.status(404).json({ error: 'Credential not found.' }); return; }
    const { rows } = await query(`${CRED_SQL} WHERE c.id = $1`, [req.params.id]);
    res.json({ credential: publicCredential(rows[0]) });
  } catch (err) {
    console.error('[credentials] update failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// DELETE /api/credentials/:id (owner/scheduler).
router.delete('/:id', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    await query('DELETE FROM credential_documents WHERE credential_id = $1 AND company_id = $2', [req.params.id, companyId]);
    const { rows } = await query('DELETE FROM credentials WHERE id = $1 AND company_id = $2 RETURNING id', [req.params.id, companyId]);
    if (!rows.length) { res.status(404).json({ error: 'Credential not found.' }); return; }
    res.json({ ok: true });
  } catch (err) {
    console.error('[credentials] delete failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

export default router;
