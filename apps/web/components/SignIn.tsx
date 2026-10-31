"use client";

import { SignIn as ClerkSignIn } from "@clerk/nextjs";

export function SignIn() {
  return <ClerkSignIn routing="hash" withSignUp fallbackRedirectUrl="/app" signUpFallbackRedirectUrl="/app" />;
}
