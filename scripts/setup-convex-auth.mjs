// One-time setup for Convex Auth on a deployment: creates the signing keys
// and sets SITE_URL. Usage:
//   node scripts/setup-convex-auth.mjs --prod https://tip.jrbussard.com
//   node scripts/setup-convex-auth.mjs http://localhost:3000        (dev deployment)
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const prod = args.includes("--prod");
const siteUrl = args.find((a) => a.startsWith("http")) ?? "http://localhost:3000";
const flags = prod ? ["--prod"] : [];

function envSet(name, value) {
  // `--` keeps values that start with "-----BEGIN" from being read as flags.
  execFileSync("npx", ["convex", "env", "set", ...flags, "--", name, value], { stdio: ["ignore", "ignore", "inherit"] });
  console.log(`Set ${name}${prod ? " (prod)" : ""}`);
}

function envGet(name) {
  try {
    return execFileSync("npx", ["convex", "env", "get", ...flags, name], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

if (envGet("JWT_PRIVATE_KEY")) {
  console.log("JWT_PRIVATE_KEY already set; keeping the existing keys.");
} else {
  const keys = await generateKeyPair("RS256", { extractable: true });
  const privateKey = await exportPKCS8(keys.privateKey);
  const jwks = JSON.stringify({ keys: [{ use: "sig", ...(await exportJWK(keys.publicKey)) }] });
  envSet("JWT_PRIVATE_KEY", privateKey.trimEnd().replace(/\n/g, " "));
  envSet("JWKS", jwks);
}
envSet("SITE_URL", siteUrl);
