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

function safeString(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function safeUrl(value) {
  return safeString(value).trim();
}

function toYamlList(tags) {
  if (!Array.isArray(tags) || tags.length === 0) return '  - github\n  - repository';
  return tags.map(tag => `  - ${safeString(tag)}`).join('\n');
}

function toYamlBlock(value) {
  const text = safeString(value);
  return '|\n' + text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => `  ${line}`)
    .join('\n');
}

function normalizeTag(value) {
  return safeString(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function encodePathSegments(path) {
  return path
    .split('/')
    .filter(Boolean)
    .map(segment => encodeURIComponent(segment))
    .join('/');
}

function normalizeRelativePath(path) {
  const parts = [];
  safeString(path)
    .split('/')
    .forEach((part) => {
      if (!part || part === '.') return;
      if (part === '..') {
        parts.pop();
        return;
      }
      parts.push(part);
    });
  return parts.join('/');
}

function extractReadmeSection(content) {
  const match = safeString(content).match(/README:\n([\s\S]*?)\n\nSampled files:/);
  return match?.[1]?.trim() || '';
}

function resolveReadmeImageUrl(imagePath, { repoUrl, defaultBranch }) {
  const rawPath = safeString(imagePath).trim();
  if (!rawPath) return '';
  if (/^(https?:|data:)/i.test(rawPath)) {
    return rawPath.replace('/blob/', '/raw/');
  }

  const baseRepoUrl = safeUrl(repoUrl).replace(/\/$/, '');
  if (!baseRepoUrl) return '';

  const branch = safeString(defaultBranch, 'main') || 'main';
  const relativePath = normalizeRelativePath(rawPath.replace(/^\/+/, ''));
  if (!relativePath) return '';
  return `${baseRepoUrl}/raw/${encodeURIComponent(branch)}/${encodePathSegments(relativePath)}`;
}

function extractReadmeImageUrl(content, metadata) {
  const readme = extractReadmeSection(content);
  if (!readme) return '';

  const markdownImage = readme.match(/!\[[^\]]*\]\(([^)]+)\)/);
  if (markdownImage?.[1]) {
    return resolveReadmeImageUrl(markdownImage[1], metadata);
  }

  const htmlImage = readme.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (htmlImage?.[1]) {
    return resolveReadmeImageUrl(htmlImage[1], metadata);
  }

  return '';
}

function repoDisplayName(repo) {
  const slug = safeString(repo).split('/').pop() || safeString(repo);
  if (!slug) return 'Repository';
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

function prefixSummaryWithRepoLink(summary, { repo, repoUrl }) {
  const text = safeString(summary).trim();
  if (!text || !repoUrl) return text;

  const repoSlug = safeString(repo).split('/').pop() || safeString(repo);
  const displayName = repoDisplayName(repo);
  const linkedName = `**[${displayName}](${repoUrl})**`;
  const escapedRepo = safeString(repo).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedSlug = safeString(repoSlug).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`^(?:\\*\\*)?${escapedRepo}(?:\\*\\*)?\\s+`, 'i'),
    new RegExp(`^(?:\\*\\*)?${escapedSlug}(?:\\*\\*)?\\s+`, 'i'),
  ];

  for (const pattern of patterns) {
    if (pattern.test(text)) {
      const rest = text.replace(pattern, '').trimStart();
      return rest ? `${linkedName} ${rest}` : linkedName;
    }
  }

  return `${linkedName} ${text}`;
}

export function extractTranscriptMetadata(content) {
  const transcript = safeString(content);
  const descriptionMatch = transcript.match(/^Description:\s*(.*)$/m);
  const repoMatch = transcript.match(/^Repository:\s*([^\n]+)$/m);
  const languagesMatch = transcript.match(/Languages:\n([\s\S]*?)\nREADME:/m);

  let languageNames = [];
  if (languagesMatch?.[1]) {
    try {
      const parsed = JSON.parse(languagesMatch[1].trim());
      languageNames = Object.keys(parsed || {}).filter(Boolean).slice(0, 5);
    } catch {
      languageNames = [];
    }
  }

  return {
    repo: repoMatch?.[1]?.trim() || '',
    description: descriptionMatch?.[1]?.trim() || '',
    languages: languageNames,
  };
}

export function enrichMetadataFromTranscript(normalized) {
  const transcriptMetadata = extractTranscriptMetadata(normalized.content);
  const mergedMetadata = {
    ...transcriptMetadata,
    ...(normalized.metadata || {}),
  };

  return {
    ...mergedMetadata,
    image: extractReadmeImageUrl(normalized.content, {
      repoUrl: mergedMetadata.repoUrl,
      defaultBranch: mergedMetadata.defaultBranch,
    }),
  };
}

export function buildSummaryFrontmatter({ normalized, metadata, tags }) {
  const today = new Date().toISOString().slice(0, 10);
  const title = safeString(normalized.repo || metadata.repo || 'unknown/unknown');
  const description = metadata.description || `Summary for ${title}`;
  const repoUrl = safeString(normalized.metadata?.repoUrl || normalized.metadata?.url || '');
  const image = safeString(metadata.image);

  return `---
title: "${title}"
date: ${today}
type: ${safeString(normalized.type, 'digest')}
description: ${toYamlBlock(description)}
image: '${image}'
tags:
${toYamlList(tags)}
repo: ${title}
repo_url: ${repoUrl}
source_id: ${safeString(normalized.sourceId)}
generated_by: smart-github-summary
---
# ${title}
`;
}

export function buildMarkdownSummary({ normalized, metadata, summary, keyPoints, actionItems }) {
  const tagInputs = [
    'github',
    'repository',
    normalized.repo.split('/')[0],
    ...metadata.languages.slice(0, 3),
  ]
    .map(normalizeTag)
    .filter(Boolean);
  const tags = [...new Set(tagInputs)].slice(0, 8);
  const linkedSummary = prefixSummaryWithRepoLink(summary, {
    repo: normalized.repo || metadata.repo,
    repoUrl: normalized.metadata?.repoUrl || normalized.metadata?.url || '',
  });

  const sections = [
    buildSummaryFrontmatter({ normalized, metadata, tags }),
    '',
  ];

  if (metadata.image) {
    sections.push(`![](${metadata.image})`, '');
  }

  sections.push(linkedSummary.trim());

  if (keyPoints.length > 0) {
    sections.push('', '## Key Points', ...keyPoints.map(point => `- ${point}`));
  }

  if (actionItems.length > 0) {
    sections.push('', '## Action Items', ...actionItems.map(item => `- ${item}`));
  }

  return sections.join('\n').trim();
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
        ? {
            ...body.metadata,
            ...((body.metadata.repoUrl || body.repoUrl || body.url)
              ? { repoUrl: body.metadata.repoUrl || body.repoUrl || body.url }
              : {}),
          }
        : undefined,
  };
}
