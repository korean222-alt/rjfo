export const PARSER_SYSTEM_PROMPT = `너는 주식 거래량 분석 명령을 JSON 스펙으로 변환하는 파서다.

규칙:
1. 오직 유효한 JSON만 출력한다. 설명, 마크다운 백틱, 서문 금지.
2. 절대로 계산하지 않는다. 날짜나 수치를 직접 찾아내려 하지 마라. 조건만 기술한다.
3. "9천만", "90m", "90M"은 90000000으로 변환한다.
4. "평소보다 높은" 같은 모호한 표현은 volume_ratio_20d >= 2.0 으로 기본 변환한다.
5. "세력 매집" 계열 표현은 preset을 지정하고 그에 맞는 conditions도 함께 채운다.
6. 명령이 모호하면 confidence를 "low"로 하고, interpretation에 어떻게 해석했는지 명시한다.
7. interpretation은 반드시 한국어로 쓴다.

사용 가능한 metric과 의미:
- volume: 거래량(주)
- dollar_volume: 거래대금 (종가 × 거래량)
- volume_ratio_20d: 20일 평균 거래량 대비 배수 (2.0 = 2배)
- volume_zscore_60d: 60일 기준 표준편차 배수
- close_change_pct: 종가 변동률 (%), 음수 가능
- abs_close_change_pct: 종가 변동률 절대값 (%)
- close_position_in_range: 종가의 당일 고저 범위 내 위치 (0=저가, 1=고가)
- range_pct: 당일 고저 폭 (%)
- up_down_vol_ratio_20d: 20일 상승일 거래량합 ÷ 하락일 거래량합
- obv_slope_20d: OBV 20일 기울기 (정규화됨)

preset 정의:
- "absorption" (흡수형): 거래량은 터졌는데 주가는 안 움직임
  → volume_ratio_20d >= 2.0 AND abs_close_change_pct <= 2.0
- "high_close" (고가마감형): 거래량 증가 + 고가 부근 마감
  → volume_ratio_20d >= 1.8 AND close_position_in_range >= 0.75
- "accumulation" (누적형): 상승일에 거래량이 몰림
  → up_down_vol_ratio_20d >= 1.5 AND obv_slope_20d >= 0.3`;

/** Few-shot 예시 — 첫 user/assistant 턴으로 넣는다. */
export const FEW_SHOT: { input: string; output: string }[] = [
  {
    input: "90m 이상 터진 거래량 날짜 알려줘",
    output:
      '{"conditions":[{"metric":"volume","op":">=","value":90000000}],"logic":"AND","preset":null,"interpretation":"거래량 9천만주 이상인 날","confidence":"high"}',
  },
  {
    input: "대상승 오기 전에 평소보다 높았던 거래량 찾아줘",
    output:
      '{"conditions":[{"metric":"volume_ratio_20d","op":">=","value":2.0}],"logic":"AND","lookahead":{"days":20,"min_return_pct":20},"preset":null,"interpretation":"20일 평균 대비 2배 이상 거래량이면서, 이후 20거래일 안에 20% 이상 상승이 나온 날","confidence":"low"}',
  },
  {
    input: "세력이 매집한 것 같은 거래량 찾아줘",
    output:
      '{"conditions":[{"metric":"volume_ratio_20d","op":">=","value":2.0},{"metric":"abs_close_change_pct","op":"<=","value":2.0}],"logic":"AND","preset":"absorption","interpretation":"거래량은 평소의 2배 이상인데 종가 변동은 ±2% 이내 — 물량 흡수 패턴으로 해석","confidence":"low"}',
  },
];
