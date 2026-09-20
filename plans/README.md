# 내장 파일 재사용과 manifest OTA 구현

기준: `next` / `ec78756926cac3b23ca32c1d3acefe28d2ebb7ab`.
작업: `feature/builtin-manifest-v1`, GPT-5.6 Sol / Medium.

[PRD](001-builtin-manifest-v1-prd.md)를 전부 읽고 순서대로 실행한다.
서브에이전트는 사용하지 않는다. 기존 main 및 Insights worktree는 수정하지 않는다.

| 단계 | 범위 | 의존 | 상태 | 증거 |
| --- | --- | --- | --- | --- |
| PRD | 요구·구현 계약·검증 기준 | — | DONE | `001-builtin-manifest-v1-prd.md` |
| M0 | Release 패키징 실측·재사용 검증 | PRD | DONE | `evidence/builtin-packaging.{md,json}` |
| M1 | 전체 파일 descriptor·base 없는 설치 | M0 조사 | DONE | server/SDK 34 tests, Android storage, Swift 36 tests, iOS Release Pod target |
| M2 | 내장 resolver·lazy 인덱스 | M0, M1 | IN PROGRESS | Android unit, Swift 28 tests, iOS Release E2E pass; Android device E2E pending |
| M3 | 전송 비용 검증·아카이브 제거 | M0–M2 gate | DONE | `evidence/manifest-transfer.{md,json}`; archive code/schema removed |
| M4 | 통합 검증·문서·changeset | M3 | IN PROGRESS | build/type/lint/integration/native checks pass; changeset added |

## 제외한 대안

- 필수 빌드 manifest 삽입: 이번에는 target manifest를 통한 lazy 조회를 우선 검증한다.
- 내장 폴더 전체 복사: 저장 공간과 초기화 비용이 늘어 필요한 파일만 복사한다.
- 해시 대신 파일명/이미지 동일성으로 재사용: 목표 바이트 검증을 약화한다.
- patch-only 배포: base/patch가 없거나 손상되면 업데이트를 복구할 수 없다.
- `updateStrategy` 제거: 사용자가 `compressStrategy`와 혼동했다고 정정했다.
- 최초 내장 Hermes patch 산출물 등록: 후속 최적화로 남기며 이번 구현 완료의 선행 조건으로 삼지 않는다.

## 실행 기록

- 2026-09-20: PRD 작성 완료. `next` 기준 별도 worktree 및 feature 브랜치 준비.
- 2026-09-20: workspace 26개 프로젝트 빌드 통과.
- 2026-09-20: Android Release AAB/APK와 arm64/en/xxhdpi split 설치 집합 실측. OTA 대상 18개 중 5개 재사용, 12개 누락, HBC 1개 불일치.
- 2026-09-20: iOS Release simulator app 실측. OTA 대상 18개 중 PNG 17개 재사용, HBC 1개 불일치.
- M0 상세 해시와 재현 명령은 `evidence/builtin-packaging.md` 및 JSON에 기록했다.
- 2026-09-20: artifact protocol v1을 별도 `/artifacts/v1/...` endpoint로 확정했다. v1은 모든 목표 파일의 원본 descriptor를 제공하고 archive URL/hash를 사용하지 않는다. unversioned endpoint는 제공하지 않는다.
- 2026-09-20: base 없는 manifest 설치, 기존 파일 손상 시 원본 복구, old server 비호환 처리를 server/SDK 34 tests, Android storage tests, Swift 36 tests로 검증했다. iOS `HotUpdater` Release Pod target도 codegen된 `assets` bridge와 함께 컴파일됐다.
- 2026-09-20: Android/iOS installer에 검증된 builtin 재사용을 연결했다. 두 플랫폼 첫 OTA 테스트에서 내장 이미지 URL 요청이 0회였고 HBC 원본만 다운로드됐다. Swift 38 tests에는 인덱스 손상 복구, 앱 번들 교체 무효화, 경로 이탈 거부가 포함된다. 실제 Release 앱 E2E 및 Android split resolver 증거는 M2 잔여 gate다.
- 2026-09-20: v1 미출시 조건에 따라 하위 호환 계층 없이 1.0.0 초기 schema와 provider 최초 migration을 직접 manifest 계약으로 변경했다. unversioned artifact endpoint와 legacy archive row는 지원하지 않는다.
- 2026-09-20: OTA ZIP/TAR 생성·전송·설치 코드와 fixtures를 제거했다. AWS Lambda@Edge 배포용 ZIP utility와 APK ZIP entry reader는 OTA archive가 아니므로 유지했다.
- 2026-09-20: workspace build 26 projects, typecheck 34 projects, lint, provider integration 383 tests, Android Gradle unit tests, Swift package tests, iOS app build를 통과했다. unit suite는 2,687/2,688 통과 후 60초를 0.86초 초과한 scaffold test를 단독 재실행해 6/6 통과했다.
- 2026-09-20: Detox default suite가 양 플랫폼에서 `bspatch-builtin-to-diff-ota`를 포함하는 dry-run을 통과했다.
- 2026-09-20: iOS Release simulator에서 `bspatch-builtin-to-diff-ota`가 78.747초에 통과했다. 첫 OTA의 builtin manifest 사용, 연속 OTA의 실제 HBC bsdiff 적용, Bundle ID·화면 marker·stable relaunch를 확인했다. Android E2E는 공유 device lease가 열리는 즉시 실행한다.
- 2026-09-20: 같은 Android Release 산출물을 7회 비교한 결과 첫 OTA는 1,048,299 → 830,077 bytes, OTA 간 HBC patch는 1,048,348 → 115,353 bytes로 줄었다. 1,000개 파일 전체 변경은 1,001 requests와 ZIP 대비 35.5% 느린 로컬 설치 시간을 보여 v1의 확장성 한계로 기록했다.
