import type { Metadata } from "next";
import { AdminUsers } from "@/components/account/AdminUsers";

export const metadata: Metadata = { title: "Users" };

/** User management (admins only: the API answers 403 to everyone else, the page shows that message). */
export default function AdminPage() {
  return (
    <main className="w-full px-4 py-6 sm:px-6 sm:py-10 xl:px-8">
      <div className="space-y-4">
        <header className="space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Users</h1>
          <p className="text-[15px] text-muted">Every account on this server. Disabling or deleting an account ends its sessions at once.</p>
        </header>
        <AdminUsers />
      </div>
    </main>
  );
}
