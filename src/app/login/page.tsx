import type { Metadata } from "next";
import { AuthFrame, LoginForm } from "@/components/account/AuthForms";
import { isPublicMode } from "@/lib/accounts/mode";

export const metadata: Metadata = { title: "Log in" };
export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const next = (await searchParams).next;
  const publicMode = isPublicMode();
  return (
    <AuthFrame title="Log in" intro={publicMode ? "Use your username or email address." : "Accounts with a password log in here."}>
      <LoginForm publicMode={publicMode} next={typeof next === "string" ? next : undefined} />
    </AuthFrame>
  );
}
