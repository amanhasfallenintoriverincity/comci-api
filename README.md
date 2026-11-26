<p align="center">
  <img src="./assets/banner.png" alt="comci-api banner" width="100%" />
</p>

# comci-api

[![npm version](https://img.shields.io/npm/v/comci-api.svg)](https://www.npmjs.com/package/comci-api)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

컴시간 학생시간표([`http://www.xn--s39aj90b0nb2xw6xh.kr/`](http://www.xn--s39aj90b0nb2xw6xh.kr/) → `http://comci.net:4082/st`)를 위한 TypeScript(Node.js) **코어 라이브러리 + HTTP REST API 서버**입니다.

## 주요 동작 방식

컴시간 학생시간표는 매 세션마다 다음 요소들을 동적으로 난독화/회전합니다.

- `window.__HourRequestToken` (`X-Hour-Token` 헤더) 및 세션 쿠키 (`HourSession4082S`)
- 중첩 난독화 스크립트 (`hour-obfuscated-v2`, `hour-ajax-obfuscated-v1`)
- 동적 AJAX 엔드포인트 및 요청 prefix/suffix
- 응답 페이로드 암호화 (`8701:` / `enc1:` — AES-CBC + HMAC-SHA256 무결성 검증)
- 필드별 XOR + EUC-KR 인코딩 키 및 동적 JSON 프로퍼티 키

`ComciClient`는 런타임에 `/st` 페이지를 해석하여 토큰·키·엔드포인트·필드 매핑을 자동 추출하며, 토큰 만료(`403 HOUR_TOKEN_REQUIRED`) 또는 키 회전 시 자동으로 세션을 갱신하고 재시도합니다.

## 요구 사항

- Node.js 20+ (Node 24에서 검증됨, 내장 `fetch` 및 `TextDecoder('euc-kr')` 사용)

## 설치

### 라이브러리로 사용

```bash
npm install comci-api
```

```ts
import { ComciClient } from 'comci-api';
```

### 저장소에서 직접 실행

```bash
npm install
```

### 개발 서버 실행

```bash
npm run dev
# 기본 포트: 3000 (PORT, HOST 환경변수로 변경 가능)
```

### 빌드 및 프로덕션 실행

```bash
npm run build
npm start
```

### 테스트 및 타입체크

```bash
npm run typecheck
npm test
```

## HTTP REST API 엔드포인트

| Method | Path | 설명 |
| --- | --- | --- |
| `GET` | `/health` | 서버 상태 확인 |
| `GET` | `/api/schools?q={학교명}` | 학교 검색 (지역, 학교명, 학교 코드) |
| `GET` | `/api/schools/{schoolCode}/meta?week={1}` | 학교 메타 정보 (학급 수, 주차 목록, 교시명, 수정일, 전달사항) |
| `GET` | `/api/schools/{schoolCode}/timetable?grade={1..3}&class={반}&week={1}&weekday={1..5}` | 학급 시간표 조회 |
| `GET` | `/api/schools/{schoolCode}/classes/{grade}/{class}?week={1}&weekday={1..5}` | 학급 시간표 조회 (REST alias) |
| `GET` | `/api/timetable?school={학교명}&grade={1..3}&class={반}&week={1}&weekday={1..5}` | 학교 검색 + 학급 시간표 원샷 조회 |

### 요청 예시 (`curl`)

```bash
# 학교 검색
curl "http://localhost:3000/api/schools?q=경기고"

# 학교 코드로 학급 시간표 조회 (1학년 1반, 1주차)
curl "http://localhost:3000/api/schools/76524/timetable?grade=1&class=1&week=1"

# 학교명으로 바로 특정 요일(월요일=1) 시간표 조회
curl "http://localhost:3000/api/timetable?school=경기고등학교&grade=1&class=1&weekday=1"
```

## 라이브러리 사용 예시 (TypeScript / ESM)

```ts
import { ComciClient } from 'comci-api';

const client = new ComciClient({
  cacheTtlMs: 60_000, // 응답 캐시 TTL (기본 60초, 0으로 비활성화 가능)
});

// 1. 학교 검색
const schools = await client.searchSchools('경기고');
console.log(schools);

// 2. 학급 시간표 조회
const timetable = await client.getClassTimetable(schools[0].code, 1, 1);
for (const day of timetable.days) {
  console.log(day.weekdayName, day.date);
  for (const period of day.periods) {
    if (!period.isEmpty) {
      console.log(`  ${period.period}교시: ${period.displaySubject} (${period.teacher})`);
    }
  }
}

// 3. 학교명 검색 + 시간표 원샷 조회
const { school, timetable: quick } = await client.findAndGetClassTimetable('경기고등학교', 1, 1);
```

## 프로젝트 구조

- [`src/core/deobfuscator.ts`](src/core/deobfuscator.ts) — 난독화 JS 디코딩 및 동적 설정/필드 키 추출
- [`src/core/crypto.ts`](src/core/crypto.ts) — AES-CBC/HMAC-SHA256 복호화 및 XOR+EUC-KR 디코딩
- [`src/core/parser.ts`](src/core/parser.ts) — 학교 검색 및 학급 시간표(변경 여부, 원래 수업, 동시그룹, 강의실) 파싱
- [`src/core/client.ts`](src/core/client.ts) — `ComciClient` (세션 관리, 자동 재시도, TTL 캐싱)
- [`src/server/app.ts`](src/server/app.ts) — Hono 기반 HTTP REST API 및 Zod 검증
- [`src/server/index.ts`](src/server/index.ts) — Node.js HTTP 서버 엔트리포인트

## 주의 사항

이 프로젝트는 비공식 API이며 컴시간 서비스의 이용 정책 및 요청 제한(`429 HOUR_RATE_LIMIT`, `503 HOUR_SERVICE_BUSY`)을 준수해야 합니다. 과도한 요청을 방지하기 위해 기본 캐싱을 유지하는 것을 권장합니다.
