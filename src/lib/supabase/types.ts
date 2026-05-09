// App-level shape for the public.users row. Mirrors the schema in
// supabase/migrations/0001_init_schema.sql so the UI can lean on a single
// type and we can swap in generated DB types later without churn.

export type AppUserStatus = 'pending' | 'active' | 'disabled'
export type GlobalRole = 'admin' | null
export type MembershipRole =
  | 'team_manager'
  | 'coach'
  | 'tl1'
  | 'tl2'
  | 'consultant'

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
  // Pre-filled by an open-link invitation redemption (0005, 0006). Used by
  // the admin approval form to default the team / role / boat dropdowns.
  requested_team_id: string | null
  requested_role: MembershipRole | null
  requested_boat_id: string | null
}
