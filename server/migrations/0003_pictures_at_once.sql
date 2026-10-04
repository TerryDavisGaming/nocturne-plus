-- nocturne+ hub: uploaders' listing pictures show at once, with nothing for the owner to approve. The first
-- hub held a new uploader's picture for picture_delay_hours (seeded as 24); the default is now 0.
--
-- Runs once. The marker row 'pictures_at_once' is written last, and every statement above it does nothing
-- when the marker is already there. src/cron.js pictureCatchUp() does the same three steps for a database
-- that was never migrated, with the same marker, so whichever runs first wins and the other does nothing.
--
-- A delay the owner chose is kept: the setting changes only if it is still the seeded 24 and /admin never
-- saved a picture_delay_hours (the audit row of such a save names the key). Waiting pictures that have a due time
-- (only the old delay made those) are shown only when the delay is now 0, so an owner who wants a delay keeps it.
-- A waiting picture with no due time is held for the owner's OK (a key the owner refused a picture of): it stays.
UPDATE settings SET v = '0'
 WHERE k = 'picture_delay_hours' AND v = '24'
   AND NOT EXISTS (SELECT 1 FROM settings WHERE k = 'pictures_at_once')
   AND NOT EXISTS (SELECT 1 FROM audit WHERE action = 'settings' AND detail LIKE '%"picture_delay_hours"%');

UPDATE packages SET picture_state = 'shown', picture_due = NULL
 WHERE picture_state = 'waiting' AND picture_due IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM settings WHERE k = 'pictures_at_once')
   AND coalesce((SELECT v FROM settings WHERE k = 'picture_delay_hours'), '0') = '0';

INSERT OR IGNORE INTO settings (k, v) VALUES ('pictures_at_once', '1');
