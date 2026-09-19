import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = (env = process.env) => env.MULTI_AGENT_SECRETS || path.join(process.cwd(), ".data", "secrets");

function safeName(id) {
  return String(id).replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function saveSecret(id, value, env = process.env) {
  if (process.platform !== "win32") throw new Error("secure secret storage currently requires Windows");
  if (!String(value ?? "").trim()) throw new Error("secret value is required");
  const dir = root(env);
  fs.mkdirSync(dir, { recursive: true });
  const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Add-Type -AssemblyName System.Security; $plain=[Text.Encoding]::UTF8.GetBytes($env:MAC_SECRET); $protected=[Security.Cryptography.ProtectedData]::Protect($plain,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Convert]::ToBase64String($protected)"], { env: { ...process.env, MAC_SECRET: String(value) }, encoding: "utf8" }).trim();
  const file = path.join(dir, `${safeName(id)}.dpapi`);
  fs.writeFileSync(file, `${output}\n`, { encoding: "utf8", mode: 0o600 });
  return file;
}

export function loadSecret(id, env = process.env) {
  if (process.platform !== "win32") return null;
  const file = path.join(root(env), `${safeName(id)}.dpapi`);
  if (!fs.existsSync(file)) return null;
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Add-Type -AssemblyName System.Security; $protected=[Convert]::FromBase64String($env:MAC_CIPHER); $plain=[Security.Cryptography.ProtectedData]::Unprotect($protected,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Text.Encoding]::UTF8.GetString($plain)"], { env: { ...process.env, MAC_CIPHER: fs.readFileSync(file, "utf8").trim() }, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

export function hasSecret(id, env = process.env) {
  return fs.existsSync(path.join(root(env), `${safeName(id)}.dpapi`));
}

export function deleteSecret(id, env = process.env) {
  const file = path.join(root(env), `${safeName(id)}.dpapi`);
  try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
}
