# 내장 파일 재사용과 manifest OTA 구현

기준: `origin/next` / `333188ab9`를 `1aa201bbd`에서 병합했다. 앞선 fingerprint 충돌 5곳을 해결했고 #1322 네이티브 변경 후 다시 생성했다.
작업: `feature/builtin-manifest-v1`. 적대적 검토·구현 서브에이전트: GPT-5.6 Sol / Medium.

[PRD](001-builtin-manifest-v1-prd.md)를 전부 읽고 순서대로 실행한다.
사용자가 요청한 두 서브에이전트의 적대적 합의에 따라 tar.br 단일 보조 경로를 구현한다. 기존 main 및 Insights worktree는 수정하지 않는다.

| 단계 | 범위 | 의존 | 상태 | 증거 |
| --- | --- | --- | --- | --- |
| PRD | 요구·구현 계약·검증 기준 | — | DONE | `001-builtin-manifest-v1-prd.md` |
| M0 | Release 패키징 실측·재사용 검증 | PRD | DONE | `evidence/builtin-packaging.{md,json}` |
| M1 | 전체 파일 descriptor·base 없는 설치 | M0 조사 | DONE | server/SDK 34 tests, Android storage, Swift 36 tests, iOS Release Pod target |
| M2 | 내장 resolver·lazy 인덱스 | M0, M1 | REVERIFY | Android unit, Swift 28 tests, five full Release E2E profiles on iOS and Android |
| M3 | tar.br 단일 보조 경로·전송 비용 검증 | M0–M2 gate | DONE | `evidence/native-tar-br-transfer.{md,json}`; 80 native runs, 1,000-file uncapped 9.174s → 0.905s, 1,001 → 2 requests; 512 KiB/s에서는 거의 동률 |
| M4 | 통합 검증·문서·changeset | M3 | REVERIFY | tar.br 구현 후 최종 revision의 required checks 및 다섯 full standalone profile 재실행 |

2026-09-21 PRD 재검증에서 이전 완료 판정을 정정했다. cached target 무결성,
descriptor 전체 검증, 중단 후 완료 파일 재사용, 제한된 병렬 다운로드,
실제 내장 PNG/font의 0-download E2E, download-only progress를 보강한다.
기존 standalone 성공 기록은 아래의 이전 revision 결과이며, 새 수정의 성공으로
재사용하지 않는다. 실제 native installer 성능과 새 PR revision의 E2E를 기록한 뒤
위 상태를 갱신한다.

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
- 2026-09-21: 최신 revision `0e821f7fa`의 `standalone-prisma` full Release E2E가 iOS 15/15 + 11/11, Android 26/26으로 통과했다. 양 플랫폼에서 `fingerprint-initial-install`과 `bspatch-builtin-to-diff-ota`를 포함해 native fingerprint와 builtin manifest OTA 경로를 검증했다. 나머지 standalone 프로필은 큐에서 계속 실행 중이다.
- 2026-09-21: 같은 revision의 `standalone-kysely` full Release E2E도 iOS 15/15 + 11/11, Android 26/26으로 통과했다. `standalone-mongodb` 검증이 이어서 시작됐다.
- 2026-09-21: `standalone-mongodb` full Release E2E도 iOS 15/15 + 11/11, Android 26/26으로 통과했다. 최신 revision 재검증은 DynamoDB와 Drizzle 프로필이 남았다.
- 2026-09-21: `standalone-dynamodb` full Release E2E가 같은 revision에서 iOS 15/15 + 11/11, Android 26/26으로 통과했다. 마지막 `standalone-drizzle` exact-head run이 이어서 시작됐다.
- 2026-09-21: `standalone-drizzle` full Release E2E도 같은 revision에서 iOS 15/15 + 11/11, Android 26/26으로 통과했다. 다섯 `standalone-*` 프로필의 exact-head 검증이 모두 완료됐다.

- 2026-09-21: 감사 수정 `8081720c0`의 build/type/lint, unit 2,727, integration 388, Swift 31, Android native unit을 통과했다. CI의 ktlint 1.3.1에 맞춰 조건식 줄바꿈을 수정했다. 실제 Swift installer 60회 측정은 `evidence/native-transfer.md`에 기록했다. M3 성능 게이트는 통과로 표시하지 않는다.

- 2026-09-21: tar.br 유지 찬성/반대 서브에이전트가 manifest 내 archive descriptor, 재사용 후 결정적 선택, 단 한 번의 원본 fallback, 단일 native 추출 경로에 합의했다. `evidence/tar-br-consensus.md`와 PRD 5.7을 새 구현 기준으로 한다. 이전 revision의 대기 E2E는 취소하고 구현 완료 후 다시 제출한다.

- 2026-09-21: Sol Medium 찬반 검토와 실제 압축 크기 반례를 반영해 tar.br 계약을 확정했다. 전체 파일이 네트워크 대상이고 patch가 없을 때만 서명된 TAR framing 크기까지 추가 전송을 허용한다. 재사용/patch가 있으면 엄격한 크기 비교를 유지한다.
- 2026-09-21: deterministic tar.br 생성·서명·업로드, canonical sibling URL, native 선택/안전 추출/단일 복구를 구현했다. iOS의 불필요한 복사·재해싱을 atomic rename으로 제거했고 복구 실패 시 설치를 중단한다. ZIP/gzip OTA decoder와 전략 계층은 없다.
- 2026-09-21: 최종 native 구현 Swift 44 cases + XCTest 3, Android 64 tests, 양 architecture 컴파일, ktlint 통과. build 26 projects, type 34 projects, lint, unit 2,747 tests, integration 388 tests 통과. E2E 지원 259 tests도 통과했다.
- 2026-09-21: 원본과 동일한 fixture로 80회 native 설치를 측정했다. 1,000-file uncapped 9.174s → 0.905s, 1,001 → 2 requests, +4,434 bytes; 512 KiB/s에서는 9.108s → 9.032s로 거의 동률이다. sampled peak disk는 4.36 → 12.95 MB. 모든 결과 해시를 검증했고 작은 delta는 동일 전송량/요청 수를 유지한다.
- 최종 Release E2E는 아직 인수하지 않았다. builtin PNG/font 재사용 시나리오에서는 optional archive URL 생략을 명시하며, 정상 archive 및 corrupt fallback의 요청 수와 모든 파일 해시는 별도 시나리오로 검증한다. 동일 최종 PR 구현을 push한 뒤 standalone 5개 full profile을 실행한다.

- 2026-09-21: 최초 tar.br E2E 큐 5건은 코드 checkout 전 `emulator-5554/5556/5558` 부재로 실패했다. 기존 전용 Pixel AVD 3대를 복구하고 부팅 완료를 확인했다. CI의 Android 신 아키텍처 실패는 Gradle 다운로드 timeout이며, iOS 구 아키텍처 실패는 백업 정리 테스트가 비동기 cleanup 후 파일 잔존을 기대한 경합이었다. 삭제 실패 주입 여부와 설치 결과로 assertion을 수정했고 Swift 전체 및 해당 사례 10회 반복을 통과했다. 프로덕션 native 코드는 성능 측정본과 동일하다. 최종 fingerprint를 다시 생성하고 E2E/CI 대상을 갱신한다.
