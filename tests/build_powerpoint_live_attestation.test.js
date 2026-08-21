"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const {
  MICROSOFT_TEAM_IDENTIFIER,
  assertPowerPointLiveAttestation,
  validatePowerPointLiveAttestation,
} = require(path.join(ROOT, ".grok", "skills", "ppt-cast", "scripts", "runtime", "powerpoint_attestation"));

const PLIST = Object.freeze({
  CFBundleIdentifier: "com.microsoft.Powerpoint",
  CFBundleShortVersionString: "16.99",
  CFBundleVersion: "25081121",
  CFBundleExecutable: "Microsoft PowerPoint",
});
const SIGNATURE = Object.freeze({
  identifier: "com.microsoft.Powerpoint",
  teamIdentifier: MICROSOFT_TEAM_IDENTIFIER,
  cdHash: "A".repeat(40),
  authorities: [
    `Developer ID Application: Microsoft Corporation (${MICROSOFT_TEAM_IDENTIFIER})`,
    "Developer ID Certification Authority",
    "Apple Root CA",
  ],
});

function sha256File(filePath) {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function fakeApp(root) {
  const appPath = path.join(root, "Microsoft PowerPoint.app");
  const infoPath = path.join(appPath, "Contents", "Info.plist");
  const executablePath = path.join(appPath, "Contents", "MacOS", PLIST.CFBundleExecutable);
  fs.mkdirSync(path.dirname(executablePath), { recursive: true });
  fs.writeFileSync(infoPath, "fake plist bytes read only through injected plutil\n");
  fs.writeFileSync(executablePath, "fake executable bytes for deterministic SHA-256\n");
  fs.chmodSync(executablePath, 0o755);
  return { appPath, executablePath };
}

function fixtureRunner(overrides = {}) {
  const calls = [];
  const plist = { ...PLIST, ...(overrides.plist || {}) };
  const signature = { ...SIGNATURE, ...(overrides.signature || {}) };
  const runner = (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === "/usr/bin/plutil") {
      const key = args[1];
      if (!Object.hasOwn(plist, key)) return { status: 1, stdout: "", stderr: `missing ${key}` };
      return { status: 0, stdout: `${plist[key]}\n`, stderr: "" };
    }
    if (command === "/usr/bin/codesign" && args[0] === "--verify") {
      return overrides.verifyFailure
        ? { status: 1, stdout: "", stderr: "code object is not signed at all" }
        : { status: 0, stdout: "", stderr: "" };
    }
    if (command === "/usr/bin/codesign" && args[0] === "-dvvv") {
      const lines = [
        `Identifier=${signature.identifier}`,
        `TeamIdentifier=${signature.teamIdentifier}`,
        `CDHash=${signature.cdHash}`,
        ...signature.authorities.map((value) => `Authority=${value}`),
      ];
      return { status: 0, stdout: "", stderr: `${lines.join("\n")}\n` };
    }
    if (command === "/usr/bin/sw_vers") return { status: 0, stdout: `${overrides.osVersion || "15.6.1"}\n`, stderr: "" };
    if (command === "/usr/bin/uname") return { status: 0, stdout: `${overrides.arch || "arm64"}\n`, stderr: "" };
    return { status: 127, stdout: "", stderr: `unexpected command: ${command} ${args.join(" ")}` };
  };
  return { calls, runner, plist, signature };
}

function matchingReceipt(executablePath, fixture) {
  return {
    powerPointVersion: `${fixture.plist.CFBundleShortVersionString} (${fixture.plist.CFBundleVersion})`,
    powerPoint: {
      bundleIdentifier: fixture.plist.CFBundleIdentifier,
      shortVersion: fixture.plist.CFBundleShortVersionString,
      bundleVersion: fixture.plist.CFBundleVersion,
      executableSha256: sha256File(executablePath),
      codeSignature: {
        valid: true,
        identifier: fixture.signature.identifier,
        teamIdentifier: fixture.signature.teamIdentifier,
        cdHash: fixture.signature.cdHash,
        authorities: [...fixture.signature.authorities],
      },
    },
    system: { platform: "macos", osVersion: "15.6.1", arch: "arm64" },
  };
}

function testOptions(appPath, fixture, platform = "darwin") {
  return {
    testOnly: {
      enabled: true,
      platform,
      appPath,
      commandRunner: fixture.runner,
    },
  };
}

test("live PowerPoint attestation matches plist, executable, code signature, version, and system", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deckformance-powerpoint-attestation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = fakeApp(root);
  const fixture = fixtureRunner();
  const receipt = matchingReceipt(app.executablePath, fixture);

  const result = validatePowerPointLiveAttestation(receipt, testOptions(app.appPath, fixture));
  assert.equal(result.passed, true, JSON.stringify(result.errors, null, 2));
  assert.deepEqual(result.errors, []);
  assert.equal(result.live.powerPoint.executableSha256, receipt.powerPoint.executableSha256);
  assert.equal(fixture.calls.filter((call) => call.command === "/usr/bin/plutil").length, 4);
  assert.deepEqual(
    fixture.calls.filter((call) => call.command === "/usr/bin/codesign").map((call) => call.args.slice(0, 2)),
    [["--verify", "--deep"], ["-dvvv", "--verbose=4"]],
  );
  assert.doesNotThrow(() => assertPowerPointLiveAttestation(receipt, testOptions(app.appPath, fixture)));
});

test("receipt hash, version, signature, and system drift are rejected independently", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deckformance-powerpoint-drift-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = fakeApp(root);

  const cases = [
    {
      name: "executable hash",
      mutate: (receipt) => { receipt.powerPoint.executableSha256 = `sha256:${"0".repeat(64)}`; },
      path: "powerPointReceipt.powerPoint.executableSha256",
    },
    {
      name: "bundle version",
      mutate: (receipt) => { receipt.powerPoint.bundleVersion = "stale-build"; },
      path: "powerPointReceipt.powerPoint.bundleVersion",
    },
    {
      name: "derived PowerPoint version",
      mutate: (receipt) => { receipt.powerPointVersion = "16.98 (stale-build)"; },
      path: "powerPointReceipt.powerPointVersion",
    },
    {
      name: "signature CDHash",
      mutate: (receipt) => { receipt.powerPoint.codeSignature.cdHash = "B".repeat(40); },
      path: "powerPointReceipt.powerPoint.codeSignature.cdHash",
    },
    {
      name: "signature authorities",
      mutate: (receipt) => { receipt.powerPoint.codeSignature.authorities = ["stale authority"]; },
      path: "powerPointReceipt.powerPoint.codeSignature.authorities",
    },
    {
      name: "system OS version",
      mutate: (receipt) => { receipt.system.osVersion = "14.0"; },
      path: "powerPointReceipt.system.osVersion",
    },
    {
      name: "system architecture",
      mutate: (receipt) => { receipt.system.arch = "x86_64"; },
      path: "powerPointReceipt.system.arch",
    },
  ];

  for (const item of cases) {
    const fixture = fixtureRunner();
    const receipt = matchingReceipt(app.executablePath, fixture);
    item.mutate(receipt);
    const result = validatePowerPointLiveAttestation(receipt, testOptions(app.appPath, fixture));
    assert.equal(result.passed, false, `${item.name} drift unexpectedly passed`);
    assert.ok(result.errors.some((error) => error.code === "POWERPOINT_LIVE_DRIFT" && error.path === item.path), JSON.stringify(result.errors, null, 2));
  }
});

test("non-macOS, missing apps, invalid live identity, and failed codesign are blocked", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deckformance-powerpoint-blocked-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = fakeApp(root);
  const fixture = fixtureRunner();
  const receipt = matchingReceipt(app.executablePath, fixture);

  const wrongPlatform = validatePowerPointLiveAttestation(receipt, testOptions(app.appPath, fixture, "linux"));
  assert.ok(wrongPlatform.errors.some((error) => error.code === "POWERPOINT_PLATFORM"));
  assert.equal(fixture.calls.length, 0, "platform failure must happen before inspecting fixtures");

  const missingFixture = fixtureRunner();
  const missing = validatePowerPointLiveAttestation(receipt, testOptions(path.join(root, "Missing.app"), missingFixture));
  assert.ok(missing.errors.some((error) => error.code === "POWERPOINT_APP_MISSING"));
  assert.equal(missingFixture.calls.length, 0);

  const identityFixture = fixtureRunner({ plist: { CFBundleIdentifier: "example.fake.PowerPoint" } });
  const identityReceipt = matchingReceipt(app.executablePath, identityFixture);
  const identity = validatePowerPointLiveAttestation(identityReceipt, testOptions(app.appPath, identityFixture));
  assert.ok(identity.errors.some((error) => error.code === "POWERPOINT_APP_IDENTITY"));

  const signatureFixture = fixtureRunner({ signature: { teamIdentifier: "NOTMICROSOFT" } });
  const signatureReceipt = matchingReceipt(app.executablePath, signatureFixture);
  const signature = validatePowerPointLiveAttestation(signatureReceipt, testOptions(app.appPath, signatureFixture));
  assert.ok(signature.errors.some((error) => error.code === "POWERPOINT_SIGNATURE_IDENTITY" && error.path.endsWith("teamIdentifier")));

  const failedCodesignFixture = fixtureRunner({ verifyFailure: true });
  const failedCodesignReceipt = matchingReceipt(app.executablePath, failedCodesignFixture);
  const failedCodesign = validatePowerPointLiveAttestation(failedCodesignReceipt, testOptions(app.appPath, failedCodesignFixture));
  assert.ok(failedCodesign.errors.some((error) => error.code === "POWERPOINT_LIVE_INSPECTION" && /code-signature verification failed/.test(error.message)));
});

test("production API rejects top-level fixture overrides", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deckformance-powerpoint-bypass-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = fakeApp(root);
  const fixture = fixtureRunner();
  const receipt = matchingReceipt(app.executablePath, fixture);

  const result = validatePowerPointLiveAttestation(receipt, {
    platform: "darwin",
    appPath: app.appPath,
    commandRunner: fixture.runner,
  });
  assert.equal(result.passed, false);
  assert.ok(result.errors.some((error) => error.code === "POWERPOINT_TEST_INJECTION_FORBIDDEN"));
  assert.equal(fixture.calls.length, 0, "forbidden overrides must never execute");
  assert.throws(
    () => assertPowerPointLiveAttestation(receipt, { testOnly: { enabled: false } }),
    (error) => error.code === "POWERPOINT_LIVE_ATTESTATION_FAILED" && error.errors[0].code === "POWERPOINT_TEST_INJECTION_FORBIDDEN",
  );
});
