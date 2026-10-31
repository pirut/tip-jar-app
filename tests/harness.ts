// Runs the real Convex handlers against an in-memory database. It enforces what these
// tests rely on: schema validators, declared indexes, rollback when a mutation throws,
// and scheduled functions. It runs one call at a time, so it can't show how live Convex
// behaves under concurrent writes.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";

// convex/ uses extensionless relative imports, which Node doesn't resolve by itself.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && context.parentURL && !context.parentURL.includes("/node_modules/") && !/\.[cm]?[jt]s$/.test(specifier)) {
      for (const ext of [".ts", ".js"]) {
        const url = new URL(specifier + ext, context.parentURL);
        if (existsSync(url)) return nextResolve(url.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const { getFunctionName } = await import("convex/server");
const { default: schema } = await import("../convex/schema.ts");
export const crews = await import("../convex/crews.ts");
export const workers = await import("../convex/workers.ts");
export const tips = await import("../convex/tips.ts");
export const earnings = await import("../convex/earnings.ts");
export const migrations = existsSync(new URL("../convex/migrations.ts", import.meta.url))
  ? await import("../convex/migrations.ts")
  : undefined;
export const payments = await import("../convex/payments.ts");
export const paymentsNode = await import("../convex/paymentsNode.ts");
export const settlement = await import("../convex/settlement.ts");
export const ops = await import("../convex/ops.ts");
export const paymentsCron = await import("../convex/paymentsCron.ts");
const modules: Record<string, any> = { crews, workers, tips, earnings, migrations, payments, paymentsNode, settlement, ops, paymentsCron };

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
const START = Date.UTC(2027, 0, 15, 8); // 8am UTC, so tests can cross midnight on purpose

function check(value: any, validator: any, path: string) {
  const fail = () => {
    throw new Error(`Schema violation at ${path}: ${JSON.stringify(value)}`);
  };
  if (value === undefined) {
    if (validator.isOptional !== "optional") fail();
    return;
  }
  switch (validator.kind) {
    case "string":
    case "id":
      if (typeof value !== "string") fail();
      if (validator.kind === "id" && !value.startsWith(`${validator.tableName}:`)) fail();
      break;
    case "float64":
      if (typeof value !== "number") fail();
      break;
    case "boolean":
      if (typeof value !== "boolean") fail();
      break;
    case "literal":
      if (value !== validator.value) fail();
      break;
    case "array":
      if (!Array.isArray(value)) fail();
      value.forEach((item: any, i: number) => check(item, validator.element, `${path}[${i}]`));
      break;
    case "object":
      if (typeof value !== "object" || value === null) fail();
      for (const key of Object.keys(value)) if (!validator.fields[key]) fail();
      for (const [key, inner] of Object.entries(validator.fields)) check(value[key], inner, `${path}.${key}`);
      break;
    case "union":
      if (!validator.members.some((m: any) => { try { check(value, m, path); return true; } catch { return false; } })) fail();
      break;
    default:
      throw new Error(`Harness has no check for validator kind ${validator.kind}`);
  }
}

class Query {
  db: Db;
  table: string;
  filters: [string, unknown][];
  direction: "asc" | "desc";
  upTo?: [string, number];
  fields?: string[];

  constructor(db: Db, table: string, filters: [string, unknown][] = [], direction: "asc" | "desc" = "asc", upTo?: [string, number], fields?: string[]) {
    this.upTo = upTo;
    this.fields = fields;
    this.db = db;
    this.table = table;
    this.filters = filters;
    this.direction = direction;
  }

  withIndex(name: string, build?: (q: any) => unknown) {
    const index = (schema as any).tables[this.table].indexes.find((i: any) => i.indexDescriptor === name);
    if (!index) throw new Error(`${this.table} has no index ${name}`);
    const filters: [string, unknown][] = [];
    let upTo: [string, number] | undefined;
    const range = {
      eq: (field: string, value: unknown) => {
        if (index.fields[filters.length] !== field) throw new Error(`${name} can't filter on ${field} here`);
        filters.push([field, value]);
        return range;
      },
      lte: (field: string, value: number) => {
        if (index.fields[filters.length] !== field) throw new Error(`${name} can't range on ${field} here`);
        upTo = [field, value];
        return range;
      },
    };
    build?.(range);
    return new Query(this.db, this.table, filters, this.direction, upTo, index.fields);
  }

  order(direction: "asc" | "desc") {
    return new Query(this.db, this.table, this.filters, direction, this.upTo, this.fields);
  }

  rows() {
    const out = [...this.db.docs.values()].filter(
      (doc) => doc._id.startsWith(`${this.table}:`) && this.filters.every(([k, v]) => doc[k] === v)
        && (!this.upTo || doc[this.upTo[0]] <= this.upTo[1]),
    );
    // Convex reads an index in field order, then creation order.
    if (this.fields) {
      const rest = this.fields.slice(this.filters.length);
      out.sort((a, b) => {
        for (const f of rest) if (a[f] !== b[f]) return a[f] < b[f] ? -1 : 1;
        return 0;
      });
    }
    if (this.direction === "desc") out.reverse();
    return out.map((doc) => structuredClone(doc));
  }

  async collect() { return this.rows(); }
  async take(n: number) { return this.rows().slice(0, n); }
  async first() { return this.rows()[0] ?? null; }
  async unique() {
    const rows = this.rows();
    if (rows.length > 1) throw new Error(`${this.table} query expected one row, found ${rows.length}`);
    return rows[0] ?? null;
  }
  async paginate({ cursor, numItems }: { cursor: string | null; numItems: number }) {
    const rows = this.rows();
    const start = cursor === null ? 0 : rows.findIndex((r) => r._id === cursor) + 1;
    const page = rows.slice(start, start + numItems);
    const isDone = start + numItems >= rows.length;
    return { page, isDone, continueCursor: page.at(-1)?._id ?? cursor ?? "" };
  }
}

class Db {
  docs = new Map<string, any>();
  next = 0;

  private validate(table: string, doc: any) {
    const { fields } = (schema as any).tables[table].validator;
    for (const key of Object.keys(doc)) {
      if (key.startsWith("_")) continue;
      if (!fields[key]) throw new Error(`Schema violation: ${table}.${key} isn't in the schema`);
    }
    for (const [key, validator] of Object.entries(fields)) check(doc[key], validator, `${table}.${key}`);
  }

  query(table: string) { return new Query(this, table); }
  normalizeId(table: string, id: string) { return id.startsWith(`${table}:`) && this.docs.has(id) ? id : null; }
  async get(id: string) {
    const doc = this.docs.get(id);
    return doc ? structuredClone(doc) : null;
  }
  async insert(table: string, value: any) {
    const _id = `${table}:${++this.next}`;
    const doc = { ...value, _id, _creationTime: Date.now() };
    this.validate(table, doc);
    this.docs.set(_id, doc);
    return _id;
  }
  async patch(id: string, value: any) {
    const doc = this.docs.get(id);
    if (!doc) throw new Error(`Patch of missing document ${id}`);
    const merged = { ...doc, ...value };
    for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
    this.validate(id.split(":")[0], merged);
    this.docs.set(id, merged);
  }
  async delete(id: string) {
    if (!this.docs.delete(id)) throw new Error(`Delete of missing document ${id}`);
  }
}

// `realClock` is for scripts/sandbox-e2e.ts, where Stripe has to agree on the time.
export function world({ realClock = false } = {}) {
  const db = new Db();
  let now = START;
  let jobs: { at: number; name: string; args: any }[] = [];
  if (!realClock) Date.now = () => now;

  const resolve = (ref: any) => {
    const [file, name] = getFunctionName(ref).split(":");
    return modules[file][name];
  };
  const ctx = (token: string | null): any => ({
    db,
    auth: { getUserIdentity: async () => (token ? { tokenIdentifier: token, email: `${token}@example.com` } : null) },
    scheduler: {
      runAt: async (at: number, ref: any, args: any) => { jobs.push({ at, name: getFunctionName(ref), args }); },
      runAfter: async (ms: number, ref: any, args: any) => { jobs.push({ at: Date.now() + ms, name: getFunctionName(ref), args }); },
    },
    // Actions: each nested call is its own transaction, as it is on Convex.
    runQuery: (ref: any, args: any) => call(resolve(ref), token, args),
    runMutation: (ref: any, args: any) => call(resolve(ref), token, args),
    runAction: (ref: any, args: any) => resolve(ref)._handler(ctx(token), args),
  });

  // Like a Convex mutation, a throw undoes the call's writes and scheduling.
  const call = async (fn: any, token: string | null = null, args: any = {}) => {
    const docs = new Map(db.docs);
    const scheduled = [...jobs];
    try {
      return await fn._handler(ctx(token), args);
    } catch (err) {
      db.docs = docs;
      jobs = scheduled;
      throw err;
    }
  };

  const runDueJobs = async () => {
    for (;;) {
      const due = jobs.filter((j) => j.at <= Date.now()).sort((a, b) => a.at - b.at)[0];
      if (!due) return;
      jobs = jobs.filter((j) => j !== due);
      const [file, name] = due.name.split(":");
      await call(modules[file][name], null, due.args);
    }
  };

  return {
    db,
    call,
    // Actions aren't transactions: what they already did stays even if they throw.
    act: (fn: any, token: string | null = null, args: any = {}) => fn._handler(ctx(token), args),
    runDueJobs,
    jobs: () => jobs,
    advance: (ms: number) => { now += ms; },
    rows: (table: string) => db.query(table).rows(),
    profile: (token: string, handle: string, workplace = "") =>
      call(workers.saveProfile, token, { name: handle, handle, jobTitle: "", workplace }),
    tip: (handle: string, amountCents: number) => call(tips.tipFromGuest, null, { handle, amountCents, coverFees: true }),
  };
}
