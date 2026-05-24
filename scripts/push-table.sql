-- Run this once in Supabase SQL editor to create the push subscriptions table
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          bigint generated always as identity primary key,
  endpoint    text unique not null,
  subscription jsonb not null,
  user_agent  text,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);
