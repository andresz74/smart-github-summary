# smart-github-summary

Express API service for GitHub-only summaries.

## Endpoints

### Health
- `GET /health`

### Sync summary
- `POST /api/github-summary-v1`

### Async summary
- `POST /api/github-summary-v1/async`
- `GET /api/github-summary-v1/status/:requestId`

All summary endpoints require:
- header: `x-api-key: <GITHUB_SUMMARY_API_KEY>`

## Accepted payloads

### Extension-friendly payload (supported)
```json
{
  "repoUrl": "https://github.com/owner/repo",
  "transcript": "...",
  "model": "chatgpt"
}
```

### Structured payload (also supported)
```json
{
  "repo": "owner/repo",
  "type": "digest",
  "sourceId": "abc123",
  "title": "Repository summary",
  "content": "...",
  "model": "openai-chat-axios"
}
```

## Model handling

The service currently normalizes both `chatgpt` and `openai-chat-axios` to the same upstream `ai-access` route:
- `POST /api/openai-chat-axios`

## Environment

Copy `.env.example` to `.env` and fill values:

- `PORT` (default `8787`)
- `GITHUB_SUMMARY_API_KEY`
- `AI_ACCESS_BASE_URL`
- `AI_ACCESS_API_KEY`
- Firestore credentials (usually `GOOGLE_APPLICATION_CREDENTIALS`)

## Run

```bash
npm install
npm start
```

## Test

```bash
npm test
```

## Notes

- Summaries are stored in Firestore collection: `github-summaries`
- Async request state is stored in: `github-summary-requests`
