"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const TRUST = require(path.join(ROOT, ".grok", "skills", "ppt-cast", "scripts", "runtime", "render_trust"));

let tempRoot;

before(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deckformance-render-trust-"));
});

after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function write(relative, value) {
  const output = path.join(tempRoot, ...relative.split("/"));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, value);
  return output;
}

function helper(filePath, version = "fixture-1") {
  return {
    name: path.basename(filePath),
    version,
    sha256: TRUST.sha256File(filePath),
  };
}

function policy(rendererPath, slidesTestPath, overrides = {}) {
  const adapter = {
    id: "fixture-adapter",
    renderer: helper(rendererPath),
    slidesTest: helper(slidesTestPath),
    ...(overrides.adapter || {}),
  };
  return {
    schema: TRUST.POLICY_SCHEMA,
    policyId: TRUST.DEFAULT_POLICY_ID,
    approvedAdapters: [adapter],
    ...overrides.policy,
  };
}

function writePolicy(name, value) {
  return write(`policies/${name}.json`, `${JSON.stringify(value, null, 2)}\n`);
}

test("default policy pins the approved OpenAI Presentations 26.819.11345 helper pair", () => {
  const loaded = TRUST.loadRendererTrustPolicy();
  assert.equal(loaded.schema, TRUST.POLICY_SCHEMA);
  assert.equal(loaded.policyId, TRUST.DEFAULT_POLICY_ID);
  assert.equal(Object.isFrozen(loaded), true);
  assert.deepEqual(loaded.approvedAdapters, [{
    id: "openai-presentations-26.819.11345",
    renderer: {
      name: "render_slides.py",
      version: "26.819.11345",
      sha256: "sha256:ab4965cd3e7338767c83217780ed0efadc219b38f1ca7e824765400fbcf69705",
    },
    slidesTest: {
      name: "slides_test.py",
      version: "26.819.11345",
      sha256: "sha256:f192e85ba17a9f7634908074e2149a277a30684c0e38d459f9c1d0245bfd6cc1",
    },
  }]);
});

test("an exact live hash, version, and name pair matches one approved adapter", () => {
  const rendererPath = write("approved/render_fixture.py", "approved renderer bytes\n");
  const slidesTestPath = write("approved/slides_fixture.py", "approved slides-test bytes\n");
  const policyPath = writePolicy("approved", policy(rendererPath, slidesTestPath));
  const result = TRUST.verifyTrustedRendererPair({
    renderer: { path: rendererPath, name: "render_fixture.py", version: "fixture-1" },
    slidesTest: { path: slidesTestPath, name: "slides_fixture.py", version: "fixture-1" },
  }, { policyPath });
  assert.equal(result.trusted, true);
  assert.equal(result.adapterId, "fixture-adapter");
  assert.equal(result.policyId, TRUST.DEFAULT_POLICY_ID);
  assert.equal(result.renderer.sha256, TRUST.sha256File(rendererPath));
  assert.equal(result.slidesTest.sha256, TRUST.sha256File(slidesTestPath));
  assert.equal(Object.isFrozen(result.renderer), true);
});

test("live hash, version, and name drift cannot self-declare trust", () => {
  const rendererPath = write("drift/render_fixture.py", "trusted renderer bytes\n");
  const slidesTestPath = write("drift/slides_fixture.py", "trusted slides-test bytes\n");
  const policyPath = writePolicy("drift", policy(rendererPath, slidesTestPath));
  const exact = {
    renderer: { path: rendererPath, name: "render_fixture.py", version: "fixture-1" },
    slidesTest: { path: slidesTestPath, name: "slides_fixture.py", version: "fixture-1" },
  };

  assert.throws(
    () => TRUST.verifyTrustedRendererPair({ ...exact, renderer: { ...exact.renderer, version: "fixture-2" } }, { policyPath }),
    (error) => error.code === "RENDERER_NOT_APPROVED" && /not approved/.test(error.message),
  );

  assert.throws(
    () => TRUST.verifyTrustedRendererPair({ ...exact, renderer: { ...exact.renderer, name: "self-declared.py" } }, { policyPath }),
    (error) => error.code === "LIVE_NAME_DRIFT",
  );

  fs.appendFileSync(rendererPath, "modified\n");
  assert.throws(
    () => TRUST.verifyTrustedRendererPair(exact, { policyPath }),
    (error) => error.code === "RENDERER_NOT_APPROVED" && /not approved/.test(error.message),
  );

  const renamedPath = write("drift/arbitrary_renderer.py", "trusted renderer bytes\n");
  assert.throws(
    () => TRUST.verifyTrustedRendererPair({
      ...exact,
      renderer: { path: renamedPath, name: "arbitrary_renderer.py", version: "fixture-1" },
    }, { policyPath }),
    (error) => error.code === "RENDERER_NOT_APPROVED",
  );
});

test("policy parsing rejects duplicate adapters, duplicate fingerprints, and duplicate JSON keys", () => {
  const rendererPath = write("duplicates/render_fixture.py", "renderer\n");
  const slidesTestPath = write("duplicates/slides_fixture.py", "slides test\n");
  const base = policy(rendererPath, slidesTestPath);
  assert.throws(
    () => TRUST.validateRendererTrustPolicy({
      ...base,
      approvedAdapters: [base.approvedAdapters[0], { ...base.approvedAdapters[0] }],
    }),
    (error) => error.code === "POLICY_DUPLICATE_ADAPTER" && /duplicates/.test(error.message),
  );
  assert.throws(
    () => TRUST.validateRendererTrustPolicy({
      ...base,
      approvedAdapters: [base.approvedAdapters[0], { ...base.approvedAdapters[0], id: "second-adapter" }],
    }),
    (error) => error.code === "POLICY_DUPLICATE_ADAPTER" && /pair/.test(error.message),
  );

  const duplicateKey = write(
    "policies/duplicate-key.json",
    `{"schema":"${TRUST.POLICY_SCHEMA}","policyId":"${TRUST.DEFAULT_POLICY_ID}","policyId":"${TRUST.DEFAULT_POLICY_ID}","approvedAdapters":[]}\n`,
  );
  assert.throws(
    () => TRUST.loadRendererTrustPolicy(duplicateKey),
    (error) => error.code === "POLICY_DUPLICATE_KEY",
  );
});

test("malformed or ambiguous policies fail closed", () => {
  const rendererPath = write("malformed/render_fixture.py", "renderer\n");
  const slidesTestPath = write("malformed/slides_fixture.py", "slides test\n");
  const base = policy(rendererPath, slidesTestPath);
  const malformedPolicies = [
    { ...base, schema: "wrong-schema" },
    { ...base, policyId: "wrong-policy" },
    { ...base, extra: true },
    { ...base, approvedAdapters: [{ ...base.approvedAdapters[0], id: "INVALID ID" }] },
    { ...base, approvedAdapters: [{ ...base.approvedAdapters[0], renderer: { ...base.approvedAdapters[0].renderer, name: "../render.py" } }] },
    { ...base, approvedAdapters: [{ ...base.approvedAdapters[0], renderer: { ...base.approvedAdapters[0].renderer, version: "bad version" } }] },
    { ...base, approvedAdapters: [{ ...base.approvedAdapters[0], renderer: { ...base.approvedAdapters[0].renderer, sha256: "sha256:not-a-hash" } }] },
  ];
  for (const [index, candidate] of malformedPolicies.entries()) {
    assert.throws(() => TRUST.loadRendererTrustPolicy(writePolicy(`malformed-${index}`, candidate)), TRUST.RendererTrustError);
  }
  const brokenJson = write("policies/broken.json", "{\"schema\":\n");
  assert.throws(
    () => TRUST.loadRendererTrustPolicy(brokenJson),
    (error) => error.code === "POLICY_JSON_INVALID",
  );
  assert.throws(
    () => TRUST.verifyTrustedRendererPair({ renderer: {}, slidesTest: {} }, { policy: base, policyPath: "unused" }),
    (error) => error.code === "POLICY_SOURCE_AMBIGUOUS",
  );
});
