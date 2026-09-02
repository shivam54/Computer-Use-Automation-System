import type { Step } from "../schema/artifact.js";

export interface SafetyPolicy {
  allowedDomains: string[];
  /** Path patterns: exact (/login.html), prefix wildcard (/api/member/*), or * for all */
  allowedRoutes: string[];
  allowedActions: Step["action"][];
  blockedActions: Step["action"][];
  requireConfirmationFor: Step["riskLevel"][];
}

export const DEFAULT_ALLOWED_ROUTES = [
  "/",
  "/login.html",
  "/main.html",
  "/member-lookup.html",
  "/sub-account.html",
  "/session-expired.html",
  "/api/login",
  "/api/member/*",
  "/api/sub-account",
];

export const DEFAULT_POLICY: SafetyPolicy = {
  allowedDomains: ["localhost", "127.0.0.1"],
  allowedRoutes: DEFAULT_ALLOWED_ROUTES,
  allowedActions: ["navigate", "click", "fill", "select", "press", "wait_for", "extract", "switch_frame"],
  blockedActions: [],
  requireConfirmationFor: ["risky", "irreversible"],
};

export type PolicyCheck = { allowed: boolean; reason?: string; requiresConfirmation?: boolean };

function parseCsv(value: string | undefined): string[] | undefined {
  if (!value?.trim()) return undefined;
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Normalize pathname for consistent route matching */
export function normalizePathname(pathname: string): string {
  if (!pathname || pathname === "/") return "/";
  const withoutTrailing = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return withoutTrailing || "/";
}

/** Match a URL path against allowlist patterns */
export function matchesRoute(pathname: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true;
  if (patterns.includes("*")) return true;

  const path = normalizePathname(pathname);

  return patterns.some((pattern) => {
    if (pattern === "*") return true;

    if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      return path === prefix.slice(0, -1) || path.startsWith(prefix);
    }

    return path === normalizePathname(pattern);
  });
}

export class SafetyGuard {
  constructor(private policy: SafetyPolicy = DEFAULT_POLICY) {}

  getPolicy(): SafetyPolicy {
    return this.policy;
  }

  validateUrl(url: string): PolicyCheck {
    try {
      const parsed = new URL(url);
      const domainAllowed = this.policy.allowedDomains.some(
        (d) => parsed.hostname === d || parsed.hostname.endsWith(`.${d}`)
      );
      if (!domainAllowed) {
        return { allowed: false, reason: `Domain ${parsed.hostname} not in allowlist` };
      }

      if (!matchesRoute(parsed.pathname, this.policy.allowedRoutes)) {
        return {
          allowed: false,
          reason: `Route ${parsed.pathname} not in allowlist`,
        };
      }

      return { allowed: true };
    } catch {
      return { allowed: false, reason: "Invalid URL" };
    }
  }

  validateAction(step: Step): PolicyCheck {
    if (this.policy.blockedActions.includes(step.action)) {
      return { allowed: false, reason: `Action ${step.action} is blocked` };
    }
    if (!this.policy.allowedActions.includes(step.action)) {
      return { allowed: false, reason: `Action ${step.action} not in allowlist` };
    }
    if (this.policy.requireConfirmationFor.includes(step.riskLevel)) {
      return { allowed: true, requiresConfirmation: true };
    }
    return { allowed: true };
  }

  /** Validate action type and navigation target (if navigate step) */
  validateStep(
    step: Step,
    params?: Record<string, string | number | boolean>,
    resolveTemplate?: (template: string, params: Record<string, string | number | boolean>) => string
  ): PolicyCheck {
    const actionCheck = this.validateAction(step);
    if (!actionCheck.allowed) return actionCheck;

    if (step.action === "navigate" && step.value) {
      const url = params && resolveTemplate ? resolveTemplate(step.value, params) : step.value;
      const urlCheck = this.validateUrl(url);
      if (!urlCheck.allowed) return urlCheck;
    }

    return actionCheck;
  }

  redactValue(key: string, value: string, sensitiveKeys: string[]): string {
    if (sensitiveKeys.includes(key)) {
      return "[REDACTED]";
    }
    return value;
  }
}

export function createPolicyFromEnv(): SafetyPolicy {
  const domains = parseCsv(process.env.ALLOWED_DOMAINS) ?? DEFAULT_POLICY.allowedDomains;
  const routes = parseCsv(process.env.ALLOWED_ROUTES) ?? DEFAULT_POLICY.allowedRoutes;
  const allowedActions = parseCsv(process.env.ALLOWED_ACTIONS) as Step["action"][] | undefined;
  const blockedActions = parseCsv(process.env.BLOCKED_ACTIONS) as Step["action"][] | undefined;

  return {
    ...DEFAULT_POLICY,
    allowedDomains: domains,
    allowedRoutes: routes,
    ...(allowedActions ? { allowedActions } : {}),
    ...(blockedActions ? { blockedActions } : {}),
  };
}
