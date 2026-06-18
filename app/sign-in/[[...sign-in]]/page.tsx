import { redirect } from "next/navigation";
import { Logo } from "@/components/layout/logo";

const googleConfigured =
  !!process.env.GOOGLE_CLIENT_ID &&
  !!process.env.GOOGLE_CLIENT_SECRET &&
  !!process.env.GOOGLE_REDIRECT_URI &&
  !!process.env.MOXIE_SECRET_KEY;

const clerkConfigured = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

const ERROR_MESSAGES: Record<string, string> = {
  state: "Your sign-in session expired. Please try again.",
  exchange: "Could not complete sign-in with Google. Please try again.",
  forbidden: "That account isn't allowed. Use your Moxie Beauty Google account.",
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (googleConfigured) {
    const { error } = await searchParams;
    const message = error ? ERROR_MESSAGES[error] ?? "Sign-in failed. Please try again." : null;
    return (
      <div className="app-wash flex min-h-screen flex-col items-center justify-center gap-8 p-6">
        <Logo variant="dark" />
        <div className="w-full max-w-sm rounded-2xl border border-border/60 bg-card p-8 shadow-soft">
          <h1 className="text-lg font-semibold">Sign in to Moxie Ops</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Use your Moxie Beauty Google account to continue.
          </p>
          {message && (
            <p className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{message}</p>
          )}
          <a
            href="/auth/google"
            className="mt-6 flex w-full items-center justify-center gap-3 rounded-xl border border-border/70 bg-white px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            <GoogleMark />
            Continue with Google
          </a>
        </div>
      </div>
    );
  }

  if (!clerkConfigured) redirect("/");
  const { SignIn } = await import("@clerk/nextjs");
  return (
    <div className="app-wash flex min-h-screen flex-col items-center justify-center gap-8 p-6">
      <Logo variant="dark" />
      <SignIn appearance={{ variables: { colorPrimary: "#9acd32" } }} />
    </div>
  );
}

function GoogleMark() {
  return (
    <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.52 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h6.47a5.53 5.53 0 0 1-2.4 3.58v2.97h3.88c2.27-2.09 3.57-5.17 3.57-8.79Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.08 7.95-2.91l-3.88-2.97c-1.08.72-2.45 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.28v3.07A12 12 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.31a7.2 7.2 0 0 1 0-4.62V6.62H1.28a12 12 0 0 0 0 10.76l3.99-3.07Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.44-3.44A11.95 11.95 0 0 0 12 0 12 12 0 0 0 1.28 6.62l3.99 3.07C6.22 6.86 8.87 4.75 12 4.75Z"
      />
    </svg>
  );
}
