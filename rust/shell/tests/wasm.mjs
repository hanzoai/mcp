// Smoke test of the wasm build: node rust/shell/tests/wasm.mjs <dir with hanzo_shell.js>
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const { classify } = createRequire(import.meta.url)(process.argv[2] + "/hanzo_shell.js");
const options = JSON.stringify({ cwd: "/work/app", home: "/home/me" });
const risk = (c) => JSON.parse(classify(c, options)).risk;
assert.equal(risk("ls -la"), "allow");
assert.equal(risk("rm -rf build"), "allow");
assert.equal(risk("rm -rf /"), "deny");
assert.equal(risk("git push origin main"), "ask");
assert.equal(risk("python3 -c \"import os; os.system('sudo id')\""), "deny");
assert.equal(risk("cat .env"), "deny");
const report = JSON.parse(classify("sudo id", options));
assert.deepEqual(report.findings.map((f) => f.kind), ["privilege"]);
console.log("wasm ok");
