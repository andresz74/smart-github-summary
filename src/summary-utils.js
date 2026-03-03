import crypto from 'node:crypto';

export const DEFAULT_MODEL = 'openai-chat-axios';
const SUPPORTED_MODEL_ALIASES = new Set(['openai-chat-axios', 'chatgpt']);
export const SUMMARY_TYPES = new Set(['pr', 'issue', 'commit', 'release', 'digest']);

export function sanitizeIdPart(value) {
  return String(value || '')
    .trim()
    .replace(/[\\/\s]+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '');
}

export function docIdFor({ repo, type, sourceId }) {
  return `${sanitizeIdPart(repo)}__${sanitizeIdPart(type)}__${sanitizeIdPart(sourceId)}`;
}

export function parseRepoFromUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!u.hostname.includes('github.com')) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    return `${parts[0]}/${parts[1]}`;
  } catch {
    return null;
  }
}

export function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((x) => typeof x === 'string' && x.trim().length > 0);
}

export function extractSummaryPayload(rawText) {
  const trimmed = String(rawText || '').trim();
  if (!trimmed) return { summary: '', keyPoints: [], actionItems: [] };

  try {
    const parsed = JSON.parse(trimmed);
    return {
      summary: typeof parsed?.summary === 'string' ? parsed.summary.trim() : '',
      keyPoints: normalizeStringArray(parsed?.keyPoints),
      actionItems: normalizeStringArray(parsed?.actionItems),
    };
  } catch {
    return { summary: trimmed, keyPoints: [], actionItems: [] };
  }
}

export function normalizeModel(model) {
  if (typeof model !== 'string') return DEFAULT_MODEL;
  const trimmed = model.trim();
  if (!trimmed) return DEFAULT_MODEL;
  if (SUPPORTED_MODEL_ALIASES.has(trimmed)) return DEFAULT_MODEL;
  return DEFAULT_MODEL;
}

export function normalizeRequestBody(body) {
  const repo =
    typeof body.repo === 'string'
      ? body.repo
      : parseRepoFromUrl(body.repoUrl || body.url) || 'unknown/unknown';
  const type = SUMMARY_TYPES.has(body.type) ? body.type : 'digest';
  const content =
    typeof body.content === 'string'
      ? body.content
      : typeof body.transcript === 'string'
        ? body.transcript
        : '';

  const sourceId =
    typeof body.sourceId === 'string' && body.sourceId.trim()
      ? body.sourceId
      : crypto
          .createHash('sha1')
          .update(`${repo}:${content.slice(0, 5000)}`)
          .digest('hex')
          .slice(0, 12);

  const title =
    typeof body.title === 'string' && body.title.trim()
      ? body.title
      : `Repository Summary: ${repo}`;

  return {
    repo,
    type,
    sourceId,
    title,
    content,
    model: normalizeModel(body.model),
    metadata:
      body && typeof body.metadata === 'object' && body.metadata !== null
        ? body.metadata
        : undefined,
  };
}
