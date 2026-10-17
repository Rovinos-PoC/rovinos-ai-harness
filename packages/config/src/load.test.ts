// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { HarnessError, ServerConfigSchema, type ServerConfig } from "@harness/schemas";
import { ConfigError, formatConfigIssues, loadConfig } from "./index.js";

const validYaml = `run:
  budgets:
    maxSteps: 12
store: {}
models: {}
policy: {}
pii: {}
telemetry: {}
sandbox: {}
`;
const webhookPolicyYaml = validYaml.replace(
  "policy: {}",
  `policy:
  approvals:
    notifier:
      kind: webhook
      url: https://hooks.example.test/approval
      secretRef: env:APPROVAL_WEBHOOK_TOKEN
      timeoutMs: 5000`,
);
const validJson = JSON.stringify({
  run: { budgets: { maxSteps: 12 } },
  store: {},
  models: {},
  policy: {},
  pii: {},
  telemetry: {},
  sandbox: {},
});

function reader(contents: string): (path: string) => Promise<string> {
  return () => Promise.resolve(contents);
}

function missingFile(): Error {
  return Object.assign(new Error("not found"), { code: "ENOENT" });
}

function requireConfigError(error: unknown): ConfigError {
  expect(error).toBeInstanceOf(ConfigError);
  if (!(error instanceof ConfigError)) {
    throw new Error("Expected ConfigError.");
  }
  return error;
}

async function expectConfigError(action: Promise<unknown>): Promise<ConfigError> {
  try {
    await action;
  } catch (error) {
    return requireConfigError(error);
  }
  throw new Error("Expected configuration loading to fail.");
}

describe("loadConfig", () => {
  it("loads a YAML file and applies schema defaults", async () => {
    const config = await loadConfig({ env: {}, readFile: reader(validYaml) });

    expect(config.run.budgets).toEqual({
      maxSteps: 12,
      maxWallClockMs: 3_600_000,
      countSuspendedTime: false,
    });
    expect(config.servers).toEqual([]);
    expect(config.roles).toEqual([]);
  });

  it("loads JSON files", async () => {
    const contents = validJson.replace('"maxSteps":12', '"maxSteps":17');
    const config = await loadConfig({
      configPath: "harness.config.json",
      env: {},
      readFile: reader(contents),
    });

    expect(config.run.budgets.maxSteps).toBe(17);
  });

  it("loads key versions as secret references", async () => {
    const contents = `${validYaml}keys:
  currentKeyId: primary
  keys:
    - id: primary
      secret: env:HARNESS_PRIMARY_KEY
`;
    const config = await loadConfig({ env: {}, readFile: reader(contents) });

    expect(config.keys).toEqual({
      currentKeyId: "primary",
      keys: [{ id: "primary", secret: "env:HARNESS_PRIMARY_KEY" }],
    });
  });

  it("reports a missing current key at the config path", async () => {
    const contents = `${validYaml}keys:
  currentKeyId: missing
  keys:
    - id: previous
      secret: env:HARNESS_PREVIOUS_KEY
`;
    const error = await expectConfigError(loadConfig({ env: {}, readFile: reader(contents) }));

    expect(error.issues).toContain(
      "keys.currentKeyId: a valid configuration value (key_current_missing)",
    );
  });

  it("lets an environment override take precedence over the file", async () => {
    const config = await loadConfig({
      env: { HARNESS__RUN__BUDGETS__MAXSTEPS: "50" },
      readFile: reader(validYaml),
    });

    expect(config.run.budgets.maxSteps).toBe(50);
  });

  it("applies nested overrides and coerces numeric environment values", async () => {
    const config = await loadConfig({
      env: {
        HARNESS__RUN__BUDGETS__MAX_WALL_CLOCK_MS: "60000",
        HARNESS__RUN__BUDGETS__MAX_COST_USD: "2.5",
      },
      readFile: reader(validYaml),
    });

    expect(config.run.budgets).toEqual({
      maxSteps: 12,
      maxCostUsd: 2.5,
      maxWallClockMs: 60_000,
      countSuspendedTime: false,
    });
  });

  it("resolves each environment segment against schema keys", async () => {
    const config = await loadConfig({
      env: {
        HARNESS__RUN__BUDGETS__MAXSTEPS: "50",
        HARNESS__RUN__BUDGETS__MAXWALLCLOCKMS: "1000",
        HARNESS__RUN__BUDGETS__MAXCOSTUSD: "2.5",
      },
      readFile: reader(validYaml),
    });

    expect(config.run.budgets).toEqual({
      maxSteps: 50,
      maxCostUsd: 2.5,
      maxWallClockMs: 1000,
      countSuspendedTime: false,
    });
  });

  it.each([
    [
      "URL",
      "https://hooks.example.test/overridden",
      {
        kind: "webhook",
        url: "https://hooks.example.test/overridden",
        secretRef: "env:APPROVAL_WEBHOOK_TOKEN",
        timeoutMs: 5000,
      },
    ],
    [
      "secretRef",
      "env:OTHER_APPROVAL_WEBHOOK_TOKEN",
      {
        kind: "webhook",
        url: "https://hooks.example.test/approval",
        secretRef: "env:OTHER_APPROVAL_WEBHOOK_TOKEN",
        timeoutMs: 5000,
      },
    ],
    [
      "timeoutMs",
      "2500",
      {
        kind: "webhook",
        url: "https://hooks.example.test/approval",
        secretRef: "env:APPROVAL_WEBHOOK_TOKEN",
        timeoutMs: 2500,
      },
    ],
  ])("applies the notifier %s environment override", async (field, value, expected) => {
    const config = await loadConfig({
      env: { [`HARNESS__POLICY__APPROVALS__NOTIFIER__${field}`]: value },
      readFile: reader(webhookPolicyYaml),
    });

    expect(config.policy.approvals?.notifier).toEqual(expected);
  });

  it("uses the notifier kind from the same environment override set", async () => {
    const config = await loadConfig({
      env: {
        HARNESS__POLICY__APPROVALS__NOTIFIER__URL: "https://hooks.example.test/approval",
        HARNESS__POLICY__APPROVALS__NOTIFIER__secretRef: "env:APPROVAL_WEBHOOK_TOKEN",
        HARNESS__POLICY__APPROVALS__NOTIFIER__timeoutMs: "5000",
        HARNESS__POLICY__APPROVALS__NOTIFIER__KIND: "webhook",
      },
      readFile: reader(validYaml),
    });

    expect(config.policy.approvals?.notifier).toEqual({
      kind: "webhook",
      url: "https://hooks.example.test/approval",
      secretRef: "env:APPROVAL_WEBHOOK_TOKEN",
      timeoutMs: 5000,
    });
  });

  it("rejects unknown notifier environment paths", async () => {
    const error = await expectConfigError(
      loadConfig({
        env: { HARNESS__POLICY__APPROVALS__NOTIFIER__UNKNOWN: "private-value" },
        readFile: reader(webhookPolicyYaml),
      }),
    );

    expect(error.issues[0]).toContain(
      "HARNESS__POLICY__APPROVALS__NOTIFIER__UNKNOWN: unknown, ambiguous, or unsupported configuration path (config_env_invalid)",
    );
    expect(error.message).not.toContain("private-value");
  });

  it.each([
    ["true", true],
    ["false", false],
  ])("coerces the suspended-time environment override %s", async (value, expected) => {
    const config = await loadConfig({
      env: { HARNESS__RUN__BUDGETS__COUNT_SUSPENDED_TIME: value },
      readFile: reader(validYaml),
    });

    expect(config.run.budgets.countSuspendedTime).toBe(expected);
  });

  it("rejects unknown environment segments with the variable path only", async () => {
    const error = await expectConfigError(
      loadConfig({
        env: { HARNESS__RUN__BUDGETS__INVALID: "private-value" },
        readFile: reader(validYaml),
      }),
    );

    expect(error.issues[0]).toContain(
      "HARNESS__RUN__BUDGETS__INVALID: unknown, ambiguous, or unsupported configuration path (config_env_invalid)",
    );
    expect(error.message).not.toContain("private-value");
  });

  it("rejects unknown config keys", async () => {
    const error = await expectConfigError(
      loadConfig({
        env: {},
        readFile: reader(validYaml.replace("store: {}", 'store:\n  privateKey: "not-a-secret"')),
      }),
    );

    expect(error).toBeInstanceOf(HarnessError);
    expect(error.code).toBe("config_invalid");
    expect(error.issues).toContain('store: unknown key "privateKey" (unrecognized_keys)');
    expect(error.message).not.toContain("not-a-secret");
  });

  it.each([["API", "KEY"].join(""), ["my", "api", "key"].join(""), ["client", "secret"].join("")])(
    "rejects inline secrets under concatenated key %s",
    async (key) => {
      const error = await expectConfigError(
        loadConfig({
          env: {},
          readFile: reader(validYaml.replace("store: {}", `store:\n  ${key}: "inline-secret"`)),
        }),
      );

      expect(error.issues).toContain(`store.${key}: a SecretRef (secret_inline)`);
      expect(error.message).not.toContain("inline-secret");
    },
  );

  it("reports trace propagation error codes through the config loader", async () => {
    const contents = validYaml.replace(
      "store: {}",
      `servers:
  - id: external
    transport:
      kind: stdio
      command: node
    propagateTrace: true
store: {}`,
    );
    const error = await expectConfigError(loadConfig({ env: {}, readFile: reader(contents) }));

    expect(error.issues).toContain(
      "servers.0.propagateTrace: a valid configuration value (propagate_requires_internal)",
    );
  });

  it("reports multiple invalid paths in one error", async () => {
    const contents = validYaml
      .replace("maxSteps: 12", "maxSteps: 0")
      .replace("maxSteps: 0", "maxSteps: 0\n    maxWallClockMs: -1");
    const error = await expectConfigError(loadConfig({ env: {}, readFile: reader(contents) }));

    expect(error.issues).toHaveLength(2);
    expect(error.issues).toContain("run.budgets.maxSteps: greater than 0 (too_small)");
    expect(error.issues).toContain("run.budgets.maxWallClockMs: greater than 0 (too_small)");
  });

  it("never includes a submitted value in validation errors", async () => {
    const error = await expectConfigError(
      loadConfig({
        env: { HARNESS__RUN__BUDGETS__MAXSTEPS: "submitted-private-value" },
        readFile: reader(validYaml),
      }),
    );

    expect(error.message).toContain("run.budgets.maxSteps");
    expect(error.message).not.toContain("submitted-private-value");
  });

  it("preserves stable PII policy codes without exposing submitted values", async () => {
    const contents = validYaml.replace(
      "pii: {}",
      `pii:
  rules:
    - entities: [email]
      boundaries: [storage]
      destinations:
        - tool: private-destination
      action: allow`,
    );
    const error = await expectConfigError(loadConfig({ env: {}, readFile: reader(contents) }));

    expect(error.issues).toContain(
      "pii.rules.0.boundaries: a valid configuration value (pii_policy_storage_allow)",
    );
    expect(error.message).not.toContain("private-destination");
  });

  it("deeply freezes the returned config", async () => {
    const config = await loadConfig({
      env: {},
      readFile: reader(validYaml),
    });

    expect(() => {
      config.run.budgets.maxSteps = 13;
    }).toThrow(TypeError);
    expect(() => {
      const server: ServerConfig = ServerConfigSchema.parse({
        id: "frozen",
        transport: { kind: "stdio", command: "node" },
      });
      config.servers.push(server);
    }).toThrow(TypeError);
  });

  it("discovers the config path in precedence order", async () => {
    const paths: string[] = [];
    const read = (path: string): Promise<string> => {
      paths.push(path);
      return Promise.resolve(path.endsWith(".json") ? validJson : validYaml);
    };
    const cwd = "/workspace";

    await loadConfig({
      configPath: "explicit.yaml",
      cwd,
      env: { HARNESS_CONFIG: "environment.json" },
      readFile: read,
    });
    await loadConfig({
      cwd,
      env: { HARNESS_CONFIG: "environment.json" },
      readFile: read,
    });
    await loadConfig({ cwd, env: {}, readFile: read });

    expect(paths).toEqual([
      "/workspace/explicit.yaml",
      "/workspace/environment.json",
      "/workspace/harness.config.yaml",
    ]);
  });

  it("rejects an attempt to override an array with environment variables", async () => {
    const error = await expectConfigError(
      loadConfig({
        env: { HARNESS__SERVERS__0__ENDPOINT: "private-value" },
        readFile: reader(validYaml),
      }),
    );

    expect(error.message).toContain("HARNESS__SERVERS__0__ENDPOINT");
    expect(error.message).not.toContain("private-value");
  });

  it("does not expose file-reader errors", async () => {
    const error = await expectConfigError(
      loadConfig({
        env: {},
        readFile: () => Promise.reject(new Error("private filesystem path")),
      }),
    );

    expect(error.issues).toEqual([
      "configuration: readable YAML or JSON config file (config_file_unavailable)",
    ]);
    expect(error.message).not.toContain("private filesystem path");
  });

  it("formats varied Zod issues without including received values", () => {
    const results = [
      z.string().safeParse(null),
      z.number().min(2).safeParse(1),
      z.number().max(2).safeParse(3),
      z.strictObject({}).safeParse({ submittedValue: "private-value" }),
      z.enum(["expected"]).safeParse("private-value"),
      z.email().safeParse("private-value"),
      z.union([z.literal("expected"), z.number()]).safeParse(true),
    ];
    const issues = results.flatMap((result) =>
      result.success ? [] : formatConfigIssues(result.error.issues),
    );
    const text = issues.join("\n");

    expect(issues).toHaveLength(7);
    expect(text).toContain("expected string (invalid_type)");
    expect(text).toContain("at least 2 (too_small)");
    expect(text).toContain("at most 2 (too_big)");
    expect(text).toContain('unknown key "submittedValue" (unrecognized_keys)');
    expect(text).toContain("an allowed value (invalid_value)");
    expect(text).toContain("a valid format (invalid_format)");
    expect(text).toContain("a valid configuration value (invalid_union)");
    expect(text).not.toContain("private-value");
  });

  it("sanitizes YAML parse errors", async () => {
    const error = await expectConfigError(
      loadConfig({
        env: {},
        readFile: reader("run: [private-value"),
      }),
    );

    expect(error.message).toContain("valid YAML or JSON (invalid_yaml)");
    expect(error.message).not.toContain("private-value");
  });

  it("rejects cyclic YAML aliases with a sanitized ConfigError", async () => {
    const error = await expectConfigError(
      loadConfig({
        env: {},
        readFile: reader("self: &self\n  child: *self\n"),
      }),
    );

    expect(error.code).toBe("config_invalid");
    expect(error.issues).toContain("self.child: acyclic configuration value (config_cycle)");
    expect(error.message).not.toContain("RangeError");
  });

  it("rejects malformed environment paths without echoing them", async () => {
    const error = await expectConfigError(
      loadConfig({
        env: { HARNESS__RUN____MAXSTEPS: "private-value" },
        readFile: reader(validYaml),
      }),
    );

    expect(error.message).toContain("config_env_invalid");
    expect(error.message).toContain("HARNESS__RUN____MAXSTEPS");
    expect(error.message).not.toContain("private-value");
  });

  it("loads defaults when the default config file is missing", async () => {
    const config = await loadConfig({
      env: {},
      readFile: () => Promise.reject(missingFile()),
    });

    expect(config).toEqual({
      controlPlane: { allowReveal: false },
      run: {
        checkpointEveryEvents: 20,
        shutdownGraceMs: 20_000,
        continuations: {
          allowFromFailed: false,
          maxChainLength: 50,
          inheritBudgets: false,
        },
        resume: { onNonIdempotent: "escalate" },
        budgets: { maxSteps: 200, maxWallClockMs: 3_600_000, countSuspendedTime: false },
        subagents: { maxDepth: 4, maxChildrenPerRun: 8, maxConcurrentChildren: 2 },
      },
      roles: [],
      store: {},
      models: {
        enforcement: { maxRepairs: 2 },
        retry: {
          maxAttempts: 3,
          baseDelayMs: 500,
          maxDelayMs: 20_000,
          timeoutMs: 120_000,
        },
        maxConcurrent: 4,
        pricing: {},
        providers: [],
        routing: {
          default: [],
          roles: {},
          fallbackOn: [
            "provider_rate_limited",
            "provider_timeout",
            "provider_unavailable",
            "model_output_invalid",
          ],
        },
      },
      servers: [],
      policy: {},
      pii: { defaultAction: "tokenize", rules: [], enabled: true },
      vault: { backend: "sqlite", purgeAfterDays: 7 },
      telemetry: { sentinel: { minValueLength: 6 } },
      sandbox: {},
    });
  });

  it("applies environment overrides when the default config file is missing", async () => {
    const config = await loadConfig({
      env: { HARNESS__RUN__BUDGETS__MAXSTEPS: "50" },
      readFile: () => Promise.reject(missingFile()),
    });

    expect(config.run.budgets).toEqual({
      maxSteps: 50,
      maxWallClockMs: 3_600_000,
      countSuspendedTime: false,
    });
  });

  it("requires an explicitly selected config file to exist", async () => {
    const error = await expectConfigError(
      loadConfig({
        configPath: "required.yaml",
        env: {},
        readFile: () => Promise.reject(missingFile()),
      }),
    );

    expect(error.issues).toEqual([
      "configuration: readable YAML or JSON config file (config_file_unavailable)",
    ]);
  });

  it("loads an empty file as the default configuration", async () => {
    const config = await loadConfig({
      env: {},
      readFile: reader("{}"),
    });

    expect(config.run.budgets).toEqual({
      maxSteps: 200,
      maxWallClockMs: 3_600_000,
      countSuspendedTime: false,
    });
    expect(config.servers).toEqual([]);
  });
});
