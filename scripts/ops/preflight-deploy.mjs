#!/usr/bin/env node
/**
 * Pre-deployment identity check. Exits non-zero unless every check passes, so
 * nothing is pushed or deployed under the wrong account.
 *
 *   node scripts/ops/preflight-deploy.mjs staging|production
 *
 * Expected values live in deploy-identity.json. An unset value is a failure.
 * Reads local state only and changes nothing.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const FORBIDDEN = /omenai/i;
const BRANCH_FOR_TARGET = { staging: "staging", production: "main" };

const target = process.argv[2];
if (!BRANCH_FOR_TARGET[target]) {
  console.error("Usage: preflight-deploy.mjs staging|production");
  process.exit(2);
}

const expected = JSON.parse(
  readFileSync(process.env.DEPLOY_IDENTITY_FILE || new URL("./deploy-identity.json", import.meta.url), "utf8"),
);

function capture(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

const git = (...args) => capture("git", args);

function repoSlug(remote) {
  if (!remote) return null;
  return remote
    .replace(/\.git$/, "")
    .replace(/^https:\/\/[^/]*github\.com\//, "")
    .replace(/^(ssh:\/\/)?git@[^:/]+[:/]/, "");
}

const results = [];

function check(name, actual, wanted) {
  let problem = null;
  if (wanted === null || wanted === undefined || wanted === "") problem = "expected value is not set";
  else if (actual === null || actual === undefined) problem = "could not be determined";
  else if (FORBIDDEN.test(String(actual))) problem = "belongs to a different project";
  else if (actual !== wanted) problem = "does not match the expected value";
  results.push({ name, actual, problem });
}

check("GitHub repository", repoSlug(git("remote", "get-url", "origin")), expected.github_repo);
check("Repository commit email", git("config", "--local", "user.email"), expected.commit_email);
check("HEAD author email", git("log", "-1", "--format=%ae"), expected.commit_email);

for (const email of new Set((git("log", `origin/${BRANCH_FOR_TARGET[target]}..HEAD`, "--format=%ae") ?? "").split("\n").filter(Boolean))) {
  check("Unpushed commit email", email, expected.commit_email);
}

function checkAllowed(name, actual) {
  const problem = actual === null ? "could not be determined" : FORBIDDEN.test(actual) ? "belongs to a different project" : null;
  results.push({ name, actual, problem });
}

// The repository belongs to an organization, so access identifies the login.
checkAllowed("GitHub login", capture("gh", ["api", "user", "--jq", ".login"]));
check("GitHub push access", capture("gh", ["api", `repos/${expected.github_repo}`, "--jq", ".permissions.push"]), "true");
checkAllowed("Vercel login", capture("vercel", ["whoami"])?.split("\n").at(-1) ?? null);

const project = existsSync(".vercel/project.json") ? JSON.parse(readFileSync(".vercel/project.json", "utf8")) : {};
check("Vercel team", project.orgId ?? null, expected.vercel_team_id);
check("Vercel project", project.projectId ?? null, expected.vercel_project_id);
check("Deployment branch", git("branch", "--show-current"), BRANCH_FOR_TARGET[target]);

if (target === "production" && git("status", "--porcelain")) {
  results.push({ name: "Clean working tree", actual: "uncommitted changes", problem: "commit or stash them first" });
}

for (const { name, actual, problem } of results) {
  console.log(`${problem ? "FAIL" : "PASS"}  ${name}: ${actual ?? "(none)"}${problem ? ` (${problem})` : ""}`);
}

const failures = results.filter((result) => result.problem).length;
console.log(failures ? `\nREFUSED: ${failures} check(s) failed for ${target}.` : `\nOK to deploy to ${target}.`);
process.exit(failures ? 1 : 0);
