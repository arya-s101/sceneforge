-- QA Report storage. Run this in Supabase SQL editor if the table does not exist.
create table if not exists reports (
  id text primary key,
  sandbox_id text not null,
  chaos_type text not null,
  report jsonb not null,
  created_at timestamptz default now()
);

create index if not exists idx_reports_sandbox_id on reports (sandbox_id);
