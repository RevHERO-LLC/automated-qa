-- Inverse of missed-shas.sql: returns the input SHAs that ARE covered by a
-- changelog.changes record. Used by the auto-close pass to close stale
-- [CHANGELOG-MISSED] issues once a (possibly backfilled / late) record exists.
--
-- Symmetric prefix match: issue-title SHAs are SHORT 7-char prefixes, whereas
-- changelog.commit_shas values may be short (7-char, per the documented
-- convention) OR full 40-char hashes. A commit is therefore covered when a
-- stored value and the input share a prefix in EITHER direction:
--   kv.value LIKE sha || '%'  -> stored full/short value starts with the 7-char input
--   sha LIKE kv.value || '%'  -> input starts with a stored (<=7-char) value
-- The length(kv.value) >= 7 guard avoids false matches on stray short/empty
-- values. SHAs are lowercase hex from both git and the GitHub API, so a plain
-- LIKE is case-safe; hex contains no LIKE metacharacters.
-- Usage: passes $1 = text[] of short (or full) SHAs to test.
SELECT sha
  FROM unnest($1::text[]) AS sha
 WHERE EXISTS (
   SELECT 1
     FROM changelog.changes c,
          jsonb_each_text(c.commit_shas) AS kv
    WHERE length(kv.value) >= 7
      AND (kv.value LIKE sha || '%' OR sha LIKE kv.value || '%')
 );
