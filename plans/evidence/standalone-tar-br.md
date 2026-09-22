# tar.br 최종 standalone Release E2E

검증 revision: `797338cd0a4daab9cac93383154a961820b9c563`. PR [#1319](https://github.com/gronxb/hot-updater/pull/1319).

5개 프로필 모두 iOS/Android Release 앱으로 default suite 27개를 실행했다.
각 플랫폼은 15개 + 12개 shard로 나누므로 shard 로그의 나머지 skip은 다른 shard가 실행한다.
총 270개 시나리오가 통과했다. 이전 revision의 성공이나 환경 준비 실패는 이 집계에 포함하지 않는다.

| Profile             | Job                         | iOS   | Android | 완료 (UTC)               |
| ------------------- | --------------------------- | ----- | ------- | ------------------------ |
| standalone-kysely   | `job-20260921145543-dahlsw` | 27/27 | 27/27   | 2026-09-21T15:39:14.560Z |
| standalone-prisma   | `job-20260921145545-hm8b5v` | 27/27 | 27/27   | 2026-09-21T16:08:47.868Z |
| standalone-mongodb  | `job-20260921145546-9zq0j1` | 27/27 | 27/27   | 2026-09-21T16:35:39.981Z |
| standalone-dynamodb | `job-20260921145549-vf1y5t` | 27/27 | 27/27   | 2026-09-21T17:08:30.483Z |
| standalone-drizzle  | `job-20260921145550-1hzs6k` | 27/27 | 27/27   | 2026-09-21T17:33:49.888Z |

## 실제 전송과 무결성

모든 프로필·플랫폼에서 아래 세 경로를 실제 프록시 요청/응답 바이트와 설치 파일 SHA-256으로 확인했다. 전체 30개 전송 기록과 파일별 기대/실제 해시는 `standalone-tar-br.json`에 있다.

| 경로        | archive 요청 | 원본 요청 | patch 요청 | 설치 결과                        |
| ----------- | -----------: | --------: | ---------: | -------------------------------- |
| 작은 변경   |            0 |         0 |          1 | 전체 파일 해시 일치              |
| 큰 변경     |            1 |         0 |          0 | 전체 파일 해시 일치              |
| 손상 tar.br |            1 |         1 |          1 | 단일 복구 후 전체 파일 해시 일치 |

손상 tar.br는 응답 body를 20바이트의 잘못된 내용으로 치환했다. 선택 후 archive 요청이 한 번뿐이고 각 네트워크 파일의 원본/patch 합계 요청도 최대 한 번인지 검사했다. 모든 성공 기록에서 주입한 실패를 소진했는지도 확인했다.

내장 재사용은 10개 프로필·플랫폼 조합에서 app-local PNG/font 각각 0요청·0바이트, 목표 20개 파일의 전체 해시 일치를 확인했다. 이 Release fixture는 native build와 OTA 사이에 공유 pnpm symlink가 dependency asset 경로를 바꾸므로 optional archive URL을 명시적으로 생략하고 이후 복원한다. 따라서 이 사례만으로 archive URL이 있는 모든 첫 OTA의 전송량을 주장하지 않는다. 자동 archive 선택은 위 세 경로가, archive URL이 있는 JS-only 내장 재사용은 `native-tar-br-transfer.md`가 검증한다.

Public progress 이벤트는 이 Release 앱에서 직접 노출하지 않아 native 단위 테스트로 검증했다. 이번 E2E는 실제 archive/file/patch 요청과 설치 파일을 검증한다.

## CI와 로컬 검증

같은 `797338cd0` revision의 GitHub checks가 모두 성공했다.

- [Kotlin Lint](https://github.com/gronxb/hot-updater/actions/runs/35615347912/job/106387557901): SUCCESS
- [integration](https://github.com/gronxb/hot-updater/actions/runs/35615347914/job/106384490594): SUCCESS
- [Publish to pkg.pr.new](https://github.com/gronxb/hot-updater/actions/runs/35615347822/job/106384489922): SUCCESS
- [Build iOS (New Architecture)](https://github.com/gronxb/hot-updater/actions/runs/35615347807/job/106393673047): SUCCESS
- [Build Android (New Architecture)](https://github.com/gronxb/hot-updater/actions/runs/35615347912/job/106387556519): SUCCESS
- [Build iOS (Old Architecture)](https://github.com/gronxb/hot-updater/actions/runs/35615347807/job/106393674835): SUCCESS
- [Build Android (Old Architecture)](https://github.com/gronxb/hot-updater/actions/runs/35615347912/job/106387556098): SUCCESS
- [Continuous Releases](https://pkg.pr.new): SUCCESS
- [Socket Security: Project Report](https://socket.dev/dashboard/org/hot-updater/sbom/ee5a9806-0580-4173-acd2-27541a9f5a5c): SUCCESS
- [Socket Security: Pull Request Alerts](https://socket.dev): SUCCESS
- [Vercel](https://vercel.com/hot-updater/hot-updater-docs/7R5PBn4un9WqVpPSDeYrgu5pxND8): SUCCESS
- [Vercel Preview Comments](https://vercel.com/github): SUCCESS

로컬 build 26 projects, typecheck 34 projects, lint, unit 2,747 tests, provider integration 388 tests, E2E 지원 259 tests, Swift Testing 44 + XCTest 3 cases, Android 64 tests도 통과했다. Swift 백업 정리 테스트의 비동기 cleanup 경합을 수정한 뒤 전체 Swift suite와 해당 사례 10회 반복을 통과했다. 프로덕션 native 코드는 80회 성능 측정본과 동일하다.

최초 E2E 제출은 세 Android emulator가 꺼져 checkout 전에 실패했으며 기존 전용 pool을 복구했다. 최초 CI의 Gradle 다운로드 timeout/504와 CocoaPods 경로 오류는 재실행에서 통과했다. 이 실패를 성공 테스트로 계산하지 않는다.

## 재현과 증거 보존

PR checkout에서 `.agents/skills/hot-updater-agent/SKILL.md`의 full E2E 명령을 사용했다:

```bash
hot-updater-agent e2e -platform full -profile standalone-kysely -env-target examples/v0.85.0/.env.hotupdater
```

나머지 네 프로필도 같은 명령의 profile만 변경했다. CLI가 현재 PR을 해석하며 실행 시 revision을 기록한다. 각 job은 `hot-updater-agent reason <job-id>`와 `hot-updater-agent log <job-id>`로 확인할 수 있다.

로컬 `/tmp/hot-updater-prd-audit-1319/standalone-{jobs,reuse,artifact-transfers}.json`에 원본 job/관측 자료를 수집했고, 이 문서와 동명의 JSON에는 로컬 simulator container 절대경로를 제외한 판정·전송·파일 해시를 보존했다. 테스트 소스는 검증 도중 수정하지 않았다.
