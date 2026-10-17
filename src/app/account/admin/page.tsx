import type { Metadata } from "next";
import { AdminUsers } from "@/components/account/AdminUsers";
import { GithubAppAdmin } from "@/components/account/GithubAppAdmin";

export const metadata: Metadata = { title: "Users" };
export const dynamic = "force-dynamic";

/** User management and the GitHub App (admins only: the APIs answer 403 to everyone else, the page shows that message). */
export default async function AdminPage({ searchParams }: PageProps<"/account/admin">) {
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  return (
    <main className="w-full px-4 py-6 sm:px-6 sm:py-10 xl:px-8">
      <div className="space-y-4">
        <header className="space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Users</h1>
          <p className="text-[15px] text-muted">Every account on this server. Disabling or deleting an account ends its sessions at once.</p>
        </header>
        <AdminUsers />
        <GithubAppAdmin created={params.github === "created"} errorCode={one(params.github_error)} errorMessage={one(params.github_message)} />
      </div>
    </main>
  );
}
