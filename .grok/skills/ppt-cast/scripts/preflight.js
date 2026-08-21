#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { runDoctor } = require("./doctor");
const { STATUS_EXIT_CODE, SUPPORTED_RELEASES, classifyPreflight } = require("./runtime/release_gate");

function validatorCheck(validation) {
  if (!validation) {
    return {
      id: "release-contract",
      status: "fail",
      required: true,
      summary: "Release contract validation did not run",
      detail: {},
    };
  }
  return {
    id: "release-contract",
    status: validation.ok ? "pass" : "fail",
    required: true,
    summary: validation.ok ? `Job satisfies the ${validation.releaseLevel} release contract` : `Job does not satisfy the ${validation.releaseLevel} release contract`,
    detail: {
      stage: validation.stage || null,
      checkedThrough: validation.checkedThrough || null,
      errors: validation.errors || [],
      warnings: validation.warnings || [],
      currentHashes: validation.currentHashes || {},
    },
  };
}

function blockedNextAction(validation) {
  const errors = Array.isArray(validation && validation.errors) ? validation.errors : [];
  const missing = errors.find((error) => error && error.code === "MISSING_CONTRACT");
  if (missing) {
    return `Start with ${missing.path || "the first missing contract"}, then complete contracts in documented stage order before running release preflight again.`;
  }
  if (errors.some((error) => error && ["JOB_DIR", "JOB_CONTRACT"].includes(error.code))) {
    return "Initialize a v2 job shell first, then add the brief and advance contracts in documented stage order.";
  }
  return "Resolve every required failed check before attempting release.";
}

function loadValidation(jobDir, release, validator) {
  if (!fs.existsSync(jobDir) || !fs.statSync(jobDir).isDirectory()) {
    return {
      ok: false,
      releaseLevel: release,
      errors: [{ code: "JOB_DIR", path: jobDir, message: "job directory does not exist" }],
      warnings: [],
    };
  }
  const jobPath = path.join(jobDir, "job.json");
  if (!fs.existsSync(jobPath)) {
    return {
      ok: false,
      releaseLevel: release,
      errors: [{ code: "JOB_CONTRACT", path: "job.json", message: "job.json is required for release preflight" }],
      warnings: [],
    };
  }
  if (validator) return validator(jobDir, { releaseLevel: release });
  try {
    const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
    if (job.schemaVersion === "2.0.0" && job.artifactKind === "job-state") {
      const { validateJobV2 } = require("./validate_job_v2");
      const transient = structuredClone(job);
      try {
        if (release === "candidate" && ["packaged", "qa-passed"].includes(transient.state && transient.state.stage) && transient.release.candidate.status !== "released") {
          const { prepareCandidateRelease } = require("./jobctl_v2");
          prepareCandidateRelease(jobDir, transient);
        } else if (release === "final" && transient.state && transient.state.stage === "candidate-released" && transient.release.final.status !== "released") {
          const { prepareFinalRelease } = require("./jobctl_v2");
          prepareFinalRelease(jobDir, transient);
        }
      } catch (error) {
        return {
          ok: false,
          releaseLevel: release,
          errors: [{ code: "PRE_RELEASE_EVIDENCE", path: "job.release", message: error.message }],
          warnings: [],
        };
      }
      return validateJobV2(jobDir, { jobOverride: transient, releaseLevel: release });
    }
    if (job.schemaVersion === "1.0.0" && !Object.hasOwn(job, "artifactKind")) {
      const { validateJob } = require("./validate_job");
      return validateJob(jobDir, { releaseLevel: release });
    }
    return {
      ok: false,
      releaseLevel: release,
      errors: [{ code: "JOB_CONTRACT", path: "job.json", message: "unsupported job schemaVersion/artifactKind" }],
      warnings: [],
    };
  } catch (error) {
    return {
      ok: false,
      releaseLevel: release,
      errors: [{ code: "VALIDATOR_RUNTIME", path: "scripts/validate_job.js", message: error.message }],
      warnings: [],
    };
  }
}

async function runPreflight(options = {}) {
  const release = options.release || "candidate";
  if (!SUPPORTED_RELEASES.includes(release)) throw new Error("release must be candidate or final");
  const jobDir = path.resolve(options.jobDir || process.cwd());
  const doctorResult = options.doctorResult || await runDoctor({
    release,
    env: options.env,
    platform: options.platform,
    scriptsRoot: options.scriptsRoot || __dirname,
    skillRoot: options.skillRoot,
    rendererRegistry: options.rendererRegistry,
  });
  const validation = options.validationResult || loadValidation(jobDir, release, options.validator);
  const releaseCheck = validatorCheck(validation);
  const status = classifyPreflight(doctorResult, validation);
  return {
    schemaVersion: "2.0.0",
    command: "preflight",
    release,
    jobDir,
    status,
    exitCode: STATUS_EXIT_CODE[status],
    checkedAt: new Date().toISOString(),
    runtime: {
      status: doctorResult.status,
      receiptSha256: doctorResult.runtimeReceipt && doctorResult.runtimeReceipt.receiptSha256,
      checks: doctorResult.checks,
    },
    releaseContract: releaseCheck,
    nextAction: status === "ready"
      ? `Release tooling may attempt ${release}; publication still occurs only through jobctl release.`
      : status === "degraded"
        ? "Resolve warning capabilities before a fully reproducible run; no missing capability was substituted."
        : blockedNextAction(validation),
  };
}

function parseArgs(argv) {
  const options = { release: null, json: false, jobDir: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--release" || arg.startsWith("--release=")) {
      options.release = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++index];
    } else if (arg.startsWith("--")) throw new Error(`unknown option: ${arg}`);
    else if (options.jobDir) throw new Error("preflight accepts at most one job directory");
    else options.jobDir = arg;
  }
  if (!SUPPORTED_RELEASES.includes(options.release)) throw new Error("usage: preflight [job-dir] --release candidate|final [--json]");
  options.jobDir = options.jobDir || process.cwd();
  return options;
}

function printHuman(result) {
  console.log(`${result.status.toUpperCase()} preflight (${result.release}) ${result.jobDir}`);
  for (const check of [...result.runtime.checks, result.releaseContract]) {
    console.log(`- ${check.status.toUpperCase()} ${check.id}: ${check.summary}`);
  }
  console.log(result.nextAction);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(64);
  }
  const result = await runPreflight(options);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
  process.exit(result.exitCode);
}

module.exports = {
  blockedNextAction,
  classifyPreflight,
  loadValidation,
  parseArgs,
  runPreflight,
  validatorCheck,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  });
}
