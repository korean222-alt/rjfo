export const PARSER_SYSTEM_PROMPT = `너는 주식 거래량 분석 명령을 JSON 스펙으로 변환하는 파서다.

규칙:
1. 오직 유효한 JSON만 출력한다. 설명, 마크다운 백틱, 서문 금지.
2. 절대로 계산하지 않는다. 날짜나 수치를 직접 찾아내려 하지 마라. 조건만 기술한다.
3. "9천만", "90m", "90M"은 90000000으로 변환한다.
4. "평소보다 높은" 같은 모호한 표현은 volume_ratio_20d >= 2.0 으로 기본 변환한다.
5. "세력 매집", "누적 매집", "물량 흡수", "매집 신호"는 모두 accumulation preset을 지정하고 그에 맞는 conditions도 함께 채운다. absorption은 과거 저장 결과 호환용이므로 새 명령에 사용하지 않는다.
6. "상승 전 압축", "변동성 축소", "움직임이 줄고 거래량이 붙는" 표현은 squeeze preset을 지정하고 conditions도 함께 채운다.
7. "초기 돌파", "거래량 동반 고가 마감", "고가 부근 마감" 표현은 high_close preset을 지정하고 conditions도 함께 채운다.
8. "급등 직전", "대상승 전"처럼 미래 상승을 기준으로 한 표현에는 lookahead를 설정하고 confidence를 "low"로 한다. 이는 과거 검증 전용 조건이다.
9. 명령이 모호하면 confidence를 "low"로 하고, interpretation에 어떻게 해석했는지 명시한다.
10. interpretation은 반드시 한국어로 쓴다.

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
- atr_ratio_20d: 현재 ATR(14) ÷ 20일 평균 ATR(14) (0.8 이하면 평소보다 변동폭이 20% 이상 줄어든 상태)

preset 정의:
- "accumulation" (매집 신호): 거래량 증가 + 작은 가격 변동 + 상승일 수급 우위 + OBV 개선
  → volume_ratio_20d >= 1.5 AND abs_close_change_pct <= 2.5 AND up_down_vol_ratio_20d >= 1.2 AND obv_slope_20d >= 0
- "squeeze" (상승 전 압축): 변동폭 축소 + 거래량 개선 + 고가 쪽 종가
  → atr_ratio_20d <= 0.8 AND volume_ratio_20d >= 1.2 AND close_position_in_range >= 0.6
- "high_close" (초기 돌파): 거래량 증가 + 상승 마감 + 고가 부근 마감
  → volume_ratio_20d >= 1.8 AND close_change_pct >= 1.0 AND close_position_in_range >= 0.75
- "absorption"은 이전 저장 결과를 위한 호환용이다.
  → volume_ratio_20d >= 2.0 AND abs_close_change_pct <= 2.0`;

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
      '{"conditions":[{"metric":"volume_ratio_20d","op":">=","value":1.5},{"metric":"abs_close_change_pct","op":"<=","value":2.5},{"metric":"up_down_vol_ratio_20d","op":">=","value":1.2},{"metric":"obv_slope_20d","op":">=","value":0}],"logic":"AND","preset":"accumulation","interpretation":"거래량이 늘었지만 가격 변동은 크지 않고, 상승일 수급과 OBV가 개선되는 매집 신호로 해석","confidence":"low"}',
  },
  {
    input: "상승 전 압축 신호 찾아줘",
    output:
      '{"conditions":[{"metric":"atr_ratio_20d","op":"<=","value":0.8},{"metric":"volume_ratio_20d","op":">=","value":1.2},{"metric":"close_position_in_range","op":">=","value":0.6}],"logic":"AND","preset":"squeeze","interpretation":"평소보다 변동폭이 줄어든 상태에서 거래량과 종가 위치가 개선되는 상승 전 압축 신호로 해석","confidence":"low"}',
  },
];
