import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { Nav } from "@/components/Nav";
import { HistoryTable } from "@/components/HistoryTable";

export default async function HistoryPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/api/auth/signin");

  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <main className="mx-auto max-w-4xl px-4 py-10">
        <h1 className="text-xl font-semibold mb-6">Check History</h1>
        <HistoryTable />
      </main>
    </div>
  );
}
