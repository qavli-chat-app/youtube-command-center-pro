# YouTube Command Center PRO

A mobile-first dashboard for managing your own YouTube channel through Google's official YouTube APIs.

## Status

This repository is being scaffolded. The current UI is a frontend foundation; it does **not** yet authenticate with Google, fetch live channel analytics, upload videos, schedule publishing, or moderate comments. Demo values are explicitly labeled. Do not treat them as live YouTube data.

## Principles

- YouTube-only scope.
- Use official YouTube Data API v3 and YouTube Analytics API with OAuth 2.0.
- Never put OAuth client secrets, access tokens, or refresh tokens in frontend code or commit them to Git.
- Destructive actions must require explicit confirmation.
- New uploads should default to private until the user chooses otherwise.
- No claims of successful deployment or API operation without verification.
- Free-first dependencies; check hosting/API quotas before relying on them.

## Frontend

Requirements: Node.js 20+ and npm.

```bash
npm install
npm run dev
npm run build
```

## Configuration roadmap

1. Create a Google Cloud project and enable YouTube Data API v3 and YouTube Analytics API.
2. Configure OAuth consent and authorized redirect URIs.
3. Implement OAuth on a backend, store tokens securely server-side, and expose only authenticated application endpoints to this frontend.
4. Add persistent storage for scheduled jobs; do not rely on an ephemeral/free instance's local filesystem for durable jobs.
5. Run tests using mocked API calls before enabling any write operation against a real channel.

## Current feature status

- Responsive dashboard shell: initial implementation
- Overview/video/analytics panels: demo UI only
- Google OAuth: not implemented
- Live video library and channel metrics: not implemented
- Uploads/scheduling/comments/automation: not implemented
- Production deployment: not verified

Never commit `.env` files or credentials. See `.env.example` for placeholder configuration names.