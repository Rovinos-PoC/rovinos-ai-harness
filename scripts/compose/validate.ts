// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseJson, RunConfigSchema } from "@harness/schemas";
import { z } from "zod";

const composeConfigSchema = z.object({
  networks: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  services: z.record(z.string(), z.record(z.string(), z.unknown())),
});

type ComposeConfig = z.infer<typeof composeConfigSchema>;
type ComposeProfile = "dev" | "test" | "prod-like";

const root = fileURLToPath(new URL("../../", import.meta.url));
const profiles: readonly ComposeProfile[] = ["dev", "test", "prod-like"];
const profileFiles: Readonly<Record<ComposeProfile, readonly string[]>> = {
  dev: ["infra/compose/docker-compose.yml", "infra/compose/docker-compose.dev.yml"],
  test: ["infra/compose/docker-compose.test.yml"],
  "prod-like": ["infra/compose/docker-compose.yml", "infra/compose/docker-compose.prod-like.yml"],
};
const minimumStopGracePeriodMs = RunConfigSchema.parse({}).shutdownGraceMs + 5_000;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function property(value: unknown, key: string): unknown {
  return isObjectRecord(value) ? value[key] : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function networkNames(service: Record<string, unknown>): string[] {
  const networks = service.networks;
  if (Array.isArray(networks)) {
    return stringList(networks);
  }
  if (typeof networks === "object" && networks !== null) {
    return Object.keys(networks);
  }
  return [];
}

function hasAllCapabilitiesDropped(service: Record<string, unknown>): boolean {
  return stringList(service.cap_drop).some((capability) => capability.toUpperCase() === "ALL");
}

function hasNoNewPrivileges(service: Record<string, unknown>): boolean {
  return stringList(service.security_opt).some((option) => option === "no-new-privileges:true");
}

function hasTmpfs(service: Record<string, unknown>): boolean {
  return stringList(service.tmpfs).length > 0;
}

function hasHealthcheck(service: Record<string, unknown>): boolean {
  const healthcheck = service.healthcheck;
  if (property(healthcheck, "disable") === true) {
    return false;
  }
  const test = property(healthcheck, "test");
  if (typeof test === "string") {
    return test.trim() !== "" && test.trim().toUpperCase() !== "NONE";
  }
  return (
    Array.isArray(test) &&
    test.length > 0 &&
    test.every((part) => typeof part === "string") &&
    (test[0]?.trim() ?? "") !== "" &&
    test[0]?.trim().toUpperCase() !== "NONE"
  );
}

function hasDockerSocketMount(service: Record<string, unknown>): boolean {
  if (!Array.isArray(service.volumes)) {
    return false;
  }
  return service.volumes.some((volume: unknown) => {
    if (typeof volume === "string") {
      return volume.toLowerCase().includes("docker.sock");
    }
    if (typeof volume === "object" && volume !== null && "source" in volume) {
      const source: unknown = volume.source;
      return typeof source === "string" && source.toLowerCase().includes("docker.sock");
    }
    return false;
  });
}

function hasLiteralSecretEnvironment(service: Record<string, unknown>): boolean {
  const environment = service.environment;
  if (typeof environment !== "object" || environment === null || Array.isArray(environment)) {
    return false;
  }
  return Object.entries(environment).some(([name, value]) => {
    const secretName =
      /secret|token|password|passwd|credential|api[_-]?key|private[_-]?key|access[_-]?key/iu.test(
        name,
      );
    if (!secretName || typeof value !== "string" || value === "") {
      return false;
    }
    return !name.endsWith("_FILE") || !value.startsWith("/run/secrets/");
  });
}

function hasCpuLimit(service: Record<string, unknown>): boolean {
  const cpus = service.cpus;
  const limits = property(property(service.deploy, "resources"), "limits");
  const deployCpus = property(limits, "cpus");
  return (
    (typeof cpus === "number" && cpus > 0) || (typeof deployCpus === "string" && deployCpus !== "")
  );
}

function hasMemoryLimit(service: Record<string, unknown>): boolean {
  const memory = service.mem_limit;
  const limits = property(property(service.deploy, "resources"), "limits");
  const deployMemory = property(limits, "memory");
  return (
    (typeof memory === "number" && memory > 0) ||
    (typeof memory === "string" && memory !== "") ||
    (typeof deployMemory === "string" && deployMemory !== "")
  );
}

function durationMilliseconds(duration: unknown): number | undefined {
  if (typeof duration !== "string") {
    return undefined;
  }
  const parts = [...duration.matchAll(/(\d+(?:\.\d+)?)(ms|[smh])/gu)];
  if (parts.length === 0 || parts.map((part) => part[0]).join("") !== duration) {
    return undefined;
  }
  const multipliers: Readonly<Record<string, number>> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
  };
  return parts.reduce((total, part) => {
    const amount = Number(part[1]);
    const unit = part[2];
    return total + amount * (unit === undefined ? 0 : (multipliers[unit] ?? 0));
  }, 0);
}

function networkViolations(
  name: string,
  service: Record<string, unknown>,
  profile: ComposeProfile,
  externallyReachableNetworks: ReadonlySet<string>,
): string[] {
  const violations: string[] = [];
  for (const network of networkNames(service)) {
    if (
      externallyReachableNetworks.has(network) &&
      name !== "otel-collector" &&
      name !== "sandbox-egress-proxy" &&
      !(profile === "test" && name === "postgres" && network === "test-host")
    ) {
      violations.push(`${name}: external_network`);
    }
  }
  return violations;
}

function hardeningViolations(name: string, service: Record<string, unknown>): string[] {
  const violations: string[] = [];
  if (!hasAllCapabilitiesDropped(service)) {
    violations.push(`${name}: cap_drop_all_missing`);
  }
  if (!hasNoNewPrivileges(service)) {
    violations.push(`${name}: no_new_privileges_missing`);
  }
  if (service.read_only !== true) {
    violations.push(`${name}: read_only_missing`);
  }
  if (!hasTmpfs(service)) {
    violations.push(`${name}: tmpfs_missing`);
  }
  return violations;
}

function productionViolations(name: string, service: Record<string, unknown>): string[] {
  const violations: string[] = [];
  if (!hasCpuLimit(service)) {
    violations.push(`${name}: cpu_limit_missing`);
  }
  if (!hasMemoryLimit(service)) {
    violations.push(`${name}: memory_limit_missing`);
  }
  if (service.restart !== "unless-stopped") {
    violations.push(`${name}: restart_policy_invalid`);
  }
  if (service.stop_signal !== "SIGTERM") {
    violations.push(`${name}: stop_signal_invalid`);
  }
  if ((durationMilliseconds(service.stop_grace_period) ?? 0) <= minimumStopGracePeriodMs) {
    violations.push(`${name}: stop_grace_period_too_short`);
  }
  return violations;
}

function serviceViolations(
  name: string,
  service: Record<string, unknown>,
  profile: ComposeProfile,
  externallyReachableNetworks: ReadonlySet<string>,
): string[] {
  const violations: string[] = [];
  if (name === "presidio-analyzer" && Array.isArray(service.ports) && service.ports.length > 0) {
    violations.push(`${name}: published_ports`);
  }
  if (service.privileged === true) {
    violations.push(`${name}: privileged`);
  }
  if (hasDockerSocketMount(service)) {
    violations.push(`${name}: docker_socket_mount`);
  }
  if (service.network_mode === "host") {
    violations.push(`${name}: host_network`);
  }
  if (name !== "otel-collector" && !hasHealthcheck(service)) {
    violations.push(`${name}: healthcheck_missing`);
  }
  if (name !== "otel-collector") {
    violations.push(...hardeningViolations(name, service));
  }
  if (hasLiteralSecretEnvironment(service)) {
    violations.push(`${name}: literal_secret_environment`);
  }
  violations.push(...networkViolations(name, service, profile, externallyReachableNetworks));
  if (profile === "prod-like") {
    violations.push(...productionViolations(name, service));
  }
  return violations;
}

/** Evaluates a rendered Compose config without invoking Docker. */
export function evaluateComposeSecurity(config: ComposeConfig, profile: ComposeProfile): string[] {
  const externallyReachableNetworks = new Set(
    Object.entries(config.networks)
      .filter(([, network]) => network.external === true || network.internal !== true)
      .map(([name]) => name),
  );
  return Object.entries(config.services).flatMap(([name, service]) =>
    serviceViolations(name, service, profile, externallyReachableNetworks),
  );
}

function renderProfile(profile: ComposeProfile): ComposeConfig {
  const args = [
    "compose",
    "--env-file",
    "infra/collector/VERSION",
    ...profileFiles[profile].flatMap((file) => ["--file", file]),
  ];
  if (profile === "dev") {
    args.push("--profile", "dev");
  } else if (profile === "test") {
    args.push("--profile", "sandbox", "--profile", "sandbox-egress");
  } else {
    args.push("--profile", "prod-like");
  }
  args.push("config", "--format", "json");
  const rendered = execFileSync("docker", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return parseJson(composeConfigSchema, rendered);
}

/** Renders and checks every supported Compose profile. */
export function validateComposeProfiles(): string[] {
  return profiles.flatMap((profile) =>
    evaluateComposeSecurity(renderProfile(profile), profile).map(
      (violation) => `${profile}: ${violation}`,
    ),
  );
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const violations = validateComposeProfiles();
  if (violations.length > 0) {
    process.stderr.write(`${violations.join("\n")}\n`);
    process.exitCode = 1;
  }
}
