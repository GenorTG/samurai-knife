import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AuthFrame, RegisterForm } from "@/components/account/AuthForms";
import { isPublicMode } from "@/lib/accounts/mode";

export const metadata: Metadata = { title: "Create account" };
export const dynamic = "force-dynamic";

export default function RegisterPage() {
  // Private mode has no registration at all (accounts come from `npm run accounts`).
  if (!isPublicMode()) notFound();
  return (
    <AuthFrame title="Create account" intro="You confirm your email address before the first login.">
      <RegisterForm />
    </AuthFrame>
  );
}
