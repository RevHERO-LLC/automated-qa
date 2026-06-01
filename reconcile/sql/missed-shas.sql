-- Returns the SHAs from the input array that have NO corresponding
-- changelog.changes record (matched by jsonb commit_shas value).
-- Usage: passes $1 = text[] of recent SHAs.
--
-- PREFIX match (not exact): the input SHAs come from the GitHub commits API
-- as full 40-char hashes, while changelog.commit_shas values follow the
-- documented Claude-Changelog convention of SHORT 7-char hashes (e.g.
-- "c1243c8"). An exact `kv.value = sha` therefore never matched any logged
-- entry, flagging every already-logged change as "missed". We instead treat
-- a commit as covered when any logged value is a prefix of the full SHA
-- (or equals it, for entries that happen to store full hashes). The
-- length(kv.value) >= 7 guard avoids false matches on stray short/empty
-- values. SHAs are lowercase hex from both git and the GitHub API, so a
-- plain LIKE is case-safe; hex contains no LIKE metacharacters.
SELECT sha
  FROM unnest($1::text[]) AS sha
 WHERE NOT EXISTS (
   SELECT 1
     FROM changelog.changes c,
          jsonb_each_text(c.commit_shas) AS kv
    WHERE length(kv.value) >= 7
      AND sha LIKE kv.value || '%'
 );
