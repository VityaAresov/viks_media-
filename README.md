# Viks Media 2.0

DTF/KOD-inspired media community platform for videographers, photographers, and creators.

## Implemented

- Registration/login/logout with hashed passwords and sessions.
- Email verification (required for post/comment/like/bookmark/report actions).
- Password reset flow via email link.
- Category + tag + keyword feed filtering with pagination.
- Markdown publishing with sanitized HTML render + live preview.
- URL-based media embeds (image + YouTube/direct video).
- Likes, bookmarks, nested comments, and comment reactions (`like`, `heart`, `fire`, `clap`).
- Profile/account pages with tabs (`Posts`, `Bookmarks`, `Moderation` for staff).
- Reports and moderation queue (`open`, `in_review`, `resolved`, `dismissed`).
- Moderator actions: assign/resolve reports, hide/unhide posts/comments, suspend/ban users.
- Admin user management: role changes (`user`, `moderator`, `admin`).
- JSON datastore with schema migration + atomic queued writes.
- Rate limits and blocked-word validation for anti-spam baseline.

## Stack

- Node.js + Express
- EJS templates
- JSON file datastore (`data/app.json`)
- `express-session` + `session-file-store`
- `marked` + `sanitize-html`
- `nodemailer`
- `express-rate-limit`

## Setup

```bash
npm install
npm run start
```

Open `http://localhost:3000`.

## Environment

Copy `.env.example` values into your environment:

- `PORT`
- `SESSION_SECRET`
- `APP_BASE_URL`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`
- `RATE_LIMIT_WINDOW_MS`
- `RATE_LIMIT_MAX_AUTH`
- `RATE_LIMIT_MAX_POSTS`
- `BLOCKED_WORDS`

If SMTP variables are not provided, email payloads are logged via JSON transport for local development.

## Notes

- First registered account is auto-assigned `admin` role for bootstrap.
- Existing `data/app.json` files are migrated to schema v2 on startup.
