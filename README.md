# PizzaHub Server

REST API for the PizzaHub application.

## Run

```bash
npm install
cp .env.example .env
npm run dev
```

The API listens on `http://localhost:3002` by default. Set `CLIENT_ORIGIN` to the Next.js origin. When `MONGODB_URI` is set, Better Auth serves sessions from `/api/better-auth`, with user and session records stored in MongoDB; the app's menu, order, and dashboard state is stored there too. Without MongoDB configured, the API uses the local JSON store and its existing email/password token auth for development; Better Auth and Google sign-in are disabled in that mode.

Copy `.env.example` to `.env` and replace the example secrets with unique values. Keep `.env` out of version control. The Google OAuth callback URL is `http://localhost:3002/api/better-auth/callback/google`; add it to the Google OAuth client's authorized redirect URIs. Set both Google variables to enable the Google sign-in button. `JWT_SECRET` is retained for the seeded demo-account flow; new email/password and Google sign-ins use Better Auth sessions.

Set `NEXT_PUBLIC_API_URL=http://localhost:3002` in the client environment (see the client `.env.example`). Stripe, ImgBB, and SMTP settings remain optional integrations.

For profile image uploads, set a valid `IMGBB_API_KEY` in the server `.env` (never in a `NEXT_PUBLIC_` client variable) and restart the API after changing it. The API reports ImgBB's rejection reason when an upload fails.

## Demo accounts

Seeded accounts use password `password`:

- `admin@pizzahub.example` / admin
- `hello@littleoven.example` / vendor
- `jamie@example.com` / customer

## Main endpoints

- `GET /api/health`
- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `GET /api/menu`
- `GET /api/menu/:id`
- `GET|POST|PATCH|DELETE /api/vendor/menu...`
- `GET|PATCH /api/admin/menu...`
- `GET|POST|PATCH|DELETE /api/orders...`
- `GET|PATCH /api/admin/users...`
- `GET /api/admin/transactions`
- `PATCH /api/auth/profile`
- `POST /api/vendor/profile/image` (multipart field `image`, PNG/JPEG/GIF/WebP, 5 MB max; requires `IMGBB_API_KEY`)
- `GET|POST|DELETE /api/favorites...`
- `GET|POST /api/reviews/:itemId`

Send authenticated requests as `Authorization: Bearer <token>`.
