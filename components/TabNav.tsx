"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "거래량 분석" },
  { href: "/bull", label: "상승장 지표" },
  { href: "/alerts", label: "🔔 알림" },
] as const;

export default function TabNav() {
  const pathname = usePathname() ?? "/";

  return (
    <nav className="mb-6 flex gap-1 rounded-xl border border-border bg-surface p-1" aria-label="화면 전환">
      {TABS.map((tab) => {
        // "/"는 정확히 일치할 때만 (그래야 /bull에서 두 탭이 같이 켜지지 않는다).
        const active = tab.href === "/" ? pathname === "/" || pathname === "/results" : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={`flex-1 rounded-lg px-3 py-2 text-center text-sm font-medium transition ${
              active ? "bg-blue-500/20 text-white" : "text-muted hover:text-white"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
