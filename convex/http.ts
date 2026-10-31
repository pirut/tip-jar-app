import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();

function stripeWebhook(source: "platform" | "connect") {
  return httpAction(async (ctx, request) => {
    const signature = request.headers.get("stripe-signature");
    if (!signature) return new Response("Missing signature", { status: 400 });
    // A missing secret throws, so Stripe gets a 500 and retries once it's fixed.
    const event = await ctx.runAction(internal.paymentsNode.verifyWebhook, { body: await request.text(), signature, source });
    if (!event) return new Response("Bad signature", { status: 400 });
    // Saved before answering, so a failure after this point is ours to retry and the event isn't lost.
    await ctx.runMutation(internal.payments.recordEvent, event);
    return new Response(null, { status: 200 });
  });
}

http.route({ path: "/stripe/webhook", method: "POST", handler: stripeWebhook("platform") });
http.route({ path: "/stripe/connect-webhook", method: "POST", handler: stripeWebhook("connect") });

export default http;
