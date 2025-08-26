# OTA Fingerprint Hash 최적화 계획

## 목표
네이티브 호환성을 위한 OTA 번들 식별 시스템 최적화 - 불필요한 변경사항으로 인한 fingerprint 변경 최소화

## 현재 상황 분석

### 현재 Fingerprint 구성요소
현재 fingerprint.json을 분석한 결과:

#### 포함되는 Source Types
- **dir**: 네이티브 디렉토리 (ios/, android/)
- **contents**: 설정 파일 내용 (expoConfig, package.json, autolinking 설정)

#### Source Reasons (포함 이유)
**iOS & Android 공통:**
- `bareNativeDir`: 네이티브 코드 디렉토리
- `rncoreAutolinkingIos/Android`: React Native autolinking 설정 (3개 항목)
- `expoAutolinkingIos/Android`: Expo autolinking 설정
- `expoConfig`: Expo/React Native 설정
- `package:react-native`: React Native 패키지 정보

#### 현재 node_modules 포함 항목
- `@hot-updater/react-native`: 프로젝트 특화 패키지
- `react-native-safe-area-context`: 네이티브 의존성 패키지

### 현재 제외 설정 분석
`packages/hot-updater/src/utils/fingerprint/common.ts`에서 현재 적용중:

```typescript
ignorePaths: [
  "**/android/**/strings.xml",    // 번역 파일 (자주 변경)
  "**/ios/**/*.plist"             // iOS 설정 파일 (자주 변경)
]

sourceSkips:
  SourceSkips.GitIgnore |                         // git ignore된 파일들
  SourceSkips.PackageJsonScriptsAll |             // package.json scripts
  SourceSkips.ExpoConfigVersions |                // 앱 버전 정보
  SourceSkips.ExpoConfigNames |                   // 앱 이름/설명
  SourceSkips.ExpoConfigRuntimeVersionIfString |  // 런타임 버전(문자열)
  SourceSkips.ExpoConfigAssets |                  // 앱 아이콘/스플래시
  SourceSkips.ExpoConfigExtraSection             // expo config 추가 섹션
```

## 문제점 식별

### 1. 불필요한 파일 포함
- 개발자 도구 파일 (.DS_Store, Thumbs.db)
- 빌드 아티팩트 (build/, dist/)
- IDE 설정 파일 (.vscode/, .idea/)
- 로그 파일 (*.log)

### 2. 과도한 설정 민감성
- EAS 프로젝트 설정 변경 시 fingerprint 변경
- URL 스킴 변경 시 fingerprint 변경 (OTA에 영향 없음)
- prebuild 스크립트 변경 시 fingerprint 변경

### 3. 비효율적인 계산 시점
- 모든 변경 시 전체 재계산
- 캐싱 로직 부재

## 개선 방안

### 1. ignorePaths 확장 (언제: 모든 fingerprint 계산 시)

```typescript
ignorePaths: [
  // 기존
  "**/android/**/strings.xml",
  "**/ios/**/*.plist",
  
  // 추가 - 개발 환경 파일
  "**/.DS_Store",
  "**/Thumbs.db",
  "**/*.log",
  
  // 추가 - 빌드 아티팩트
  "**/build/",
  "**/dist/",
  "**/node_modules/.cache/",
  
  // 추가 - IDE 설정
  "**/.vscode/",
  "**/.idea/",
  "**/*.swp",
  "**/*.swo",
  
  // 추가 - 임시 파일
  "**/tmp/",
  "**/temp/",
  "**/.tmp/",
  
  // 사용자 커스텀
  ...options.ignorePaths,
]
```

### 2. sourceSkips 최적화 (언제: 모든 fingerprint 계산 시)

```typescript
sourceSkips:
  SourceSkips.GitIgnore |
  SourceSkips.PackageJsonScriptsAll |
  SourceSkips.ExpoConfigVersions |
  SourceSkips.ExpoConfigNames |
  SourceSkips.ExpoConfigRuntimeVersionIfString |
  SourceSkips.ExpoConfigAssets |
  SourceSkips.ExpoConfigExtraSection |
  
  // 추가 - OTA에 영향 없는 설정들
  SourceSkips.ExpoConfigEASProject |              // EAS 프로젝트 설정
  SourceSkips.ExpoConfigSchemes |                 // URL 스킴
  SourceSkips.PackageJsonAndroidAndIosScriptsIfNotContainRun // prebuild 스크립트
```

### 3. 제외해야 하는 항목들

#### 완전 제외 대상 (OTA 호환성에 영향 없음)
- **앱 메타데이터**: 이름, 설명, 아이콘, 스플래시
- **버전 정보**: versionCode, buildNumber, version
- **개발 도구**: ESLint, Prettier 설정
- **IDE 설정**: VSCode, IntelliJ 설정
- **CI/CD 설정**: GitHub Actions, GitLab CI
- **문서화**: README, CHANGELOG, docs/

#### 부분 제외 대상 (조건부)
- **번역 파일**: strings.xml, Localizable.strings (이미 제외중)
- **테스트 파일**: __tests__, *.test.*, *.spec.*
- **스토리북**: .storybook/, stories/

### 4. 계산 시점 최적화

#### 전체 재계산이 필요한 경우
1. **네이티브 의존성 변경**: package.json dependencies 중 네이티브 모듈
2. **React Native 버전 변경**: react-native 패키지 버전
3. **네이티브 설정 변경**: android/, ios/ 디렉토리 내 파일
4. **autolinking 설정 변경**: react-native.config.js, expo modules

#### 캐시 활용 가능한 경우
1. **JavaScript 코드 변경**: src/, components/ 등
2. **스타일 변경**: CSS, stylesheet 파일
3. **문서 변경**: README, docs/
4. **테스트 코드 변경**: __tests__, *.test.*

### 5. 구현 우선순위

#### Phase 1: 즉시 적용 (호환성 영향 최소)
1. ignorePaths 확장 - 개발 파일들 제외
2. sourceSkips 추가 - EAS, 스킴 관련 제외

#### Phase 2: 점진적 적용 (검증 후 적용)
3. processExtraSources 로직 개선
4. 캐싱 메커니즘 구현

#### Phase 3: 고도화 (장기 계획)
5. 네이티브 의존성 자동 감지
6. 조건부 fingerprint 계산
7. 성능 모니터링 및 최적화

## 검증 방법

### 1. 테스트 시나리오
- [ ] 개발 파일 변경 시 fingerprint 유지
- [ ] JavaScript 코드 변경 시 fingerprint 유지  
- [ ] 네이티브 의존성 추가 시 fingerprint 변경
- [ ] React Native 버전 업그레이드 시 fingerprint 변경
- [ ] 설정 파일 변경 시 적절한 fingerprint 처리

### 2. 성능 측정
- fingerprint 계산 시간 개선도
- fingerprint 변경 빈도 감소율
- 불필요한 네이티브 빌드 감소율

## 예상 효과

### 정량적 효과
- **Fingerprint 변경 빈도**: 현재 대비 50-70% 감소 예상
- **개발 속도**: 불필요한 네이티브 빌드 50% 이상 감소
- **CI/CD 효율**: 빌드 시간 30-40% 단축

### 정성적 효과  
- **개발자 경험 개선**: 코드 변경 시 즉시 OTA 업데이트 가능
- **배포 안정성 향상**: 실제 호환성 변경 시에만 네이티브 빌드
- **리소스 절약**: 클라우드 빌드 비용 절감

## 리스크 및 대응방안

### 리스크
1. **과도한 제외로 인한 호환성 문제**: 실제 네이티브 변경을 놓칠 가능성
2. **기존 프로젝트 호환성**: 기존 fingerprint와의 일관성

### 대응방안
1. **점진적 적용**: Phase별 단계적 롤아웃
2. **광범위한 테스트**: 다양한 시나리오 검증
3. **롤백 계획**: 문제 발생 시 이전 로직으로 복원
4. **모니터링**: fingerprint 변경 패턴 지속적 관찰