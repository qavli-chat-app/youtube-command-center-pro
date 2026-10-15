# YouTube Command Center PRO

A YouTube-only, mobile-first channel management dashboard with a FastAPI backend. This repository is separate from QAVLI, NEXBOT, and orbit-social-manager.

## Important status notice

This is an **active implementation, not a verified production-complete platform**. The UI and backend routes are being built, but Google OAuth credentials, YouTube channel authorization, deployment, persistent production storage, and live API operations still require setup and testing. Never treat demo/empty states as live metrics.

## Included implementation

- Responsive dark/purple dashboard with separate YouTube-focused workspaces.
- FastAPI backend and `/health` health endpoint.
- Google OAuth authorization flow, one-time state validation, signed session cookie, encrypted credential storage, token refresh, local disconnect, and best-effort Google token revocation.
- Channel details and video library through official YouTube Data API v3.
- Video metadata updates, visibility changes, and thumbnail upload endpoints with confirmation in the UI.
- Private-by-default video upload with upload progress, persistent job records, and optional YouTube-native scheduled publishing.
- YouTube Analytics daily report endpoint with date-range validation.
- Official YouTube search-based topic research.
- Comment retrieval, replies, and explicit confirmation before moderation changes.
- Local, no-paid-API SEO draft generator and thumbnail preview.
- Basic API tests and GitHub Actions CI workflow.

## Feature status

| Feature | Current status |
|---|---|
| Dashboard/mobile UI | PARTIALLY WORKING — UI exists; responsive layout needs device/browser QA |
| Google OAuth | PARTIALLY WORKING — code exists; requires Google Cloud credentials and callback verification |
| Channel details and video library | PARTIALLY WORKING — endpoints exist; live owner-account testing required |
| Metadata, visibility, thumbnail actions | PARTIALLY WORKING — endpoints/UI exist; owner-channel verification required |
| Private upload and progress | PARTIALLY WORKING — endpoint exists; real upload and interrupted-upload recovery not verified |
| Scheduled publishing | PARTIALLY WORKING — requests YouTube-native publishAt scheduling; account eligibility and real scheduling need verification |
| Analytics | PARTIALLY WORKING — daily report endpoint exists; metric eligibility and live reports need verification |
| SEO manual drafts | WORKING as a local draft helper; not AI and does not guarantee rankings |
| Topic research | PARTIALLY WORKING — official search endpoint exists; quota and results need live verification |
| Comments and moderation | PARTIALLY WORKING — API routes exist; channel permissions and each moderation operation need testing |
| Persistent background scheduler/retries | NOT IMPLEMENTED — native YouTube scheduling is separate from an app-managed durable job worker |
| Database durability in production | BLOCKED — configure a persistent disk or external database before production use |
| Automated tests | PARTIALLY WORKING — tests and CI workflow added; passing results must be confirmed in GitHub Actions |
| Production deployment | NOT VERIFIED |

## Local setup

Requirements: Python 3.11+.

1. Create a virtual environment and install dependencies:

   ```bash
   python -m venv .venv
   # Windows: .venv\\Scripts\\activate
   # macOS/Linux: source .venv/bin/activate
   pip install -r requirements.txt
   ```

2. Copy `.env.example` to `.env` and set the variables in your **server environment**. Never commit `.env`.

3. In Google Cloud Console, create a project, enable **YouTube Data API v3** and **YouTube Analytics API**, create an OAuth 2.0 Web application client, and add the exact `GOOGLE_REDIRECT_URI` to its authorized redirect URIs. If the consent screen is in testing mode, add your Google account as a test user.

4. Generate `APP_SECRET` and `TOKEN_ENCRYPTION_KEY` locally. Keep the encryption key stable: changing it makes previously encrypted credentials unreadable. Never send secrets in chat or commit them.

5. Start the server:

   ```bash
   uvicorn app:app --reload --port 8000
   ```

6. Open `http://localhost:8000`. OAuth cookies are configured for HTTPS in production; local HTTP OAuth testing may require a secure local HTTPS tunnel or a development-only cookie setting. Do not disable secure cookies in production.

7. Run checks:

   ```bash
   python -m compileall -q app.py api_extensions.py tests
   pytest -q
   ```

## Production configuration

- Set `APP_SECRET`, `TOKEN_ENCRYPTION_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, and optionally `FRONTEND_ORIGIN` as server-side environment variables.
- For durable production storage, set `DATABASE_URL` to the Supabase PostgreSQL connection string (prefer the Supavisor session/transaction pooler URI provided by the Supabase dashboard, with SSL required). The app creates its required tables automatically and stores OAuth states, encrypted channel credentials, audit logs, and upload-job history in PostgreSQL. Keep the database password only in Railway Variables; never commit it. If `DATABASE_URL` is absent, local development/CI falls back to SQLite, which is ephemeral on Railway.
- Set `MAX_UPLOAD_BYTES` to a limit compatible with your host and available disk/memory.
- Use HTTPS and exact OAuth callback URLs.
- Monitor `/health`, application logs, Google API quota, and OAuth failures.
- Native YouTube scheduled publishing does not make the app's own job history durable. A separate background scheduler, retry worker, and persistent queue are still not implemented.
- Free hosts can sleep, limit execution time, or use ephemeral storage. Do not rely on an unverified free instance for uninterrupted background processing.

## Security

- Never put Google client secrets, refresh tokens, `APP_SECRET`, or the token encryption key in frontend JavaScript or public Git.
- Do not paste passwords or one-time codes into ChatGPT.
- Video uploads are private by default. Public/unlisted visibility changes and comment moderation require explicit confirmation in the UI.
- Do not enable real channel write operations until the Google account, channel, API scopes, and production storage have been verified.

## API overview

- `GET /health`
- `GET /api/auth/start`, `GET /api/auth/callback`, `GET /api/auth/status`, `POST /api/auth/disconnect`
- `GET /api/channel`, `GET /api/channel/settings`
- `GET /api/videos`, `PATCH /api/videos/{video_id}`, `PATCH /api/videos/{video_id}/visibility`
- `POST /api/videos/upload`, `POST /api/videos/{video_id}/thumbnail`, `GET /api/upload-jobs`
- `GET /api/analytics?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD`
- `GET /api/research?q=keyword`
- `GET /api/comments?video_id=VIDEO_ID`, `POST /api/comments/{comment_id}/reply`, `POST /api/comments/{comment_id}/moderate`
- `GET /api/notifications`, `GET /api/audit`

Google API quotas and channel permissions can block individual operations. API availability is not a guarantee that every account is eligible for every feature.
