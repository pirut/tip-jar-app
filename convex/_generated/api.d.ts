/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as crews from "../crews.js";
import type * as crons from "../crons.js";
import type * as earnings from "../earnings.js";
import type * as helpers from "../helpers.js";
import type * as http from "../http.js";
import type * as lib_handles from "../lib/handles.js";
import type * as lib_money from "../lib/money.js";
import type * as lib_paymentRules from "../lib/paymentRules.js";
import type * as lib_paymentsDb from "../lib/paymentsDb.js";
import type * as lib_split from "../lib/split.js";
import type * as lib_stripeEnv from "../lib/stripeEnv.js";
import type * as lib_stripeEvents from "../lib/stripeEvents.js";
import type * as migrations from "../migrations.js";
import type * as ops from "../ops.js";
import type * as payments from "../payments.js";
import type * as paymentsCron from "../paymentsCron.js";
import type * as paymentsNode from "../paymentsNode.js";
import type * as settlement from "../settlement.js";
import type * as tips from "../tips.js";
import type * as workers from "../workers.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  crews: typeof crews;
  crons: typeof crons;
  earnings: typeof earnings;
  helpers: typeof helpers;
  http: typeof http;
  "lib/handles": typeof lib_handles;
  "lib/money": typeof lib_money;
  "lib/paymentRules": typeof lib_paymentRules;
  "lib/paymentsDb": typeof lib_paymentsDb;
  "lib/split": typeof lib_split;
  "lib/stripeEnv": typeof lib_stripeEnv;
  "lib/stripeEvents": typeof lib_stripeEvents;
  migrations: typeof migrations;
  ops: typeof ops;
  payments: typeof payments;
  paymentsCron: typeof paymentsCron;
  paymentsNode: typeof paymentsNode;
  settlement: typeof settlement;
  tips: typeof tips;
  workers: typeof workers;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
