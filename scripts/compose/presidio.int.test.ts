// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { DetectionSchema, parseJson } from "@harness/schemas";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const composeArgs = [
  "compose",
  "--env-file",
  "infra/collector/VERSION",
  "--file",
  "infra/compose/docker-compose.test.yml",
];

describe("Presidio analyzer Compose service", () => {
  it("detects a synthetic name through the internal Compose network", () => {
    const script = [
      'import { PresidioDetector } from "./packages/pii/dist/index.js";',
      'import { PiiPresidioConfigSchema } from "./packages/schemas/dist/index.js";',
      'const config = PiiPresidioConfigSchema.parse({ baseUrl: "http://presidio-analyzer:3000" });',
      "const detector = new PresidioDetector(config);",
      'const detections = await detector.detect("My name is Alice Smith.");',
      "process.stdout.write(JSON.stringify(detections));",
    ].join("\n");
    const output = execFileSync(
      "docker",
      [...composeArgs, "exec", "-T", "harness", "node", "--input-type=module", "-e", script],
      { encoding: "utf8", timeout: 15_000 },
    );
    const detections = parseJson(z.array(DetectionSchema), output);
    const namedEntity = detections.find(({ entityType }) => entityType === "person_name");

    expect(namedEntity).toBeDefined();
    expect("My name is Alice Smith.".slice(namedEntity?.start, namedEntity?.end)).toContain(
      "Alice",
    );
  }, 20_000);
});
