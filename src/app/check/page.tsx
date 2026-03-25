import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { Nav } from "@/components/Nav";
import { CheckForm } from "@/components/CheckForm";

export default async function CheckPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/api/auth/signin");

  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <main className="mx-auto max-w-xl px-4 py-10">
        <h1 className="text-xl font-semibold mb-6">Run a Compliance Check</h1>
        <CheckForm />
      </main>
    </div>
  );
}
