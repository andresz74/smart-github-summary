import { onRequest } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import * as admin from 'firebase-admin';
admin.initializeApp();
const db = admin.firestore();
const GITHUB_SUMMARY_API_KEY = defineSecret('GITHUB_SUMMARY_API_KEY');
const AI_ACCESS_API_KEY = defineSecret('AI_ACCESS_API_KEY');
const AI_ACCESS_BASE_URL = defineSecret('AI_ACCESS_BASE_URL');
const COLLECTION = 'github-summaries';
const DEFAULT_MODEL = 'openai-chat-axios';
function sanitizeIdPart(value) {
    return value.trim().replace(/[\\/\s]+/g, '-').replace(/[^a-zA-Z0-9._-]/g, '');
}
function docIdFor(input) {
    return `${sanitizeIdPart(input.repo)}__${sanitizeIdPart(input.type)}__${sanitizeIdPart(input.sourceId)}`;
}
function isSummaryType(type) {
    return ['pr', 'issue', 'commit', 'release', 'digest'].includes(type);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
function authFailed(req) {
    const requestKey = req.header('x-api-key');
    const expectedKey = GITHUB_SUMMARY_API_KEY.value();
    return !requestKey || requestKey !== expectedKey;
}
async function persistSummary(input) {
    const id = docIdFor(input);
    const ref = db.collection(COLLECTION).doc(id);
    const now = admin.firestore.FieldValue.serverTimestamp();
    await ref.set({
        ...input,
        updatedAt: now,
        createdAt: now,
    }, { merge: true });
    return id;
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
function parseModelText(data) {
    if (!isRecord(data))
        return '';
    const text = data.text;
    return typeof text === 'string' ? text : '';
}
function normalizeStringArray(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((x) => typeof x === 'string' && x.trim().length > 0);
}
function extractSummaryPayload(rawText) {
    const trimmed = rawText.trim();
    if (!trimmed)
        return { summary: '', keyPoints: [], actionItems: [] };
    try {
        const parsed = JSON.parse(trimmed);
        return {
            summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '',
            keyPoints: normalizeStringArray(parsed.keyPoints),
            actionItems: normalizeStringArray(parsed.actionItems),
        };
    }
    catch (_) {
        return {
            summary: trimmed,
            keyPoints: [],
            actionItems: [],
        };
    }
}
async function callAiAccessForSummary(params) {
    const baseUrl = AI_ACCESS_BASE_URL.value().replace(/\/$/, '');
    const route = params.model === 'openai-chat-axios' ? '/api/openai-chat-axios' : '/api/openai-chat-axios';
    const body = {
        modelMessages: [
            { role: 'system', content: githubSummarySystemPrompt() },
            {
                role: 'user',
                content: `Repository: ${params.repo}\nType: ${params.type}\nSource ID: ${params.sourceId}\nTitle: ${params.title}\n\nContent:\n${params.content}`,
            },
        ],
    };
    const response = await fetch(`${baseUrl}${route}`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-api-key': AI_ACCESS_API_KEY.value(),
        },
        body: JSON.stringify(body),
    });
    const text = await response.text();
    let data = null;
    try {
        data = text ? JSON.parse(text) : null;
    }
    catch (_) {
        data = { text };
    }
    if (!response.ok) {
        throw new Error(`ai-access failed (${response.status}): ${text.slice(0, 300)}`);
    }
    return data;
}
export const upsertGithubSummary = onRequest({ secrets: [GITHUB_SUMMARY_API_KEY], region: 'us-central1' }, async (req, res) => {
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed. Use POST.' });
        return;
    }
    if (authFailed(req)) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
    }
    const body = req.body;
    if (!body ||
        typeof body.repo !== 'string' ||
        typeof body.type !== 'string' ||
        !isSummaryType(body.type) ||
        typeof body.sourceId !== 'string' ||
        typeof body.title !== 'string' ||
        typeof body.summary !== 'string') {
        res.status(400).json({
            error: 'Invalid payload. Required: repo, type(pr|issue|commit|release|digest), sourceId, title, summary',
        });
        return;
    }
    const input = {
        repo: body.repo,
        type: body.type,
        sourceId: body.sourceId,
        title: body.title,
        summary: body.summary,
        keyPoints: normalizeStringArray(body.keyPoints),
        actionItems: normalizeStringArray(body.actionItems),
        model: typeof body.model === 'string' ? body.model : undefined,
        version: typeof body.version === 'string' ? body.version : 'v1',
        metadata: isRecord(body.metadata) ? body.metadata : undefined,
    };
    const id = await persistSummary(input);
    res.status(200).json({ ok: true, collection: COLLECTION, id });
});
export const generateGithubSummary = onRequest({ secrets: [GITHUB_SUMMARY_API_KEY, AI_ACCESS_API_KEY, AI_ACCESS_BASE_URL], region: 'us-central1' }, async (req, res) => {
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed. Use POST.' });
        return;
    }
    if (authFailed(req)) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
    }
    const body = req.body;
    if (!body ||
        typeof body.repo !== 'string' ||
        typeof body.type !== 'string' ||
        !isSummaryType(body.type) ||
        typeof body.sourceId !== 'string' ||
        typeof body.title !== 'string' ||
        typeof body.content !== 'string') {
        res.status(400).json({
            error: 'Invalid payload. Required: repo, type(pr|issue|commit|release|digest), sourceId, title, content',
        });
        return;
    }
    try {
        const selectedModel = body.model || DEFAULT_MODEL;
        const aiResponse = await callAiAccessForSummary({
            model: selectedModel,
            title: body.title,
            type: body.type,
            repo: body.repo,
            sourceId: body.sourceId,
            content: body.content,
        });
        const rawText = parseModelText(aiResponse);
        const generated = extractSummaryPayload(rawText);
        if (!generated.summary) {
            res.status(502).json({
                error: 'Summary generation failed',
                code: 'EMPTY_SUMMARY',
                message: 'Model returned empty summary text.',
            });
            return;
        }
        const input = {
            repo: body.repo,
            type: body.type,
            sourceId: body.sourceId,
            title: body.title,
            summary: generated.summary,
            keyPoints: generated.keyPoints,
            actionItems: generated.actionItems,
            model: selectedModel,
            version: 'v1',
            metadata: isRecord(body.metadata) ? body.metadata : undefined,
        };
        const id = await persistSummary(input);
        res.status(200).json({
            ok: true,
            collection: COLLECTION,
            id,
            fromCache: false,
            summary: generated.summary,
            keyPoints: generated.keyPoints,
            actionItems: generated.actionItems,
        });
    }
    catch (error) {
        res.status(502).json({
            error: 'Summary generation failed',
            code: 'SUMMARY_UPSTREAM_FAILURE',
            message: error instanceof Error ? error.message : 'Unknown upstream error',
        });
    }
});
