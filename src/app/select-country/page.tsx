"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Nav } from "@/components/Nav";

type Country = "LT" | "PL";

export default function SelectCountryPage() {
  const router = useRouter();
  const [autoRedirecting, setAutoRedirecting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // On mount: check if a DB preference exists and auto-restore the cookie
    fetch("/api/user/country")
      .then((r) => r.json())
      .then(async (data) => {
        if (data.country) {
          // Re-set the cookie by calling PUT, then redirect
          const putRes = await fetch("/api/user/country", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ country: data.country }),
          });
          if (putRes.ok) {
            router.replace("/check");
            return;
          }
          // PUT failed — fall through to show selection UI
          setError("Could not restore your country preference — please select again.");
        }
        setAutoRedirecting(false);
      })
      .catch(() => {
        setAutoRedirecting(false);
      });
  }, [router]);

  async function handleSelect(country: Country) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/user/country", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ country }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? "Failed to save preference. Please try again.");
        return;
      }
      router.replace("/check");
    } catch {
      setError("Network error — please try again.");
    } finally {
      setSaving(false);
    }
  }

  if (autoRedirecting) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <p className="text-muted-foreground text-sm">Loading…</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <main className="mx-auto max-w-xl px-4 py-16">
        <h1 className="text-xl font-semibold mb-2 text-center">Select your market</h1>
        <p className="text-sm text-muted-foreground mb-10 text-center">
          You can change this at any time from the navigation bar.
        </p>

        {error && (
          <p className="text-sm text-destructive text-center mb-6">{error}</p>
        )}

        <div className="grid grid-cols-2 gap-4">
          {(["LT", "PL"] as Country[]).map((c) => (
            <button
              key={c}
              onClick={() => handleSelect(c)}
              disabled={saving}
              className="rounded-lg border-2 border-border hover:border-primary p-8 flex flex-col items-center gap-3 transition-colors disabled:opacity-50"
            >
              <span className="text-4xl">{c === "LT" ? "🇱🇹" : "🇵🇱"}</span>
              <span className="font-semibold">{c === "LT" ? "Lithuania" : "Poland"}</span>
              <span className="text-xs text-muted-foreground">{c}</span>
            </button>
          ))}
        </div>
      </main>
    </div>
  );
}
