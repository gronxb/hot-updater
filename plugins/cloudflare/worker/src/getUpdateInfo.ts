import { Platform, UpdateInfo, UpdateStatus } from "@hot-updater/core";

export const getUpdateInfo = async (
    DB: D1Database,
    {platform, appVersion, bundleId}:{platform: Platform, appVersion: string, bundleId: string},
) => {
    const sql = /* sql */`
         WITH input AS (
           SELECT 
             ? AS app_platform,       -- e.g. 'ios' or 'android'
             ? AS app_version,        -- e.g. '1.2.3'
             ? AS bundle_id,          -- current bundle id (string)
             '00000000-0000-0000-0000-000000000000' AS nil_uuid
         ),
         update_candidates AS (
           SELECT 
             b.id,
             b.should_force_update,
             b.file_url,
             b.file_hash,
             'UPDATE' AS status,
             CASE 
               -- (1) Exact wildcard: "*"
               WHEN b.target_app_version = '*' THEN 1
         
               -- (2) Exact version: "N.M.P" (e.g. "1.2.3")
               WHEN b.target_app_version GLOB '[0-9]*.[0-9]*.[0-9]*'
                    AND b.target_app_version NOT LIKE '%x%' AND b.target_app_version NOT LIKE '%X%'
                 THEN CASE WHEN b.target_app_version = input.app_version THEN 1 ELSE 0 END
         
               -- (3) major.x.x pattern (e.g. "1.x.x")
               WHEN b.target_app_version GLOB '[0-9]*.[xX].[xX]' 
                 THEN CASE 
                        WHEN CAST(substr(b.target_app_version, 1, instr(b.target_app_version, '.') - 1) AS INTEGER) =
                             CAST(substr(input.app_version, 1, instr(input.app_version, '.') - 1) AS INTEGER)
                        THEN 1 ELSE 0 END
         
               -- (4) major.minor.x pattern (e.g. "1.2.x")
               WHEN b.target_app_version GLOB '[0-9]*.[0-9]*.[xX]'
                 THEN CASE 
                        WHEN CAST(substr(b.target_app_version, 1, instr(b.target_app_version, '.') - 1) AS INTEGER) =
                             CAST(substr(input.app_version, 1, instr(input.app_version, '.') - 1) AS INTEGER)
                          AND
                             CAST(substr(b.target_app_version, instr(b.target_app_version, '.')+1, 
                                      instr(substr(b.target_app_version, instr(b.target_app_version, '.')+1), '.') - 1) AS INTEGER)
                             =
                             CAST(substr(input.app_version, instr(input.app_version, '.')+1, 
                                      instr(substr(input.app_version, instr(input.app_version, '.')+1), '.') - 1) AS INTEGER)
                        THEN 1 ELSE 0 END
         
               -- (5) major.minor pattern (e.g. "1.2")
               WHEN b.target_app_version GLOB '[0-9]*.[0-9]*'
                    AND NOT(b.target_app_version GLOB '*.[0-9]*.[0-9]*')
                 THEN CASE 
                        WHEN CAST(substr(b.target_app_version, 1, instr(b.target_app_version, '.') - 1) AS INTEGER) =
                             CAST(substr(input.app_version, 1, instr(input.app_version, '.') - 1) AS INTEGER)
                          AND
                             CAST(substr(b.target_app_version, instr(b.target_app_version, '.')+1) AS INTEGER) =
                             CAST(substr(input.app_version, instr(input.app_version, '.')+1) AS INTEGER)
                        THEN 1 ELSE 0 END
         
               -- (6) dash range: "N.M.P - N.M.P" (e.g. "1.2.3 - 1.2.7")
               WHEN b.target_app_version GLOB '* - *'
                 THEN CASE 
                        WHEN input.app_version >= trim(substr(b.target_app_version, 1, instr(b.target_app_version, '-') - 1))
                             AND input.app_version <= trim(substr(b.target_app_version, instr(b.target_app_version, '-')+1))
                        THEN 1 ELSE 0 END
         
               -- (7) inequality range: ">=N.M.P <N.M.P" (e.g. ">=1.2.3 <2.0.0")
               WHEN b.target_app_version GLOB '>=* <*'
                 THEN CASE 
                        WHEN input.app_version >= trim(substr(b.target_app_version, 3, instr(b.target_app_version, ' ') - 3))
                             AND input.app_version < trim(substr(b.target_app_version, instr(b.target_app_version, '<')+1))
                        THEN 1 ELSE 0 END
         
               -- (8) tilde(~) pattern: "~N.M.P" (e.g. "~1.2.3" ⇒ >=1.2.3 AND <1.3.0)
               WHEN b.target_app_version GLOB '~[0-9]*.[0-9]*.[0-9]*'
                 THEN CASE 
                        WHEN input.app_version >= substr(b.target_app_version, 2)
                             AND input.app_version < (
                               CAST(substr(substr(b.target_app_version,2), 1, instr(substr(b.target_app_version,2),'.')-1) AS TEXT)
                               || '.' ||
                               CAST(CAST(substr(substr(b.target_app_version,2), instr(substr(b.target_app_version,2),'.')+1, 
                                      instr(substr(substr(b.target_app_version,2), instr(substr(b.target_app_version,2),'.')+1),'.') - 1) AS INTEGER) + 1 AS TEXT)
                               || '.0'
                             )
                        THEN 1 ELSE 0 END
         
               -- (9) caret(^) pattern: "^N.M.P" (e.g. "^1.2.3" ⇒ >=1.2.3 AND <2.0.0)
               WHEN b.target_app_version GLOB '\\^[0-9]*.[0-9]*.[0-9]*'
                 THEN CASE 
                        WHEN input.app_version >= substr(b.target_app_version, 2)
                             AND input.app_version < (
                               CAST(CAST(substr(substr(b.target_app_version,2), 1, instr(substr(b.target_app_version,2),'.')-1) AS INTEGER) + 1 AS TEXT)
                               || '.0.0'
                             )
                        THEN 1 ELSE 0 END
         
               -- (10) single major version: "N" (e.g. "1" ⇒ >=1.0.0 AND <2.0.0)
               WHEN b.target_app_version GLOB '[0-9]+'
                 THEN CASE 
                        WHEN input.app_version >= (b.target_app_version || '.0.0')
                             AND input.app_version < (CAST(b.target_app_version AS INTEGER) + 1 || '.0.0')
                        THEN 1 ELSE 0 END
         
               -- (11) major.x pattern: "N.x" (e.g. "1.x" ⇒ >=1.0.0 AND <2.0.0)
               WHEN b.target_app_version GLOB '[0-9]+\.x'
                 THEN CASE 
                        WHEN input.app_version >= (substr(b.target_app_version, 1, instr(b.target_app_version, '.') - 1) || '.0.0')
                             AND input.app_version < (CAST(substr(b.target_app_version, 1, instr(b.target_app_version, '.') - 1) AS INTEGER) + 1 || '.0.0')
                        THEN 1 ELSE 0 END
         
               ELSE 0
             END AS version_match
           FROM bundles b, input
           WHERE b.enabled = 1
             AND b.platform = input.app_platform
             AND b.id >= input.bundle_id
           ORDER BY b.id DESC
         ),
         update_candidate AS (
           SELECT id, should_force_update, file_url, file_hash, status
           FROM update_candidates
           WHERE version_match = 1
           LIMIT 1
         ),
         rollback_candidate AS (
           SELECT 
             b.id,
             1 AS should_force_update,
             b.file_url,
             b.file_hash,
             'ROLLBACK' AS status
           FROM bundles b, input
           WHERE b.enabled = 1
             AND b.platform = input.app_platform
             AND b.id < input.bundle_id
           ORDER BY b.id DESC
           LIMIT 1
         ),
         final_result AS (
           SELECT * FROM update_candidate
           UNION ALL
           SELECT * FROM rollback_candidate
           WHERE NOT EXISTS (SELECT 1 FROM update_candidate)
         )
         SELECT id, should_force_update, file_url, file_hash, status
         FROM final_result, input
         WHERE id <> bundle_id
         
         UNION ALL
         
         SELECT 
           nil_uuid AS id,
           1 AS should_force_update,
           NULL AS file_url,
           NULL AS file_hash,
           'ROLLBACK' AS status
         FROM input
         WHERE (SELECT COUNT(*) FROM final_result) = 0
           AND bundle_id <> nil_uuid;
               `;

    const result = await DB.prepare(sql)
        .bind(platform, appVersion, bundleId)
        .first<{
            id: string;
            should_force_update: number;
            file_url: string | null;
            file_hash: string | null;
            status: UpdateStatus;
        }>();

    if (!result) {
        return null;
    }

    return {
        id: result.id,
        shouldForceUpdate: Boolean(result.should_force_update),
        fileUrl: result.file_url,
        fileHash: result.file_hash,
        status: result.status,
    } as UpdateInfo;
};
