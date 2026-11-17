-- Stored files still to be deleted after their rows have gone. An
-- administrator's deletion of a finished envelope commits the row and the
-- record of its deletion first, then deletes the files; a file that could
-- not be deleted then (storage was down, the request stopped) stays named
-- here, and the daily cleanup tries it again until it is gone.

create table if not exists public.pending_file_deletions (
  storage_key text primary key,
  envelope_id text not null,
  queued_at bigint not null
);

create index if not exists pending_file_deletions_queued_at_idx
  on public.pending_file_deletions (queued_at);
