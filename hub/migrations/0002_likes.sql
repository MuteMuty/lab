-- Anonymous like counts (lab#16). One row per like, kept forever. No cookies, no raw IPs:
-- ip_hash is an HMAC of the IP and the day, used only for abuse limits and cleared after 30 days.
create table if not exists likes (
  id integer primary key,
  project text not null,
  day text not null,              -- YYYY-MM-DD, UTC
  receipt_hash text not null,     -- SHA-256 of the random receipt; only the receipt can undo the like
  ip_hash text                    -- null once the like is older than 30 days
);
create unique index if not exists likes_receipt on likes (receipt_hash);
-- At most one like per project per IP hash per day. Cleared (null) hashes never collide.
create unique index if not exists likes_once_a_day on likes (project, day, ip_hash);
-- Only rows that still hold a hash, so the cleanup stays cheap as likes pile up.
create index if not exists likes_hashed_day on likes (day) where ip_hash is not null;

-- Counts per project per day, kept in step with likes by the triggers below.
create table if not exists like_counts (
  project text not null,
  day text not null,
  n integer not null default 0,
  primary key (project, day)
);
create trigger if not exists likes_count_add after insert on likes
begin
  insert into like_counts (project, day, n) values (new.project, new.day, 1)
    on conflict (project, day) do update set n = n + 1;
end;
create trigger if not exists likes_count_remove after delete on likes
begin
  update like_counts set n = n - 1 where project = old.project and day = old.day;
end;

-- Burst limit: like and unlike requests per IP hash per minute. Rows older than the current minute are deleted.
create table if not exists like_hits (
  ip_hash text not null,
  minute text not null,           -- YYYY-MM-DDTHH:MM, UTC
  n integer not null default 0,
  primary key (ip_hash, minute)
);
create index if not exists like_hits_minute on like_hits (minute);
