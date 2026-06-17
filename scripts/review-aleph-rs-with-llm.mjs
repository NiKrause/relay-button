import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const LOCAL_FILES = {
  uiController: "packages/ui/src/shared/controller.ts",
  coreForget: "packages/core/src/forget.ts",
  coreRetention: "packages/core/src/retention.ts",
  coreRuntime: "packages/core/src/runtime.ts",
  browserApi: "packages/browser/src/aleph-api.ts",
  rootfsBuild: "packages/rootfs/reference/orbitdb-relay-pinner/rootfs/build-rootfs.sh",
};

const UPSTREAM_FILES = {
  readme: "README.md",
  cli: "crates/aleph-cli/src/cli.rs",
  instanceCommand: "crates/aleph-cli/src/commands/instance.rs",
  fileCommand: "crates/aleph-cli/src/commands/file.rs",
  messageCommand: "crates/aleph-cli/src/commands/message.rs",
  crnSdk: "crates/aleph-sdk/src/crn.rs",
};

function ensureEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

async function readText(filePath) {
  return await readFile(filePath, "utf8");
}

function cleanJsonFence(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

function parseModelJson(text) {
  const cleaned = cleanJsonFence(text);
  return JSON.parse(cleaned);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function findPatternLineNumbers(source, patterns) {
  const lines = source.split("\n");
  const matches = [];
  lines.forEach((line, index) => {
    if (patterns.some((pattern) => pattern.test(line))) {
      matches.push(index + 1);
    }
  });
  return unique(matches).sort((a, b) => a - b);
}

function sliceByLineRange(lines, startLine, endLine) {
  return lines
    .slice(Math.max(0, startLine - 1), Math.min(lines.length, endLine))
    .map((line, index) => `${String(startLine + index).padStart(4, " ")}: ${line}`)
    .join("\n");
}

function extractRelevantSnippet(fileLabel, source, patterns, context = 16, maxSections = 4) {
  const lines = source.split("\n");
  const lineNumbers = findPatternLineNumbers(source, patterns).slice(0, maxSections);

  if (lineNumbers.length === 0) {
    return `### ${fileLabel}\n\n_No relevant match found for requested patterns._`;
  }

  const ranges = [];
  for (const lineNumber of lineNumbers) {
    const start = Math.max(1, lineNumber - context);
    const end = Math.min(lines.length, lineNumber + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  const body = ranges
    .map((range) => sliceByLineRange(lines, range.start, range.end))
    .join("\n...\n");

  return `### ${fileLabel}\n\n\`\`\`ts\n${body}\n\`\`\``;
}

function extractRelevantContext(labelToSource, isUpstream = false) {
  const config = [
    {
      key: isUpstream ? "readme" : "browserApi",
      patterns: [/api\.aleph\.im/i, /api2\.aleph\.im/i, /scheduler\.api/i, /messages/i],
    },
    {
      key: isUpstream ? "cli" : "uiController",
      patterns: [/instance erase/i, /instance delete/i, /forget/i, /deleteInstance/i, /FORGET/],
    },
    {
      key: isUpstream ? "instanceCommand" : "coreRetention",
      patterns: [/erase/i, /delete/i, /forget/i, /instance/i, /control\/machine/i],
    },
    {
      key: isUpstream ? "fileCommand" : "coreForget",
      patterns: [/file delete/i, /STORE/i, /forget/i, /hashes/i],
    },
    {
      key: isUpstream ? "messageCommand" : "coreRuntime",
      patterns: [/aggregates/i, /hashes/i, /about\/executions\/list/i, /v2\/about\/executions\/list/i],
    },
    {
      key: isUpstream ? "crnSdk" : "rootfsBuild",
      patterns: [/control\/machine/i, /X-SignedOperation/i, /aleph-client/i, /install aleph-client/i],
    },
  ];

  return config
    .filter(({ key }) => labelToSource[key])
    .map(({ key, patterns }) =>
      extractRelevantSnippet(key, labelToSource[key], patterns, 18, 5),
    )
    .join("\n\n");
}

function buildPrompt(localContext, upstreamContext) {
  return [
    "You are reviewing drift between a local repository named relay-button and upstream aleph-rs.",
    "Focus on Aleph API behavior, instance lifecycle operations, file/store deletion behavior, runtime lookup endpoints, and any remaining Python-client assumptions.",
    "Be strict and concrete. Do not speculate beyond the provided evidence.",
    "Important: if upstream requires a CRN erase before a FORGET, and local code only issues FORGET, that is a high-severity mismatch.",
    "Return only valid JSON with this exact shape:",
    "{",
    '  "verdict": "aligned" | "drifted" | "uncertain",',
    '  "summary": "short paragraph",',
    '  "findings": [',
    "    {",
    '      "severity": "high" | "medium" | "low",',
    '      "title": "short title",',
    '      "details": "1-3 sentences grounded in evidence",',
    '      "local_refs": ["path:line", "..."],',
    '      "upstream_refs": ["path:line", "..."],',
    '      "impact": "why it matters operationally",',
    '      "recommendation": "specific next step"',
    "    }",
    "  ],",
    '  "suggested_issue_title": "title for GitHub issue",',
    '  "suggested_issue_labels": ["automation", "aleph"],',
    '  "recommended_followups": ["task 1", "task 2"]',
    "}",
    "",
    "Local evidence:",
    localContext,
    "",
    "Upstream evidence:",
    upstreamContext,
  ].join("\n");
}

async function callOpenAICompatible({ baseUrl, apiKey, model, prompt }) {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const url = new URL(
    normalizedBaseUrl.endsWith("/v1")
      ? `${normalizedBaseUrl}/chat/completions`
      : `${normalizedBaseUrl}/chat/completions`,
  );
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a careful code-review agent. Return only strict JSON matching the user's requested schema.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`LLM request failed: HTTP ${response.status} ${text}`);
  }

  const payload = JSON.parse(text);
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("LLM response did not include message content.");
  }

  return content;
}

function renderMarkdownReport(review) {
  const findings = Array.isArray(review.findings) ? review.findings : [];
  const followups = Array.isArray(review.recommended_followups)
    ? review.recommended_followups
    : [];

  const lines = [
    "# Aleph LLM Drift Review",
    "",
    `Generated at: ${new Date().toISOString()}`,
    "",
    `Verdict: **${review.verdict ?? "uncertain"}**`,
    "",
    review.summary ?? "No summary returned.",
    "",
    "## Findings",
    "",
  ];

  if (findings.length === 0) {
    lines.push("- No findings returned.");
  } else {
    for (const finding of findings) {
      lines.push(
        `- [${String(finding.severity ?? "low").toUpperCase()}] ${finding.title ?? "Untitled finding"}`,
      );
      lines.push(`  ${finding.details ?? ""}`);
      if (Array.isArray(finding.local_refs) && finding.local_refs.length > 0) {
        lines.push(`  Local: ${finding.local_refs.join(", ")}`);
      }
      if (Array.isArray(finding.upstream_refs) && finding.upstream_refs.length > 0) {
        lines.push(`  Upstream: ${finding.upstream_refs.join(", ")}`);
      }
      if (finding.impact) {
        lines.push(`  Impact: ${finding.impact}`);
      }
      if (finding.recommendation) {
        lines.push(`  Recommendation: ${finding.recommendation}`);
      }
      lines.push("");
    }
  }

  lines.push("## Recommended Follow-Ups", "");
  if (followups.length === 0) {
    lines.push("- None returned.");
  } else {
    for (const followup of followups) {
      lines.push(`- ${followup}`);
    }
  }

  return lines.join("\n");
}

async function main() {
  const upstreamRoot = ensureEnv("ALEPH_RS_DIR");
  const apiKey = ensureEnv("OPENAI_COMPAT_API_KEY");
  const baseUrl = ensureEnv("OPENAI_COMPAT_BASE_URL");
  const model = ensureEnv("OPENAI_COMPAT_MODEL");

  const localEntries = await Promise.all(
    Object.entries(LOCAL_FILES).map(async ([key, relativePath]) => [
      key,
      await readText(path.join(repoRoot, relativePath)),
    ]),
  );
  const upstreamEntries = await Promise.all(
    Object.entries(UPSTREAM_FILES).map(async ([key, relativePath]) => [
      key,
      await readText(path.join(upstreamRoot, relativePath)),
    ]),
  );

  const localSources = Object.fromEntries(localEntries);
  const upstreamSources = Object.fromEntries(upstreamEntries);

  const prompt = buildPrompt(
    extractRelevantContext(localSources, false),
    extractRelevantContext(upstreamSources, true),
  );

  const raw = await callOpenAICompatible({
    baseUrl,
    apiKey,
    model,
    prompt,
  });
  const review = parseModelJson(raw);
  const report = renderMarkdownReport(review);

  if (process.env.REPORT_PATH) {
    await writeFile(process.env.REPORT_PATH, report);
  }
  if (process.env.JSON_PATH) {
    await writeFile(process.env.JSON_PATH, JSON.stringify(review, null, 2));
  }

  console.log(report);

  if (String(review.verdict).toLowerCase() === "drifted") {
    process.exitCode = 1;
  }
}

await main();
