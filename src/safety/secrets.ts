import type { Parameter } from "../schema/artifact.js";

/** Map runtime parameter names to environment variables (never commit values) */
const SECRET_ENV_KEYS: Record<string, string> = {
  username: "DEMO_USERNAME",
  password: "DEMO_PASSWORD",
};

/** Demo defaults only when REQUIRE_ENV_SECRETS is not set (local take-home runs) */
const DEMO_DEFAULTS: Record<string, string> = {
  username: "shivam",
  password: "demo123",
};

let singleton: SecretProvider | undefined;

export class SecretProvider {
  /** Resolve a fill value at runtime — sensitive params never use LLM/artifact values */
  resolveFillValue(parameterRef: string | undefined, llmOrStepValue?: string): string {
    if (!parameterRef) return llmOrStepValue ?? "";

    if (this.isSensitive(parameterRef)) {
      return this.requireSecret(parameterRef);
    }

    if (parameterRef === "username") {
      return this.getSecret("username") ?? llmOrStepValue ?? DEMO_DEFAULTS.username;
    }

    return llmOrStepValue ?? "";
  }

  /**
   * Build replay parameters for browser execution.
   * Sensitive values come from environment only — CLI flags for secrets are ignored.
   */
  resolveRuntimeParameters(
    cliParams: Record<string, string> = {},
    parameterDefs: Pick<Parameter, "name" | "sensitive">[] = []
  ): Record<string, string> {
    const sensitiveNames = new Set(
      parameterDefs.filter((p) => p.sensitive).map((p) => p.name)
    );
    // Always treat password as sensitive even if schema is incomplete
    sensitiveNames.add("password");

    const result: Record<string, string> = {};

    for (const name of new Set([...Object.keys(SECRET_ENV_KEYS), ...Object.keys(cliParams)])) {
      if (sensitiveNames.has(name)) {
        if (cliParams[name]) {
          console.warn(
            `[secrets] Ignoring CLI value for "${name}". Set ${SECRET_ENV_KEYS[name] ?? name} in the environment.`
          );
        }
        result[name] = this.requireSecret(name);
        continue;
      }

      result[name] = cliParams[name] ?? this.getSecret(name) ?? DEMO_DEFAULTS[name] ?? "";
    }

    return result;
  }

  isSensitive(parameterRef: string): boolean {
    return parameterRef === "password";
  }

  getSecret(name: string): string | undefined {
    const envKey = SECRET_ENV_KEYS[name];
    const value = envKey ? process.env[envKey]?.trim() : undefined;
    return value || undefined;
  }

  requireSecret(name: string): string {
    const fromEnv = this.getSecret(name);
    if (fromEnv) return fromEnv;

    if (process.env.REQUIRE_ENV_SECRETS === "true") {
      const envKey = SECRET_ENV_KEYS[name] ?? name;
      throw new Error(
        `Missing required secret "${name}". Set ${envKey} in the environment (never pass via CLI or store in artifacts).`
      );
    }

    const fallback = DEMO_DEFAULTS[name];
    if (fallback) return fallback;

    throw new Error(`Missing secret for parameter "${name}"`);
  }
}

export function getSecretProvider(): SecretProvider {
  if (!singleton) singleton = new SecretProvider();
  return singleton;
}
