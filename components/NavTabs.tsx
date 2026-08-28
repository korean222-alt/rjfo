"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * 화면이 셋으로 늘어나면서(거래량 / 상승장 / 알림) 어디에 있는지 헷갈리기 쉬워졌다.
 * 상단에 항상 같은 자리에 탭을 둔다.
 */
const TABS = [
  { href: "/", label: "거래량 분석", icon: "📊" },
  { href: "/cycle", label: "상승장 지표", icon: "🔺" },
  { href: "/alerts", label: "알림", icon: "🔔" },
];

export default function NavTabs() {
  const pathname = usePathname();

  return (
    <nav className="mb-5 flex gap-1.5 rounded-xl border border-border bg-surface p-1">
      {TABS.map((tab) => {
        // /results 는 거래량 분석의 결과 화면이라 첫 탭을 활성으로 본다.
        const active =
          tab.href === "/"
            ? pathname === "/" || pathname.startsWith("/results")
            : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={`flex-1 rounded-lg px-2 py-2 text-center text-[13px] font-medium transition ${
              active ? "bg-blue-500 text-white" : "text-muted active:bg-bg"
            }`}
          >
            <span className="mr-1">{tab.icon}</span>
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
