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
npm run verify AAPL     # 실데이터로 지표/통계 콘솔 출력
DATA_PROVIDER=fixture npm run verify DEMO
```

`selftest`는 손으로 계산한 상수와, 본 구현과 다르게 짠 naive 구현 양쪽에 대조한다.
포함 항목: vol_ma20/50, volume_ratio_20d, volume_zscore_60d, ATR(14) Wilder 스무딩,
high==low 봉의 0 나누기 방어, forward return, 클러스터링, AND/OR 로직,
그리고 **전체 매칭 시 stats == baseline** 불변식.

## Vercel 배포

1. 이 저장소를 GitHub에 푸시 (이미 되어 있음)
2. [vercel.com/new](https://vercel.com/new) → 저장소 임포트 → 프레임워크는 Next.js로 자동 인식
3. **Environment Variables**에 `GEMINI_API_KEY` 추가 (Production/Preview/Development 모두)
4. Deploy

`NEXT_PUBLIC_` 접두사에는 절대 API 키를 넣지 마라. 클라이언트 번들에 그대로 박힌다.

### 캐시 (선택)

없어도 동작한다 (람다 인스턴스 메모리 캐시로 폴백). 제대로 하려면
Vercel 대시보드에서 KV(Upstash Redis) 스토어를 붙이고 `KV_REST_API_URL`,
`KV_REST_API_TOKEN`을 환경변수에 넣으면 `ohlcv:{ticker}` 키로 12시간 캐싱된다.

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

키 하나만 꽂으면 되는 게 아니라, **모델이 조용히 폐기돼도 자동으로 우회하는 구조**다.
`npm run test:gemini`가 위 시나리오 9가지를 전부 검증한다.

## 데이터 소스

기본은 Yahoo Finance의 비공식 chart 엔드포인트다. 무료·키 불필요지만 **비공식이라 언제든
막힐 수 있다.** 서버 라우트에서만 호출한다 (브라우저에서 부르면 CORS).

유료 소스로 갈아끼우려면 `lib/data/provider.ts`의 `DataProvider` 인터페이스를 구현하고
`lib/data/index.ts`의 `getProvider()`만 바꾸면 된다. 나머지 코드는 그대로다.

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
  api/analyze/route.ts      데이터 로드 + 지표 + 필터 + 통계
lib/
  data/provider.ts          데이터 소스 인터페이스
  data/yahoo.ts             Yahoo 어댑터 (조정 처리 포함)
  data/fixture.ts           오프라인 데모용 합성 데이터
  data/cache.ts             KV / 메모리 캐시 (TTL 12h)
  indicators.ts             파생 지표
  filter.ts                 FilterSpec 적용 + 클러스터링
  stats.ts                  forward return, base rate, edge
  presets.ts                프리셋 정의
  gemini.ts                 Gemini 호출 + 모델 폴백 체인 + 시간 예산
  validate-spec.ts          LLM 출력 검증 (알려진 값만 통과)
components/                 TickerInput, CommandInput, SummaryCard, VolumeChart, MatchList
scripts/                    selftest.ts, verify.ts, gemini-test.ts
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

워밍업 구간(20~60봉)의 지표는 `null`이며 필터에서 자동 제외된다.

## 주의

- `lookahead`가 걸린 명령("급등 직전" 류)은 미래 데이터를 보는 것이라
  결과 상단에 **"백테스트 전용 — 실시간 매매 신호 아님"** 배지가 뜬다.
- 매칭이 10일 미만이면 "표본이 너무 적어 통계적 의미 없음" 경고가 뜬다.
- 날짜는 전부 거래소 기준 `YYYY-MM-DD` 문자열로 다룬다. `new Date()` 타임존 변환에
  의존하지 않는다.

**과거 패턴이며 투자 판단의 근거가 아닙니다.**
