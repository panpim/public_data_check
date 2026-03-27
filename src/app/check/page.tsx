import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { authOptions } from "@/lib/auth";
import { Nav } from "@/components/Nav";
import { CheckForm } from "@/components/CheckForm";

export default async function CheckPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/api/auth/signin?callbackUrl=/check");

  const cookieStore = await cookies();
  const country = (cookieStore.get("country")?.value ?? "LT") as "LT" | "PL";

  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <main className="mx-auto max-w-xl px-4 py-10">
        <h1 className="text-xl font-semibold mb-6">Run a Compliance Check</h1>
        <CheckForm country={country} />
      </main>
    </div>
  );
}
