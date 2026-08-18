# Hot Updater CLI Release Catalog 멘탈모델 감사

> 작성일: 2026-08-18
> 비교 기준: `origin/main` `a5272d70119928052d76567d33c6887732ebfacf` ↔
> `origin/next` `467e5f63c31876223b1d3378c2e6c3bebd8ca508`
> merge base: `bf7c3ff502b25c731a0b7ec80819583bd178858b`
> 구현 기준 브랜치: `codex/cli-release-mental-model`, base `origin/next`
> 범위: `packages/hot-updater`의 공개 CLI 전체와 직접 연결된 Release,
> Bundle, Catalog, Storage 코드 및 문서. Console UI와 모바일 런타임 자체의
> 완전한 감사는 범위 밖이다.

## 합의된 개선 방향과 처리 결과

4개 독립 검토 관점(Release lifecycle, artifact/GC, docs/tests, scope
challenge)이 초안을 검토한 뒤 2차 이견 확인을 거쳤다. 공통 기준은 다음과
같다.

- 정책 mutation은 정확한 Release ID를 받는다.
- Bundle은 불변 artifact와 native crash identity로만 다룬다.
- Catalog는 Release에서 재생성하는 projection이며 누락도 진단·복구한다.
- Storage GC의 live root는 Bundle 레코드이지만, exact patch/asset reference도
  함께 검사한다.
- APP_VERSION scope에서는 기기 버전별 결과가 다를 수 있으므로 disable 이후
  하나의 predecessor Release를 단정하지 않는다.

| 항목 | 처리 | 구현 결과 |
| --- | --- | --- |
| deploy Release handle | 완료 | 플랫폼별 Release ID, Bundle ID, authority ID, scope key, generation을 출력하고 Bundle ID로 commit 결과를 안전하게 매핑한다. |
| top-level `rollback` | 완료 | Bundle/channel 추론 mutation을 제거했다. 정식 경로는 `release disable <release-id>`이며 v1 migration 문서에 이전 절차를 추가했다. |
| Release read/disable UX | 완료 | `release list --bundle-id`, Created, 상세 policy/provenance, scope 기반 disable preview와 CAS를 추가했다. 결과는 previous compatible enabled Release 또는 `BUILTIN`이라고 표현한다. |
| promote policy reset | 완료 | 기존 enabled/100%/target cohorts 없음/새 Release seed 동작은 유지하되 mutation 전에 모두 표시한다. `move`의 source disable도 표시하고 preview revision으로 CAS한다. |
| Bundle reference UX | 부분 완료 | `bundle show` human/JSON과 `bundle delete` preflight에 Release 참조 count/ID를 추가했다. `bundle list` batch count는 provider-neutral count API가 없어 보류했다. |
| `storage prune` | 완료 | 유지한다. writer 경고를 deploy+patch로 고치고, live target Bundle 아래의 exact-unreferenced canonical patch object도 2차 reference scan 후 회수한다. |
| missing Catalog | 완료 | Catalog와 Release scope 합집합을 탐색하며 missing projection을 표시하고 generation 1로 rebuild한다. canonical scope-key parser와 불일치 검증을 추가했다. |
| stale docs/help | 완료 | 운영 policy는 Release, artifact/crash identity는 Bundle로 분리했다. native automatic crash rollback 문서는 Bundle 기반으로 유지했다. |
| command tests | 완료 | deploy, Release, promote, Bundle, Storage, Catalog의 위험 시나리오 중심 테스트를 추가했다. |

의도적으로 보류한 항목은 다음과 같다.

- `bundle list`의 exact Release reference count: N+1 대신 batch/count read contract
  결정이 먼저 필요하다.
- patch reference-safe Bundle deletion: 현 provider들은 patch metadata를 cascade
  delete한다. Release-safe preflight는 구현했지만 완전한 GC eligibility라고
  부르지 않는다. provider 전반의 base/target patch reference contract가 필요하다.
- 모든 공식 Storage provider의 `listObjects/deleteObjects`: 현재 실제 CLI GC
  capability는 `s3Storage`에 한정됨을 help와 문서에 명시했다.
- deploy `--json`, Release Console deep link, promote 기본 policy 변경/flags:
  각각 별도 output 또는 제품 결정이 필요하다.

## 감사 시점 결론

`next`의 큰 방향은 맞다. 정책 명령을 `bundle`에서 `release`로 옮기고,
Bundle을 불변 설치 아티팩트로 제한한 것은 새 Release Catalog 모델과
일치한다. 그러나 CLI 전환은 아직 끝나지 않았다.

감사 시점에 출시 전에 정리해야 했던 항목은 다음과 같다. 현재 처리 상태는
위 표와 각 finding의 `처리` 문단을 기준으로 한다.

1. `deploy`가 새 Release ID를 출력하지 않는다. 배포 직후 정책을 조작하려면
   Release ID가 필요한데 사용자는 다시 `release list`로 추측해야 한다.
2. 최상위 `rollback`은 여전히 Bundle ID를 받으며, 같은 Bundle을 여러
   Release가 재사용할 수 있는 새 모델에서 모호하다.
   `release disable <release-id>`를 유일한 정식 롤백 동작으로 두고 최상위
   `rollback`은 폐기하는 편이 단순하다.
3. `bundle list/show`가 Release 참조 수와 GC 가능 여부를 보여주지 않는다.
   안전 삭제가 구현되어도 사용자는 왜 삭제가 막혔는지 사전에 알 수 없다.
4. `release show`가 target cohorts, source Release, scope를 숨기고,
   `release disable`은 기기별로 previous compatible enabled Release 또는
   `BUILTIN`으로 이동할 수 있다는 결과를 보여주지 않는다.
5. `release promote`는 대상 Release를 즉시 enabled, 100% rollout,
   target cohorts 없음으로 만들지만 확인 화면에 이 정책 변화를 표시하지
   않는다.
6. `db catalog preflight/rebuild`는 이미 존재하는 Catalog 행만 열거한다.
   Release는 있는데 Catalog가 사라진 상태를 발견하거나 복구하지 못한다.
7. 새 `release.ts`와 `catalog.ts`에는 전용 CLI 테스트가 없다.
8. 여러 가이드가 `next`에서 삭제된 `bundle update/enable/disable`과 제거된
   `bundle list --channel/--target-app-version`을 계속 안내한다.

`hot-updater storage prune`은 **계속 가치가 있다**. Bundle DB 레코드 삭제와
Storage 객체 삭제를 한 트랜잭션으로 묶을 수 없고, 실패한 deploy/patch가
고아 객체를 남길 수 있기 때문이다. 새 모델에서는 다음 3단계 GC의 마지막
단계로 역할이 더 명확해진다.

```text
Release disable/delete
  -> 참조 없는 Bundle 레코드 delete
  -> storage prune으로 실제 archive/manifest/patch/shared asset 회수
```

다만 현재 `storage prune` 경고는 실제 Storage writer인 `patch`를 빠뜨리고,
Storage를 전혀 복사하지 않는 새 `release promote`를 멈추라고 한다. 또한
실제 `listObjects/deleteObjects` 구현은 현재 S3 storage에만 있어 다른 공식
Storage provider에서는 같은 GC 흐름을 쓸 수 없다.

## 판정 기준

새 모델의 책임 경계는 다음과 같이 해석했다.

| 개념 | 소유하는 것 | 소유하지 않는 것 |
| --- | --- | --- |
| Bundle | 설치 bytes, hash, storage URI, manifest, asset, patch lineage, crash identity | channel, enabled, rollout, cohort, force, message, 호환 대상 |
| Release | channel, enabled, rollout, target cohorts, force, message, app-version/fingerprint 호환성, chronology | archive/manifest/patch bytes |
| Release Catalog | Release 정책의 재생성 가능한 AoT projection | canonical 정책, Storage 객체 |
| Storage | 불변 Bundle 계열 객체 | 전달 정책, update selection |
| Native channel/fingerprint/app version | 어떤 Release scope를 조회할지 정하는 앱 빌드 입력 | 서버의 Channel/Release 레코드 관리 |

근거는
`docs/architecture/release-catalog-plan.md:126-238`,
`docs/architecture/release-catalog-plan.md:1017-1105`,
`docs/architecture/release-catalog-plan.md:1210-1232`이다.

## `main`에서 `next`로 바뀐 공개 CLI

### 의도대로 제거된 Bundle 정책 명령

| `main` 명령 | `next` 상태 | v1 대체 명령 | 판정 |
| --- | --- | --- | --- |
| `bundle disable <bundle-id>` | 제거 | `release disable <release-id>` | 다시 제공하지 않는다. 같은 Bundle의 여러 Release를 한 번에 비활성화하면 안 된다. |
| `bundle enable <bundle-id>` | 제거 | `release enable <release-id>` | 다시 제공하지 않는다. 기존 Release ID와 rollout seed를 유지해야 한다. |
| `bundle update <bundle-id>` | 제거 | `release update <release-id>` | 다시 제공하지 않는다. rollout, cohorts, force, message, 호환 대상은 Release 정책이다. |
| `bundle promote <bundle-id>` | 제거 | `release promote <source-release-id>` | 새 명령이 맞다. Storage 복사가 아니라 같은 Bundle을 가리키는 새 Release 생성이다. |

### 의미가 바뀐 기존 명령

| 명령 | 변화 | 호환성 주의점 |
| --- | --- | --- |
| `bundle list` | 정책 목록에서 불변 아티팩트 목록으로 변경 | `--channel`, `--target-app-version` 제거. 해당 필터는 Release 관점으로 다시 작성해야 한다. |
| `bundle show` | 정책 필드 제거, artifact 정보만 표시 | channel/enabled/rollout을 찾는 자동화는 `release show`로 이동해야 한다. |
| `bundle delete` | Release 참조가 없을 때만 DB artifact 행 삭제 | 실제 Storage 객체는 남으며 `storage prune`이 별도로 필요하다. |
| `deploy` | Bundle과 Release를 원자적으로 생성 | 출력은 아직 Bundle ID만 보여 주어 변경된 의미를 충분히 반영하지 못한다. |
| `promote` | Bundle 복사에서 Release 생성으로 변경 | `bundle promote`가 아니라 `release promote`; 대상 정책 기본값도 달라진다. |
| `rollback` | Bundle 비활성화에서 Release 비활성화로 내부 동작 변경 | 공개 입력은 여전히 channel/Bundle 중심이라 멘탈모델 전환이 불완전하다. |

## 공개 명령 전체 조사

판정 표기:

- **유지**: 새 모델에서도 책임이 명확하고 현재 형태가 적절함.
- **수정**: 명령은 필요하지만 입력, 출력, 경고 또는 이름을 고쳐야 함.
- **운영 전용**: 일반 배포 흐름이 아니라 진단/복구/GC 명령으로 유지.
- **폐기**: 다른 명령과 중복되거나 새 식별자 모델에서 모호함.

### 설정, 진단, 로컬 앱 입력

| 명령 | 판정 | 조사 결과 |
| --- | --- | --- |
| `init` | 유지 + help 수정 | 신규 구성뿐 아니라 managed provider의 v1 migration/reconcile에도 다시 실행한다. `Initialize`만으로는 upgrade 역할이 드러나지 않는다. |
| `doctor` | 유지 | 로컬 native/config와 서버 version endpoint를 검사한다. Catalog projection 검증은 하지 않으므로 `db catalog preflight`와 역할이 다르다. |
| `fingerprint` | 유지 + help 수정 | 실제 동작은 현재 fingerprint 생성 및 `fingerprint.json`과의 일치 검사다. `Generate fingerprint`보다 `Check fingerprints`가 정확하다. Fingerprint는 FINGERPRINT Release scope의 일부다. |
| `fingerprint create` | 유지 | fingerprint 파일과 native 값을 갱신하며 rebuild를 요구한다. Release가 아니라 앱 빌드 scope 입력을 관리하므로 책임이 맞다. |
| `channel` | 수정 | 서버 Channel을 관리하지 않고 Android/iOS native 기본 channel만 읽는다. `Manage channels`는 v1의 canonical Channel row와 혼동된다. `Show native default channels`로 명시한다. |
| `channel set <channel>` | 수정 | native 파일만 바꾸며 서버 Channel/Release를 생성하지 않는다. help와 출력에 `native default` 및 rebuild 필요성을 일관되게 표시한다. |
| `app-version` | 유지 | APP_VERSION Release 호환성에 사용되는 로컬 native version을 읽는다. 정책 mutation이 아니다. |
| `console` | 유지 | Release가 운영 기본 화면이어야 한다. 명령 구현 자체보다 문서와 deploy 후 deep link가 Release 중심인지 정리해야 한다. |

`channel` 판정의 직접 근거는 `packages/hot-updater/src/index.ts:142-152`와
`packages/hot-updater/src/commands/channel.ts:8-45`이다. 이 코드는 DB를 읽거나
쓰지 않고 native 파일만 다룬다.

### 배포와 Release 정책

| 명령 | 판정 | 조사 결과 |
| --- | --- | --- |
| `deploy` | **필수 수정** | 필수 명령이다. Bundle + Release + Catalog commit은 맞지만 Release ID, authority ID, scope key, generation을 출력하지 않는다. help의 `deploy a new version`, `disable the update`, `deployed bundle rollout`도 Release 생성 의미로 바꿔야 한다. |
| `release list` | 유지 + 출력 보강 | 정책 운영의 기본 목록이다. channel/platform 필터가 맞다. Created, scope/strategy 구분 또는 target cohort 요약이 없고 JSON 외에는 provenance가 약하다. |
| `release show <release-id>` | **수정** | revision, channel, target, enabled, force, rollout은 보이지만 `target_cohorts`, `source_release_id`, `scope_key`, timestamps가 보이지 않는다. 정책 상세 명령으로 불완전하다. |
| `release update <release-id>` | 유지 | mutable policy를 revision/catalog CAS로 갱신한다. `--message`와 `--clear-message`, `--target-cohorts`와 `--clear-target-cohorts`는 Commander conflict로 명시하는 편이 안전하다. |
| `release preflight <release-id>` | 유지 | mutation을 저장하지 않고 256 KiB 한도와 catalog complexity를 검사한다. `db catalog preflight`와 다른 “정책 mutation preview”임을 help에서 강조한다. |
| `release enable <release-id>` | 유지 | 같은 Release ID와 rollout seed를 유지한 채 재활성화하므로 새 모델과 맞다. |
| `release disable <release-id>` | **필수 수정** | 정식 rollback 동작으로 유지한다. 확인 전에 영향 scope와 기기별 previous compatible enabled Release 또는 `BUILTIN` 결과를 보여 주어야 한다. scope에 enabled Release가 하나뿐일 때만 `BUILTIN`을 단정할 수 있다. 현재는 일반적인 `Disable this Release?`만 출력한다. |
| `release delete <release-id>` | 운영 전용 유지 | disabled Release의 hard delete는 Bundle GC를 가능하게 하는 관리 기능이다. 일반 rollback은 delete가 아니라 disable임을 help에서 분리해야 한다. |
| `release promote <source-release-id>` | **수정** | 같은 Bundle을 재사용하고 Storage를 복사하지 않는 구현은 맞다. 대상 Release가 enabled=true, rollout=100%, target cohorts=[]가 되는 사실을 preview에 표시하고, 이 기본값을 유지할지 제품 결정을 명시해야 한다. |
| `rollback <channel>` | **폐기 권고** | `release disable`과 같은 canonical mutation을 중복 제공하면서 channel/platform/Bundle ID로 source Release를 추론한다. FINGERPRINT scope가 여러 개이거나 같은 Bundle을 여러 Release가 재사용하면 모호하다. |

### Bundle, patch, Storage

| 명령 | 판정 | 조사 결과 |
| --- | --- | --- |
| `bundle list` | 수정 | platform으로 불변 artifact를 나열하는 방향은 맞다. Release reference count, patch/base reference, GC eligibility가 없어 관리 흐름이 끊긴다. |
| `bundle show <bundle-id>` | **수정** | hash, URI, manifest, patch 수만 보여 준다. 이 Bundle을 가리키는 Release와 patch lineage/base references, 삭제 가능 여부가 필요하다. |
| `bundle delete <bundle-id...>` | 운영 전용 유지 + UX 수정 | Release 참조가 있으면 DB가 안전하게 거부하고 patch metadata는 Bundle 삭제에 종속된다. 성공 후 Storage 객체는 남는다. 차단한 Release ID를 보여 주고 성공 시 `storage prune --dry-run`을 안내해야 한다. |
| `patch` | 유지 + help 수정 | Bundle-to-Bundle 파생 artifact를 만들므로 Release와 무관한 것이 맞다. `--channel`은 정책 대상이 아니라 config 로딩 context라는 현재 설명을 유지·강조한다. 선택적 향후 정리로 `bundle patch create` 아래에 둘 수 있지만 기능상 필수 rename은 아니다. |
| `storage prune` | **운영 전용 유지 + 수정** | Bundle 레코드 전체를 live set으로 삼고 Release는 보지 않는 것이 정확하다. Bundle이 존재하는 한 정책 참조 여부와 무관하게 artifact를 보존해야 하기 때문이다. writer 경고와 provider coverage는 수정해야 한다. |

### DB schema와 Catalog 운영

| 명령 | 판정 | 조사 결과 |
| --- | --- | --- |
| `db migrate` | 운영 전용 유지 | v1 schema/backfill 적용에 필수다. forward-only migration이며 v0 writer를 중지해야 한다. |
| `db generate` | 운영 전용 유지 | SQL/ORM schema review 흐름에 필요하다. Runtime Release mutation 명령과 겹치지 않는다. |
| `db catalog preflight [scope-keys...]` | **운영 전용 유지 + 수정** | 기존 projection을 canonical Releases로 다시 컴파일해 drift/size를 비교하는 진단 명령이다. 이름을 유지한다면 `release preflight`와의 차이를 help에 써야 한다. 누락 Catalog 탐지는 현재 불가능하다. |
| `db catalog rebuild [scope-keys...]` | **break-glass 유지 + 수정** | 파생 projection 복구라는 역할은 타당하다. 일반 배포 절차로 노출하지 말고 `preflight` 후 복구용으로 문서화한다. 누락 Catalog를 새로 만드는 경로가 필요하다. |

### signing과 native build/run

| 명령 | 판정 | 조사 결과 |
| --- | --- | --- |
| `keys generate` | 유지 | Bundle signing key 생성으로 Release 모델과 독립적이다. |
| `keys export-public` | 유지 | native 검증 키 배치로 Bundle bytes 검증 책임과 맞다. |
| `keys remove` | 유지 | native signing 설정 제거이며 Release 정책과 무관하다. |
| `build:android` | 유지 | store/native artifact build 명령이다. OTA Release 생성이 아니다. |
| `build:ios` (`EXPERIMENTAL`) | 유지 | 위와 동일. 실험 플래그 여부는 Release Catalog 전환과 무관하다. |
| `run:android` (`EXPERIMENTAL`) | 유지 | 로컬 native 실행 명령이다. |
| `run:ios` (`EXPERIMENTAL`) | 유지 | 로컬 native 실행 명령이다. |

## 상세 findings

### [CLI-01] `deploy`가 생성한 Release handle을 반환하고 출력하게 한다

**처리: 완료.** Single/multi-platform commit 결과를 Bundle ID로 매핑하고
Release/Bundle/authority/scope/generation을 함께 출력한다.

- **Evidence**:
  `docs/architecture/release-catalog-plan.md:1210-1232`는 deploy 출력에
  Release, Bundle, authority ID, scope key, generation을 요구한다.
  `packages/hot-updater/src/commands/deploy.ts:88-92`의 결과 타입은 Bundle
  ID만 보관하고, `deploy.ts:1003-1024`는 commit 결과를 버린다.
  `deploy.ts:1136-1140`과 `deploy.ts:1224-1239`의 성공 출력도 Bundle ID만
  표시한다.
- **Impact**: 배포 직후 `release update/disable/promote`를 실행할 안정적인
  ID가 없다. CI는 `release list` 결과에서 “방금 배포한 것”을 추측해야 하며
  동시 배포에서 잘못된 Release를 조작할 수 있다.
- **Effort**: M — single/multi-platform commit 결과를 platform 결과에 다시
  연결하고 human/JSON 출력을 테스트해야 한다.
- **Risk**: MED — multi-platform 원자 commit과 deferred patch 흐름의 결과
  매핑을 깨뜨리지 않아야 한다.
- **Confidence**: HIGH.
- **Fix sketch**: `ReleaseCatalogMutationResult`를 버리지 말고 platform별
  `{ releaseId, bundleId, authorityId, scopeKey, generation }`으로 전파한다.
  interactive Console URL도 가능하면 `releaseId`를 기준으로 연다.

### [CLI-02] Bundle 기반 최상위 `rollback`을 폐기하고 Release disable로 통합한다

**처리: 완료.** top-level command와 Bundle-target handler를 제거하고 v1
upgrade 문서에 exact Release ID migration을 추가했다.

- **Evidence**:
  `packages/hot-updater/src/index.ts:528-544`는
  `rollback <channel> --target <bundle-id>`를 노출한다.
  `commands/rollback.ts:111-151`은 Bundle
  ID로 enabled Release를 역검색하고, `rollback.ts:152-173`은 channel/platform
  전체에서 최신 enabled Release 하나를 고른다. 반면 실제 mutation은
  `rollback.ts:199-205`에서 그 Release를 disable할 뿐이다.
- **Impact**: Bundle 재사용이 허용되므로 Bundle ID는 정책 chronology를
  유일하게 식별하지 않는다. 한 channel/platform 아래 여러 fingerprint
  scope가 존재할 때 “current Release”도 하나가 아니다.
- **Effort**: M — deprecation, help/docs, 스크립트 migration이 필요하다.
- **Risk**: MED — 기존 rollback 자동화가 깨지므로 major-version migration
  안내가 필요하다.
- **Confidence**: HIGH.
- **Fix sketch**: `release disable <release-id>`를 정식 API로 둔다. convenience
  command가 꼭 필요하면 Release ID를 필수 입력으로 받고 결국 같은 handler를
  호출하는 얇은 alias로만 유지한다. Bundle-target retry는 제공하지 않는다.

### [CLI-03] Bundle 명령에 Release 참조와 GC 가능성을 노출한다

**처리: 부분 완료.** `bundle show`와 delete preflight에 Release 참조를
노출했다. `bundle list` batch count와 patch-reference-safe deletion은 위 보류
항목으로 남긴다.

- **Evidence**:
  `packages/hot-updater/src/commands/bundle.ts:14-34`의 list 필드는 ID,
  platform, hash, storage, commit뿐이다. `bundle.ts:79-90`의 show는 patch
  개수까지만 보여 준다. `bundle.ts:249-253`의 delete는 DB constraint에
  의존한다. 아키텍처 계약은
  `docs/architecture/release-catalog-plan.md:1210-1232`에서 Bundle 명령이
  reference count와 reference-safe delete를 보여 주도록 요구한다.
- **Impact**: 삭제가 가능한지 실행 전에는 알 수 없고, 실패해도 어떤
  Release가 참조하는지 알 수 없다. Release 삭제 → Bundle 삭제 → Storage
  prune이라는 관리 흐름을 CLI만으로 계획하기 어렵다.
- **Effort**: M — provider-neutral batch reference read와 출력/테스트가 필요하다.
- **Risk**: LOW — read-side 보강이며 mutation 의미는 유지한다.
- **Confidence**: HIGH.
- **Fix sketch**: 최소한 `bundle show`에 referencing Release IDs/count,
  target/base patch references, `deletable`을 표시한다. `bundle list`에는
  batch로 계산한 Release count와 GC state를 추가하고 N+1 query는 피한다.

### [CLI-04] Release 상세와 disable preview를 정책 중심으로 완성한다

**처리: 완료.** 단, 아래 초안의 “predecessor Release” 단일 표시는 정확하지
않아 수정했다. APP_VERSION compatibility와 cohort에 따라 기기별로 previous
compatible enabled Release 또는 `BUILTIN`을 선택할 수 있다고 표시한다.

- **Evidence**:
  `packages/hot-updater/src/commands/release.ts:93-109`의 human summary는
  target cohorts, source Release, scope key, timestamps를 생략한다.
  `release.ts:261-294`의 enable/disable은 일반 확인문만 보여 준다.
  아키텍처의 disable 의미는
  `docs/architecture/release-catalog-plan.md:1041-1055`에서 predecessor 또는
  `BUILTIN` 선택으로 정의된다.
- **Impact**: 사용자가 수정한 실제 정책과 rollback 결과를 JSON 없이는
  확인할 수 없다. 특히 마지막 compatible Release disable은 native bytes로
  강제 이동시킬 수 있다.
- **Effort**: M.
- **Risk**: LOW — mutation 전에 authoritative preflight/read를 추가하는
  방향이다.
- **Confidence**: HIGH.
- **Fix sketch**: `release show`에 모든 mutable policy, revision, scope,
  provenance를 표시한다. `release disable`은 affected scope와 기기별
  previous compatible enabled Release 또는 `BUILTIN` 결과를 확인문 앞에
  표시하고 `rollback`의 유용한 preview를 이쪽으로 옮긴다.

### [CLI-05] Promote의 대상 정책 기본값을 숨기지 않는다

**처리: 완료(가시성).** 기본값은 바꾸지 않고 enabled, 100% numeric rollout,
명시 target cohort 없음, 새 Release ID/seed, move source disable을 preview한다.

- **Evidence**:
  `plugins/plugin-core/src/releaseManagement.ts:329-346`은 target Release를
  `enabled: true`, `rollout_cohort_count: 1000`, `target_cohorts: []`로 만든다.
  `packages/hot-updater/src/commands/promote.ts:27-40`의 preview는 Storage 재사용만
  보여 주고 이 정책 변화를 표시하지 않는다.
- **Impact**: QA-only 또는 부분 rollout Release를 production으로 promote하면
  대상 channel에서 즉시 100% 공개될 수 있다. `-y` 자동화에서는 더 쉽게
  놓친다.
- **Effort**: S(표시만) / M(정책 옵션 추가).
- **Risk**: MED — 기본값을 바꾸면 기존 promote 동작이 달라진다.
- **Confidence**: HIGH.
- **Fix sketch**: 먼저 현재 동작을 preview/help에 명시한다. 제품 결정으로
  source policy 유지, 명시적 target policy flags, 또는 disabled 생성 중 하나를
  선택한다. 선택 전에는 조용한 100% enable을 두지 않는다.

### [CLI-06] `storage prune`을 유지하되 writer 경고와 provider coverage를 고친다

**처리: 부분 완료.** deploy+patch 경고와 orphan patch GC를 수정했다. provider
capability 확대는 보류하고 현재 `s3Storage` 범위를 명시했다.

- **Evidence**:
  `packages/hot-updater/src/commands/storage.ts:502-541`은 Bundle 및 manifest를
  두 번 읽어 candidate를 재검증하며, Release를 reference root로 사용하지
  않는다. 이는 새 책임 경계와 맞다. 그러나 `storage.ts:493-499`와
  `packages/hot-updater/src/index.ts:393-396`은 deploy와 promote를 멈추라고
  한다. 새 promote는 `commands/promote.ts:33-40`처럼 Storage를 재사용하고,
  실제 `patch`는 `packages/server/src/db/createBundleDiff.ts:300-347`에서 새
  patch 객체를 업로드한 뒤 DB reference를 쓴다. `listObjects/deleteObjects`
  생산 구현은 `plugins/aws/src/s3Storage.ts:105-150`에만 있다.
- **Impact**: `--protect-newer-than 0m --yes` 같은 운영에서 concurrent patch
  object를 지울 수 있는데 경고가 이를 막지 않는다. S3 외 provider에서는
  Bundle 삭제 후 실제 객체를 회수할 CLI 경로가 없다.
- **Effort**: S(경고/문서) / L(provider-neutral coverage).
- **Risk**: LOW(경고) / MED(provider 구현).
- **Confidence**: HIGH.
- **Fix sketch**: 경고를 `deploy and patch operations that write to this
  storage prefix`로 바꾼다. 기능은 유지한다. 각 provider가 안전한 enumeration/
  exact delete를 구현할지, S3-only 운영 도구로 명시할지 결정한다.

### [CLI-07] Catalog verify/rebuild가 누락 projection도 탐지하게 한다

**처리: 완료.** canonical scope parser와 Catalog∪Release discovery를 추가하고
missing projection을 generation 1로 복구한다.

- **Evidence**:
  `packages/hot-updater/src/commands/catalog.ts:40-80`은
  `releaseCatalogs.findMany`로 이미 있는 Catalog만 열거한다. 명시 scope key가
  없으면 `catalog.ts:60-63`에서 즉시 오류가 나며 rebuild 대상 scope를 Release
  canonical rows에서 재구성하지 않는다.
- **Impact**: Releases가 존재하지만 Catalog 행이 사라진 손상 상태에서 전체
  `db catalog preflight`는 그 scope를 보지 못한다. “전부 verified”라는 운영상
  오해 또는 빈 결과가 생기며 rebuild도 복구하지 못한다.
- **Effort**: M.
- **Risk**: MED — scope discovery와 tombstone semantics를 정확히 보존해야 한다.
- **Confidence**: HIGH.
- **Fix sketch**: canonical Release scopes와 Catalog scopes를 비교해 missing,
  extra, drifted 상태를 출력한다. rebuild는 missing projection 생성까지 하되
  같은 compiler/CAS 경계를 사용한다.

### [DOCS-01] 삭제된 Bundle 정책 CLI를 문서에서 제거한다

**처리: 완료.** 직접 영향받는 개념/배포/Console/rollout/Storage/simulator/
agent/v1 upgrade 문서를 Release 중심으로 갱신했다.

- **Evidence**:
  `docs/content/docs/guides/console.mdx:50-63`은 삭제된 `bundle disable`,
  `bundle enable`, `bundle update`를 안내한다.
  `docs/content/docs/guides/rollout-cohorts.mdx:199-216`도 Bundle ID로 policy를
  수정한다. `docs/content/docs/guides/storage-cleanup.mdx:28-40`은 next에서
  제거된 `bundle list --channel --target-app-version`을 사용한다.
  `storage-cleanup.mdx:69-79`와
  `docs/content/docs/storage-plugins/custom-storage.mdx:147-153`은 promote가
  Storage에 쓴다고 설명한다.
- **Impact**: `next` 문서의 명령이 즉시 실패하며, 사용자가 정책을 다시
  Bundle 속성으로 이해하게 만든다.
- **Effort**: M — 명령 치환뿐 아니라 설명/스크린샷을 Release 중심으로 다시
  써야 한다.
- **Risk**: LOW.
- **Confidence**: HIGH.
- **Fix sketch**: 정책 예제를 전부 `release list/show/update/enable/disable`로
  교체한다. Storage cleanup은 Release 참조 해제 → Bundle delete → prune 순서를
  문서화하고, stop-promote를 stop-patch로 바꾼다.

### [TEST-01] 새 Release/Catalog CLI에 의미 있는 command-level 테스트를 추가한다

**처리: 완료.** happy-path 개수 채우기가 아니라 identity mapping, stale
revision CAS, device-dependent disable, missing Catalog, Release reference 차단,
orphan patch recheck를 검증한다.

- **Evidence**:
  `packages/hot-updater/src/commands/release.ts`와 `catalog.ts`가 새로 생겼지만
  같은 디렉터리에 `release.spec.ts`와 `catalog.spec.ts`가 없다. plugin-core의
  mutation/compiler 테스트는 Commander 옵션 연결, human/JSON 출력, confirmation,
  disposal, missing catalog UX를 검증하지 않는다.
- **Impact**: v1의 핵심 운영 표면이 parser/handler 회귀에 노출된다. 특히
  Release ID 출력, disable consequence, missing catalog 같은 이번 감사 항목을
  고정할 테스트가 없다.
- **Effort**: M.
- **Risk**: LOW.
- **Confidence**: HIGH.
- **Fix sketch**: 기존 `bundle.spec.ts`, `promote.spec.ts`의 database harness
  패턴을 사용하고 `release.spec.ts`, `catalog.spec.ts`를 추가한다. happy path
  개수 채우기가 아니라 각 위험 시나리오를 검증한다.

## 권장 최종 CLI 멘탈모델

```text
deploy
  Build bytes -> create Bundle -> create Release -> compile Catalog
  Output: Release ID + Bundle ID + authority/scope/generation

release ...
  Delivery policy and chronology
  list/show/update/preflight/enable/disable/delete/promote

bundle ...
  Immutable install artifacts and references
  list/show/delete

patch
  Bundle-derived delivery artifact; no Release policy mutation

storage prune
  Reclaim objects after DB references are gone

db migrate/generate
  Canonical schema lifecycle

db catalog preflight/rebuild
  Derived projection verification and break-glass repair

channel/fingerprint/app-version/keys/build/run
  Native build inputs or local tooling, not server Release management
```

## 우선순위

| 순서 | 조치 | 출시 판단 |
| --- | --- | --- |
| 1 | deploy 결과에 Release handle 출력 | v1 CLI 흐름을 닫기 위해 필수 |
| 2 | top-level rollback 폐기/호환 결정, release disable preview 완성 | Bundle/Release 혼동 방지를 위해 필수 |
| 3 | stale CLI 문서 전환 | next 공개 전 필수 |
| 4 | release/catalog command-level 테스트 | 위 변경과 v1 표면 보호를 위해 필수 |
| 5 | missing Catalog 탐지/복구 | 운영 복구 명령을 신뢰하려면 필수 |
| 6 | Bundle reference/GC visibility | 운영 UX상 높음 |
| 7 | promote 정책 기본값 표시/결정 | 오배포 위험 때문에 높음 |
| 8 | storage prune writer 경고 수정 | 작은 변경, 즉시 반영 가치 높음 |
| 9 | channel/fingerprint/deploy help 문구 정리 | 개념 일관성 마무리 |

## 검증 게이트

감사 시점에는 다음 기존 command-level 회귀 테스트를 실행했고 모두 통과했다.

```text
Test Files  7 passed (7)
Tests      71 passed (71)
```

대상은 `bundle`, `deploy`, `deployTransaction`, `promote`, `rollback`, `patch`,
`storage` spec이다. 이는 현재 구현을 설명하는 테스트 계약이 통과한다는
뜻이지, 위 findings가 해결됐다는 뜻은 아니다. 특히 `release`와 `catalog`는
전용 spec이 없어 이 실행 대상에 포함할 수 없었다.

실제 수정 시 최소 검증은 다음을 권장한다.

```bash
pnpm -w lint
pnpm -w build
pnpm -w test:type
pnpm -w test
pnpm -w test:integration
```

CLI에 대해서는 추가로 다음 시나리오가 통과해야 한다.

1. single/multi-platform deploy가 각 Release ID와 Bundle ID를 정확히 매핑해
   출력한다.
2. 같은 Bundle을 재사용하는 여러 Release가 있어도 모든 policy mutation이
   Release ID로만 대상을 고른다.
3. 마지막 enabled Release disable preview가 `BUILTIN`을 표시한다.
4. 다른 enabled Release가 있는 disable preview는 하나의 predecessor를
   단정하지 않는다.
5. promote preview가 target enabled/rollout/cohorts를 정확히 표시한다.
6. Release가 Bundle을 참조하면 Bundle delete가 차단되고 참조 Release가
   출력된다.
7. Release가 있는데 Catalog가 없으면 전체 preflight가 실패하거나
   `missing`을 보고하고 rebuild가 복구한다.
8. concurrent patch를 운영자가 중지해야 한다는 prune 경고와 문서가 일치한다.

## 구현 후 검증 결과

2026-08-18 구현 브랜치에서 다음 gate를 통과했다.

| 검증 | 결과 |
| --- | --- |
| 변경 command/core 포커스 테스트 | 9 files, 103 tests passed |
| missing Catalog 실제 rebuild 테스트 | generation 1 생성 및 DB persist 통과 |
| 전체 unit suite | 260 files, 2,545 tests passed |
| workspace lint | 918 formatted files, 923 linted files, 0 warning/error |
| workspace typecheck | 34 projects passed |
| workspace build | 26 projects passed |
| docs production build | 162 pages generated, dead link 0 |
| built CLI help smoke | top-level rollback 없음, Release/Storage/Catalog help 확인 |

`test:integration`은 provider adapter나 schema를 변경하지 않았고 unit provider
contract, 전체 typecheck/build가 통과했으므로 이 변경에서는 실행하지 않았다.
