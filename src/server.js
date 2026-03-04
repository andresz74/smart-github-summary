import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import { initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import {
  buildMarkdownSummary,
  DEFAULT_MODEL,
  docIdFor,
  enrichMetadataFromTranscript,
  extractSummaryPayload,
  normalizeRequestBody,
} from './summary-utils.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

initializeApp();
const db = getFirestore();

const COLLECTION = 'github-summaries';
const REQUESTS_COLLECTION = 'github-summary-requests';

const PORT = Number(process.env.PORT || 8787);
const GITHUB_SUMMARY_API_KEY = process.env.GITHUB_SUMMARY_API_KEY || '';
const AI_ACCESS_API_KEY = process.env.AI_ACCESS_API_KEY || '';
const AI_ACCESS_BASE_URL = (process.env.AI_ACCESS_BASE_URL || '').replace(/\/$/, '');

function authFailed(req) {
  const requestKey = req.header('x-api-key');
  return !GITHUB_SUMMARY_API_KEY || !requestKey || requestKey !== GITHUB_SUMMARY_API_KEY;
}

function githubSummarySystemPrompt() {
  return `You summarize GitHub artifacts for engineers.
Return ONLY valid JSON with this exact shape:
{
  "summary": "string",
  "keyPoints": ["string"],
  "actionItems": ["string"]
}
Rules:
- summary: concise markdown, max 220 words.
- keyPoints: 4-8 bullets, each <= 20 words.
- actionItems: 0-6 concrete next steps.
- No prose outside JSON.`;
}

async function callAiAccessForSummary({ model, title, type, repo, sourceId, content }) {
  if (!AI_ACCESS_BASE_URL || !AI_ACCESS_API_KEY) {
    throw new Error('Missing AI_ACCESS_BASE_URL or AI_ACCESS_API_KEY');
  }

  const route = '/api/openai-chat-axios';

  const body = {
    modelMessages: [
      { role: 'system', content: githubSummarySystemPrompt() },
      {
        role: 'user',
        content: `Repository: ${repo}\nType: ${type}\nSource ID: ${sourceId}\nTitle: ${title}\n\nContent:\n${content}`,
      },
    ],
  };

  const response = await fetch(`${AI_ACCESS_BASE_URL}${route}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': AI_ACCESS_API_KEY,
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { text };
  }

  if (!response.ok) {
    throw new Error(`ai-access failed (${response.status}): ${text.slice(0, 300)}`);
  }

  return data;
}

async function persistSummary(input) {
  const id = docIdFor(input);
  const ref = db.collection(COLLECTION).doc(id);
  const now = FieldValue.serverTimestamp();

  await ref.set(
    {
      ...input,
      updatedAt: now,
      createdAt: now,
    },
    { merge: true },
  );

  return id;
}

async function getCachedSummary(normalized) {
  const id = docIdFor(normalized);
  const snap = await db.collection(COLLECTION).doc(id).get();
  if (!snap.exists) return null;

  const data = snap.data() || {};
  if (typeof data.summary !== 'string' || !data.summary.trim()) return null;
  const summary = data.summary.startsWith('---')
    ? data.summary
    : buildMarkdownSummary({
        normalized,
        metadata: enrichMetadataFromTranscript(normalized),
        summary: data.summary,
        keyPoints: Array.isArray(data.keyPoints) ? data.keyPoints : [],
        actionItems: Array.isArray(data.actionItems) ? data.actionItems : [],
      });

  return {
    id,
    repo: data.repo || normalized.repo,
    type: data.type || normalized.type,
    sourceId: data.sourceId || normalized.sourceId,
    title: data.title || normalized.title,
    summary,
    keyPoints: Array.isArray(data.keyPoints) ? data.keyPoints : [],
    actionItems: Array.isArray(data.actionItems) ? data.actionItems : [],
    model: data.model || normalized.model,
    version: data.version || 'v1',
    ...(data.metadata !== undefined ? { metadata: data.metadata } : {}),
    fromCache: true,
  };
}

async function setRequestStatus(requestId, patch) {
  await db
    .collection(REQUESTS_COLLECTION)
    .doc(requestId)
    .set(
      {
        requestId,
        updatedAt: FieldValue.serverTimestamp(),
        ...patch,
      },
      { merge: true },
    );
}

async function generateSummaryFromBody(body) {
  const normalized = normalizeRequestBody(body);
  if (!normalized.content) {
    const err = new Error('Missing content/transcript in payload');
    err.statusCode = 400;
    throw err;
  }

  const cached = await getCachedSummary(normalized);
  if (cached) {
    return cached;
  }

  const aiResponse = await callAiAccessForSummary(normalized);
  const rawText = typeof aiResponse?.text === 'string' ? aiResponse.text : '';
  const generated = extractSummaryPayload(rawText);

  if (!generated.summary) {
    const err = new Error('Model returned empty summary text.');
    err.statusCode = 502;
    err.code = 'EMPTY_SUMMARY';
    throw err;
  }

  const metadata = enrichMetadataFromTranscript(normalized);
  const summary = buildMarkdownSummary({
    normalized,
    metadata,
    summary: generated.summary,
    keyPoints: generated.keyPoints,
    actionItems: generated.actionItems,
  });

  const doc = {
    repo: normalized.repo,
    type: normalized.type,
    sourceId: normalized.sourceId,
    title: normalized.title,
    summary,
    keyPoints: generated.keyPoints,
    actionItems: generated.actionItems,
    model: normalized.model,
    version: 'v1',
    metadata: {
      repoUrl: normalized.metadata?.repoUrl || '',
      defaultBranch: normalized.metadata?.defaultBranch || '',
      description: metadata.description,
      languages: metadata.languages,
      image: metadata.image,
    },
  };

  const id = await persistSummary(doc);
  return { id, ...doc, fromCache: false };
}

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true, service: 'smart-github-summary' });
});

app.post('/api/github-summary-v1', async (req, res) => {
  if (authFailed(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const result = await generateSummaryFromBody(req.body || {});
    res.status(200).json({
      ok: true,
      collection: COLLECTION,
      id: result.id,
      fromCache: result.fromCache,
      summary: result.summary,
      keyPoints: result.keyPoints,
      actionItems: result.actionItems,
    });
  } catch (error) {
    const status = error?.statusCode || 502;
    res.status(status).json({
      error: 'Summary generation failed',
      code: error?.code || 'SUMMARY_UPSTREAM_FAILURE',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.post('/api/github-summary-v1/async', async (req, res) => {
  if (authFailed(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const requestId = crypto.randomUUID();
  const normalized = normalizeRequestBody(req.body || {});
  const cached = normalized.content ? await getCachedSummary(normalized) : null;

  if (cached) {
    await setRequestStatus(requestId, {
      status: 'succeeded',
      result: {
        summary: cached.summary,
        keyPoints: cached.keyPoints,
        actionItems: cached.actionItems,
        id: cached.id,
        fromCache: true,
      },
    });

    res.status(202).json({
      ok: true,
      requestId,
      status: 'succeeded',
      statusUrl: `/api/github-summary-v1/status/${requestId}`,
    });
    return;
  }

  await setRequestStatus(requestId, { status: 'queued' });

  setImmediate(async () => {
    try {
      await setRequestStatus(requestId, { status: 'processing' });
      const result = await generateSummaryFromBody(req.body || {});
      await setRequestStatus(requestId, {
        status: 'succeeded',
        result: {
          summary: result.summary,
          keyPoints: result.keyPoints,
          actionItems: result.actionItems,
          id: result.id,
          fromCache: result.fromCache,
        },
      });
    } catch (error) {
      await setRequestStatus(requestId, {
        status: 'failed',
        error: {
          code: error?.code || 'SUMMARY_UPSTREAM_FAILURE',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      });
    }
  });

  res.status(202).json({
    ok: true,
    requestId,
    status: 'queued',
    statusUrl: `/api/github-summary-v1/status/${requestId}`,
  });
});

app.get('/api/github-summary-v1/status/:requestId', async (req, res) => {
  if (authFailed(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { requestId } = req.params;
  const snap = await db.collection(REQUESTS_COLLECTION).doc(requestId).get();
  if (!snap.exists) {
    res.status(404).json({ error: 'Not found', requestId });
    return;
  }

  const data = snap.data() || {};
  res.status(200).json({
    requestId,
    status: data.status || 'queued',
    result: data.result || null,
    error: data.error || null,
  });
});

app.listen(PORT, () => {
  console.log(`smart-github-summary listening on :${PORT}`);
});
