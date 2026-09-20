# P2P Platform — Supabase edition

This is a deployment-ready starter using Supabase Auth/Database/Storage and an Express server.

## Important
- Payment screenshots do NOT automatically create balance.
- An order only credits balance after an admin approves the submitted payment proof.
- Do not put the Supabase service-role key in the browser or public repository.
- This package does not require Gmail. Optional notifications use Resend.

## 1. Supabase
You already created the `profiles`, `settings`, `orders`, `withdrawals` tables with the initial SQL.

Run `supabase_upgrade.sql` in SQL Editor.

## 2. Environment variables
Copy `.env.example` to `.env` and fill:
- SUPABASE_URL
- SUPABASE_PUBLISHABLE_KEY
- SUPABASE_SERVICE_ROLE_KEY
- ADMIN_EMAIL
- ADMIN_PASSWORD

The publishable key can be used by the browser, but the service-role key must stay server-side.

## 3. Run locally
npm install
npm start

Open http://localhost:3000

## 4. Admin
On first startup, the server creates/updates the Supabase Auth user specified by ADMIN_EMAIL and gives that user's profile role `admin`.

Change the admin password before using the site publicly.

## 5. Optional email
Set RESEND_API_KEY and NOTIFY_EMAIL if you want notification emails. Gmail is not required.

## 6. Deploy
This includes render.yaml for Render. Create a Render Web Service from this folder/repository and add the environment variables.

Free hosting tiers have quotas/sleep/temporary-storage limitations. Supabase Storage is used for payment screenshots so screenshots are not stored on the Render filesystem.

## Features
- Register/login/logout
- Order slots
- Bank/UPI payment instructions
- UPI deep-link button
- UTR + payment screenshot
- Admin review/approve/reject
- Balance credit only after approval
- Withdrawal requests
- Admin marks withdrawals paid/rejected
- Admin settings for bank details, UPI, support URL and order amounts
- Telegram support
