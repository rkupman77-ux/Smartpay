-- Run this after the original schema.
-- The server uses Supabase Auth for passwords; password_hash is retained
-- only for compatibility with the first schema.
alter table public.profiles
  alter column password_hash drop not null;

-- Make sure profiles use auth user IDs.
-- Existing rows can remain; new rows are created with auth.users.id.

-- Useful indexes
create index if not exists idx_orders_user_id on public.orders(user_id);
create index if not exists idx_orders_status on public.orders(status);
create index if not exists idx_withdrawals_user_id on public.withdrawals(user_id);
create index if not exists idx_withdrawals_status on public.withdrawals(status);

-- Storage bucket (safe if it already exists)
insert into storage.buckets (id, name, public)
values ('payment-screenshots','payment-screenshots',false)
on conflict (id) do nothing;
