/**
 * In-app Notes feed — serves APP-NOTES.md (+ optional forward log summary).
 * Read-only; path defaults to VPS docs layout.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const prerender = false;

const DOCS_ROOT = process.env.BRIDGE_DOCS_ROOT || '/opt/cartesi-bridge/docs';
const APP_NOTES = resolve(DOCS_ROOT, 'APP-NOTES.md');
const FORWARD_LOG = resolve(DOCS_ROOT, 'PROJECT-FORWARD-LOG.md');

function corsHeaders() {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders() });
}

/** Split markdown into ## sections (newest first expected). */
function parseSections(md) {
  if (!md || !String(md).trim()) return [];
  const text = String(md).replace(/\r\n/g, '\n');
  // Drop leading H1 / intro before first ##
  const fromH2 = text.includes('\n## ') ? text.slice(text.indexOf('\n## ') + 1) : text;
  const parts = fromH2.split(/^## /m).filter((p) => p && p.trim());
  const sections = [];
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const title = (nl === -1 ? part : part.slice(0, nl)).trim().replace(/^#+\s*/, '');
    if (!title || title.startsWith('Bridge notes')) continue;
    const body = (nl === -1 ? '' : part.slice(nl + 1)).trim();
    if (!body) continue;
    const keep =
      /^\d{4}-\d{2}-\d{2}/.test(title) || title.toLowerCase().startsWith('how to use');
    if (!keep) continue;
    sections.push({ title, body, id: title.slice(0, 80) });
  }
  return sections;
}

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    const [appNotes, forwardLog] = await Promise.all([
      readOptional(APP_NOTES),
      readOptional(FORWARD_LOG),
    ]);

    const sections = parseSections(appNotes || '');
    // Keep "How to use" last; dated entries first as in file
    const entries = sections.filter((s) => !s.title.toLowerCase().startsWith('how to use'));
    const howto = sections.filter((s) => s.title.toLowerCase().startsWith('how to use'));

    const logTail = forwardLog
      ? forwardLog
          .trim()
          .split(/\n(?=## )/)
          .slice(-5)
          .join('\n')
      : null;

    return json(200, {
      ok: true,
      updatedAt: new Date().toISOString(),
      source: 'APP-NOTES.md',
      entries: [...entries, ...howto],
      rawMarkdown: appNotes || '',
      progressLogTail: logTail,
      notice:
        'Automated project-forward work must keep this demo usable. Risky features ship behind flags.',
    });
  } catch (e) {
    return json(500, { ok: false, error: String(e?.message || e) });
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}
