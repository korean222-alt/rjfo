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
[POST /api/parse]  → Claude Haiku가 자연어를 FilterSpec JSON으로 변환 (파싱만, 계산 금지)
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
cp .env.example .env.local     # ANTHROPIC_API_KEY 채우기
npm run dev
```

외부 시세 API 없이 UI만 확인하려면:

```bash
DATA_PROVIDER=fixture npm run dev   # 합성 데이터 (실제 시세 아님)
```

## 검증

```bash
npm run selftest        # 지표·통계 검산 (네트워크 불필요)
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
3. **Environment Variables**에 `ANTHROPIC_API_KEY` 추가 (Production/Preview/Development 모두)
4. Deploy

`NEXT_PUBLIC_` 접두사에는 절대 API 키를 넣지 마라. 클라이언트 번들에 그대로 박힌다.

### 캐시 (선택)

없어도 동작한다 (람다 인스턴스 메모리 캐시로 폴백). 제대로 하려면
Vercel 대시보드에서 KV(Upstash Redis) 스토어를 붙이고 `KV_REST_API_URL`,
`KV_REST_API_TOKEN`을 환경변수에 넣으면 `ohlcv:{ticker}` 키로 12시간 캐싱된다.

> 환경변수는 전부 **런타임**에 읽는다. 모듈 최상위에서 `process.env`를 읽으면
> Next가 빌드 타임 값으로 인라인해 버려서 배포 환경변수가 무시된다.

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
  validate-spec.ts          LLM 출력 검증 (알려진 값만 통과)
components/                 TickerInput, CommandInput, SummaryCard, VolumeChart, MatchList
scripts/                    selftest.ts, verify.ts
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
