import type { Metadata } from "next";
import { WelcomeWizard } from "@/components/welcome/WelcomeWizard";
import { requireSignIn } from "@/lib/accounts/viewer";
import { getT } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT();
  return { title: t("Welcome") };
}

export const dynamic = "force-dynamic";

/** The first-run wizard (docs/TOOLSETS.md). New accounts land here once from `/`; anyone can come back from the home page. */
export default async function WelcomePage() {
  await requireSignIn("/welcome");
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-10">
      <WelcomeWizard />
    </main>
  );
}
