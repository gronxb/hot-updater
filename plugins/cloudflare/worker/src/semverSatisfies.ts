export const SEMVER_SATISFIES_SQL = (alias: string): string => {
    return /* sql */`
      CASE
        -- (1) Exact wildcard: "*"
        WHEN ${alias}.target_app_version = '*' THEN 1
  
        -- (2) Exact version: "N.M.P" (e.g. "1.2.3")
        WHEN ${alias}.target_app_version GLOB '[0-9]*.[0-9]*.[0-9]*'
             AND ${alias}.target_app_version NOT LIKE '%x%' AND ${alias}.target_app_version NOT LIKE '%X%'
          THEN CASE WHEN ${alias}.target_app_version = input.app_version THEN 1 ELSE 0 END
  
        -- (3) major.x.x pattern (e.g. "1.x.x")
        WHEN ${alias}.target_app_version GLOB '[0-9]*.[xX].[xX]' 
          THEN CASE 
                 WHEN CAST(substr(${alias}.target_app_version, 1, instr(${alias}.target_app_version, '.') - 1) AS INTEGER) =
                      CAST(substr(input.app_version, 1, instr(input.app_version, '.') - 1) AS INTEGER)
                 THEN 1 ELSE 0 END
  
        -- (4) major.minor.x pattern (e.g. "1.2.x")
        WHEN ${alias}.target_app_version GLOB '[0-9]*.[0-9]*.[xX]'
          THEN CASE 
                 WHEN CAST(substr(${alias}.target_app_version, 1, instr(${alias}.target_app_version, '.') - 1) AS INTEGER) =
                      CAST(substr(input.app_version, 1, instr(input.app_version, '.') - 1) AS INTEGER)
                   AND
                      CAST(
                        substr(
                          ${alias}.target_app_version,
                          instr(${alias}.target_app_version, '.')+1,
                          instr(${alias}.target_app_version || '.', '.') - instr(${alias}.target_app_version, '.') - 1
                        ) AS INTEGER
                      )
                      =
                      CAST(
                        substr(
                          input.app_version,
                          instr(input.app_version, '.')+1,
                          instr(input.app_version || '.', '.') - instr(input.app_version, '.') - 1
                        ) AS INTEGER
                      )
                 THEN 1 ELSE 0 END
  
        -- (5) major.minor pattern (e.g. "1.2")
        WHEN ${alias}.target_app_version GLOB '[0-9]*.[0-9]*'
             AND NOT(${alias}.target_app_version GLOB '*.[0-9]*.[0-9]*')
          THEN CASE 
                 WHEN CAST(substr(${alias}.target_app_version, 1, instr(${alias}.target_app_version, '.') - 1) AS INTEGER) =
                      CAST(substr(input.app_version, 1, instr(input.app_version, '.') - 1) AS INTEGER)
                   AND
                      CAST(substr(${alias}.target_app_version, instr(${alias}.target_app_version, '.')+1) AS INTEGER) =
                      CAST(substr(input.app_version, instr(input.app_version, '.')+1) AS INTEGER)
                 THEN 1 ELSE 0 END
  
        -- (6) dash range: "N.M.P - N.M.P" (e.g. "1.2.3 - 1.2.7")
        WHEN ${alias}.target_app_version GLOB '* - *'
          THEN CASE 
                 WHEN input.app_version >= trim(substr(${alias}.target_app_version, 1, instr(${alias}.target_app_version, '-') - 1))
                      AND input.app_version <= trim(substr(${alias}.target_app_version, instr(${alias}.target_app_version, '-')+1))
                 THEN 1 ELSE 0 END
  
        -- (7) inequality range: ">=N.M.P <N.M.P" (e.g. ">=1.2.3 <2.0.0")
        WHEN ${alias}.target_app_version GLOB '>=* <*'
          THEN CASE 
                 WHEN input.app_version >= trim(substr(${alias}.target_app_version, 3, instr(${alias}.target_app_version, ' ') - 3))
                      AND input.app_version < trim(substr(${alias}.target_app_version, instr(${alias}.target_app_version, '<')+1))
                 THEN 1 ELSE 0 END
  
        -- (8) tilde(~) pattern: "~N.M.P" (e.g. "~1.2.3" ⇒ >=1.2.3 AND <1.(minor+1).0)
        WHEN ${alias}.target_app_version GLOB '~[0-9]*.[0-9]*.[0-9]*'
          THEN CASE 
                 WHEN input.app_version >= substr(${alias}.target_app_version, 2)
                      AND input.app_version < (
                        substr(${alias}.target_app_version, 2, instr(${alias}.target_app_version, '.')-1)
                        || '.' ||
                        CAST(
                          CAST(
                            substr(
                              ${alias}.target_app_version,
                              instr(${alias}.target_app_version, '.')+1,
                              instr(substr(${alias}.target_app_version, instr(${alias}.target_app_version, '.')+1) || '.', '.') - 1
                            ) AS INTEGER
                          ) + 1 AS TEXT
                        )
                        || '.0'
                      )
                 THEN 1 ELSE 0 END
  
        -- (9) caret(^) pattern: "^N.M.P" (e.g. "^1.2.3" ⇒ >=1.2.3 AND <(major+1).0.0)
        WHEN ${alias}.target_app_version GLOB '\\^[0-9]*.[0-9]*.[0-9]*'
          THEN CASE 
                 WHEN input.app_version >= substr(${alias}.target_app_version, 2)
                      AND input.app_version < (
                        CAST(
                          CAST(
                            substr(${alias}.target_app_version, 2, instr(${alias}.target_app_version, '.')-1)
                            AS INTEGER
                          ) + 1 AS TEXT
                        )
                        || '.0.0'
                      )
                 THEN 1 ELSE 0 END
  
        -- (10) single major version: "N" (e.g. "1" ⇒ >=1.0.0 AND <2.0.0)
        WHEN ${alias}.target_app_version GLOB '[0-9]+'
          THEN CASE 
                 WHEN input.app_version >= (${alias}.target_app_version || '.0.0')
                      AND input.app_version < (CAST(${alias}.target_app_version AS INTEGER) + 1 || '.0.0')
                 THEN 1 ELSE 0 END
  
        -- (11) major.x pattern: "N.x" (e.g. "1.x" ⇒ >=1.0.0 AND <2.0.0)
        WHEN ${alias}.target_app_version GLOB '[0-9]+\.x'
          THEN CASE 
                 WHEN input.app_version >= (substr(${alias}.target_app_version, 1, instr(${alias}.target_app_version, '.') - 1) || '.0.0')
                      AND input.app_version < (CAST(substr(${alias}.target_app_version, 1, instr(${alias}.target_app_version, '.') - 1) AS INTEGER) + 1 || '.0.0')
                 THEN 1 ELSE 0 END
  
        ELSE 0
      END
    `;
  }