"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";

export function Nav() {
  const pathname = usePathname();
  const { data: session } = useSession();

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
          <span className="text-xs text-muted-foreground">
            {session?.user?.email}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => signOut({ callbackUrl: "/" })}
          >
            Sign out
          </Button>
        </div>
      </div>
    </nav>
  );
}
