-- Returns the SHAs from the input array that have NO corresponding
-- changelog.changes record (matched by jsonb commit_shas value).
-- Usage: passes $1 = text[] of recent SHAs.
SELECT sha
  FROM unnest($1::text[]) AS sha
 WHERE NOT EXISTS (
   SELECT 1
     FROM changelog.changes c,
          jsonb_each_text(c.commit_shas) AS kv
    WHERE kv.value = sha
 );
