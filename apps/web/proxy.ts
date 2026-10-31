import { clerkMiddleware } from "@clerk/nextjs/server";

export default clerkMiddleware();

// Only the worker dashboard signs in. Guest tip pages stay free of auth.
export const config = { matcher: ["/app", "/app/(.*)"] };
