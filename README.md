# 거래량 분석기 (Volume Analyzer)

티커 하나를 입력하고 자연어로 거래량 조건을 명령하면, 그 조건에 맞는 과거 날짜들과
**그 날짜 이후 실제 수익률**을 보여주는 모바일 웹앱.

가장 중요한 건 **base rate 비교**다. 조건에 걸린 날의 승률이 45%인데 그 종목의 아무 날이나
골라도 44%라면 그 조건은 아무것도 발견한 게 아니다. 그래서 결과 화면은 이 **차이(edge)** 를
가장 크게 보여준다.

## 동작 방식

```
[모바일 브라우저] 티커 + 자연어 명령
        ↓
[POST /api/parse]  → Gemini가 자연어를 FilterSpec JSON으로 변환 (파싱만, 계산 금지)
        ↓
[POST /api/analyze]
   1) 일봉 로드 (캐시 → 없으면 외부 API)
   2) 파생 지표 계산
   3) FilterSpec 적용 → 매칭 날짜 추출
   4) 각 매칭일의 forward return 계산
   5) base rate와 비교
        ↓
[결과 화면] 요약 카드 + 차트 + 날짜 카드 리스트 + CSV
```

**숫자는 100% TypeScript 코드가 계산한다.** LLM은 자연어를 JSON 스펙으로 바꾸는 일만 한다.

## 로컬 실행

```bash
npm install
cp .env.example .env.local     # GEMINI_API_KEY 채우기
npm run dev
```

외부 시세 API 없이 UI만 확인하려면:

```bash
DATA_PROVIDER=fixture npm run dev   # 합성 데이터 (실제 시세 아님)
```

## 검증

```bash
npm run selftest        # 지표·통계 검산 (네트워크 불필요)
npm run test:gemini     # Gemini 폴백 체인 검증 (fetch를 가짜로 갈아끼움)
npm run test:data       # 시세 소스 폴백 체인 검증 (fetch를 가짜로 갈아끼움)
npm run verify AAPL     # 실데이터로 지표/통계 콘솔 출력
DATA_PROVIDER=fixture npm run verify DEMO
```

`selftest`는 손으로 계산한 상수와, 본 구현과 다르게 짠 naive 구현 양쪽에 대조한다.
포함 항목: vol_ma20/50, volume_ratio_20d, volume_zscore_60d, ATR(14) Wilder 스무딩,
high==low 봉의 0 나누기 방어, forward return, 클러스터링, AND/OR 로직,
그리고 **전체 매칭 시 stats == baseline** 불변식.

## Vercel 배포

1. 이 저장소를 GitHub에 푸시 (이미 되어 있음)
2. [vercel.com/new](https://vercel.com/new) → 저장소 임포트
   - **Framework Preset은 반드시 Next.js.** "Other"로 두면 Vercel이 빌드를 하지 않고
     레포 루트를 정적 파일로 서빙해서 `404: NOT_FOUND`가 뜬다.
   - 레포의 `vercel.json`이 `"framework": "nextjs"`를 강제하므로 대시보드에서 잘못 골라도
     덮어써진다.
3. **Environment Variables**에 `GEMINI_API_KEY` 추가 (Production/Preview/Development 모두)
4. Deploy

`NEXT_PUBLIC_` 접두사에는 절대 API 키를 넣지 마라. 클라이언트 번들에 그대로 박힌다.

### 캐시 (선택이지만 권장)

없어도 동작한다 (람다 인스턴스 메모리 캐시로 폴백). 다만 인스턴스마다 캐시가 따로 놀아서
외부 시세 API를 그만큼 더 자주 부르고, 그게 곧 **HTTP 429**로 돌아온다.

Vercel 대시보드 → Storage에서 KV(Upstash Redis) 스토어를 만들어 프로젝트에 연결하면
`KV_REST_API_URL` / `KV_REST_API_TOKEN`이 자동으로 주입된다 (직접 타이핑할 필요 없음).
연결 후에는 반드시 **재배포**해야 새 환경변수가 함수에 들어간다.

캐시 정책: `ohlcv:{ticker}` 키에 저장하고 **12시간은 그냥 쓰고**, 12시간이 지나도
**7일까지는 버리지 않는다**. 외부 시세 API가 전부 막혔을 때 에러 화면 대신
조금 오래된 데이터라도 보여주기 위해서다.

> 환경변수는 전부 **런타임**에 읽는다. 모듈 최상위에서 `process.env`를 읽으면
> Next가 빌드 타임 값으로 인라인해 버려서 배포 환경변수가 무시된다.

## AI 모델 (Gemini)

모델명을 버전 고정하지 않는다. `gemini-2.5-flash`처럼 박아두면 구글이 조용히 폐기했을 때
"신규 사용자에게 더 이상 제공되지 않음" 404를 맞는다. 그래서 `lib/gemini.ts`는 폴백 체인을 쓴다.

**시도 순서**

1. 마지막으로 성공한 모델 (`workingModel` — 람다 인스턴스가 기억)
2. `gemini-flash-latest` — 구글이 계속 최신 flash로 가리켜주는 별칭
3. 정적 후보: `gemini-2.5-flash` → `gemini-2.0-flash` → `gemini-1.5-flash`
4. 그래도 전부 막히면 `/v1beta/models`를 조회해 이 키로 **실제 쓸 수 있는** 모델을 찾는다
   (flash 계열 우선)

**실패 처리**

| 응답 | 처리 |
|---|---|
| 429 (한도 초과) | 재시도 없이 즉시 다음 모델. 같은 모델을 다시 두드려도 한도는 그대로다 |
| 5xx (순간 장애) | 같은 모델 한 번만 재시도, 그래도 실패면 다음 모델 |
| 404 (폐기/접근 불가) | 폐기 목록에 넣고 이후 요청에서도 건너뜀 |
| 400 (응답 형식 문제) | `responseMimeType: application/json`만 빼고 한 번 더 |

**시간 예산**: 체인 전체에 `AI_DEADLINE_MS`(기본 15초)를 건다. Vercel 함수가 자체 타임아웃으로
죽어서 502를 뱉는 대신, 예산 안에 사람이 읽을 수 있는 에러를 반환한다. 개별 호출도 최대 9초.

> 배포 후 `/api/parse`에서 504(함수 타임아웃)가 뜬다면, 그 플랜의 함수 실행 시간 제한이
> 15초보다 짧다는 뜻이다. 환경변수 `AI_DEADLINE_MS=8000`으로 낮추면 플랫폼이 함수를 죽이기
> 전에 앱이 먼저 사람이 읽을 수 있는 에러를 반환한다.

키 하나만 꽂으면 되는 게 아니라, **모델이 조용히 폐기돼도 자동으로 우회하는 구조**다.
`npm run test:gemini`가 위 시나리오 9가지를 전부 검증한다.

## 데이터 소스

무료·키 불필요한 소스 **두 개를 체인**으로 쓴다. 서버 라우트에서만 호출한다
(브라우저에서 부르면 CORS).

```
[서버] Twelve Data (키 필요) ──실패──▶ Yahoo ──실패──▶ Stooq ──실패──▶ 만료된 캐시
                                                                          │ 그래도 실패
                                                                          ▼
[브라우저] 사용자 기기에서 Yahoo 직접 호출 ──▶ 받은 일봉을 /api/analyze로 전송
```

### 배포하려면 시세 API 키가 사실상 필요하다

Yahoo와 Stooq는 키가 필요 없는 대신 **IP만 보고 막는다.** 실제 배포에서 확인한 결과:

| 소스 | Vercel 람다에서의 응답 |
|---|---|
| Yahoo | `HTTP 429` (데이터센터 IP 차단) |
| Stooq | CSV 대신 `<!DOCTYPE html>` 봇 차단 페이지 |
| 브라우저 직접 호출 | Yahoo가 CORS를 허용하지 않아 실패 |

로컬에서는 잘 되는데 배포하면 안 되는 이유가 이것이다. 내 코드 문제가 아니라
**IP 평판 문제**라 재시도·폴백으로는 못 뚫는다.

해결책은 IP가 아니라 **키로 식별되는 소스**를 쓰는 것이다:

1. [twelvedata.com](https://twelvedata.com/pricing)에서 무료 가입 → API 키 발급 (하루 800회)
2. Vercel 대시보드 → Settings → Environment Variables → `TWELVE_DATA_API_KEY` 추가
   (Production/Preview 모두)
3. **Redeploy** — 환경변수는 재배포해야 함수에 들어간다

키가 없으면 이 소스는 체인에서 통째로 빠지고, 기존 Yahoo → Stooq 경로로만 동작한다
(로컬 개발은 그걸로 충분하다). 전부 막히면 에러 화면이 키 발급 방법을 알려준다.

> Twelve Data는 분할 조정된 가격을 준다. 무료 플랜은 미국 상장 종목 위주라
> 한국 종목 등은 Yahoo 폴백이 받는다.

### 왜 배포하면 HTTP 429가 뜨나

Yahoo의 chart 엔드포인트는 비공식이고, **클라우드/데이터센터 IP에서 오는 요청을 자주
막는다.** 내 노트북에서는 되는데 Vercel 람다에서만 429가 나는 이유가 이것이다.
IP가 Vercel 것이라 요청 수와 무관하게 막힐 수 있다. 그래서:

1. `query1` → `query2` 두 호스트를 번갈아 시도
2. 429/401/403이면 `fc.yahoo.com` 쿠키 + `getcrumb` 크럼을 받아 다시 시도
3. 지수 백오프(지터 포함), 전체 시간 예산 `DATA_DEADLINE_MS`(기본 6초) 안에서만
4. 그래도 막히면 **Stooq CSV**로 폴백 (`nvda.us` 형태의 심볼로 변환)
5. Stooq도 실패하면 만료된 캐시라도 반환, 그것도 없으면 사람이 읽을 수 있는 429 안내

`DATA_PROVIDER=stooq`로 아예 Stooq만 쓰게 고정할 수도 있다 (`yahoo` / `fixture`도 가능).

### 서버가 막히면 브라우저가 대신 받아온다

위 폴백이 전부 실패하면 **사용자 기기의 브라우저가 직접 Yahoo를 호출**하고, 받아온 일봉을
`/api/analyze`에 실어 보낸다 (`lib/client-quotes.ts` → `lib/analyze-client.ts`).
차단당하는 건 Vercel의 데이터센터 IP지 사용자의 통신사·가정용 IP가 아니기 때문에,
서버가 429를 맞는 상황에서도 이 경로는 대체로 살아 있다.

- 계산은 **여전히 서버 코드가 한다.** 브라우저는 원본 일봉만 나른다.
- 서버는 받은 일봉을 `lib/validate-bars.ts`로 전부 검증한다 (날짜 형식·오름차순·중복·
  유한한 숫자·양수 가격·고가≥저가·개수 상한). 하나라도 어긋나면 통째로 400.
- 검증했더라도 **클라이언트가 보낸 데이터는 서버 캐시에 넣지 않는다.** 다른 사용자에게
  오염된 데이터가 퍼지지 않게 하기 위해서다. 대신 그 브라우저의 sessionStorage에만 남겨
  결과 화면에서 다시 계산할 때 재사용한다.
- Yahoo가 CORS preflight를 허용하지 않으므로 커스텀 헤더 없이 단순 GET으로만 부른다.

### 원인 진단: `/api/diag`

배포 화면에 에러가 떴을 때 어느 소스가 왜 막혔는지 추측하지 않으려고 둔 라우트다.

```
https://<배포주소>/api/diag?ticker=NVDA
```

각 소스별로 성공 여부·HTTP 상태·에러 메시지·소요 시간·받아온 일봉 수를 그대로 보여주고,
`DATA_PROVIDER` / `DATA_DEADLINE_MS` / KV·Gemini 키가 함수에 실제로 주입됐는지도 알려준다
(**값은 노출하지 않고 존재 여부만**).

> Stooq는 분할 조정은 되어 있지만 배당 조정은 하지 않는다. 거래량 필터가 목적이라
> 실사용에 문제는 없고, Yahoo가 살아 있으면 항상 Yahoo가 우선한다.

`npm run test:data`가 위 시나리오(호스트 교체, 크럼 재시도, Stooq 폴백, 404 즉시 종료,
만료 캐시 폴백)를 가짜 fetch로 전부 검증한다.

유료 소스로 갈아끼우려면 `lib/data/provider.ts`의 `DataProvider` 인터페이스를 구현하고
`lib/data/index.ts`의 `getProviders()`에 넣으면 된다. 나머지 코드는 그대로다.

### 조정(adjusted) 데이터

분할·배당 조정을 안 하면 액면분할일에 거래량이 인위적으로 튀어서 결과가 전부 오염된다.

- **배당**: `adjclose / close` 비율을 OHLC 전체에 곱한다 (거래량은 배당과 무관).
- **분할**: Yahoo는 보통 이미 조정해서 주지만 보장은 없다. splits 이벤트를 받아
  분할 전후 종가 점프를 실측해서, 조정이 안 되어 있을 때만 직접 적용한다
  (`applySplitsIfNeeded`).

## 파일 구조

```
app/
  page.tsx                  메인 (티커 + 명령 입력)
  results/page.tsx          결과 화면
  api/parse/route.ts        자연어 → FilterSpec
  api/analyze/route.ts      데이터 로드 + 지표 + 필터 + 통계 (일봉을 직접 받기도 함)
  api/diag/route.ts         시세 소스 진단 (?ticker=NVDA)
lib/
  analyze-client.ts         분석 요청 + 브라우저 폴백 조율
  client-quotes.ts          브라우저에서 Yahoo 직접 호출
  validate-bars.ts          클라이언트가 보낸 일봉 검증
  data/provider.ts          데이터 소스 인터페이스
  data/yahoo.ts             Yahoo 어댑터 (429 재시도 + 조정 처리)
  data/twelvedata.ts        Twelve Data 어댑터 (키 기반, 1순위)
  data/stooq.ts             Stooq CSV 폴백 어댑터
  data/fixture.ts           오프라인 데모용 합성 데이터
  data/cache.ts             KV / 메모리 캐시 (fresh 12h, stale 7d)
  indicators.ts             파생 지표
  filter.ts                 FilterSpec 적용 + 발화 규칙 + 클러스터링
  stats.ts                  forward return, base rate, edge
  presets.ts                프리셋 정의
  gemini.ts                 Gemini 호출 + 모델 폴백 체인 + 시간 예산
  validate-spec.ts          LLM 출력 검증 (알려진 값만 통과)
components/                 TickerInput, CommandInput, SummaryCard, VolumeChart, MatchList
scripts/                    selftest.ts, verify.ts, gemini-test.ts
vercel.json                 프레임워크 고정 (대시보드 오설정 방지)
```

## 파생 지표

| 필드 | 공식 |
|---|---|
| `vol_ma20` / `vol_ma50` | 최근 20/50봉 거래량 단순평균 |
| `volume_ratio_20d` | `volume / vol_ma20` |
| `volume_zscore_60d` | `(volume - mean60) / std60` |
| `dollar_volume` | `close × volume` |
| `close_change_pct` | `(close - prevClose) / prevClose × 100` |
| `close_position_in_range` | `(close - low) / (high - low)`, `high==low`면 0.5 |
| `range_pct` | `(high - low) / close × 100` |
| `up_down_vol_ratio_20d` | 최근 20봉 상승일 거래량합 ÷ 하락일 거래량합 |
| `up_day_ratio_20d` | 최근 20봉 중 상승 마감한 날의 비율 (0~1) |
| `obv` / `obv_slope_20d` | OBV 누적 / 20봉 선형회귀 기울기를 `vol_ma20`으로 정규화 |
| `obv_slope_60d` | OBV 60봉 기울기를 `vol_ma50`으로 정규화. 장기 매집 방향 |
| `atr14` | 표준 ATR(14), Wilder 스무딩 |
| `atr_ratio_20d` | `atr14 / 최근 20봉 ATR(14) 평균`; 0.8 이하면 변동폭이 평소 대비 20% 이상 줄어든 상태 |
| `range_ratio_20d` | 당일 고저폭 ÷ 최근 20봉 평균 고저폭 |
| `close_vs_sma20_pct` | 종가의 20봉 이동평균 대비 이격도 (%) |
| `dist_from_high_60d_pct` | **직전** 60봉(당일 제외) 최고가 대비 종가 위치 (%). 0 이상이면 60일 신고가 돌파 |
| `dist_from_low_60d_pct` | **직전** 60봉(당일 제외) 최저가 대비 종가 위치 (%) |
| `vol_ma_ratio_20_50` | `vol_ma20 / vol_ma50`. 1보다 크면 거래량 바닥 자체가 올라오는 중 |

워밍업 구간(20~60봉)의 지표는 `null`이며 필터에서 자동 제외된다.

### 이벤트 지표 vs 상태 지표

지표는 성격이 둘로 갈리고, 이 차이가 신호 개수를 지배한다.

- **이벤트 지표** (`volume_ratio_20d`, `close_change_pct`, `volume_zscore_60d` …) — 그날 하루의 사건.
  자연히 드물게 뜬다.
- **상태 지표** (`up_down_vol_ratio_20d`, `obv_slope_20d`, `atr_ratio_20d`, `vol_ma_ratio_20_50` …) —
  20~60일 롤링 창. **한 번 임계값을 넘으면 국면이 끝날 때까지 매일 참이다.**

상태 지표만으로 만든 조건(누적 매집·수급 개선 등)은 임계값을 아무리 올려도
"한 국면 = 신호 수십 개"가 된다. 그래서 조건 강화와 별개로 아래 발화 규칙을 함께 건다.

또 `volume_ratio_20d`나 `range_ratio_20d`처럼 **"그날 값 ÷ 자기 20일 평균"** 형태인 지표는
조용한 구간에서 분모도 같이 내려가 늘 1 근처가 된다. "거래량이 말라간다"를 표현하려면
`volume_ratio_20d <= 0.6`이 아니라 `vol_ma_ratio_20_50 <= 0.8`을 써야 한다.

## 신호 발화 규칙

조건을 만족한 날을 전부 신호로 세지 않는다. `FilterSpec`의 두 필드가 이를 통제한다.

| 필드 | 뜻 |
|---|---|
| `fresh_only` | 직전 거래일에는 조건을 만족하지 않았던 날(= 조건 진입 첫날)만 신호로 센다 |
| `min_gap_days` | 직전 신호 이후 최소 N거래일이 지나야 다음 신호를 인정한다 (상한 120) |

적용 순서: **조건 필터 → `fresh_only` → `lookahead` → 연속일 묶기 → `min_gap_days`**

둘 다 스펙에 없으면 프리셋 기본값(`PRESET_TRIGGERS`)을 쓰고, 프리셋도 없으면 규칙 없이 동작한다.
결과 화면 **신호 발화 규칙** 카드에서 두 값을 직접 바꿔 즉시 다시 계산할 수 있고,
`rawMatchCount`(조건 충족일) → `stats.matchCount`(최종 신호) 가 함께 표시된다.

## 빠른 신호 명령

| 명령 | 조건 | 발화 규칙 |
|---|---|---|
| 거래량 폭발 | 20일 평균 거래량 대비 3.0배 이상 | — |
| 물량 흡수 | 20일 평균 대비 2.0배 이상, 종가 변동 ±2.0% 이내 | 간격 5일 |
| 고가 마감 | 20일 평균 대비 1.8배 이상, 당일 고저폭 상위 25%에서 마감 | 간격 5일 |
| 급등 직전 | 이후 20거래일 내 +20% 상승 여부 | — (미래 데이터를 쓰는 과거 검증 전용) |
| 누적 매집 | 상승·하락일 거래량 비율 **2.0** 이상, OBV 20일 기울기 **0.6** 이상, `vol_ma_ratio_20_50` 1.1 이상, 20일선 대비 +12% 이내 | **첫 진입만 · 간격 20일** |
| 조용한 매집 | ATR 비율 0.85 이하, OBV 20일 0.4 / 60일 0.1 이상, 종가 변동 ±3% 이내, 20일선 대비 +8% 이내 | **첫 진입만 · 간격 20일** |
| 상승 전 압축 | ATR 비율 0.8 이하, 거래량 1.2배 이상, 당일 고저폭 상위 40% 마감 | 첫 진입만 · 간격 10일 |
| 거래량 소진 | `vol_ma_ratio_20_50` 0.8 이하, 거래량 0.9배 이하, 60일 고점 대비 -20% 이내 | 첫 진입만 · 간격 10일 |
| 강한 돌파 | 거래량 2.0배 이상, 종가 +2.0% 이상, 당일 고저폭 상위 15% 마감 | 간격 5일 |
| 박스 돌파 | 종가가 직전 60일 최고가 돌파, 거래량 2.0배 이상, 고저폭 상위 30% 마감 | 간격 10일 |
| 거래량 확장 | 거래량 2.5배 이상, 60일 거래량 z-score 1.5 이상 | 간격 5일 |
| 눌림목 지지 | 20일선 대비 -8%~+3%, 거래량 0.9배 이하, 고저폭 상위 40% 마감, 상승·하락일 거래량 비율 1.2 이상 | 첫 진입만 · 간격 10일 |
| 수급 개선 | 상승·하락일 거래량 비율 **1.6** 이상, OBV 20일 기울기 **0.3** 이상, 20일 중 상승일 비율 50% 이상 | **첫 진입만 · 간격 15일** |

굵게 표시한 값이 이번에 바뀐 부분이다. **누적 매집**과 **수급 개선**은 전부 상태 지표로만
이뤄져 있어 예전 임계값(1.5 / 0.3, 규칙 없음)으로는 한 국면이 신호 수십 개로 부풀려졌다.
임계값을 올리고, 방향이 같은 조건(거래량 베이스 상승·상승일 비율)을 더하고,
발화 규칙을 함께 걸어 "국면 하나 = 신호 한두 개"가 되게 했다.

최근에 입력한 **티커와 명령은 브라우저에 저장**되며, 결과 화면 최상단의 **티커·명령 수정**에서 같은 티커로 조건만 바꾸거나 티커 자체를 바꿔 즉시 재분석할 수 있다. 분석 결과에는 TradingView Lightweight Charts 기반의 **캔들 차트와 거래량 패널**이 표시되고, 현재 조건에 매칭된 날짜는 파란 화살표로 확인할 수 있다.

## 주의

- `lookahead`가 걸린 명령("급등 직전" 류)은 미래 데이터를 보는 것이라
  결과 상단에 **"백테스트 전용 — 실시간 매매 신호 아님"** 배지가 뜬다.
- 매칭이 10일 미만이면 "표본이 너무 적어 통계적 의미 없음" 경고가 뜬다.
- 날짜는 전부 거래소 기준 `YYYY-MM-DD` 문자열로 다룬다. `new Date()` 타임존 변환에
  의존하지 않는다.

**과거 패턴이며 투자 판단의 근거가 아닙니다.**
