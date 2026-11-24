import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const certDir = path.join(root, "infra", "emqx", "certs");
const required = ["ca.crt", "ca.key", "server.crt", "server.key"];
const present = required.filter((name) => existsSync(path.join(certDir, name)));

if (present.length === required.length) {
  process.stdout.write("MQTT certificates already exist; keeping the current CA and server key\n");
  process.exit(0);
}
if (present.length > 0 && !process.argv.includes("--force")) {
  throw new Error(`MQTT certificate set is incomplete (${present.join(", ")}); restore the missing files or rerun with --force to rotate the complete set`);
}

mkdirSync(certDir, { recursive: true });
const run = (...args) => execFileSync("openssl", args, { cwd: certDir, stdio: "inherit" });
run("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "3650", "-subj", "/CN=Agri Local MQTT CA");
writeFileSync(path.join(certDir, "server.ext"), "subjectAltName=DNS:emqx,DNS:localhost,IP:127.0.0.1\n");
run("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=emqx");
run("x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "server.crt", "-days", "825", "-extfile", "server.ext");
for (const name of ["ca.key", "server.key"]) chmodSync(path.join(certDir, name), 0o600);
process.stdout.write("Generated local MQTT CA and server certificate; distribute ca.crt to devices and keep private keys local\n");
