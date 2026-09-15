-- The Supabase platform primitives the migrations assume. Needed only when
-- running against a bare PostgreSQL; Supabase itself provides all of these.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS storage;
-- Mirrors the columns SSA's own triggers read off auth.users. 0001 installs a
-- trigger that reads raw_user_meta_data, so a stub without it fails at the first
-- fixture insert rather than at anything the test is actually about.
CREATE TABLE IF NOT EXISTS auth.users (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email               TEXT,
    raw_user_meta_data  JSONB NOT NULL DEFAULT '{}'::jsonb,
    raw_app_meta_data   JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS UUID LANGUAGE SQL STABLE AS $$ SELECT NULL::uuid $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT LANGUAGE SQL STABLE AS $$ SELECT 'authenticated'::text $$;
CREATE OR REPLACE FUNCTION auth.jwt()  RETURNS JSONB LANGUAGE SQL STABLE AS $$ SELECT '{}'::jsonb $$;
DO $$ BEGIN CREATE ROLE authenticated;  EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE anon;           EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role;   EXCEPTION WHEN duplicate_object THEN NULL; END $$;
