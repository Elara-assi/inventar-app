WITH ranked_devices AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY session_id, device_fingerprint
      ORDER BY
        CASE WHEN revoked_at IS NULL THEN 0 ELSE 1 END,
        last_seen_at DESC NULLS LAST,
        created_at DESC,
        id DESC
    ) AS row_number
  FROM session_devices
  WHERE device_fingerprint IS NOT NULL
)
UPDATE session_devices AS d
SET device_fingerprint = d.device_fingerprint || ':duplicate:' || d.id::text
FROM ranked_devices AS ranked
WHERE d.id = ranked.id
  AND ranked.row_number > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_devices_session_fingerprint_unique
  ON session_devices(session_id, device_fingerprint)
  WHERE device_fingerprint IS NOT NULL;
