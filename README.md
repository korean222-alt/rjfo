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
빠른 신호(칩)를 고르면 LLM을 아예 거치지 않고 정해진 조건이 그대로 쓰인다.

여기에 더해, 등록해 둔 종목에 신호가 뜨면 **텔레그램으로 알림**을 보낸다
([텔레그램 알림](#텔레그램-알림) 참고).

화면은 탭 3개다 — **거래량 분석**(`/`), **상승장 지표**(`/bull`), **알림**(`/alerts`).
상승장 지표는 과거를 뒤지는 게 아니라 *지금이 오르는 국면인지*를 일봉·주봉·월봉으로 각각
판정한다 ([상승장 지표](#상승장-지표) 참고).

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
3. 정적 후보: `gemini-flash-lite-latest` → `gemini-3.6-flash` → `gemini-3.5-flash` → lite/preview → 구형 2.5/2.0/1.5
4. 그래도 전부 막히면 `/v1beta/models`를 조회해 이 키로 **실제 쓸 수 있는** 모델을 찾는다
   (flash 계열 우선, TTS·이미지·임베딩은 제외)

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
  bull/page.tsx             상승장 지표 (티커 + 일/주/월봉 + TradingView 차트)
  alerts/page.tsx           텔레그램 알림 등록·삭제
  api/parse/route.ts        자연어 → FilterSpec
  api/analyze/route.ts      데이터 로드 + 지표 + 필터 + 통계 (일봉을 직접 받기도 함)
  api/bull/route.ts         봉 집계 + 상승장 지표 판정
  api/diag/route.ts         시세 소스 진단 (?ticker=NVDA)
  api/alerts/route.ts       알림 목록 조회/등록/삭제
  api/alerts/check/route.ts 매일 도는 신호 점검 + 발송 (Vercel Cron)
  api/alerts/test/route.ts  테스트 메시지 발송
  api/alerts/chat-id/route.ts  최초 설정용 chat id 조회
lib/
  kv.ts                     Vercel KV REST 클라이언트 (캐시·알림 공용)
  alerts/store.ts           알림 워치리스트 (KV)
  alerts/telegram.ts        텔레그램 Bot API
  alerts/evaluate.ts        마지막 봉 신호 판정 + 메시지 문안
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
  timeframe.ts              일봉 → 주봉·월봉 집계
  bull.ts                   상승장 지표 (봉별 기간표 TF_CONFIG + RSI/MACD/EMA)
  bull-client.ts            상승장 지표 요청 + 브라우저 폴백 조율
  tradingview.ts            티커 → TradingView 심볼 (BTC = CRYPTO:BTCUSD)
  filter.ts                 FilterSpec 적용 + 클러스터링
  stats.ts                  forward return, base rate, edge
  presets.ts                프리셋 정의
  gemini.ts                 Gemini 호출 + 모델 폴백 체인 + 시간 예산
  validate-spec.ts          LLM 출력 검증 (알려진 값만 통과)
components/                 TabNav, TickerInput, CommandInput, SummaryCard, MatchList,
                            ChartPanel (일/주/월봉 전환), VolumeChart, TradingViewChart
scripts/                    selftest.ts, verify.ts, gemini-test.ts
vercel.json                 프레임워크 고정 + 알림 크론 스케줄
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
| `obv` / `obv_slope_20d` | OBV 누적 / 20봉 선형회귀 기울기를 `vol_ma20`으로 정규화 |
| `atr14` | 표준 ATR(14), Wilder 스무딩 |
| `atr_ratio_20d` | `atr14 / 최근 20봉 ATR(14) 평균`; 0.8 이하면 변동폭이 평소 대비 20% 이상 줄어든 상태 |

워밍업 구간(20~60봉)의 지표는 `null`이며 필터에서 자동 제외된다.

## 빠른 신호

칩을 탭하면 명령창이 그 문장으로 바뀌고, **AI 해석을 거치지 않고** 아래 조건이 그대로
적용된다. 같은 칩은 언제 눌러도 같은 결과가 나온다.

| 신호 | 조건 | 뜻 |
|---|---|---|
| 거래량 폭발 | 거래량 20일 평균 대비 3.0배 이상 | 평소보다 거래량이 확 터진 날 |
| 물량 흡수 | 거래량 2.0배 이상, 종가 변동 ±2.0% 이내 | 거래량은 늘었는데 주가는 거의 안 움직인 날 |
| 고가 마감 | 거래량 1.8배 이상, 당일 고저폭 상위 25%에서 마감 | 거래량 늘면서 고가 근처에서 끝난 날 |
| 급등 직전 | 거래량 2.0배 이상 + 이후 20거래일 내 +20% 상승 | 미래 데이터를 쓰는 **과거 검증 전용** |
| 누적 매집 | 상승일/하락일 거래량 비율 1.5 이상, OBV 기울기 0.3 이상 | 오르는 날에 거래량이 몰리는 구간 |
| 상승 전 압축 | ATR 비율 0.8 이하, 거래량 1.2배 이상, 고저폭 상위 40% 마감 | 변동폭이 좁아진 채 거래량·종가 위치가 개선되는 날 |
| 강한 돌파 | 거래량 2.0배 이상, 종가 +2.0% 이상, 고저폭 상위 15% 마감 | 거래량 급증과 함께 고가권에서 강하게 마감한 날 |
| 거래량 확장 | 거래량 2.5배 이상, 60일 z-score 1.5 이상 | 평소 대비 뚜렷하게 거래량이 늘어난 날 |
| 수급 개선 | 상승일/하락일 거래량 비율 1.4 이상, OBV 기울기 0.15 이상 | 수급이 개선되는 초기 조짐 |

각 신호는 조건 3개 이하로 유지한다. `scripts/selftest.ts`는 이 조건들이 여전히
유효한지(빈 조건 없음, 3개 이하)와 분석 화면·알림 판정이 서로 어긋나지 않는지를
검사한다 — 조건 3개짜리 신호(상승 전 압축·강한 돌파)는 임계값이 엄격해서 매칭이
드문 게 정상이므로, 매칭 횟수 자체는 참고용으로만 출력하고 실패 조건으로 삼지 않는다.

칩에 없는 조건은 명령창에 직접 쓰면 된다. 그때만 Gemini가 문장을 조건으로 바꾼다.

최근에 입력한 **티커와 명령은 브라우저에 저장**되며, 결과 화면 최상단의 **티커·명령 수정**에서 같은 티커로 조건만 바꾸거나 티커 자체를 바꿔 즉시 재분석할 수 있다. 분석 결과에는 TradingView Lightweight Charts 기반의 **캔들 차트와 거래량 패널**이 표시되고, 현재 조건에 매칭된 날짜는 파란 화살표로 확인할 수 있다. 여기에 TradingView 차트가 함께 뜨고 **일봉·주봉·월봉**을 바꿔 볼 수 있다 ([결과 화면 차트](#결과-화면-차트) 참고).

## 결과 화면 차트

거래량 분석 결과 화면의 차트는 **일봉 / 주봉 / 월봉** 버튼으로 바꿔 볼 수 있고, 버튼은 두
차트에 함께 걸린다.

1. **TradingView 차트** — 분석한 티커를 TradingView 심볼로 바꿔 공개 위젯으로 띄운다.
   비트코인이면 `CRYPTO:BTCUSD`다 (아래 [차트](#차트) 참고).
2. **캔들 · 거래량 차트** — 우리가 받아온 데이터로 그리고, 조건에 걸린 날을 화살표로 찍는다.

**분석·통계 자체는 계속 일봉 기준이다.** 주봉·월봉은 같은 일봉을 `lib/timeframe.ts`로 묶어
보여 주는 것이고, 매칭 화살표는 그 날이 속한 봉에 찍힌다.

## 상승장 지표

`/bull` 탭. 티커를 입력하고 **일봉 / 주봉 / 월봉**을 고르면, 그 봉 기준으로 상승 국면
지표 10~11개를 각각 판정하고 100점으로 묶어 준다.

**봉마다 기준이 다르다.** 일봉의 20/60/200일선을 주봉에 그대로 쓰면 200주 = 약 4년치라
아무 신호도 안 나오고, 월봉에는 계산조차 안 된다. 그래서 `lib/bull.ts`의 `TF_CONFIG`가
봉마다 이평 기간·모멘텀 구간·고점 비교 창을 따로 잡는다.

| | 이평 (단/중/장) | 기울기 | 크로스 인정 | 모멘텀 | 고점 비교 |
|---|---|---|---|---|---|
| 일봉 | 20 / 60 / 200일 | 20봉 | 20봉 | 60봉 | 252봉 (≈1년) |
| 주봉 | 10 / 30 / 50주 | 8봉 | 8봉 | 13봉 | 52봉 (1년) |
| 월봉 | 6 / 12 / 24개월 | 3봉 | 3봉 | 6봉 | 12봉 (1년) |

차트에 올라가는 이평선도 이 표를 그대로 따라간다.

지표는 장기 추세(종가 vs 장기 이평), 이평 배열(정배열/역배열), 장기 이평 기울기,
골든·데드크로스, 모멘텀, 고점 대비, RSI(14), MACD(12,26,9), 매수/매도 거래량 비,
OBV 기울기, 그리고 코인이면 펀딩비까지. 각 지표는 상승(1점)·중립(0.5점)·하락(0점)을
내고 평균이 점수가 된다. 75점 이상이면 "강한 상승장", 25점 미만이면 "강한 하락장".

**주봉·월봉은 일봉을 직접 묶어서 만든다** (`lib/timeframe.ts`). 시세 소스가 전부 일봉만
주기 때문이다. 시가는 구간 첫 봉, 종가는 마지막 봉, 고저는 구간 전체 최대·최소,
거래량은 합, 펀딩비는 구간 평균이다. 주봉은 월요일에 시작하고, 아직 안 끝난 마지막 봉은
"진행 중"으로 표시한다.

시세는 5년치까지만 받으므로 월봉은 60개 남짓이다. 24개월선이 상한인 이유다.

### 차트

TradingView 공개 위젯(키 없음)을 그대로 띄운다. 비트코인은 **`CRYPTO:BTCUSD`** —
TradingView 심볼 검색에서 `BTCUSD · Bitcoin · CRYPTO · spot crypto`로 나오는 그 심볼이다.
거래소 하나(`BINANCE:BTCUSDT`)가 아니라 여러 현물 거래소를 합친 지수라 특정 거래소가 튀어도
차트가 흔들리지 않고, 무기한 선물(`.P`)도 아니다. 매핑은 `lib/tradingview.ts`에 있다.

| 입력 | TradingView 심볼 |
|---|---|
| `BTC`, `비트코인`, `BTCUSD` | `CRYPTO:BTCUSD` |
| `ETH`, `SOL`, `XRP`, `DOGE`, `ADA` | `CRYPTO:<코인>USD` |
| `005930`, `삼성전자` | `KRX:005930` |
| `AAPL`, `NVDA` | `AAPL`, `NVDA` (거래소는 TradingView가 찾는다) |

위젯 안에서는 심볼을 못 바꾸게 막아 뒀다. 바꾸면 아래 지표 패널과 어긋나기 때문이다.
티커는 위의 입력창으로만 바꾼다.

`/api/bull`은 `/api/analyze`와 같은 폴백을 쓴다 — 서버가 시세 소스에 막히면 브라우저가
직접 일봉을 받아 실어 보내고, 계산은 그대로 서버 코드가 한다.

## 텔레그램 알림

등록한 종목에 신호가 뜬 날, **미국장 마감 뒤(매일 22:00 UTC)** 텔레그램으로 알려준다.
`/alerts` 화면에서 종목과 신호를 등록·삭제하고, 테스트 메시지도 보내 볼 수 있다.

판정은 **가장 최근 봉 하나만** 본다. 조건은 분석 화면과 같은 `lib/presets.ts`를 쓰므로
화면에서 본 신호와 알림이 어긋나지 않는다. "급등 직전"은 이후에 실제로 올랐는지를
보고 고르는 조건이라 알림 대상이 아니다.

### 설정 (3단계)

1. 텔레그램에서 **@BotFather** 에게 `/newbot` → 받은 토큰을 Vercel 환경변수
   `TELEGRAM_BOT_TOKEN` 에 넣는다.
2. 만든 봇에게 아무 메시지나 한 번 보낸 뒤 **`/api/alerts/chat-id`** 를 열면 chat id가
   나온다. 그 값을 `TELEGRAM_CHAT_ID` 에 넣는다.
3. Vercel 프로젝트에 **KV(Upstash Redis)** 스토어를 연결한다. 알림 목록이 여기 저장된다
   (시세 캐시와 같은 스토어를 쓴다). 환경변수를 바꾼 뒤에는 다시 배포해야 적용된다.

`CRON_SECRET` 을 함께 설정하면 `/api/alerts/check` 는 Vercel Cron이 붙여 주는
Authorization 헤더가 있을 때만 응답한다. 넣어 두는 걸 권장한다.

### 동작 규칙

- **종목 최대 8개.** 크론 한 번에 시세 API를 종목 수만큼 부르는데, Twelve Data 무료
  등급이 분당 8회다. 같은 종목의 여러 신호는 시세를 한 번만 받는다.
- **하루 한 번만.** 같은 봉으로는 `lastNotifiedDate` 때문에 두 번 알리지 않는다.
  크론이 두 번 돌거나 주말에 돌아도 중복 발송되지 않는다.
- **전송 실패는 다시 시도한다.** 텔레그램 전송이 실패하면 "알렸다" 표식을 남기지
  않으므로 다음 실행에서 다시 보낸다.
- **한 종목이 실패해도 나머지는 계속 본다.** 실패 사유는 응답의 `notes`에 남는다.
- 크론은 캐시가 아직 fresh여도 시세를 새로 받는다 (오늘 봉이 반드시 필요하므로).

## 주의

- `lookahead`가 걸린 명령("급등 직전" 류)은 미래 데이터를 보는 것이라
  결과 상단에 **"백테스트 전용 — 실시간 매매 신호 아님"** 배지가 뜬다.
- 매칭이 10일 미만이면 "표본이 너무 적어 통계적 의미 없음" 경고가 뜬다.
- 날짜는 전부 거래소 기준 `YYYY-MM-DD` 문자열로 다룬다. `new Date()` 타임존 변환에
  의존하지 않는다.

**과거 패턴이며 투자 판단의 근거가 아닙니다.**
