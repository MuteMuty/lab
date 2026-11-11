create table if not exists suggestions (
  id integer primary key,
  created_at text not null,
  text text not null,
  project text,
  ip_hash text not null,
  status text not null default 'new'
);
create index if not exists suggestions_ip_time on suggestions (ip_hash, created_at);
create index if not exists suggestions_status on suggestions (status);
