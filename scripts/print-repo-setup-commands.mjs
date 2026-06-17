#!/usr/bin/env node

const owner = process.argv[2];
const visibility = process.argv[3] ?? "private";
const repoName = process.argv[4] ?? "relay-button";

if (!owner) {
  console.error(
    "Usage: pnpm repo:setup:print -- <github-owner> [private|public] [repo-name]",
  );
  process.exit(1);
}

const repoSlug = `${owner}/${repoName}`;
const repoUrl = `git@github.com:${repoSlug}.git`;
const repoPath = "/Users/nandi/Documents/projekte/DecentraSol/shared-aleph-tooling";

const lines = [
  `# GitHub CLI create-and-push`,
  `cd ${repoPath}`,
  `gh repo create ${repoSlug} --${visibility} --source=. --remote=origin --push`,
  ``,
  `# GitHub UI create, then connect local repo`,
  `cd ${repoPath}`,
  `git remote add origin ${repoUrl}`,
  `git push -u origin main`,
  ``,
  `# Recommended first verification after push`,
  `cd ${repoPath}`,
  `git status`,
  `pnpm test`,
  `pnpm docs:build`,
  `pnpm release:preview`,
];

process.stdout.write(`${lines.join("\n")}\n`);
