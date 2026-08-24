// Integration guard: every getInput()/getBooleanInput() string literal in src/
// must correspond to an input declared in action.yml. Catches a typo'd input
// name that would silently resolve to "" at runtime.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function declaredInputs() {
  const yml = fs.readFileSync(path.join(ROOT, "action.yml"), "utf8");
  const start = yml.indexOf("\ninputs:");
  const end = yml.indexOf("\nruns:");
  const block = yml.slice(start, end === -1 ? undefined : end);
  // Top-level input keys are exactly two-space indented "name:" lines.
  return new Set([...block.matchAll(/^ {2}([a-z0-9-]+):\s*$/gm)].map((m) => m[1]));
}

function inputDefinition(name) {
  const yml = fs
    .readFileSync(path.join(ROOT, "action.yml"), "utf8")
    .replace(/\r\n/g, "\n");
  const match = yml.match(
    new RegExp(`^  ${name}:\\n((?: {4}.*\\n?)*)`, "m")
  );
  return match?.[1] || "";
}

function usedInputLiterals() {
  const srcDir = path.join(ROOT, "src");
  const used = new Map(); // name -> file it appears in
  for (const file of fs.readdirSync(srcDir)) {
    if (!file.endsWith(".js") || file.endsWith(".test.js")) continue;
    const text = fs.readFileSync(path.join(srcDir, file), "utf8");
    for (const m of text.matchAll(
      /\bget(?:Boolean)?Input\(\s*["']([^"']+)["']/g
    )) {
      used.set(m[1], file);
    }
  }
  return used;
}

test("action.yml + src parsing find something (guards against a vacuous test)", () => {
  const declared = declaredInputs();
  const used = usedInputLiterals();
  assert.ok(declared.size >= 10, `expected many declared inputs, got ${declared.size}`);
  assert.ok(used.size >= 5, `expected several used inputs, got ${used.size}`);
  // The detection logic must report an unknown name as undeclared.
  assert.equal(declared.has("totally-bogus-input"), false);
});

test("every getInput literal in src is declared in action.yml", () => {
  const declared = declaredInputs();
  const used = usedInputLiterals();
  const undeclared = [...used.entries()].filter(([name]) => !declared.has(name));
  assert.deepEqual(
    undeclared,
    [],
    `getInput() references not declared in action.yml: ${undeclared
      .map(([n, f]) => `"${n}" (${f})`)
      .join(", ")}`
  );
});

test("cache saving and job summaries are opt-out by default", () => {
  assert.match(inputDefinition("save-cache"), /^ {4}default: "true"$/m);
  assert.match(inputDefinition("job-summary"), /^ {4}default: "true"$/m);
});

test("C/C++ caching is opt-in by default", () => {
  assert.match(inputDefinition("cache-c-cpp"), /^ {4}default: "false"$/m);
});

test("cache-dir is optional and has no platform-specific default", () => {
  const definition = inputDefinition("cache-dir");
  assert.match(definition, /^ {4}required: false$/m);
  assert.doesNotMatch(definition, /^ {4}default:/m);
});

test("node-cache is explicit and runtime-dir stays optional", () => {
  assert.match(inputDefinition("node-cache"), /^ {4}default: "false"$/m);
  assert.match(inputDefinition("runtime-dir"), /^ {4}required: false$/m);
  assert.doesNotMatch(inputDefinition("runtime-dir"), /^ {4}default:/m);
});

test("no input description contains an expression (metadata context cannot resolve runner.* and would brick parsing)", () => {
  const yml = fs.readFileSync(path.join(ROOT, "action.yml"), "utf8");
  const inputsStart = yml.indexOf("\ninputs:");
  const runsStart = yml.indexOf("\nruns:");
  const inputsBlock = yml.slice(inputsStart, runsStart);
  const offenders = [...inputsBlock.matchAll(/description:.*\$\{\{([^}]*)\}/g)].map(
    (m) => m[1].trim()
  );
  assert.deepEqual(offenders, [], `expressions found in input descriptions: ${offenders.join(", ")}`);
});
