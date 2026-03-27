"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

export function Nav() {
  const pathname = usePathname();
  const { data: session } = useSession();
  const [country, setCountry] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/user/country")
      .then((r) => r.json())
      .then((d) => setCountry(d.country ?? null))
      .catch(() => {});
  }, []);

  return (
    <nav className="border-b bg-background">
      <div className="mx-auto flex h-14 max-w-4xl items-center justify-between px-4">
        <div className="flex items-center gap-6">
          <span className="font-semibold text-sm">Public Registry Check</span>
          <Link
            href="/check"
            className={`text-sm transition-colors hover:text-foreground ${
              pathname === "/check"
                ? "text-foreground font-medium"
                : "text-muted-foreground"
            }`}
          >
            Run Check
          </Link>
          <Link
            href="/history"
            className={`text-sm transition-colors hover:text-foreground ${
              pathname === "/history"
                ? "text-foreground font-medium"
                : "text-muted-foreground"
            }`}
          >
            History
          </Link>
        </div>
        <div className="flex items-center gap-3">
          {country && (
            <Link
              href="/select-country"
              className="text-xs font-medium px-2 py-1 rounded border border-border hover:bg-muted transition-colors"
              title="Change market"
            >
              {country === "LT" ? "🇱🇹" : "🇵🇱"} {country}
            </Link>
          )}
          <span className="text-xs text-muted-foreground">
            {session?.user?.email}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => signOut({ callbackUrl: "/api/auth/signin?callbackUrl=/check" })}
          >
            Sign out
          </Button>
        </div>
      </div>
    </nav>
  );
}
