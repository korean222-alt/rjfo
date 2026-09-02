import { json } from "@/lib/json-response";

/**
 * 알림 API 접근 통제.
 *
 * 이 앱에는 로그인이 없다. 배포 주소는 공개이고, /api/alerts 계열은 등록 종목을 보여주고
 * 텔레그램을 발송하고 워치리스트를 고친다. 아무 보호가 없으면 주소만 알면 누구나
 * 크론을 돌리고 알림을 지울 수 있다.
 *
 * 두 겹으로 막는다:
 *
 *  1) 크론용 GET — CRON_SECRET. Vercel Cron은 이 환경변수가 있으면
 *     Authorization: Bearer <값>을 붙여 준다. 예전 코드는 "값이 있을 때만" 검사해서,
 *     환경변수를 안 넣으면 검사 자체가 통째로 없어졌다. 안 넣은 상태가 가장 위험한데
 *     가장 느슨했던 셈이다. 이제 운영에서는 값이 없으면 거절한다.
 *
 *  2) 화면에서 호출하는 변경 요청 — 같은 오리진에서 온 요청만 받는다.
 *     브라우저는 POST/DELETE에 Origin(과 Sec-Fetch-Site)을 반드시 붙이므로 앱은 그대로
 *     동작하고, 남의 사이트에서 걸어 둔 요청과 헤더 없는 curl은 걸린다.
 *     비밀번호가 아니라서 완벽한 잠금은 아니다 — 주소를 아는 사람까지 막으려면
 *     Vercel Deployment Protection을 켜야 한다.
 */

function isProduction(): boolean {
  return process.env.VERCEL_ENV === "production";
}

/** 크론 GET. 통과하면 null, 막으면 응답. */
export function cronDenied(req: Request): Response | null {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    if (!isProduction()) return null; // 로컬·프리뷰에서는 손으로 돌려볼 수 있어야 한다
    return json(
      {
        error:
          "CRON_SECRET이 설정되지 않아 이 엔드포인트를 잠갔습니다. " +
          "Vercel 프로젝트 환경변수(Production)에 CRON_SECRET을 추가하면 크론이 다시 돕니다.",
      },
      { status: 503 },
    );
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return json({ error: "권한이 없습니다." }, { status: 401 });
  }
  return null;
}

/** 화면에서 호출하는 변경 요청. 다른 사이트에서 왔으면 막는다. */
export function crossSiteDenied(req: Request): Response | null {
  const site = req.headers.get("sec-fetch-site");
  if (site === "same-origin" || site === "none") return null;

  const origin = req.headers.get("origin");
  if (origin) {
    const host = req.headers.get("host");
    try {
      if (host && new URL(origin).host === host) return null;
    } catch {
      // 파싱 안 되는 Origin은 그냥 막는다
    }
  }

  return json(
    { error: "이 요청은 앱 화면에서만 보낼 수 있습니다." },
    { status: 403 },
  );
}
