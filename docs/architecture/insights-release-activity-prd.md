# PRD: 집계 기반 Release Activity와 번들 통계 과조회 제거

- 상태: **PRD 완료 · 구현 대기**. 사용자가 이 스펙의 구현과 `next` 대상 PR 생성을 승인했다.
- 작성일: 2026-09-15.
- 기준: `origin/next`, `ec78756926cac3b23ca32c1d3acefe28d2ebb7ab`.
- migration 방침: 정식 배포 전이므로 사용자의 지시에 따라 기존 `1.0.0` schema·migration을 직접 수정한다. 별도 후속 schema 버전을 만들지 않는다.
- 구현 브랜치: `feature/insights-release-activity`.
- 로컬 작업 디렉터리: `/Users/gronxb/workspace/hot-updater-release-activity`.
- 우선순위: P1. 규모: L. 위험: 높음; 모든 Insights 저장 경로의 원자성과 migration에 영향.
- 이 문서는 앞선 검토 문서를 대체하는 구현 기준이다. 대화나 다른 계획을 읽지 않아도
  실행할 수 있도록 API·정확성·DB 비용·전환 절차·검증 기준을 함께 정의한다.
- 검토 이력: 저장/정확성 기본 설계는 독립 리뷰어 3명 승인. 이후 사용자가 공개 조회
  통합·인자명 변경·과조회 금지를 확정했다. 수정된 API에 별도 리뷰어 재승인이 있었다고
  주장하지 않는다. 설계 승인과 native 구현/성능 검증을 구분한다.

## 제품 목표와 완료 기준

운영자는 번들 목록에서 각 release의 마지막 실행/적용 대기 설치 수와 수집된 전체 기간의
고유 다운로드/복구 설치 수를 확인한다. Insights에서는 같은 요약을 보면서 선택 기간의
보고 추이를 살핀다. 기록이 쌓여도 이 화면의 DB 읽기량이 함께 증가해서는 안 된다.

1. `{ releases }`는 해당 release의 저장된 summary만 읽는다. raw events, 설치 상태
   전체, lifetime markers 전체, 전체 기간 hourly buckets를 읽거나 세지 않는다.
2. `timeRange`가 있으면 요청한 release·기간의 hourly series만 추가한다. summary 의미는
   그대로다. 보이지 않는 release와 요청 밖 시간은 읽지 않는다.
3. 번들 통계 계산을 위한 100건 페이지네이션과 50,000건 스캔 상한을 제거한다.
   집계 미준비/미지원 시 full-scan fallback을 두지 않는다.
4. 현재값 귀속, 고유 누적값, 중복 수락, 지연·역순 저장을 native 원자성으로 보장한다.
5. 기본 제공 provider, schema/migration, Console, shared conformance와 실제 읽기 비용
   검증을 완료하고 변경사항·측정 결과를 담은 **base=`next` PR**을 생성한다.

## 범위 밖

- App Usage의 DAU/WAU/MAU 계산과 이벤트 탐색 화면의 페이지네이션 재설계.
  이들은 기존 의미로 유지하며 이번 PR로 모든 Insights 과조회가 해결됐다고 표현하지 않는다.
- 기존 공개 raw overview, `listEvents`/`findLatestEvents`의 탐색 의미 제거.
- 일반 관리 목록의 페이지네이션과 무관한 공통 `PAGE_SIZE` 전역 삭제.
- SDK 강제 업그레이드, lifetime Active 추가, 통계적 성공률/장애율 추정.
- 온라인 rebuild, CDC, queue, Redis, 선제적 counter sharding, raw event TTL.
- 운영 DB에 실제 migration 실행, 배포, PR merge. 이 작업의 결과물은 검증된 코드와 PR이다.

## 1. 결정

최우선 요구사항은 과조회 제거다. **동일한 release 수·기간을 요청할 때 원본 이력이나
무관한 release가 늘어도 조회량이 늘어나지 않아야 한다.** 페이지 크기 변경이나
프런트엔드 캐시만으로 이 요구사항을 충족했다고 판단하지 않는다. DB가 실제로 읽는
rows/items와 요청 횟수로 검증한다.

공개 Insights 모델은 기존 5개 메서드를 유지하고 `getReleaseActivity` 하나를
추가한다. 별도 `getReleaseStats`는 추가하지 않는다. 새 조회는 기본 제공되는 지원 provider의
필수 계약이며, 미지원 시 명시적으로 실패한다. 원본 이벤트 스캔 fallback은 없다.

`releases`로 조회할 배포들을 지정한다. `timeRange: { start, end }`를 생략하면
현재 상태·전체 기간 요약만 반환하고, 지정하면 같은 요약에 해당 기간의 시계열을
추가한다. 시간 범위는 시계열에만 적용된다. 생략을 전체 기간 시계열 조회로 해석하지 않는다.

이것만으로 구현이 끝나지 않는다. 기존 release ID 상속을 보존하기 위해
core가 설치별 작은 집계 상태를 읽고, 순수 계산으로 변경분을 만들고,
provider가 revision 조건을 확인하며 원자적으로 저장하는 쓰기 계약도 필요하다.
호출자가 사용하는 `recordEvent({ event })`는 유지한다.

우선순위는 정상 SDK 동작과 release 귀속의 정확성을 보존하면서 읽기 비용을
누적 이력과 분리하는 것이다. SDK가 release ID를 빠짐없이 보고하도록 개선하는
것은 바람직하지만, 이 설계의 정확성을 그 개선이나 SDK 일괄 업그레이드에 의존시키지 않는다.

## 2. 기존 구조와 이 설계가 바꾸는 결정

조사 기준 파일의 확인된 사실:

- `packages/console/src/lib/server/bundleActivity.ts:15`: 화면의 모든 행이
  30일 global event scan 하나를 공유하고, 이후 scope/release별로 필터한다.
- `packages/console/src/lib/server/insightsHistory.ts:20`: 100건 + 다음 페이지
  확인용 1건을 최대 500회 읽으며, 50,000건 상한 이후는 Partial이다.
- `packages/console/src/lib/server/insightsRecovery.ts:95`: 같은 실행 파일과
  scope의 null release 보고는 앞서 관측한 release를 이어받는다.
- `packages/react-native/src/notifyAppReadyInsights.ts:79,227`: 정상 no-change
  보고도 release ID가 null일 수 있다. 최신 raw ID만 세면 실제 기존 동작에서
  Active가 unknown으로 이동한다.
- `plugins/plugin-core/src/types/databasePlugin.ts:127`: 기존 5개 메서드.
- `packages/server/src/insights/provider.ts:524`: 구 공개 overview가 여전히
  기간별 bundle ID/current 설치 수 및 raw event 건수를 제공한다.
- `packages/console/src/routes/insights.tsx:25`: 현재 App Usage와 Bundle Activity가
  appVersion을 포함한 같은 scope를 사용한다.

이 PRD는 과거 PRD의 다음 범위 결정을 명시적으로 변경한다:

1. 기존 5개 계약을 변경 없이 동결한다는 제한: 읽기 1개와 native 쓰기 프로토콜 추가.
2. provider-private heads에 release 귀속 상태를 두지 않는 제한: core가 계산한
   작고 불투명한 상태 저장을 허용한다. provider 저자가 lifecycle reducer를
   작성하지 않는 원칙은 유지한다.
3. Downloaded를 pending 하나로만 표현하는 UI: 누적 Downloaded와 현재 Pending을 분리.
4. Bundle Activity의 전체 release 시계열 비교: 선택 release의 raw report 변화로 전환.

App Usage의 DAU/WAU/MAU와 기존 raw overview는 이번 설계에서 폐기하지 않는다.

## 3. 지표와 식별자

집계 대상은 `(platform, channel, releaseId)`이다. 설치 식별자는 기존 contract의
`install_id`이며, 고유 설치 수를 사용자 수나 물리적 기기 수로 표현하지 않는다.
`bundle_id`는 파일 식별자이므로 같은 파일을 사용하는 여러 release를 합치지 않는다.

| 반환 필드                 | 의미                                                                      |
| ------------------------- | ------------------------------------------------------------------------- |
| `activeInstallations`     | 마지막 관측 실행 상태가 대상 release에 귀속되는 설치 수                   |
| `pendingInstallations`    | 마지막 관측이 해당 release를 받은 뒤 적용 대기인 설치 수                  |
| `downloadedInstallations` | 수집된 전체 기간의 UPDATE_DOWNLOADED를 대상 release로 보고한 고유 설치 수 |
| `recoveredInstallations`  | 수집된 전체 기간의 RECOVERED를 대상 release에서 보고한 고유 설치 수       |

현재 상태는 **설치의 전역 최신 receipt tuple을 결정한 후** platform/channel을
적용한다. scope가 바뀌었다고 이전 scope의 마지막 상태를 되살리지 않는다.
활동 중단/앱 삭제는 보고 없이 알 수 없으므로 Active에 30일 만료 규칙을 넣지 않는다.
UI에는 마지막 관측 상태임을 표시한다.

누적 다운로드는 APPLIED로 역추정하지 않는다. 누적 복구는 source release에 귀속한다.
동일 설치의 반복 보고는 lifetime 값에 한 번만 기여한다. 보고의 release ID가
없고 정당한 현재 상태 상속도 불가능하면 다른 release에 추측해서 배분하지 않는다.

`active <= downloaded`, `recovered <= downloaded`, 여러 release의 누적 합계가
전체 고유 설치 수라는 불변식은 성립하지 않는다. 새 스펙은 성공률/장애율을 반환하지 않는다.
`Ever active`는 이번 요구에 필수적이지 않으므로 추가하지 않는다.

## 4. 공개 읽기 계약

다음 이름/필드가 제안된 구체적 계약이다. provider용 계약에서 `releaseIds`만
받으면 현재 scope 의미를 보존할 수 없으므로 `releases`에 scope를 포함한 참조를 받는다.
상위 server/Console 편의 함수는 이미 읽은 release 메타데이터로 참조를 만든다.
ingestion마다 release 테이블을 조회하는 의무는 추가하지 않는다.

```ts
type ReleaseReference = {
  readonly releaseId: string;
  readonly platform: "ios" | "android";
  readonly channel: string;
};

type ReleaseActivityTimeRange = {
  /** Inclusive UTC Unix timestamp in milliseconds, aligned to an hour. */
  readonly start: number;
  /** Exclusive UTC Unix timestamp in milliseconds, aligned to an hour. */
  readonly end: number;
};

type InsightsHistoryCoverage =
  | { readonly kind: "complete"; readonly sinceMs: number }
  | { readonly kind: "partial"; readonly sinceMs: number | null };

type ReleaseActivity = {
  readonly release: ReleaseReference;
  readonly summary: {
    readonly activeInstallations: number;
    readonly pendingInstallations: number;
    readonly downloadedInstallations: number;
    readonly recoveredInstallations: number;
  };
  readonly series?: readonly {
    readonly startMs: number;
    readonly downloadedReports: number;
    readonly appliedReports: number;
    readonly recoveredReports: number;
  }[];
  readonly measuredAtMs: number;
};

interface InsightsModel {
  // Existing signatures and query semantics remain.
  recordEvent(input: InsightsRecordEventInput): Promise<void>;
  listEvents(
    input: InsightsListEventsInput,
  ): Promise<readonly BundleEventRow[]>;
  findLatestEvents(
    input: InsightsFindLatestEventsInput,
  ): Promise<readonly BundleEventRow[]>;
  countLatestEvents(input: InsightsCountLatestEventsInput): Promise<number>;
  countEvents(input: InsightsCountEventsInput): Promise<number>;

  getReleaseActivity(input: {
    readonly releases: readonly ReleaseReference[];
    readonly timeRange?: ReleaseActivityTimeRange;
  }): Promise<{
    readonly coverage: InsightsHistoryCoverage;
    readonly data: readonly ReleaseActivity[];
  }>;
}
```

### 인자와 요약

- `releases`는 중복 없는 1~20개 tuple이다. 중복/잘못된 값을 거부하고 입력 순서대로
  하나씩 결과를 반환한다.
- `timeRange` 생략 시 `summary`만 조회하고 `series` 필드를 생략한다. 시간 버킷과
  원본 이벤트는 읽지 않는다. 지정 시 같은 의미의 `summary`와 기간에 맞는 `series`를
  반환한다. 시간 범위로 summary를 필터하거나 과거 current 상태를 재구성하지 않는다.
- 기간 객체를 주면 `start`와 `end`를 모두 전달해야 한다. null/한쪽 경계만 지정은
  거부한다. 시간 값은 0 이상의 safe integer인 UTC Unix milliseconds로 통일하고
  Date 객체나 날짜 문자열을 혼용하지 않는다.
- appVersion, arbitrary dimensions, 정렬/페이지 cursor를 받지 않는다.
- summary의 네 값은 release별 한 번의 일관된 native 관측에 해당해야 한다.
  배열 전체, summary와 series 사이, 별도 호출 사이의 동일 snapshot은 보장하지 않는다.
- `measuredAtMs`는 해당 release 결과를 읽은 시각이며, 역사적 cutoff나
  처리완료 watermark가 아니다. 단일 시점의 전체 snapshot을 뜻하지 않는다.
- release의 존재/삭제 여부 검증은 상위 releases 모델의 역할이다. 준비된 저장소에서
  해당 release에 관측이 없으면 summary에 0을 반환하며, 이를 존재하는 release라고 해석하지 않는다.
- 삭제된 release의 분석 데이터를 관리 메타데이터 삭제에 따라 자동 cascade하지 않는다.

호출 예시:

```ts
// Bundles: current state and lifetime totals for the displayed releases.
await insights.getReleaseActivity({ releases });

// Insights: the same summary, plus reports within the selected period.
await insights.getReleaseActivity({
  releases: [selectedRelease],
  timeRange: {
    start: Date.UTC(2026, 8, 14, 0),
    end: Date.UTC(2026, 8, 15, 0),
  },
});
```

`releases`는 무엇을 조회하는지 드러내고, `timeRange`는 함께 유효해야 하는
두 경계를 묶는다. `start/end`의 포함·제외 규칙과 milliseconds 단위는 타입 주석 및
런타임 검증 계약에 명시한다. 기존 `fromMs/toMs`를 쓰는 다른 API는 이 변경으로 개명하지 않는다.

### 기간을 지정한 시계열

- 고정 UTC 1시간 버킷만 사용한다. 두 경계는 정확한 UTC hour 경계이며 `[start,end)`.
  release당 1~720시간 범위만 허용한다. 한 호출의 최대 논리 버킷 수는
  `releases.length × (end - start) / HOUR`이며 14,400개다. 이 상한은 허용 용량에 대한
  v1 상한이며 실측된 성능 보장은 아니다. 불완전한 임의 millisecond 구간을 받지 않는다.
- 각 release의 `series`는 해당 범위의 sparse ascending buckets이며 timestamp 중복은 없다.
  관측된 보고가 없으면 빈 배열을 반환한다. 빈 배열을 전체 기간 이력이 없다는 뜻으로 해석하지 않는다.
  누락된 버킷의 0 채우기와 6시간/24시간 합산은 core가 수행한다.
- UI 24h/7d/30d는 각각 최근 24/168/720개 시간 버킷이다. 현재 hour를 포함하면
  오른쪽 경계는 다음 hour 시작이며, 현재 버킷은 ‘진행 중’이다.
  임의 시각에서 정확히 지난 24시간이라는 의미와 구분한다.
- core 검증 경계는 `start < now`, `end <= ceil(now / HOUR) * HOUR`를 요구한다.
  정확한 hour 경계에서는 end=now인 완료 구간을 기본으로 한다. 미래 버킷을 0으로
  채워 미래 활동이 없다고 표시하지 않는다.
- 6시간/일간 합산은 UTC 경계로 수행하되 요청 범위와 겹친 시간만 합산한다.
  첫/끝 그룹이 잘리면 core의 화면 DTO에 실제 시작/끝과 partial 표시를 포함한다.
  범위 밖 시간을 0으로 보충해 완전한 하루처럼 표시하지 않는다.
- 값은 고유 설치 수가 아닌 **수락된 event ID별 보고 건수**이다. 같은 설치의
  반복 보고를 포함하므로 시간 버킷 합산이 가능하다.
- 같은 event ID 재기록은 증가하지 않는다. 현재 서버가 HTTP 요청별 새 ID를
  생성하므로 HTTP 재전송이나 실제 update attempt의 중복 제거까지 보장하지 않는다.
- 과거 버킷도 늦게 저장된 오래된 receipt tuple로 보정될 수 있다. closed bucket을
  영구 불변으로 캐싱하지 않는다. 새 계약에 rate/spike/firstAppliedAt은 없다.

### coverage와 준비 상태

- `complete/sinceMs`는 최초 보장된 수집 시작부터 빠짐없는 집계를 제공한다는 선언이다.
  계측 시작 전 실제 사용자 동작이나 실패한 전송까지 뜻하지 않는다.
- `partial/sinceMs`가 non-null이면 그 시각 이후 연속된 구간에는 누락이 없음을
  검증했지만 그 이전 이력이 불완전하다는 뜻이다. 내부 gap이 있으면 마지막 gap
  뒤로 sinceMs를 옮긴다. 그런 연속 구간을 증명할 수 없으면 null이다.
- 어느 경우도 단순히 가장 오래된 남은 이벤트 timestamp로 sinceMs를 추정하지 않는다.
- 부분 이력도 제공할 수 있지만 UI는 ‘수집된 이력 기준’과 coverage를 표시해야 한다.
  lifetime은 수집된 자료에 대한 값이며 완전한 lifetime의 하한이다. partial current는
  불완전 자료의 마지막 관측 상태이므로 실제 current의 하한이라고도 보장하지 않는다.
- activity의 버킷 전체가 검증된 연속 구간 안에 있을 때만 sparse missing을 0으로
  채운다. sinceMs=10:37이면 10:00 버킷도 partial이다. 경계 전/겹침 버킷은 관측값이
  있더라도 partial로 표시하며, 값이 없으면 unknown이다. 현재 열린 버킷은 관측 시점까지의
  값이다. coverage.sinceMs=null이면 어떤 누락 버킷에도 완전한 0을 부여하지 않는다.
- 메서드 미지원은 `InsightsAggregationUnsupportedError`로 반환하며 0/빈 결과나
  raw event scan fallback으로 숨기지 않는다.
- 실제 수치 타입은 기존과 같이 0 이상의 safe integer. overflow 시 명시적으로 실패한다.

## 5. 쓰기 계약: 논리 모델 6개, native adapter 7개

위 `InsightsModel`은 소비자가 사용하는 모델이다. 실제 provider 저자가 공급하는
adapter는 읽기 5개와 아래 두 저장 연산으로 구성한다. **조회 1개만 추가하는 변경이 아니다.**

core wrapper가 `recordEvent`를 구현하며, plugin author는 아래 native I/O를 구현한다.
domain 계산이나 helper 선택을 author에게 맡기지 않는다.

```ts
type LifetimeKey = {
  readonly release: ReleaseReference;
  readonly installId: string;
  readonly metric: "downloaded" | "recovered";
};

type CurrentDelta = {
  readonly release: ReleaseReference;
  readonly metric: "active" | "pending";
  readonly delta: -1 | 1;
};

type PreparedInsightsEvent = {
  readonly event: BundleEventRow;
  readonly expectedRevision: string;
  // Core-serialized, versioned, bounded state; adapters store it verbatim.
  readonly nextState: string;
  readonly currentDeltas: readonly CurrentDelta[];
  // Null if the relevant lifetime marker already existed, or no such outcome.
  readonly firstLifetime: LifetimeKey | null;
  readonly hourly: {
    readonly release: ReleaseReference;
    readonly hourStartMs: number;
    readonly metric: "downloaded" | "applied" | "recovered";
  } | null;
};

type InsightsStorageAdapter = Omit<InsightsModel, "recordEvent"> & {
  readRecordContext(input: {
    readonly installId: string;
    readonly lifetimeKey: LifetimeKey | null;
  }): Promise<{
    // Opaque token identifies the install revision or its absence.
    readonly revision: string;
    readonly state: string | null;
    readonly lifetimeExists: boolean;
  }>;

  commitPreparedEvent(
    input: PreparedInsightsEvent,
  ): Promise<
    | { readonly status: "committed" }
    | { readonly status: "duplicate" }
    | { readonly status: "conflict" }
  >;
};
```

이것은 용도가 고정된 저장 프로토콜이다. 임의 테이블명, counter key, 사용자 함수,
SQL fragment, 자유로운 delta 값, 일반 query DSL은 받지 않는다.
`currentDeltas`는 상쇄/중복을 제거한 최대 4개이고, firstLifetime/hourly는 각각 최대 1개다.
증가량은 lifetime/hourly 모두 항상 +1이다. core가 event scope와 방향을 검증/준비한다.

### recordEvent 처리

1. 기존처럼 raw event를 검증한다. core가 명시적 outcome에서 lifetime key를 준비한다.
2. `readRecordContext`로 설치의 revision/상태와 해당 lifetime marker 유무를 읽는다.
3. core가 기존 상태와 event로 새 상태, current delta, 최초 lifetime 여부, hour 증가를 계산한다.
4. provider가 `commitPreparedEvent`를 native transaction/조건부 atomic batch로 실행한다.
5. conflict면 같은 event ID/receipt tuple을 유지하며 재조회·재계산한다.
   무한 재시도하지 않으며, 고정된 bounded retry 후 오류를 호출자에게 전파한다.
6. duplicate는 성공과 동등한 완전 no-op이다. timeout으로 결과가 모호해도
   같은 prepared event의 raw ID를 유지하여 재시도한다.

context의 marker와 state는 같은 revision에 대응해야 한다. native snapshot 또는
revision 재확인으로 보장한다. marker를 stale replica에서 읽고 최신 revision과
결합해서는 안 된다. 모든 새 수락 이벤트는 오래된 tuple이어도 해당 설치 revision을
전진시킨다. revision은 설치 revision/아직 없음 상태를 나타내는 provider-owned opaque
token이다. 설치 revision은 수락 event.id를 사용할 수 있고 시간순일 필요는 없다.
신규 설치의 state=null도 CAS에 사용할 token을 반환한다.

### commit의 원자성

다음 항목이 모두 commit되거나 모두 rollback된다:

- canonical event 최초 삽입; 같은 event ID는 first-write-wins.
- 기존 latest-event/user/scope 인덱스의 원래 의미에 따른 갱신.
- expectedRevision 검사와 새 opaque state/revision 저장.
- current delta 반영.
- firstLifetime marker 최초 삽입과 해당 lifetime counter +1.
- hourly report counter +1.

duplicate 판정은 stale revision보다 우선하거나 실패 후 canonical ID를 확인해
duplicate로 판정해야 한다. conflict는 event append까지 포함해 아무것도 쓰지 않는다.
최초 marker 조건 실패도 전체 rollback 후 conflict로 처리한다. read/commit 사이에
다른 event가 들어와도 같은 설치 revision으로 marker와 현재 값의 경쟁을 막는다.

신규 event 수락과 ingestion 재시도는 core wrapper를 반드시 통과한다. factory 없이
raw adapter를 runtime에 그대로 주입하거나, 일부 ingestion 경로만 old recordEvent로
저장하는 우회는 지원하지 않는다. optional wrapper는 아니다. 이미 수락된 event의
이번 pre-GA `1.0.0`은 집계 테이블이 포함된 fresh schema에서 시작한다.

## 6. release 상속을 이력 재조회 없이 유지하는 방식

현재 상태 귀속을 위해 core가 설치당 유지할 논리 상태:

- H: 가장 큰 `(received_at_ms,id)`와 그 이벤트의 running key, pending target.
- running key: `(platform, channel, currentBundleId)`.
- A: H의 running key와 같은 이벤트 중 마지막 명시적 release 할당.
  APPLIED/RECOVERED의 명시적 null도 할당이며, UNCHANGED/DOWNLOADED의 null은 상속이다.
- B: H의 running key와 다른 이벤트 중 가장 큰 tuple.

실행 release는 `A.tuple > B.tuple`이면 A의 값이고, 아니면 unknown이다.
새로운 H가 다른 key라면 이전 H가 새 barrier가 된다. 그보다 오래된 이전 anchor는
새 key의 현재 귀속에 영향을 줄 수 없어 버릴 수 있다.
늦게 저장된 event도 A/B를 바꿀 수 있으므로 ‘older event는 current를 절대 바꾸지 않음’은
이 파생 귀속 상태에 적용하지 않는다. canonical raw head의 max-tuple 규칙은 그대로다.

이 상태는 event 개수에 비례하는 map이 필요하지 않다. source ID가 없는 lifetime
다운로드/복구 사실을 이 상속으로 역추정하지도 않는다. event-local outcome은 명시 ID만 쓴다.

독립 메모리 검증:

- root: 2 keys × 4 assignment/inheritance shape, 길이4의 모든 이벤트 조합 및
  저장 순서 98,304개, 매 prefix 393,216개를 정렬 fold와 비교하여 실패 0.
- semantics reviewer: exhaustive 31,104 + random 10,000 histories 일치.
- storage reviewer: random 20,000 histories × 50-event prefixes 일치.

이것은 유한 모델 검증이며, native transaction 정확성·SDK E2E·쓰기 성능의 증거는 아니다.
기존 Console의 scope별 boolean inScope로 상속 여부를 판단하는 구현을 그대로 복제하지
않고 정확한 platform/channel/file 연속성을 사용한다. 필요한 의미 보정은 regression으로 명시한다.

## 7. 물리 저장과 성능 경계

공통 테이블 구조는 강제하지 않는다. 기본 provider 구현에는 다음 접근 경로가 필요하다:

- 원본 event와 기존 canonical latest 접근 경로.
- 설치당 bounded core state + revision.
- `(scope,release,install,metric)` unique lifetime marker.
- release별 current/lifetime summary.
- `(scope,release,hour)` report bucket.

원본 이력이 늘어도 요약은 요청한 release별 summary만, 시계열은 요청한 release와
hour의 bucket만 읽는다. 수집 기간 전체에 해당하는 숫자는 이미 저장한 누적 counter다.
조회할 때 lifetime marker나 설치 상태를 전부 세거나 시간별 bucket을 전부 더하지 않는다.

| 요청                      | 허용되는 읽기                                              | 이력이 늘 때 비용                             |
| ------------------------- | ---------------------------------------------------------- | --------------------------------------------- |
| `{ releases }`            | 요청한 release들의 summary와 집계 준비/coverage 메타데이터 | release 수에 비례, 이벤트 수·이력 길이와 무관 |
| `{ releases, timeRange }` | 같은 summary와 지정한 범위의 hour buckets                  | release 수 × 요청 hours에 비례                |

번들 통계의 **100건 페이지 크기, 다음 페이지 탐색, 50,000건 스캔 상한을 제거한다.**
기존의 100건 기준을 다른 숫자의 이벤트 페이지 크기로 대체하지 않는다.
화면에 표시된 release들을 한 API 호출로 전달하고, provider는 native batch/key lookup 또는
scope와 release key로 제한한 indexed query를 사용한다. release별 API 요청이나
원본 이벤트 전체 순회로 통계를 완성하지 않는다.

- summary 경로에서 `listEvents`/`readInsightsHistory` 호출, raw event scan,
  설치별 row나 lifetime marker의 전체 `COUNT`, 전체 기간 hourly 합산은 금지한다.
- 기간을 생략한 호출은 hourly 저장소에 접근하지 않는다.
- 시계열에서 provider가 자체 응답 크기 제한 때문에 이어 읽는 것은 요청 범위의
  집계 bucket에 한정한다. 애플리케이션 공통의 `pageSize = 100` 규칙은 두지 않는다.
  이는 누적 원본 이벤트를 끝까지 읽는 페이지네이션과 비용 경계가 다르다.
- 집계 미준비/미지원 시 명시적 오류를 반환하며, 원본 조회로 fallback하지 않는다.
- 한 API 호출이 항상 물리 DB 쿼리 한 번이라는 보장은 없다. native 제한에 따른
  batch 분할, 준비 상태 확인, retry를 포함하여 실제 읽은 rows/items와 왕복 수를 검증한다.

native `COUNT`가 한 번이라는 이유로 bounded 읽기라고 인정하지 않는다.
요약을 shard로 저장한다면 비용은 releases × shards이며, shard 간 snapshot/일관성
조건도 입증해야 한다. 기본값으로 샤딩/큐/Redis를 추가하지 않는다.

UNCHANGED가 같은 현재 귀속을 유지하면 release summary에는 쓰지 않는다.
canonical head와 설치 state/revision의 쓰기까지 없어지는 것은 아니다.
보고 유입이 한 release에 집중되면 summary/hour bucket 경합을 측정해야 한다.

- D1: read→conditional atomic batch→CAS retry. JS transaction callback 요구 금지.
  기존 `d1Implementation.ts:476`의 revision guard 패턴이 참고점이다.
- SQL/MongoDB/Firestore: native transaction과 적절한 locking/CAS.
- DynamoDB: strongly consistent context read와 조건부 TransactWrite;
  기존 `dynamoDB.ts:3152` write concurrency 패턴을 참고한다.
  같은 summary item의 current/lifetime 변경은 하나의 native Update로 병합한다.
  동일 item에 여러 transaction action을 보내지 않는다.
- summary/series 모두 primary/strong 경로 또는 동등한 일관성으로 읽는다.
  release별 요약 및 hour별 세 지표는 각각 coherent committed read여야 하며,
  여러 행/호출 전체 snapshot은 보장하지 않는다. eventual secondary
  index 결과를 primary에 대한 정확한 즉시 집계라고 주장하지 않는다.

이 버전은 raw event 삭제/TTL 기능을 추가하지 않는다. 현재 동일 ID의 영구 no-op
계약을 유지하려면 globally accepted event-ID의 존재 정보도 계속 보존해야 한다.
향후 payload 정리를 지원하더라도 원본 row 또는 compact receipt/tombstone으로
중복 확인을 유지한다. archive만 있고 ingestion에서 ID 존재를 확인할 수 없으면 부족하다.
dedup horizon을 도입해 오래된 동일 ID를 다시 수락하는 의미 변경은 이번 범위에 없다.

lifetime marker, 설치 귀속 state, summary도 함께 보존한다. marker만 TTL로
없애면 재다운로드를 최초로 다시 셈한다. event-only 재구축을 약속하려면 원본 archive가
필요하며, 없다면 projection checkpoint와 신규 이력을 함께 보존해야 한다.
삭제/retention 정책은 acceptance identity, idempotency와 복구 가능성까지 일관되게
정의한다.

## 8. Console 구성과 제거 범위

- Bundles 행은 `getReleaseActivity({ releases })`로 현재 화면의 release 요약을 받는다.
  Insights는 같은 메서드에 선택 release와 `timeRange`를 주어 요약·시계열을 함께 받는다.
  화면 밖 release의 통계나 표시하지 않는 시계열은 미리 읽지 않는다. 번들 목록 자체의
  페이지네이션은 유지할 수 있으며, 통계를 계산하려고 목록 전체 페이지를 순회하지 않는다.
- Active/Pending은 마지막 관측, Downloaded/Recovered는 누적 설치 수로 표시한다.
- Insights 기간 선택은 activity graph에만 적용한다. graph 단위는 Reports.
- appVersion 필터는 App Usage 영역으로 옮긴다. 새 activity API에 appVersion을
  몰래 무시하거나 speculative dimensions를 추가하지 않는다.
- App Usage의 날짜 기반 동작은 유지한다. 그 경로의 원본 스캔 최적화는 별도 과제이며
  이번 작업 후 Insights 전체가 bounded해졌다고 주장하면 안 된다.
- 여러 release의 기간별 Reports 비교 그래프는 유지하되, 합산값을 고유 설치 수로
  표시하지 않는다. 근거가 동일 집단의 장애율이 아닌 rate/spike 표시는 제거한다.
- `readInsightsHistory`는 App Usage에서 남으므로 전체 삭제하지 않는다.
  이 문서의 100건 기준 제거는 번들 통계 경로에 적용하며, App Usage의 기존 별도
  이벤트 이력 처리까지 개선한 것으로 간주하지 않는다.
- `getReportingOverview`, `countLatestEvents`, `countEvents`, event history filters는 유지한다.
  raw report 건수/bundle 파일 식별자/기간 의미를 새 unique-release 통계로 대체하지 않는다.

## 9. 초기화와 배포 순서

1. 정식 배포 전인 기존 `1.0.0` schema·migration과 factory/adapter 계약을 직접 갱신한다.
   최종 스펙은 required이다. 구 plugin에는 명시적 unsupported를 반환하고 scan으로 숨기지 않는다.
2. fixed contract와 shared core reducer/CAS wrapper를 먼저 구현한다.
3. native provider별 ingestion/read를 구현하고 native conformance를 통과시킨다.
4. 아직 정식 배포 전이므로 기존 `1.0.0` migration을 이미 적용한 RC 개발 DB의
   자동 backfill 또는 in-place upgrade를 제공하지 않는다. 수정된 최종 migration으로
   fresh schema를 만들고 검증한다.
5. 보존해야 하는 RC 데이터가 있는 환경은 이번 변경을 자동 적용하지 않는다. 별도
   export/rebuild가 필요한 운영 migration은 정식 호환 정책과 함께 후속 범위로 다룬다.
6. native schema와 집계 기록 검증이 완료된 뒤 Console을 전환한다.

공유 factory는 상태 format/version의 해석을 소유한다. provider는 opaque state를
그대로 저장하며, 지원하지 않는 상태 버전은 명시적으로 실패한다.

## 10. 구현 시 통과해야 할 검증

| 시나리오                                                         | 반드시 성립할 결과                                                                |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| R1 실행 → R2 다운로드 → R2 적용 → R1 복구                        | current 이동, pending 해제, R2 lifetime download/recover 각각1                    |
| 같은 설치 R2 반복 다운로드/복구                                  | lifetime 각각1, 새 event ID별 Reports 증가                                        |
| 같은 event ID 중복, commit timeout 후 재시도                     | 원본·state·markers·모든 counter 추가 변화0                                        |
| t20 null UNCHANGED 먼저, t10 explicit R1 나중                    | canonical head=t20, Active R1=1                                                   |
| 위 상황에 t15 다른 파일/scope가 뒤늦게 삽입                      | 상속 차단, R1 Active 감소, unknown으로 귀속                                       |
| same-file R1→R2 selection UNCHANGED                              | Active 이동, 다운로드/적용 보고를 만들어내지 않음                                 |
| channel/platform 변경, 동일 receipt timestamp와 ID tie-break     | 전역 최신 후 scope 적용, 이전 scope 부활 없음                                     |
| 동일 artifact를 쓰는 여러 release, 잘못된 scope의 같은 ID 보고   | release와 scope 숫자가 섞이지 않음                                                |
| 서로 다른 설치가 동시에 같은 release 갱신                        | summary/hour 증가 유실 없음                                                       |
| 같은 설치의 두 context 읽기 후 경쟁 commit                       | 하나 conflict, 전체 rollback, 재계산 후 정확                                      |
| 첫 event/zero outcome/no marker, 삭제된 release                  | 유효 zero와 준비 안 됨을 구분, 집계 데이터 자동 삭제 없음                         |
| 정렬 hour 경계, current bucket, 늦은 old event                   | 범위/순서 정확, 허위 as-of/완료 watermark 없음                                    |
| coverage 시작 전 범위를 포함한 조회                              | 알려진 연속 구간만 표시, 이전 누락을 거짓0으로 채우지 않음                        |
| 같은 release summary에 대응하는 원본 이력을 10배 늘림            | 요약 조회의 examined rows/items·왕복 수 증가 없음, raw event 조회0                |
| 무관한 scope/release의 데이터만 늘림                             | 요청한 summary/시간 범위의 조회량 증가 없음, 전체 집계 테이블 스캔 없음           |
| `timeRange` 생략/지정 비교                                       | 생략 시 hourly 조회0·series 없음, 지정 시 summary 의미 유지·범위 내 series만 반환 |
| 여러 release를 표시하는 번들 화면                                | 한 API 호출로 요청, 100건 이벤트 페이지/전체 이력 순회 없음                       |
| 재보고                                                           | marker 유지로 lifetime 중복 없음                                                  |
| payload 정리 기능을 제공하는 provider의 동일 old event ID 재입력 | acceptance receipt로 중복 확인, state/current/lifetime/hourly 변화0               |

성능 실험은 다음 축을 별도로 바꾼다: 이력 깊이, 관련 설치 수, 무관한 scope의 크기,
선택 release 수, 요청 hours, 한 release에 집중되는 쓰기량. query count뿐 아니라
native rows/documents/items examined, 읽기/쓰기량, latency와 contention을 기록한다.
기본 데이터는 1,000/10,000 installations에 대해 installation당 이력 깊이를 별도 축으로
늘려, raw 이력 깊이가 요약 조회량에 영향을 주지 않는지 확인한다.

기존 root 검증 명령: `pnpm -w build`, `pnpm -w test:type`, `pnpm -w lint`,
`pnpm -w test`, `pnpm -w test:integration`. provider별 native conformance와
대표 SDK OTA flow를 추가로 실행해야 한다. 구현 PR에서는 아래 단계의 결과를 PR 검증
항목에 기록한다.

## 11. 적대적 리뷰와 결론

API/author 비용, SQL·NoSQL 저장, 지표/UX 정확성 담당 3명이 독립 검토 후
서로 반례와 대안을 교환했다. 당시 읽기 메서드가 둘이던 수정안을 다시 읽은 뒤
세 명 모두 최종 YES를 회신했다. 이후 사용자 요청으로 읽기를 `getReleaseActivity`
하나로 통합하고 `releases`, `timeRange: { start, end }`로 개명했으며, 기존 100건
이벤트 페이지네이션을 새 번들 통계 경로에서 제거하도록 명시했다.
이 API 수정은 재리뷰하지 않았다. 기존 합의도 native 구현 완료/성능 검증을 뜻하지 않는다.

| 리뷰 관점              | 최종 표 | 남은 조건/선호                                                               |
| ---------------------- | ------- | ---------------------------------------------------------------------------- |
| API·plugin author 부담 | YES     | author 구현 최소화만 목표면 A+SDK 선호, 이번 귀속 보존 우선순위에서는 B 승인 |
| SQL·NoSQL 저장/원자성  | YES     | native atomicity와 실제 읽기·쓰기 경합 검증 필요                             |
| 지표·UX·시간 의미      | YES     | provider/SDK conformance 필요, finite proof를 실측으로 표현하지 않음         |

| 쟁점                                                    | 결정과 이유                                                           |
| ------------------------------------------------------- | --------------------------------------------------------------------- |
| 기존5개를 없애고 stats로 통합                           | 기각. 공개 raw overview와 설치/이력 기능의 의미가 다름                |
| 조회 추가, recordEvent 책임은 설명 생략                 | 기각. 실제 원자적 쓰기/상태 비용을 숨김                               |
| getReleaseStats와 getReleaseActivity 별도 제공          | 사용자 후속 요청으로 통합. 시간 범위 생략 시 summary만 반환           |
| 최신 raw release만 인정                                 | 기각. 정상 SDK의 null no-change에서 Active 손실                       |
| SDK 수정+legacy unknown(A)                              | 대안으로 인정하나 이번 권고에서 제외. 정상/기존 보고의 귀속 보존 우선 |
| 상속 유지(B)는 반드시 전체 history replay 필요          | 초기 반론 철회. head/anchor/barrier 유한 상태로 처리 가능             |
| B의 core context-read/CAS-write 프로토콜                | 채택. state 계산은 core, 고정된 원자 I/O는 provider                   |
| native COUNT=constant cost                              | 기각. summary/bucket 접근의 실제 examined rows를 검증                 |
| releaseIds만 받는 provider 계약                         | 수정. releases에 명시 scope를 포함하여 기존 필터 의미 보존            |
| 시간버킷별 unique를 더해 기간 unique 계산               | 기각. graph는 additive raw Reports, lifetime은 별도 unique            |
| async projection / arbitrary intervals / 새 generic DSL | 이번 범위에서 제외                                                    |

남은 구현 검증은 native atomicity, hot-counter 쓰기 비용, factory 우회 방지와
SDK/Console 회귀다. 순수 reducer 검증을 이 증거의 대체물로 쓰지 않는다.
문서의 TypeScript 계약은 parser로 구문 검증한다. 제품 타입과의 통합 typecheck와
provider 구현 검증은 아래 실행 단계의 완료 조건이다.

## 12. 근거

- 조사 코드: 위에 명시된 모든 경로는 `ec78756926cac3b23ca32c1d3acefe28d2ebb7ab` 기준.
- 기존 설계: `docs/architecture/insights-event-storage-prd.md`,
  `docs/architecture/insights-event-storage-decision.md`, `docs/architecture/insights.md`.
- [Materialized View pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/materialized-view)
- [DynamoDB transaction isolation](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html)
- [Firestore aggregation cost](https://firebase.google.com/docs/firestore/query-data/aggregation-queries)
- [Firestore counter contention](https://firebase.google.com/docs/firestore/solutions/counters)
- [D1 read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)
- [Google AIP-190: Naming conventions](https://google.aip.dev/190)
- [Google AIP-145: Ranges](https://google.aip.dev/145)

## 13. 현재 코드와 구현 위치

아래 경로는 기준 커밋에서 확인했다. 구현 작업 디렉터리에서 상대 경로로 읽는다.
`main`에는 해당 Insights 구현이 없으므로 원래 checkout에서 제품 소스를 작성하지 않는다.

현재 번들 통계는 `packages/console/src/lib/server/bundleActivity.ts`의 다음 흐름이다:

```ts
const history = await readInsightsHistory(model, "30d", now);
// The returned history is folded and then filtered by scope/release.
```

`packages/console/src/lib/server/insightsHistory.ts`는 다음처럼 원본을 반복해서 읽는다:

```ts
while (events.length < 50_000) {
  const limit = Math.min(100, 50_000 - events.length);
  const rows = await model.listEvents({
    filter: { kind: "all" },
    sinceMs,
    beforeReceivedAtMs,
    after,
    limit: limit + 1,
  });
  // Take a page, advance the cursor, and continue until complete or truncated.
}
```

이 루프를 다른 크기나 `Promise.all`로 바꾸는 방식은 이 PRD의 구현으로 인정하지 않는다.
새 번들 통계는 이 함수에 도달하지 않아야 한다. App Usage의 사용처는 별도로 유지한다.

| 영역                     | 기존 경로 / 변경 책임                                                                                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 공개 모델·검증           | `plugins/plugin-core/src/types/databasePlugin.ts`, `types/public.ts`, `types/internal.ts`, `types/index.ts`, `insightsContract.ts`, `createDatabasePlugin.ts`, `index.ts`                       |
| core 저장 조정           | `plugins/plugin-core/src/`에 전용 reducer/context/CAS wrapper 모듈 추가; `recordEvent` 생성 경로에 필수로 연결                                                                                  |
| 기존 low-level 구현 연결 | `plugins/plugin-core/src/types/databaseOperations.ts` 등 현재 `DatabasePluginImplementation` 선언/호출부; 범용 CRUD DSL을 확장해 domain 연산을 노출하지 않음                                    |
| 공통 테스트 계약         | `packages/test-utils/src/databasePluginInsightsTests.ts`, `setupDatabasePluginTestSuite.ts`, `databaseTestFixtures.ts`, `databasePluginTypes.spec.ts`                                           |
| D1                       | `plugins/cloudflare/src/d1Implementation.ts`, `plugins/cloudflare/worker/migrations/`, `plugins/cloudflare/worker/src/insightsReadCost.integration.spec.ts` 및 native integration tests         |
| AWS                      | `plugins/aws/src/dynamoDB.ts`, 기존 bounds/concurrency integration fixtures, 필요 시 관련 IaC 접근 경로                                                                                         |
| Firebase                 | `plugins/firebase/src/firebaseDatabase.ts`, `firebaseDatabasePersistence.ts`, `firebaseDatabaseState.ts`, `plugins/firebase/firebase/public/firestore.indexes.json`, emulator integration tests |
| Supabase                 | `plugins/supabase/src/supabaseDatabase.ts`, `plugins/supabase/supabase/migrations/`, migration 생성기와 tests; REST 다중 요청을 transaction이라고 간주하지 않음                                 |
| ORM / MongoDB            | `packages/server/src/adapters/kysely.ts`, `kyselyCrud.ts`, `drizzle.ts`, `drizzleCrud.ts`, `prisma.ts`, `prismaInsights.ts`, `mongodb.ts`, `mongodbWrites.ts`, `mongodbReads.ts` 및 인접 테스트 |
| 공통 schema / tooling    | `packages/server/src/schema/`, `packages/server/src/db/schema/`, `schemaGenerators.ts`, `schemaReadiness.ts`, `db/databasePluginCore.ts`                                                        |
| Mock / 조합 provider     | `plugins/mock/src/mockDatabase.ts` 및 상태·테스트; `plugins/standalone/`, `plugins/postgres/`의 위임 경로도 실제 지원 여부 확인                                                                 |
| Console 호출             | `packages/console/src/lib/bundle-activity.ts`, `insights-recovery-rpc.ts`, `lib/server/bundleActivity.ts`, `lib/server/insightsRecovery.ts`와 관련 DTO/RPC 테스트                               |
| Console 표시             | `components/features/bundles/BundleInsightsSummary.tsx`, `components/features/insights/InsightsOverview.tsx`, `InsightsControls.tsx`, `routes/insights.tsx`, 번들 테이블의 activity 열          |
| 인프라 안내              | `packages/hot-updater/src/commands/infrastructureUpdates.ts`, `packages/hot-updater/infrastructure-upgrades/`, provider scaffold/packaging에 직접 필요한 변경                                   |
| 문서·릴리스              | 이 PRD, 기존 Insights architecture 문서, `docs/content/docs/(latest)/guides/insights.mdx`, `.changeset/`, `docs/architecture/measurements/`                                                     |

관련 기능을 정확하게 연결하기 위해 위 모듈의 직접 import/export, test fixture, 생성 schema와
배포 scaffold를 변경할 수 있다. unrelated 리팩터링·포맷 변경·의존성 업그레이드는 하지 않는다.
기본 제공 provider 중 일부를 `unsupported` stub으로 남기고 구현 완료로 처리하지 않는다.
외부 구 plugin만 명시적 unsupported 경로의 대상이다.

저장소 규칙은 `AGENTS.md` 및 `packages/server/AGENTS.md`를 따른다. TypeScript strict,
2 spaces, semicolon, 기존 error/type validation 패턴을 유지한다. server runtime root에
migration API를 추가하지 않고 DB tooling은 `@hot-updater/server/db` 경계를 따른다.
React 변경 시 `vercel-react-best-practices`의 관련 data fetching 지침을 적용한다.

## 14. 구현 순서와 단계별 검증

각 단계는 코드·테스트·필요한 문서 변경을 함께 진행한다. 실패 원인을 해결하고 다음 단계로
이동한다. 테스트 횟수나 경과 시간만을 이유로 중단하지 않는다. 계약을 바꿔야 하는 실제
모순이 발견되면 반례를 기록하고 사용자에게 알리되 독립적으로 가능한 작업은 계속한다.

### 단계 1 — 기준과 회귀 시나리오 확보

- `git fetch origin next` 후 기준 커밋과 변경을 비교한다. in-scope 변경이 있으면
  관련 부분을 읽어 통합하고, 기존 귀속/중복 의미가 달라졌으면 PRD의 반례를 갱신한다.
- 실제 `.node-version`은 `24.15.0`, package manager는 `pnpm@11.6.0`이다.
  AGENTS의 예전 Node 22 안내보다 checkout의 runtime pin을 우선 확인한다.
- `pnpm install --frozen-lockfile`로 이 worktree의 의존성을 설치한다.
- native test fixture의 기존 local Docker/emulator 설정을 확인한다. 운영 DB 자격증명이나
  다른 사용자의 실행 상태를 변경하지 않는다.
- 기존 Insights/shared contract tests로 baseline을 기록한다. 먼저 발견한 기존 실패는
  이번 변경의 실패와 구분하여 기록하고, 필요한 환경 문제는 해결한다.

검증: `pnpm -w test -- plugins/plugin-core/src/insightsContract.spec.ts packages/server/src/insights/provider.spec.ts`
→ 관련 기존 tests 통과. 환경 실패를 성공/skip으로 숨기지 않는다.

### 단계 2 — 공개 조회 계약과 core 집계 로직

- §4의 타입·입력 검증·출력 검증·오류를 구현한다. 기존 5개 공개 메서드의 의미를 유지한다.
  별도 `getReleaseStats`는 추가하지 않는다.
- §5의 native 저장 계약과 필수 core wrapper를 연결한다. `createDatabasePluginAdapter`
  경유와 직접 `createDatabasePlugin({ models })` 경유 모두 raw ingestion 우회가 없어야 한다.
- §6의 reducer를 순수 함수로 작성하고 버전된 bounded state 직렬화를 구현한다.
  이벤트의 event-local metric 귀속, head/anchor/barrier 상태 갱신, 현재 counter 상쇄,
  최초 lifetime marker, hourly 증가를 나눠 설명할 수 있는 최소 구성으로 둔다.
- 최신 null UNCHANGED, scope/file 변경, 같은 파일의 release 이동, 오래된 receipt의 뒤늦은
  삽입을 독립 참조 fold와 비교한다. fixture에 정답을 직접 하드코딩한 단순 mock만으로
  새 reducer를 검증했다고 처리하지 않는다.
- conflict의 재조회·재계산과 ambiguous commit retry의 ID 보존을 검증한다.

검증: 새 `plugins/plugin-core/src/insightsReleaseActivity.spec.ts`,
`insightsProjection.spec.ts`, `insightsStorage.spec.ts`와 기존 Insights 계약 테스트를
`pnpm -w test -- plugins/plugin-core/src`로 실행 → 입력/귀속/중복/경쟁 시나리오 통과.
파일명은 이 범위 안에서 기존 구조와 맞춰 조정해도 된다.

### 단계 3 — native provider 구현과 schema

- provider별 summary, hourly, lifetime marker, install state/revision, coverage
  접근 경로를 구현한다. 물리 schema는 각 provider에 맞추되 공개 계약은 동일하다.
- 모든 수락 event는 §5의 atomic commit 조건을 만족한다. 같은 event ID, concurrent
  install write, 같은 release의 여러 install write를 실제 backend에서 검증한다.
- D1 conditional batch, DynamoDB conditional transaction, SQL/Firestore/MongoDB native
  transaction의 차이를 adapter 안에서 처리한다. 일반 read-modify-write 저장을 atomic
  transaction 대신 사용하지 않는다.
- 준비 metadata와 release summaries를 함께 읽어야 할 경우에도 범위는 요청 key로
  제한한다. primary/strong read 요구와 배열 전체 snapshot을 약속하지 않는 계약을 지킨다.
- Mock은 conformance용으로 실제 상태를 보관하고 계산한다. 다른 지원 provider의
  미구현을 Mock 통과로 대체하지 않는다.

검증: `pnpm -w test`와 provider별 `pnpm -w test:integration -- <관련 integration 파일>`
→ §10 시나리오를 동일한 shared fixture로 통과. 전체 integration gate는 단계 6에서 실행한다.

### 단계 4 — pre-GA `1.0.0` schema와 migration

- fresh DB는 최종 `1.0.0` schema에서 즉시 기록 가능한 상태가 된다.
- 사용자가 정식 배포 전임을 확인했으므로 **기존 `1.0.0` migration을 직접 수정한다.**
  `packages/server/src/schema/v1_0_0.ts`, 기존 D1/Supabase의 `1.0.0` migration,
  schema generators, provider scaffold와 native test fixtures를 동일한 최종 구조로 맞춘다.
  이 변경만을 위한 후속 migration 파일이나 새 schema version은 만들지 않는다.
- doctor requirement와 `packages/hot-updater/infrastructure-upgrades/1.0.0.md`도 기존
  `1.0.0` 항목을 갱신한다. Compatibility, Steps, Cloudflare, Supabase, AWS, Firebase,
  Verification 섹션을 유지한다. package version을 임의로 일괄 bump하지 않는다.
- 이전 RC migration을 이미 적용한 개발 DB가 수정된 파일만으로 자동 업그레이드된다고
  가정하지 않는다. 로컬 테스트 DB는 fresh schema로 검증하고, 보존할 기존 이벤트가 있는
  환경은 별도 운영 migration 범위가 필요하다고 안내한다.
  이 작업에서 사용자의 기존 데이터 삭제/reset은 실행하지 않는다.

검증: 각 provider migration tests, fresh schema 생성 tests, wrapper CAS tests 통과.

### 단계 5 — Console 전환과 불필요한 조회 제거

- 번들 목록은 현재 표시된 release의 `{ releases }` 한 요청으로 숫자를 얻는다.
  bundle 상세 요약도 같은 query를 사용한다. 30일 label, 의미가 pending이던 Downloaded,
  통계 계산용 raw history/chart 구성 경로를 교체한다.
- Insights Bundle Activity는 선택 release 요약과 기간별 Reports 그래프를 보여준다.
  release metadata 선택기는 기존 releases 모델의 제한된 목록을 사용하고 전 목록을 순회하지 않는다.
  scope 변경으로 선택 release가 범위에서 벗어나면 선택을 갱신하고 stale 통계를 섞지 않는다.
- summary는 현재/누적, graph는 선택 기간임을 표시한다. appVersion은 App Usage 안에서만
  적용한다. window 변경으로 누적 숫자가 달라지는 UI를 만들지 않는다.
- §4의 missing/partial/current-hour zero-fill 규칙을 core 화면 DTO에서 처리한다.
- query key에 실제 조회 인자를 포함하고, release별 N+1 request나 화면 밖 prefetch를 넣지 않는다.
- 이 변경으로 사용처가 사라진 Bundle Activity 전용 계산기/타입/RPC는 제거한다.
  App Usage/공개 raw overview/이벤트 탐색이 쓰는 부분은 남긴다. 공통 100 상수를 지워
  unrelated 목록 계약까지 바꾸지 않는다.

검증: Console server/RPC 테스트에 raw `listEvents`를 호출하면 실패하는 stub을 넣고
summary-only와 range 호출 모두 정상 결과를 반환하는지 확인한다. 실제 route test에서
제한된 release metadata 선택기, 선택 release 한 개의 기간 조회, UTC 구간 경계,
scope, partial/error 표시를 검증한다.
`pnpm -w test -- packages/console/src` 통과 후 브라우저에서 번들 목록·상세·Insights를
확인하고 PR용 스크린샷을 남긴다. UI 테스트가 Vitest include에 실제 수집되는지도 확인한다.

### 단계 6 — 조회 비용·전체 회귀·PR

- §15의 측정 결과를 `docs/architecture/measurements/insights-release-activity-*.json`에
  저장한다. 재현 명령, backend/runtime 버전, 입력 크기, cold/no-cache 여부를 함께 기록한다.
- `pnpm -w build`, `pnpm -w test:type`, `pnpm -w lint`, `pnpm -w test`,
  `pnpm -w test:integration`을 모두 실행하고 관련 실패를 해결한다.
- 포맷은 변경 파일에 한정해 맞춘다. 이미 통과한 전체 검사는 새 변경/실패/불확실성이
  있을 때 다시 실행한다. 무관한 파일의 포맷을 끌어들이지 않는다.
- 영향을 받는 package의 changeset을 추가하고 public plugin 계약 변경·인프라 준비 요구·
  Downloaded/Pending 의미를 설명한다. 문서의 기존 5개 동결/30일 번들 집계 설명은
  새 PRD와 충돌하지 않도록 필요한 부분을 갱신한다.
- 의미 있는 commit으로 정리하고 `git push -u origin feature/insights-release-activity`를 실행한다.
  `gh pr create --base next --head feature/insights-release-activity --body-file <작성한 파일>`로
  PR을 생성한다. base를 main으로 바꾸거나 force push하지 않는다.
- PR에는 문제와 결과, 현재·누적·기간 의미, 지원 provider/migration, 테스트 결과,
  조회 비용 before/after와 쓰기 경합 결과, Console 스크린샷, 남은 한계를 포함한다.
  비용 수치를 측정 없이 추정값으로 채우지 않는다.
- PR URL과 base/head를 확인하고 CI가 시작되면 상태를 확인한다. required check 실패를
  해결하고 PR을 갱신한다. PR merge나 운영 배포는 수행하지 않는다.

## 15. 과조회 성능 인수 기준

`R`은 요청 release 수, `H`는 요청 시간 버킷 수, `E`는 저장된 원본 이벤트 수다.
summary 읽기는 `O(R)`, 시계열 추가 읽기는 `O(R × H)`이어야 한다. 상수 크기의 준비/coverage
metadata 조회는 허용한다. 이는 물리 쿼리 1회 약속이 아니라 실제 접근 데이터의 경계다.

| 실험                 | 조건                                        | 통과 기준                                                               |
| -------------------- | ------------------------------------------- | ----------------------------------------------------------------------- |
| summary 이력 증가    | 같은 R, 같은 summary 결과, E만 10배 증가    | raw 조회0, hourly 조회0, materialized 조회량/왕복 수에 E 비례 증가 없음 |
| summary 설치 수 증가 | 같은 R, install 수와 summary 값 증가        | install/marker 전수 count0, summary key 읽기량 유지                     |
| 무관 데이터 증가     | 다른 scope/release 및 범위 밖 hour 증가     | 요청 범위를 벗어난 scan/filter-after-read 없음                          |
| 시간 범위 변화       | 같은 R/E에서 H를 24→168→720 증가            | 해당 범위 buckets만 읽음; 전체 기간 읽고 메모리 필터 금지               |
| visible batch        | release 1개와 여러 개, metadata는 이미 준비 | Console API 호출1회, native key/batch 경로, release별 원본 조회0        |
| 최대 허용 요청       | R=20, H=720                                 | 14,400 논리 버킷 한도 내; 정확한 결과와 실제 payload/latency 기록       |
| counter 경합         | 여러 install의 같은 release/hour 병렬 write | 유실/중복 증가0; CAS retries, p50/p95 latency, write 비용 기록          |
| null UNCHANGED 반복  | 현재 귀속 변동 없음                         | raw/head/state 처리는 유지, summary의 불필요한 counter write0           |

자료량 축은 1,000/10,000 installations × 10/100 events를 기본으로 한다. 이력/설치/무관
scope를 한꺼번에 바꾸지 말고 축마다 비교하여 원인을 분리한다. 10배 실험만을 임의의 절대
latency SLO로 해석하지 않는다. provider 서비스 한계와 hot-counter 병목은 실측으로 보고한다.

D1은 기존 `insightsReadCost.integration.spec.ts`의 `result.meta.rows_read` 계측을 확장한다.
다른 provider는 실제 query count와 backend가 제공하는 examined rows/docs/items, scanned
count/consumed capacity 또는 동등한 실행계획 증거를 사용한다. in-memory mock의 함수 호출
횟수만으로 native 과조회 제거를 입증하지 않는다. unavailable 계측 항목은 unavailable로
표시하고 가능한 native 증거를 제시한다. 측정 누락을 0으로 기록하지 않는다.

조회 비용 실험은 앱 캐시를 비우거나 우회하고 실제 provider 경로를 실행한다. 구현이 full scan
또는 install 수 비례 count를 숨기고 있으면 HTTP 요청 수가 줄어도 실패다. native 서비스가
집계 buckets를 응답 한도에 맞춰 이어 읽는 것은 허용하되 범위 제한과 실제 읽기량을 기록한다.

## 16. 최종 체크리스트와 목표 종료

- [ ] 공개 `getReleaseActivity({ releases, timeRange? })` 및 기존 5개 메서드 호환 의미 구현.
- [ ] summary-only는 raw/hourly/installation/lifetime marker 전수 조회0.
- [ ] range는 지정 release와 기간 bucket만 조회, summary 의미 유지.
- [ ] 번들 통계의 100건 이벤트 페이지네이션·50,000건 제한·scan fallback 제거.
- [ ] shared core reducer/필수 wrapper/native atomic commit과 모든 기본 provider 지원.
- [ ] 중복·역순·동시성·null 상속·scope 변경·coverage 시나리오 통과.
- [ ] fresh install용 최종 `1.0.0` migration과 RC 개발 DB 제한 안내 완성.
- [ ] Bundles/Insights 전환, App Usage/기존 공개 overview 회귀 확인, UI 스크린샷 확보.
- [ ] native 조회 비용 측정으로 이력·무관 데이터 증가에 비례한 과조회가 없음을 확인.
- [ ] required local checks 통과, 실제 실행하지 못한 검증을 완료로 표시하지 않음.
- [ ] changeset과 문서 갱신, next 기반 commit/push, base=`next`인 PR URL 확보.
- [ ] PR required checks 확인 및 관련 실패 해결; 결과/잔여 제약을 사용자에게 보고.

목표는 문서 작성이나 draft scaffold만으로 완료 처리하지 않는다. 구현·검증·PR 생성이
완료되어야 종료한다. 기술적으로 불가능한 native 보장이나 데이터 유실을 발견하면
정확성을 완화해 숨기지 않고 반례·증거·영향을 사용자에게 설명한다.
