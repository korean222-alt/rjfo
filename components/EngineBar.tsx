/**
 * 화면 맨 아래 고정 바.
 *
 * 면책 문구만 있던 자리에 "무엇이 이 숫자를 만들었나"를 같이 적는다.
 *   - 채점·적중률·등급·차트는 서버 코드가 수식으로 계산한다. AI가 관여하지 않는다.
 *   - Gemini는 그렇게 나온 숫자를 문장으로 옮기는 일만 한다. 꺼져 있어도 숫자는 그대로다.
 *
 * 모델 이름을 여기에 두는 이유: AI 요약 카드에만 있으면 스크롤을 내린 뒤에는
 * 무엇이 답했는지 알 수 없다. 폴백 체인 때문에 요청마다 모델이 달라질 수 있어서,
 * 화면 어디서든 보이는 자리에 한 번 더 적는다.
 */

import { modelLabel } from "@/lib/format";

type Props = {
  /** 이번 응답을 실제로 처리한 모델 id. AI를 안 쓴 결과면 null. */
  model?: string | null;
};

export default function EngineBar({ model }: Props) {
  return (
    <div className="fixed inset-x-0 bottom-0 border-t border-border bg-bg/95 px-4 py-2 text-center backdrop-blur">
      <p className="text-xs text-muted">과거 패턴이며 투자 판단의 근거가 아닙니다.</p>
      <p className="mt-0.5 text-[10px] leading-relaxed text-muted">
        숫자·등급·차트 = <span className="text-white">서버 계산</span>(AI 아님) · 문장 ={" "}
        {model ? (
          <span className="text-white">{modelLabel(model)}</span>
        ) : (
          <span>AI 없이 만든 요약문</span>
        )}
      </p>
    </div>
  );
}
