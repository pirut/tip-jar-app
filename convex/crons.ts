import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// These do nothing on a deployment with no payment activity, but the Stripe ones need keys,
// so they return early when STRIPE_MODE isn't set. See paymentsCron.
crons.interval("pay workers what's due", { minutes: 10 }, internal.paymentsCron.runDue);
crons.interval("catch anything a webhook missed", { hours: 1 }, internal.paymentsCron.reconcile);
crons.interval("compare books with Stripe", { hours: 24 }, internal.paymentsCron.reconcileBooks);

export default crons;
