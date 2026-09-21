# PRD: 내장 파일 재사용과 manifest 기반 OTA 전송 통일

## 1. 상태와 실행 계약

- 작성일: 2026-09-20
- 상태: 2026-09-21 사용자가 tar.br 단일 보조 경로와 네이티브 압축 로직 단순화를 승인했다. 두 서브에이전트의 적대적 검토와 반박 후 아래 계약에 합의했다. 구현·성능·최종 E2E 재검증 진행 중이다.
- 현재 병합 기준: `origin/next`의 `333188ab939769609913529004d6c0d15474ad03`, 병합 revision `1aa201bbd`. 4절의 과거 코드 근거는 최초 기준 `ec78756926cac3b23ca32c1d3acefe28d2ebb7ab`다.
- 작업 디렉터리: `/Users/gronxb/.codex/worktrees/builtin-manifest-v1/hot-updater`.
- 브랜치: `feature/builtin-manifest-v1`.
- 서브에이전트 모델: `gpt-5.6-sol`, reasoning effort `medium`.
- 이 문서와 `plans/README.md`가 후속 실행의 기준이다. 대화 내용을 몰라도 실행할 수 있어야 한다.
- 기존 main checkout 및 별도 Insights worktree는 수정하지 않는다.
- 사용자가 서브에이전트 적대적 합의를 명시적으로 요청했다. Sol Medium 두 검토자의 찬성·반대 검토 및 반박 결과는 `evidence/tar-br-consensus.md`에 기록한다.
- 구현·로컬 검증·PR push/갱신·standalone E2E 요청은 승인됐다. 별도 GitHub/Linear 대화 게시, 운영 인프라 변경, 패키지 배포, merge는 포함되지 않는다.
- 작업 결과는 검증 가능한 코드 diff, 변경사항 문서, 실측·테스트 증거로 남긴다.

### 관련 요구

- [GitHub #1315](https://github.com/gronxb/hot-updater/issues/1315): 스토어 설치 후 첫 OTA에서 변하지 않은 이미지·폰트를 다시 다운로드하는 비용.
- [HOT-18](https://linear.app/hot-updater/issue/HOT-18): 내장 번들을 OTA diff base로 사용.
- [HOT-19](https://linear.app/hot-updater/issue/HOT-19): `compressStrategy` 제거, brotli로 단순화.
- 사용자가 `updateStrategy`라고 부른 것은 `compressStrategy`의 착오였다. `appVersion`/`fingerprint`는 유지한다.
- 기존 티켓은 1.0 출시 블로커가 아니라고 기록돼 있다. 이 문서는 구현 승인을 기록하며, 출시 일정을 임의로 변경하지 않는다.

## 2. 문제와 목표

현재 첫 OTA는 내장 파일을 재사용하지 않고 전체 아카이브를 다운로드한다. 이후 OTA에서는 manifest 파일 재사용과 Hermes binary patch를 사용할 수 있지만, 로컬 파일 손상 등 일부 실패의 복구가 전체 아카이브에 의존한다.

목표는 내장 manifest를 빌드 때 반드시 삽입하지 않아도, 실제 설치된 내장 파일 중 목표 바이트와 같은 파일을 안전하게 재사용하는 것이다. 설치·복구는 manifest와 개별 원본 파일만으로도 완결된다. 큰 변경의 요청 비용을 줄이기 위해 tar.br 하나만 선택적 전체 전송 경로로 제공하며 `compressStrategy`는 제거한다.

핵심 불변식:

> 로컬 base와 binary patch가 하나도 없어도, 검증된 목표 manifest와 그 manifest의 모든 원본 파일만으로 업데이트를 완성할 수 있다.

### 성공하는 사용자 경험

1. 일반적인 네이티브 빌드로 앱을 설치한다. 필수 manifest 삽입 스크립트나 서버 업로드 단계를 추가하지 않는다.
2. 첫 JS 수정 OTA에서 네이티브가 대응하는 내장 에셋을 찾아 실제 해시를 검사한다.
3. 일치하는 파일은 다운로드하지 않는다. 변경·누락·변환된 파일은 전체 파일로 받는다.
4. 이후 OTA도 동일한 installer를 사용한다. 유리한 Hermes patch는 추가 최적화다.
5. 업데이트 중 실패하면 실행 중인 정상 버전을 보존한다. 기존 catalog 선택·crash recovery 규칙을 유지한다.
6. 사용자는 archive/diff나 압축 형식을 고르지 않는다.

## 3. 범위

### 이번 구현에 포함

- iOS/Android 내장 파일을 목표 manifest 경로에 대응시키는 제한된 resolver.
- 필요한 파일만 읽는 비동기 lazy 재사용 인덱스와 재생성 가능한 로컬 캐시.
- 내장 base가 미등록이거나 로컬 manifest가 없어도 가능한 manifest 전체 설치.
- 모든 목표 파일에 대한 원본 다운로드 계약과 로컬 재사용 실패 시 파일 단위 복구.
- 기존 OTA 간 Hermes patch 유지 및 patch 실패 시 원본 파일 복구.
- 안전한 staging, 재시도, 설치 도중 중단 및 crash rollback 보존.
- 실제 Release 산출물 기반 재사용·성능 검증.
- tar.br 단일 보조 경로의 생성·전송·설치 및 선택·실패 복구 검증. ZIP/tar.gz/tar.bz, 자동 감지와 `compressStrategy`는 제거한다.
- 필요한 SDK/CLI/server/provider schema, 문서, 예제, E2E, changeset 갱신.

### 후속 최적화로 분리

**최초 내장 Hermes → OTA binary patch 생성용 네이티브 산출물 등록 기능은 이번 완료 조건이 아니다.** 내장 파일 재사용만으로 첫 OTA diff가 성립한다. 이 문서에서는 그 확장 경계만 정하며 새 등록 CLI나 자동 CI 업로드 기능을 추가하지 않는다.

후속 기능에는 실제 네이티브 빌드에 포함한 최종 Hermes 바이트를 배포 측이 보관하는 경로가 필요하다. 디바이스가 계산한 해시나 manifest만으로 patch를 생성할 수 없다. 등록되지 않은 앱은 첫 Hermes 파일 전체를 받아 정상 업데이트해야 한다.

### 비범위

- `updateStrategy`, runtime 호환성, cohort, channel, Release chronology, catalog 선택 정책 변경.
- native asset resolver를 전역 교체하거나 이미지 의미적 동일성으로 검증을 우회하는 일.
- 내장 이미지 전체를 별도 디렉터리에 중복 탑재하거나 전부 앱 저장소로 복사하는 일.
- APK/IPA 자체의 압축 형식 제거. OTA 전체 전송 형식은 tar.br 하나로 제한한다.
- tar.br 이외의 새 archive/pack 형식, 범용 캐시 프레임워크, 모든 bundler를 위한 새 plugin API.
- 전송하는 모든 파일에 무조건 brotli 재압축. 이득 없는 이미지 등은 raw 전송 가능.
- 선택한 diff 알고리즘 변경. `bsdiff` 내부 압축이나 `bz2` 의존성을 OTA tar 제거와 혼동하지 않는다.
- 기존 운영 Storage의 아카이브나 DB 데이터를 일괄 삭제하는 일.
- 인접 Insights 작업의 리팩터링.

## 4. 현재 상태와 코드 근거

아래 줄 번호는 기준 SHA의 위치다. 먼저 실제 코드와 비교한다.

| 파일 | 현재 역할과 변경 이유 |
| --- | --- |
| `packages/react-native/src/native.ts:631` | 동기 `getManifest()`와 session cache. 빈 manifest도 캐싱하므로 느린 초기화를 숨겨 넣지 않는다. |
| `packages/react-native/src/checkForUpdate.ts:360` | Release 선택 후 artifact resolve 및 install. catalog guard/receipt를 그대로 보존한다. |
| `packages/react-native/src/httpClient.ts:243` | `/artifacts/:targetBundleId/from/:currentBundleId` 호출. 전체 파일 descriptor 계약을 연결한다. |
| `packages/react-native/android/src/main/java/com/hotupdater/BundleFileStorageService.kt:893` | 기존 OTA 디렉터리·manifest가 없으면 manifest 설치를 거부한다. |
| 같은 파일 `:1473`, `:1558`, `:1894` | null archive URL은 builtin reset, diff 실패는 archive fallback, 재사용 파일 누락·손상은 예외다. |
| `packages/react-native/ios/HotUpdater/Internal/BundleFileStorageService.swift:1020` | 동일한 기존 OTA 전제. `:2251` 이후 파일을 순차 처리한다. |
| `packages/server/src/db/updateArtifacts.ts:286` | 서버 manifest끼리 같은 해시이면 원본 descriptor를 응답에서 제외한다. 로컬 손상 복구에 불충분하다. |
| 같은 파일 `:395`, `:507` | patch와 원본 크기 비교는 유지하되, archive와 manifest 크기 비교는 최종 제거한다. |
| `packages/core/src/types.ts:34` | Bundle에 archive hash/URI/size가 필수이며 manifest는 선택이다. 최종 계약은 반대로 정리한다. |
| `plugins/plugin-core/src/types/databaseRows.ts:17` | archive 중심 BundleRow. provider 및 schema의 일관된 전환이 필요하다. |
| `plugins/plugin-core/src/assetStorageLayout.ts` | content-addressed 파일 경로 및 `.bundle.br` 지원을 재사용한다. |
| `packages/hot-updater/src/commands/deploy.ts:899` | archive 선택·생성과 manifest/개별 파일 업로드가 공존한다. |
| `packages/hot-updater/src/utils/bundleManifest.ts` | 설치 바이트의 `fileHash`와 전송 바이트의 `downloadFileHash`/size를 구분한다. |
| `packages/server/src/db/createBundleDiff.ts:290` | 기존 patch 생성도 base/target 실제 바이트를 읽는다. |
| `docs/architecture/release-catalog-plan.md` | Bundle은 불변 바이트, Release는 배포 의도. builtin base 때문에 가짜 Release를 만들지 않는다. |

핵심 현재 코드:

```kotlin
if (hasManifestDrivenArtifacts && canUseManifestDrivenInstall()) {
    // manifest installer
}
```

```ts
const currentAsset = currentManifest?.assets[assetPath];
if (currentAsset?.fileHash === asset.fileHash) {
  return []; // 현재는 이 파일의 다운로드 descriptor가 사라진다.
}
```

기존 테스트 스타일은 `packages/server/src/db/updateArtifacts.spec.ts`, Android의 `BundleFileStorageServiceTest.kt`, iOS의 `BundleFileStorageServiceTests.swift`를 따른다. 단순 삭제나 구현 복사 테스트 대신 아래 시나리오의 실제 결과를 검증한다.

## 5. 설계 결정

### 5.1 목표 manifest와 내장 인덱스는 다른 데이터다

- 목표 manifest는 설치 결과의 전체 파일 집합과 해시를 정의한다. 기존 signing 설정이면 서명도 검증한다.
- 내장 인덱스는 디바이스가 읽을 수 있었던 파일들의 부분집합이다. 완전한 빌드 manifest나 서버의 canonical Bundle로 가장하지 않는다.
- 서버 manifest의 `bundleId`, 현재 launch selection, `MIN_BUNDLE_ID`를 새 인덱스 ID로 바꾸지 않는다.
- 인덱스에는 서버가 사용할 영구적인 URL이나 서명이 필요 없다. 신뢰 기준은 항상 목표 manifest와 실제 읽은 바이트다.
- 새 OTA 디렉터리에는 부분 인덱스가 아니라 완성된 목표 manifest를 저장한다.

### 5.2 lazy 생성 시점과 보관

설치된 app bundle/APK 안에 manifest를 쓰지 않는다. 앱 전용 쓰기 가능 저장소의 builtin 전용 namespace에 인덱스를 원자적으로 저장한다.

1. 목표 manifest를 다운로드·검증한다.
2. 파일마다 기존 OTA의 후보를 먼저 찾는다.
3. 후보가 없거나 잘못됐으면 내장 resolver로 해당 경로만 조회한다.
4. 실제 바이트를 스트리밍으로 해시하고 목표 값과 일치할 때만 재사용한다.
5. 확인한 `logicalPath → native source locator + observed hash`를 캐싱한다.
6. 파일이 없거나 처리할 수 없는 형태이면 정상 cache miss로 처리하고 원본 다운로드를 사용한다.

별도 공개 `ensureManifest()` API를 추가하지 않아도 된다. installer 내부 비동기 준비 단계로 구현한다. 동기 `getManifest()` 또는 JS/main thread에서 전체 스캔·해싱을 수행하지 않는다. 초기 getter가 빈 값을 반환해도 이후 설치 단계의 내장 조회가 영구적으로 비활성화되면 안 된다.

캐시가 손상·삭제되거나 쓰기에 실패해도 다운로드 설치는 가능해야 한다. 캐시 힌트만으로 복사를 승인하지 말고 최종 staging 파일을 목표 해시로 검증한다. native package 교체와 schema 변경에서 무효화하며, 단순 `appVersion` 또는 fingerprint만을 패키지 식별자로 쓰지 않는다. OS가 제공하는 설치/package revision, 실제 로드한 builtin bundle 정체성, split 집합을 고려한다. 최초 필요 시 HBC 해시 계산은 비동기로 한다.

다른 target hash를 찾았다는 이유로 기존 후보를 영구 삭제하지 않는다. split 추가 설치 등으로 달라질 수 있는 missing 결과를 영구 negative cache로 남기지 않는다. 오래된 인덱스가 있어도 실제 소스를 다시 검증하므로 잘못된 바이트는 재사용할 수 없다.

### 5.3 내장 파일 resolver

**iOS**

- 현재 앱이 실제 선택한 builtin bundle URL을 사용한다. 무조건 `Bundle.main`만 가정하지 않아 brownfield bundle 인자를 보존한다.
- 기본 `main.jsbundle`은 논리적 `index.ios.bundle`로 대응한다. 사용자 bundle 위치가 이미 지원된다면 같은 정보원을 사용한다.
- Metro의 일반 파일 에셋은 bundle 기준 상대 경로로 제한해 찾는다.
- asset catalog에서 원본 바이트를 얻을 수 없는 항목은 unsupported/miss로 둔다. 이미지 decode/re-encode로 목표 해시 검증을 대체하지 않는다.

**Android**

- 기본 HBC는 `AssetManager`의 `index.android.bundle`을 읽는다.
- Metro가 생성한 `drawable-*` 및 `raw` 경로를 실제 설치된 리소스에 대응시킨다. base APK만 있다고 가정하지 않는다.
- stream/resource locator를 다룬다. 모든 소스가 일반 `File`이라는 기존 installer 전제를 내장 파일에 강요하지 않는다.
- density를 임의로 고르거나 이미지를 재인코딩하지 않는다. 요청한 논리 경로에 대응하는 정확한 후보만 재사용한다.
- 패키징 중 PNG 처리, resource name/path 변경, split 미설치로 바이트가 없거나 달라지면 원본을 다운로드한다.
- APK entry 조회를 사용하더라도 이것은 내장 리소스 읽기다. OTA ZIP 다운로드·추출 경로와 혼동해 제거하지 않는다.

공통으로 remote path는 기존 path traversal 방어를 통과해야 한다. 네이티브 locator를 원격 manifest가 임의로 지정하게 하지 않는다. 재사용은 최종 OTA staging 디렉터리로 복사한다. 패키지 전체 사본이나 shared mutable hardlink는 만들지 않는다.

### 5.4 manifest 기반 전송 계약

단순성과 복구 가능성을 위해 **모든 target asset의 원본 descriptor를 제공하는 계약**을 채택한다. 서버가 현재 base와 같다고 판단한 파일도 빠지면 안 된다. 이 계약에서는 changed 여부를 클라이언트가 결정한다.

- artifact 응답은 목표 manifest URL/hash와 전체 파일 descriptor map을 포함한다.
- 새 전체 map의 이름은 `assets`로 한다. `changedAssets`를 전체 목록인 것처럼 조용히 재정의하지 않는다.
- 각 항목은 목표 `fileHash`, 원본 `file` descriptor, 가능한 경우 `patch`를 갖는다.
- 원본 descriptor의 URL은 필수다. patch만 있고 원본이 없는 새 artifact는 발행하지 않는다.
- manifest와 descriptor의 파일 집합·해시가 다르면 설치를 거부한다. 데이터 제공 실패를 builtin reset으로 해석하지 않는다.
- `fileHash`는 복원된 파일 바이트, `downloadFileHash`는 압축 등 실제 전송 표현이다. 기존 구분을 보존한다.
- binary patch는 base hash, patch hash, 최종 target hash를 모두 검증한다. 실패하면 해당 파일의 원본으로 복구한다.
- patch가 원본의 압축 전송 바이트보다 크거나 같으면 원본을 선택한다.
- base Bundle이 서버에 등록되지 않아도 전체 파일 응답이 가능해야 한다. builtin 인덱스를 서버에 업로드할 필요가 없다.
- 정적인 Release catalog에 디바이스 인덱스를 넣거나 update-check를 디바이스별 cache key로 바꾸지 않는다.

wire 변경은 명시적으로 versioning한다. v1은 아직 정식 배포되지 않았으므로
하위 호환 계층을 두지 않고 manifest 기반 계약으로 직접 확정한다. 새 SDK는
응답 version과 descriptor를 검증하며, 지원하지 않는 서버 응답을 builtin reset이나
빈 성공으로 처리하지 않는다.

M1에서 확정한 wire 경계는 다음과 같다.

- 새 SDK는 `/artifacts/v1/:targetBundleId/from/:currentBundleId`만 호출한다.
- 응답은 `artifactProtocolVersion: 1`, 목표 manifest URL/hash, 모든 목표 파일의
  필수 원본 descriptor를 담은 `assets`를 제공한다. 선택적 `archiveUrl`은 고정 tar.br 객체 URL이며 hash/크기는 검증된 manifest만 권위를 갖는다. `patch.byteSize`는 비용 비교 힌트다.
- unversioned `/artifacts/:targetBundleId/from/:currentBundleId` endpoint는 지원하지
  않는다. 서버와 SDK는 versioned v1 endpoint만 제공·호출한다.
- manifest 읽기 기능이 없는 서버는 v1 artifact를 만들지 않는다.
  새 SDK는 endpoint 404 또는 version/descriptor 누락을 protocol 비호환 오류로
  처리하며 builtin reset으로 해석하지 않는다.

### 5.5 설치·실패·동시성

파일별 순서는 `검증된 기존 OTA 재사용 → 검증된 builtin 재사용 → 유리한 patch → 원본 파일`이다. 실패를 정상 miss로 바꿀 수 있는 것은 로컬 후보 부재·불일치와 patch 최적화 실패다. 목표 manifest 서명 실패나 설치 파일 최종 해시 불일치를 성공 처리하지 않는다.

- 모든 목표 파일을 확인한 후 staging을 원자적으로 승격한다.
- manifest에 없는 이전 파일은 새 디렉터리에 남기지 않는다.
- catalog guard와 선택 receipt를 설치 시작·완료 경계에서 그대로 적용한다.
- 실패 시 stable/builtin과 crash history, 최고 catalog generation은 유지한다.
- 중단 후 검증된 완료 파일을 재사용할 수 있게 한다. 완료되지 않은 파일은 신뢰하지 않는다.
- 네트워크 파일 다운로드는 작은 고정 동시성 상한을 사용하고 외부 옵션은 추가하지 않는다. 기존 utility가 있으면 재사용한다.
- progress는 실제 다운로드 파일만 다운로드 대상으로 세되, 로컬 준비·검증 중에도 교착처럼 보이지 않아야 한다. 새 설치가 시작되면 이전 파일 progress를 초기화한다.
- 디스크 부족은 현재 정상 번들을 파괴하지 않는 실패여야 한다.

### 5.6 내장 Hermes patch 확장 경계

이번에는 기존 OTA 간 patch를 보존하고 내장 Hermes 파일도 동일 파일이면 재사용한다. 최초 내장 HBC가 변경됐고 등록된 patch가 없으면 전체 `.bundle.br` 다운로드가 정답이다.

후속 등록 기능은 최종 native build의 HBC 원본을 보관해야 한다. 동일 appVersion/fingerprint를 동일 파일의 증거로 쓰지 않으며, builtin base 등록을 OTA Release 발행으로 취급하지 않는다. 이미 배포한 앱에서 hash만 보내서 서버가 patch를 만들 수 있다고 문서화하지 않는다.

### 5.7 tar.br 단일 보조 경로와 v1 계약 확정

manifest는 설치 결과의 유일한 기준이다. 새 deploy 및 Bundle copy는 모든
content-addressed 원본, 선택적 patch와 함께 `bundle.tar.br`를 생성한다.
아카이브에는 정렬된 목표 일반 파일만 포함하고 `manifest.json`은 포함하지 않는다.
archive를 생성한 뒤 다음 정보를 최종 manifest에 넣고 전체 manifest를 서명한다.

```ts
archive?: {
  downloadFileHash: string; // 압축된 bundle.tar.br의 SHA-256
  downloadByteSize: number; // 압축 전송 크기
  tarByteSize: number;      // 해제된 TAR 스트림의 정확한 크기
};
// 각 assets[path]에는 논리 파일의 byteSize도 기록한다.
```

- archive는 `bundles/<id>/manifest.json`의 고정 sibling `bundle.tar.br`다.
  서버가 canonical Storage URI를 검증해 URL을 해석하며 native가 signed URL을
  문자열 가공해 추측하지 않는다. URL 해석 실패 시 archiveUrl을 생략할 수 있다.
- Bundle/DB/provider 계약은 manifest 중심으로 유지한다. archive 전용 DB 컬럼,
  metadata 우회 저장, 이전 row 호환 경로를 복원하지 않는다. 기존 1.0.0 초기
  schema/migration 수정 원칙은 유지하며 이 보조 경로 자체에는 추가 DB 변경이 없다.
- 사용자 config의 `compressStrategy`와 archive/diff 선택은 없다. 이전 옵션은 거부한다.
- TAR 메타데이터(mtime/mode/uid/gid)와 파일 순서를 고정한다. 아카이브와 모든
  원본 업로드가 끝난 뒤 Bundle/Release를 공개하며 archive 생성/업로드 실패는
  배포 실패다. 생성 CPU/임시 디스크와 릴리스마다 전체 압축 객체 하나의 저장 비용을 기록한다.
- Storage prune/delete는 canonical Bundle prefix 아래 archive까지 처리한다.

**전송 선택**은 native의 manifest/전체 descriptor 검증 및 기존 staging·OTA·builtin
재사용 후, 개별 파일 다운로드 시작 전에 한 번만 한다.

1. 남은 네트워크 파일이 2개 미만이면 개별 전송한다.
2. 각 파일의 서명된 `downloadByteSize`와, patch가 있으면 `patch.byteSize`를 읽는다.
3. 각 예상 전송량은 `min(원본 크기, 제공된 patch 크기)`다. patch base가 실제로
   사용 불가해도 이는 낙관적인 하한이므로 archive 선택을 보수적으로 만든다.
4. 필요한 크기 또는 archive/논리 파일 경계가 없거나 잘못됐거나 합산이 overflow하면
   개별 전송한다. 임의 RTT·대역폭·파일 수 가중치·사용자 임계값은 추가하지 않는다.
5. `archive.downloadByteSize <= 예상 개별 전송량 합`일 때만 archive를 선택한다.
6. 모든 목표 파일이 네트워크 대상이고 제공된 patch가 하나도 없을 때만 예외를 둔다.
   `TAR framing = tarByteSize - Σ asset.byteSize`가 음수가 아니고,
   `archive.downloadByteSize <= 예상 개별 전송량 합 + TAR framing`이면 archive를 선택한다.
   모든 값·합산은 JavaScript safe integer 범위여야 한다. 이 예외는 압축되지 않는
   다수 파일에서 TAR 포맷 자체의 오버헤드 때문에 요청이 폭증하는 것을 막는다.
   재사용 또는 patch가 있는 경우에는 5번의 엄격한 크기 비교만 적용한다.
7. 추가 전송 허용량은 서명된 실제 TAR framing으로 한정한다. 항상 최소 지연 시간을
   보장하거나 모든 정상 경로에서 payload가 줄어든다고 주장하지 않는다. 같은 입력으로
   대역폭 제한 유무를 나눠 실제 native installer를 측정한다.

**설치와 실패:** archive를 별도 scratch에 한 번 다운로드하고 압축 크기와 SHA-256을
검증한 뒤 Brotli 해제 및 TAR 추출을 수행한다. `tarByteSize`와 파일별 `byteSize`
경계를 강제하고, 정규화된 상대 경로·중복 없음·정확한 파일 집합·정상 스트림 종료를
검증한다. symlink/hardlink/device/미지원 entry 및 path traversal는 조용히 건너뛰지
않고 거부한다. 모든 추출 파일에 기존 manifest hash/signature 검증을 적용한 뒤
staging에 반영한다. 검증된 manifest는 별도로 저장하고 기존 atomic promotion,
catalog guard, stable/crash recovery 규칙을 유지한다.

archive 다운로드/해시/해제/파일 검증 실패 시 archive scratch를 전부 버리고,
앞서 계산한 개별 파일 계획을 한 번 실행한다. 실패한 부분 추출 파일은 재사용하지
않으며 이미 검증한 로컬 재사용은 보존한다. archive로 되돌아가는 루프나 두 경로의
동시 실행은 없다. manifest 또는 descriptor 계약 검증 실패는 즉시 실패한다.
이 복구 경로에서는 전송량 중복이 발생할 수 있으며 정상 경로의 크기 상한을 주장하지 않는다.
patch 실패는 계속 해당 파일의 원본으로만 복구한다.

**네이티브 단순화:** 기존 개별 Brotli decoder를 공유하는 직접 tar.br 경로만 둔다.
ZIP/gzip/bzip2 OTA 추출, 형식 자동 감지, DecompressionStrategy/registry/factory,
압축 협상은 복원하지 않는다. bsdiff 내부 bzip2와 builtin APK reader는 유지한다.

## 6. 구현 순서와 검증 게이트

각 단계 완료 시 `plans/README.md`를 갱신한다. 체크리스트만 채우고 증거를 생략하지 않는다. 기술적 장애가 생기면 관련 없는 단계는 계속 진행하되 실패한 gate를 통과했다고 기록하지 않는다.

### M0 — Release 패키징 조사와 작은 동작 검증

1. 작업 기준/브랜치 및 AGENTS 지침을 확인한다. baseline CI/E2E 명령을 기록한다.
2. `examples/v0.85.0`에 JS만 변경하는 첫 OTA fixture와 내장 PNG/font fixture를 마련한다. 정상 Release 설정을 유지한다.
3. iOS Release 앱의 실제 bundle, Android AAB에서 기기에 맞춰 생성·설치한 split APK들을 조사한다. universal APK만으로 split 검증을 대신하지 않는다.
4. 각 파일의 OTA 논리 경로, 패키지 source, 읽은 SHA256, target SHA256, 재사용 가능 여부와 사유를 기록한다.
5. 패키징이 보존한 동일 PNG/font는 재사용하고, 실제 변환된 PNG·없는 density·변경 파일은 다운로드하는 최소 동작을 검증한다.

**산출물:** `plans/evidence/builtin-packaging.md`와 기계 판독 가능한 결과 JSON. 빌드 SHA, 빌드 설정, device/split 구성, 비교 해시, 테스트 명령을 포함한다. 앱 전체 바이너리나 secret은 커밋하지 않는다.

**gate:** 두 플랫폼에서 byte-identical 내장 asset 재사용과 missing/mismatched 파일 다운로드가 증명돼야 한다. stock packaging에서 이미지 재사용이 사실상 불가능하면 그 사실을 숨기거나 강제로 packaging 옵션을 바꾸지 않는다. 가능한 font/일반 파일 범위는 진행하고, 이미지 보장에 필요한 변경을 분리해 보고한다.

### M1 — 전체 원본 descriptor와 base 없는 설치

1. 새 artifact wire version과 unsupported unversioned 경계를 확정하고 현재 문서에 실제 선택을 기록한다.
2. core, server artifact resolver, SDK HTTP/native bridge를 갱신해 모든 목표 파일의 원본 경로를 제공한다.
3. native installer의 기존 OTA manifest 필수 조건과 null archive URL reset 결합을 풀고 명시적인 install/builtin transition을 구분한다.
4. 기존 로컬 파일 손상·누락을 해당 원본 다운로드로 복구한다. patch 실패 역시 파일 단위로 복구한다.
5. manifest만으로 빈 상태에서 전체 설치, 불일치 응답 거부, unversioned endpoint 미제공을 검증한다.

**gate:** server artifact tests, SDK/native bridge tests, Swift/Android storage tests가 통과하고 base가 없는 설치에 archive 요청이 없어야 한다.

### M2 — 내장 resolver와 lazy 인덱스 통합

1. 두 플랫폼에 작은 내장 resolver를 추가한다. 기존 storage 서비스와 맞는 interface를 사용하고 범용 framework는 만들지 않는다.
2. 비동기 installer에서만 인덱스를 준비한다. 패키지 identity·cache schema·원자적 저장·무효화를 구현한다.
3. 실제 source 바이트를 검증하고 필요한 파일만 staging으로 복사한다.
4. 빈 getter cache, 캐시 손상/삭제, 앱 교체, split 변경, 동시 update 호출을 시나리오로 검증한다.
5. 초기 OTA 이후 동일 installer로 연속 업데이트와 crash rollback을 검증한다.

**gate:** 첫 OTA의 동일 내장 파일에 대해 network request/bytes가 0이며, 최종 파일 해시와 앱 화면·Bundle ID가 목표와 일치해야 한다. 단순 로그 메시지는 증거로 충분하지 않다.

Release E2E의 shard 의존성 symlink는 native build와 OTA의 dependency asset 경로를
다르게 만들 수 있다. 앱 로컬 PNG/font 재사용 시나리오는 선택적 `archiveUrl`을
명시적으로 생략하고 archive 요청도 0인지 확인한다. 이는 재사용 기능의 분리 검증이며
기본 자동 선택의 증거로 보고하지 않는다. 자동 선택은 archive URL이 있는 native
JS-only/patch 벤치마크 및 정상 archive·손상 fallback Release 시나리오로 검증한다.

### M3 — tar.br 보조 경로와 전송 비용 검증

1. baseline archive 버전과 새 installer를 같은 산출물·네트워크 조건으로 비교한다.
2. 비교 항목은 JS-only 첫 OTA, 작은 OTA→OTA, 빈 base, 많은 작은 파일의 전체 변경이다.
3. 다운로드 바이트·요청 수, 준비/해싱/설치 시간, peak 임시 디스크와 메모리를 기록한다. 반복 횟수·기기·네트워크 조건을 명시하고 소수 실행을 p95라고 부르지 않는다.
4. 제한된 병렬화·검증된 파일 재사용·개별 retry로 전체 변경 경로의 피할 수 있는 병목을 해결한다. 측정 근거 없이 새 pack 형식을 만들지 않는다.
5. 5.7의 단일 tar.br 계약을 deploy/copy/server/SDK/native에 구현하고 ZIP/gzip/압축 선택의 부활을 막는다.
6. 문서·예제·progress·E2E의 archive 전제를 변경하고 changeset을 작성한다.

**gate:** correctness 시나리오는 모두 통과해야 한다. JS-only fixture는 재사용 대상의 다운로드가 정확히 제거돼야 한다. 전체 변경 시나리오가 반복적으로 baseline보다 느리면 크기/요청 수에 따른 원인을 보고서에 적고 병목 개선 후 다시 측정한다. unresolved 심각한 성능 회귀나 프로토콜 문제가 있으면 전송 계약의 인수 완료로 판정하지 않는다. 관측하지 않은 수치나 임의 SLO로 성공을 선언하지 않는다.

### M4 — 통합 검증과 인수

변경된 native build를 사용하는 iOS/Android E2E 및 모든 영향받는 provider 계약을 검증한다. 원래 archive→diff 시나리오를 단순 삭제하지 말고 builtin→manifest, patch→원본 fallback 시나리오로 전환한다. 기존 catalog ordering, scope switch, recovery, signing 시나리오는 계속 통과해야 한다.

**gate:** 아래 완료 조건과 검증 명령의 실제 결과가 모두 기록돼야 한다. 완료 후 사용자에게 변경 요약, 테스트 결과, 남은 한계, 작업 디렉터리를 보고한다.

## 7. 필수 시나리오

| ID | 시나리오 | 관측할 결과 |
| --- | --- | --- |
| A01 | 첫 설치, 서버 base 미등록, JS만 변경 | 동일 내장 파일은 0 bytes; HBC 원본을 받아 정상 실행 |
| A02 | 로컬 manifest와 builtin 인덱스 모두 없음 | lazy 조회 또는 원본만으로 정상 설치 |
| A03 | 내장 PNG가 패키징 중 변환됨 | 실제 hash mismatch; 그 파일 다운로드; 최종 해시 일치 |
| A04 | Android density split 일부 없음 | 없는 파일만 다운로드; 잘못된 density를 대용하지 않음 |
| A05 | iOS asset catalog/지원 밖 asset | 안전한 miss와 원본 다운로드; crash 없음 |
| A06 | 서버는 unchanged라 판단하지만 로컬 파일 손상 | 전체 descriptor로 해당 파일 복구; archive 요청 없음 |
| A07 | patch 없음/404/손상/base 불일치/적용 실패 | 같은 target 원본 다운로드, 최종 검증 성공 |
| A08 | patch가 원본 전송보다 큼 | 원본 선택 |
| A09 | 전체 파일 변경, 여러 작은 파일 | 조건에 맞으면 tar.br 1회, 개별 파일 요청 없음, 모든 최종 hash·성능 증거 |
| A10 | 설치 중 종료 후 재시도 | stable 보존, 검증된 완료 파일 재사용, partial 신뢰 금지 |
| A11 | 새 OTA 시작 시 crash | 기존 stable 또는 builtin 복구, crashed Bundle 재선택 방지 |
| A12 | 앱 native 업데이트/동일 version 재빌드 | 오래된 인덱스로 잘못 재사용하지 않음 |
| A13 | manifest/descriptor 해시·집합 불일치 또는 서명 오류 | fail closed; 현재 실행 상태 보존 |
| A14 | 삭제·경로 변경 asset | 목표 manifest 파일 집합과 완성 디렉터리가 일치 |
| A15 | 이전 catalog 응답/동시 설치 뒤늦게 완료 | 기존 generation/selection guard가 stale 활성화 방지 |
| A16 | unversioned endpoint 또는 manifest 없는 artifact | 미지원 오류; reset/빈 성공 아님 |
| A17 | 디스크 부족/인덱스 쓰기 실패 | stable 보존; 인덱스 최적화 실패만이면 다운로드 가능 |
| A18 | `getManifest()`를 초기화 전에 호출 | 빈 session cache 때문에 첫 OTA 재사용이 막히지 않음 |
| A19 | 남은 파일 0/1/2, 동률, framing 경계·초과, 재사용/patch, 크기 누락·overflow | 전체 원본 요청만 framing allowance; 나머지는 엄격한 비용 비교 |
| A20 | archive 404·손상·truncation·TAR 경로/중복/링크/집합·크기 위반 | scratch 제거 후 개별 원본 한 번, stable 보존, 반복 전환 없음 |
| A21 | 정상 tar.br 및 긴 PAX 경로 | 정확한 파일 집합·크기·hash/signature, manifest 별도 보존 |
| A22 | deploy/copy 및 Storage 정리 | archive 메타데이터 서명, 공개 전 업로드 완료, live 보존/dead 삭제 |

## 8. 파일 경계

직접 관련된 다음 범위만 수정한다. 새 파일은 인접 테스트/작은 native resolver처럼 직접 필요한 경우만 추가한다.

- `packages/core/src/{types,bundleArtifacts}.ts` 및 계약 테스트.
- `packages/server/src/db/{updateArtifacts,releaseCatalog,createBundleDiff}.ts`, HTTP artifact boundary, 영향받는 schema/migration/adapter와 테스트.
- `packages/react-native/src/{native,httpClient,checkForUpdate,store}.ts`, native specs 및 실제 소비자.
- `packages/react-native/ios/HotUpdater/Internal/`의 storage, download, hash, builtin resolver, archive 제거 대상과 해당 Test/Package.swift.
- `packages/react-native/android/src/main/java/com/hotupdater/`의 같은 책임과 단위 테스트·build dependencies.
- `packages/hot-updater/src/commands/deploy.ts`, bundle/artifact/patch 명령의 필요한 필드 대응, config loader, `utils/bundleManifest.ts`, signing 및 관련 테스트.
- `plugins/plugin-core/src/`의 Bundle/DB/storage contract와 provider별 직접 영향받는 schema/CRUD/migration.
- `packages/console`은 제거되는 archive 필드의 실제 소비자만 수정하며 UI 재설계를 하지 않는다.
- `examples/v0.85.0`, `e2e/detox`, 직접 영향을 받는 문서·예제 설정·`.changeset`.
- `plans/`의 PRD·실행 상태·검증 증거.

server public entry 경계는 `packages/server/AGENTS.md`를 따른다. CLI 출력은 기존 `cli-ui.ts`를 사용한다. config 제거만을 이유로 관련 없는 deploy UI migration을 하지 않는다. 기존 코드의 naming/formatting을 맞추고 필요한 변경만 수행한다.

## 9. 검증 명령과 실행 환경

모든 명령의 cwd는 위 작업 디렉터리다. worktree에 의존성이 없으면 repo에서 지정한 Node/pnpm 환경을 확인한 뒤 `pnpm install --frozen-lockfile`로 준비한다. main의 node_modules나 출력 디렉터리를 변경하는 symlink를 임의로 만들지 않는다.

| 목적 | 명령 | 성공 기준 |
| --- | --- | --- |
| 기준 확인 | `git diff --stat ec78756926cac3b23ca32c1d3acefe28d2ebb7ab..HEAD -- packages plugins e2e` | 변경이 있으면 live code와 PRD 차이를 검토 |
| 빌드 | `pnpm -w build` | exit 0 |
| 타입 | `pnpm -w test:type` | exit 0 |
| lint | `pnpm -w lint` | exit 0 |
| unit | `pnpm -w test` | 전체 통과 |
| integration | `pnpm -w test:integration` | 전체 통과, 필요 Java 환경은 기존 CI 참조 |
| Swift | `pnpm -w test:swift` | 관련 native 테스트 포함 통과 |
| Android | `./gradlew :hot-updater_react-native:testDebugUnitTest --build-cache` | cwd `examples/v0.85.0/android`, 관련 테스트 통과 |
| E2E 확인 | `pnpm -w e2e:detox -- --list` | 새 시나리오와 suite 표시 |
| E2E 계획 | `pnpm -w e2e:detox -- --platform all --suite default --dry-run` | 양 플랫폼 시나리오 포함 |
| 준비된 환경 E2E | `pnpm -w e2e:detox -- --platform all --suite default` | 변경된 native 산출물 기준 통과 |
| 변경 범위 | `git diff --check` 및 `git status --short` | whitespace 오류/무관 파일 변경 없음 |

비용 큰 전체 검증 전에 실패 시나리오에 맞는 focused tests를 돌린다. 변경 없이 이미 통과한 검증을 반복하지 않는다. 변경된 native 부분은 simulator/unit만으로 Release 패키징 검증 완료라 하지 않는다.

대시보드/기기 E2E는 이 checkout의 `.agents/skills/hot-updater-agent/SKILL.md`를 읽고 이용한다. 기본 profile은 `standalone-kysely`. 초기 준비는 `hot-updater-agent status -limit 5`로 기존 작업을 확인한다. `verify`는 현재 PR을 요구하므로 PR이 없는 로컬 diff에 성공 증거로 사용할 수 없다. local prepared harness 또는 CLI가 지원하는 정확한 ref의 manual 환경을 사용하고 테스트 대상 SHA를 기록한다. 원격 job이 로컬 uncommitted 변경을 포함한다고 가정하지 않는다. manual lease는 반드시 정리한다. private key/credential/.env 값은 문서나 로그에 남기지 않는다.

## 10. 완료 조건

- [x] M0 실측으로 두 플랫폼의 실제 내장 파일 대응과 재사용·fallback 한계를 기록했다.
- [x] 필수 빌드 manifest 삽입 없이 첫 OTA 동일 파일 재사용이 작동한다.
- [x] 내장 인덱스는 비동기·부분적·재생성 가능하고 native package identity 변화에 안전하다.
- [x] 모든 목표 파일의 원본을 얻을 수 있어 base/cache/patch 없이 설치된다.
- [x] 로컬 손상·patch 실패가 파일 단위로 복구된다.
- [x] signing/hash/path/atomic staging/catalog/recovery 불변식이 유지된다.
- [x] tar.br 단일 보조 경로와 결정적 선택·실패 복구가 구현됐고 ZIP/gzip/자동 감지/전략 분기가 없다.
- [x] `compressStrategy`가 공개 surface에서 제거되고 예전 설정은 명확히 거부된다.
- [x] 1.0.0 schema/migration과 versioned protocol을 직접 갱신하고 테스트했다.
- [x] 실제 tar.br로 작은 변경과 전체 변경의 bytes/requests/time/disk/memory를 비교하고 많은 파일의 요청 병목을 해결했다. 80회 결과와 대역폭 제한 시 거의 동률인 한계는 `evidence/native-tar-br-transfer.{md,json}`에 기록했다.
- [ ] 최종 구현 revision의 unit/integration/native와 standalone-* 5개 full E2E 및 required checks가 통과했다.
- [x] 첫 내장 Hermes patch가 base 등록 없이 지원된다고 주장하지 않는다.
- [ ] tar.br 합의 기준으로 문서·예제·changeset·실행 상태와 실제 검증 증거를 갱신했다.

## 11. 진행을 제한하는 조건

다음은 자동 승인 요청 조건이 아니라 구현 방향을 함부로 바꾸지 않기 위한 경계다. 관련 없는 구현·검증은 계속한다.

- byte equality가 성립하지 않는 포맷을 의미적 동일성으로 우회해야만 재사용할 수 있으면 그 재사용은 하지 않는다.
- stock Release에서 요구한 재사용 효과가 실증되지 않으면 아카이브 삭제 gate를 통과한 것으로 처리하지 않는다. 실제 차이와 최소 대안을 보고한다.
- 첫 Hermes patch 때문에 필수 CI 업로드/새 Release 정책이 필요해지면 이번 범위를 확장하지 않는다.
- credential 사용 범위 확대가 필요하면 이미 승인된 범위인지 확인하고 경계를 넘지 않는다.
- 외부 device/build/signing 환경이 부족하면 가능한 소스·로컬 테스트를 진행하되 실제 Release 검증을 완료로 표시하지 않는다.

## 12. 근거와 남은 판단

- [Apple: bundle은 런타임에 수정하지 않는 구조](https://developer.apple.com/documentation/xcode/embedding-nonstandard-code-structures-in-a-bundle)
- [Android AAPT2: resource compile과 PNG processing](https://developer.android.com/tools/aapt2)
- [Android App Bundle: density 등 configuration APK](https://developer.android.com/guide/app-bundle/configure-base)
- RN 0.85.2에서 확인한 `getAssetDestPathAndroid`, `getAssetDestPathIOS`, `saveAssets`, `AssetSourceResolver`: 실제 설치 경로는 bundler output 경로와 단순 동일하지 않을 수 있다.

M0 실측 결과는 `plans/evidence/builtin-packaging.md`와 JSON에 기록했다. iOS는 OTA PNG 17개 전부가 일반 bundle-relative 파일로 동일했고, Android arm64/en/xxhdpi split 설치 집합은 PNG 17개 중 5개만 동일했다. 두 플랫폼 모두 현재 Re.Pack native build와 bare OTA build의 HBC가 달랐다. 따라서 부분 인덱스와 파일별 원본 fallback 설계를 유지한다.

native package cache identity는 iOS app bundle identity와 Android package/split
identity로 구현했다. artifact 경계는 versioned v1 endpoint만 지원하며, v1 초기
schema와 최초 migration을 archive 없는 계약으로 직접 수정했다.

M3 실측은 `plans/evidence/manifest-transfer.md`와 JSON에 기록했다. Android
Release fixture에서 첫 OTA는 1,048,299 → 830,077 bytes, 실제 HBC patch OTA는
1,048,348 → 115,353 bytes였다. 1,000개 파일 전체 변경은 1,001 requests와 ZIP
대비 35.5% 느린 로컬 설치 시간을 보여, 개별 파일 프로토콜의 확장성 한계로
명시했다. 이 결과를 모든 workload의 성능 향상으로 해석하지 않는다.

exact revision `0e821f7fa8f365a7446c2ab41fbe92ee852ddb4e`에서 Prisma,
Kysely, MongoDB, DynamoDB, Drizzle의 full Release E2E가 모두 통과했다. 각
profile은 iOS 15/15 + 11/11과 Android 26/26을 실행했으며
`fingerprint-initial-install`과 `bspatch-builtin-to-diff-ota`를 양 플랫폼에서
검증했다. 상세 job ID와 결과는 `plans/evidence/device-e2e.md`에 기록했다.

2026-09-21 감사 수정 이후 실제 Swift installer 비교는
`plans/evidence/native-transfer.md`와 JSON을 기준으로 한다. 순차 처리 대비
1,000-file 설치는 71.1% 개선됐지만 ZIP 대비 9.3배 걸렸으므로 M3는 아직
인수되지 않았다. 이전 Node microbenchmark와 이전 revision E2E 결과를
현재 구현의 전체 인수 근거로 사용하지 않는다.

2026-09-21 사용자가 tar.br 단일 보조 경로를 승인했다. 위 5.7과 적대적 합의 기록이
이전의 아카이브 완전 제거 결정을 대체한다. 이전 측정과 E2E는 이전 구현 증거로
보존하며, 새 tar.br 구현의 성공으로 재사용하지 않는다.

2026-09-21 tar.br 후속 구현과 최신 native 성능 증거는
`evidence/native-tar-br-transfer.{md,json}`에 기록했다. 기존 archive 삭제만으로
남았던 1,000-file 요청 병목은 해결됐다. 512 KiB/s 제한에서는 속도 개선을
주장하지 않으며 추가 framing bytes와 임시 디스크 비용을 명시한다.
최종 standalone full E2E와 required checks는 별도 잔여 gate다.
