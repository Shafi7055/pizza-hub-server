# PizzaHub Server

REST API for the PizzaHub application.

## Run

```bash
npm install
cp .env.example .env
npm run dev
```

The API listens on `http://localhost:3002` by default. Set `CLIENT_ORIGIN` to the Next.js origin.
The server loads `.env` on startup. `TOKEN_SECRET` signs API authentication tokens; use a unique secret and keep `.env` out of version control. This implementation uses a JSON-backed store unless a MongoDB adapter is configured. Stripe, ImgBB, Google OAuth, SMTP, and MongoDB variables are optional integration configuration.

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
- `GET|POST|DELETE /api/favorites...`
- `GET|POST /api/reviews/:itemId`

Send authenticated requests as `Authorization: Bearer <token>`.
