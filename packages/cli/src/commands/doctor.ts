// SPDX-License-Identifier: Apache-2.0
import {
  CompositeSecretResolver,
  EnvSecretResolver,
  FileSecretResolver,
  getConfigSecretRefs,
  type HarnessConfig,
} from "@harness/config";
import {
  createServersAuthorizedCheck,
  createServersReachableChecks,
  OAuthTokenStore,
  type McpConnectionDependencies,
} from "@harness/mcp";
import { createPresidioReachableCheck } from "@harness/pii";
import {
  Code,
  DoctorResultsSchema,
  HarnessError,
  type DoctorCheckResult,
  type SecretRef,
} from "@harness/schemas";
import { LocalKeyProvider, LocalKeyProviderError } from "@harness/vault";
import type { DoctorCheck, DoctorContext, RuntimeConfig } from "@harness/core";
import type * as Core from "@harness/core";
import type { Command } from "commander";
import { join } from "node:path";
import type { CliContext, CommandModule } from "../command.js";

class DoctorChecksFailedError extends HarnessError {
  override readonly code = "doctor_failed";

  constructor() {
    super("One or more doctor checks failed.");
  }
}

function keysConfiguredCheck(
  config: RuntimeConfig | undefined,
  env: Readonly<Record<string, string | undefined>>,
): DoctorCheck {
  return {
    id: "keys_configured",
    title: "Encryption keys",
    run: async (ctx) => {
      if (config === undefined) {
        return { status: "ok", code: "keys_configured" };
      }
      if (config.keys === undefined) {
        return env.NODE_ENV === "production"
          ? { status: "fail", code: "key_config_required" }
          : { status: "warn", code: "keys_ephemeral" };
      }
      const provider = new LocalKeyProvider({
        config: config.keys,
        secretResolver: new CompositeSecretResolver({
          env: new EnvSecretResolver(env),
          file: new FileSecretResolver(),
        }),
        env,
        onWarning: () => undefined,
      });
      try {
        for (const { id } of config.keys.keys) {
          if (ctx.signal?.aborted === true) {
            return { status: "fail", code: "check_timeout" };
          }
          try {
            await provider.getKey(id);
          } catch (error) {
            const parsedCode =
              error instanceof LocalKeyProviderError ? Code.safeParse(error.code) : undefined;
            return {
              status: "fail",
              code: parsedCode?.success === true ? parsedCode.data : "key_secret_unavailable",
              detail: Code.parse(id),
            };
          }
        }
        return { status: "ok", code: "keys_configured" };
      } finally {
        provider.dispose();
      }
    },
  };
}

/**
 * Creates the `harness doctor` command.
 *
 * @param checks - Optional check list used by command tests or embedding callers.
 * @returns A command module that validates configuration and reports safe diagnostics.
 */
export function createDoctorCommand(checks?: readonly DoctorCheck[]): CommandModule {
  return {
    name: "doctor",
    register(program, context) {
      program
        .command("doctor")
        .description("Check the local harness environment")
        .action(() => runDoctor(program, context, checks));
    },
  };
}

interface LoadedDoctorConfig {
  readonly config: HarnessConfig | undefined;
  readonly configErrorCode: string | undefined;
}

async function loadDoctorConfig(context: CliContext): Promise<LoadedDoctorConfig> {
  try {
    return { config: await context.loadConfig(), configErrorCode: undefined };
  } catch (error) {
    const configErrorCode = error instanceof HarnessError ? Code.safeParse(error.code) : undefined;
    return {
      config: undefined,
      configErrorCode: configErrorCode?.success === true ? configErrorCode.data : undefined,
    };
  }
}

interface DoctorContextOptions {
  readonly config: HarnessConfig | undefined;
  readonly configErrorCode: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly dataDir: string;
  readonly envResolver: EnvSecretResolver;
}

function createDoctorContext(options: DoctorContextOptions): DoctorContext {
  const { config, configErrorCode, env, dataDir, envResolver } = options;
  return {
    config,
    ...(configErrorCode === undefined ? {} : { configErrorCode }),
    secretRefs: config === undefined ? [] : getConfigSecretRefs(config),
    env,
    dataDir,
    resolveSecret: async (ref, signal) => {
      let fileWarning: "secret_file_permissions" | undefined;
      const resolver = new CompositeSecretResolver({
        env: envResolver,
        file: new FileSecretResolver({
          onWarning: (code) => {
            fileWarning = code;
          },
        }),
      });
      await resolver.resolve(ref, signal);
      return fileWarning;
    },
  };
}

async function openOAuthResources(
  config: HarnessConfig | undefined,
  secretResolver: CompositeSecretResolver,
  env: Readonly<Record<string, string | undefined>>,
  dataDir: string,
): Promise<{ readonly keys?: LocalKeyProvider; readonly store?: OAuthTokenStore }> {
  const hasOAuthServers = (config?.servers ?? []).some(
    (server) => server.transport.kind === "http" && server.transport.auth !== undefined,
  );
  if (!hasOAuthServers) {
    return {};
  }
  let keys: LocalKeyProvider | undefined;
  try {
    keys = new LocalKeyProvider({
      ...(config?.keys === undefined ? {} : { config: config.keys }),
      secretResolver: { resolve: (ref) => secretResolver.resolve(ref) },
      env,
      onWarning: () => undefined,
    });
    const store = await OAuthTokenStore.open(join(dataDir, "mcp-oauth.db"), keys);
    return { keys, store };
  } catch {
    keys?.dispose();
    return {};
  }
}

function createMcpDependencies(
  secretResolver: CompositeSecretResolver,
  env: Readonly<Record<string, string | undefined>>,
  store: OAuthTokenStore | undefined,
): McpConnectionDependencies {
  return {
    resolveSecret: async (ref: SecretRef, signal?: AbortSignal) =>
      (await secretResolver.resolve(ref, signal)).reveal(),
    env,
    ...(store === undefined ? {} : { oauthTokenStore: store }),
  };
}

function defaultDoctorChecks(
  core: typeof Core,
  config: HarnessConfig | undefined,
  env: Readonly<Record<string, string | undefined>>,
  dependencies: McpConnectionDependencies,
): DoctorCheck[] {
  const servers = config?.servers ?? [];
  return [
    ...core.doctorChecks(),
    keysConfiguredCheck(config, env),
    ...(config?.pii.presidio === undefined
      ? []
      : [createPresidioReachableCheck(config.pii.presidio)]),
    createServersAuthorizedCheck(servers, dependencies),
    ...createServersReachableChecks(servers, dependencies),
  ];
}

function printDoctorResults(
  program: Command,
  context: CliContext,
  results: DoctorCheckResult[],
): void {
  if (program.opts<{ json?: boolean }>().json === true) {
    context.out.json(DoctorResultsSchema, results);
  } else {
    const rows: string[][] = [["id", "status", "code"]];
    for (const result of results) {
      rows.push([result.id, result.status, result.code]);
    }
    context.out.table(rows);
  }
}

async function runDoctor(
  program: Command,
  context: CliContext,
  checks: readonly DoctorCheck[] | undefined,
): Promise<void> {
  const { config, configErrorCode } = await loadDoctorConfig(context);
  const env = process.env;
  const core = await import("@harness/core");
  const envResolver = new EnvSecretResolver(env);
  const secretResolver = new CompositeSecretResolver({
    env: envResolver,
    file: new FileSecretResolver(),
  });
  const doctorContext = createDoctorContext({
    config,
    configErrorCode,
    env,
    dataDir: core.resolveDataDir(env),
    envResolver,
  });
  const resources = await openOAuthResources(config, secretResolver, env, doctorContext.dataDir);
  try {
    const dependencies = createMcpDependencies(secretResolver, env, resources.store);
    const defaultChecks = defaultDoctorChecks(core, config, env, dependencies);
    const results = await core.runDoctor(doctorContext, checks ?? defaultChecks);
    printDoctorResults(program, context, results);
    if (results.some(({ status }) => status === "fail")) {
      throw new DoctorChecksFailedError();
    }
  } finally {
    resources.store?.close();
    resources.keys?.dispose();
  }
}

/** The default command registered by the CLI. */
export const doctorCommand = createDoctorCommand();
