import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AuthFrame, ForgotForm } from "@/components/account/AuthForms";
import { isPublicMode } from "@/lib/accounts/mode";

export const metadata: Metadata = { title: "Forgot password" };
export const dynamic = "force-dynamic";

export default function ForgotPasswordPage() {
  if (!isPublicMode()) notFound();
  return (
    <AuthFrame title="Forgot password" intro="We send a link to set a new password to the address of your account.">
      <ForgotForm />
    </AuthFrame>
  );
}
