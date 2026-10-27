-- Moderator cheat-sheet. Run these in the Supabase SQL Editor (which uses the
-- service role and so bypasses RLS). Nothing here is reachable with the anon key.

-- 1. The review queue: hidden reports and anything with flags, newest first.
select id, created_at, street, house_number, town, county, flag_count, moderation_status, notes,
       'https://YOUR-PROJECT.supabase.co/storage/v1/object/public/report-photos/' || photo_path as photo
  from public.reports
 where moderation_status = 'hidden' or flag_count > 0
 order by created_at desc;

-- 2. Reinstate a report and protect it from further auto-hiding:
-- update public.reports set moderation_status = 'approved', moderated_at = now() where id = '...';

-- 3. Take a report down (keeps the row for the record):
-- update public.reports set moderation_status = 'hidden', moderated_at = now() where id = '...';

-- 4. Delete a report and its photo outright (e.g. a person is identifiable):
--    a) Dashboard → Storage → report-photos → delete <client_id>.jpg
--    b) delete from public.reports where id = '...';
