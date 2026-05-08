// App-level shape for the public.users row. Mirrors the schema in
// supabase/migrations/0001_init_schema.sql so the UI can lean on a single
// type and we can swap in generated DB types later without churn.

export type AppUserStatus = 'pending' | 'active' | 'disabled'
export type GlobalRole = 'admin' | null

export interface AppUser {
  id: string
  email: string
  name: string
  status: AppUserStatus
  global_role: GlobalRole
  created_at: string
  approved_at: string | null
  approved_by: string | null
  last_seen_at: string | null
}
