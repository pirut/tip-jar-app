// Deployments with no Stripe setup, like production today, shouldn't wake a Node action on every tick or log errors.
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { configuredMode } from "./lib/stripeEnv";

export const runDue = internalMutation({
  args: {},
  handler: async (ctx) => {
    if (configuredMode()) await ctx.scheduler.runAfter(0, internal.paymentsNode.runDue, {});
  },
});

export const reconcile = internalMutation({
  args: {},
  handler: async (ctx) => {
    if (configuredMode()) await ctx.scheduler.runAfter(0, internal.paymentsNode.reconcile, {});
  },
});

export const reconcileBooks = internalMutation({
  args: {},
  handler: async (ctx) => {
    if (configuredMode()) await ctx.scheduler.runAfter(0, internal.paymentsNode.reconcileBooks, {});
  },
});
