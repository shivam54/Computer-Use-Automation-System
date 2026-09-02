import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SecretProvider } from "./secrets.js";

describe("SecretProvider", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.REQUIRE_ENV_SECRETS;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("loads password from environment only, ignores CLI", () => {
    process.env.DEMO_PASSWORD = "from-env";
    const params = new SecretProvider().resolveRuntimeParameters(
      { password: "cli-leak", memberId: "12345" },
      [{ name: "password", sensitive: true }]
    );
    expect(params.password).toBe("from-env");
  });

  it("uses demo default when env unset locally", () => {
    delete process.env.DEMO_PASSWORD;
    expect(new SecretProvider().requireSecret("password")).toBe("demo123");
  });

  it("throws when REQUIRE_ENV_SECRETS is set and password missing", () => {
    delete process.env.DEMO_PASSWORD;
    process.env.REQUIRE_ENV_SECRETS = "true";
    expect(() => new SecretProvider().requireSecret("password")).toThrow(/DEMO_PASSWORD/);
  });
});
