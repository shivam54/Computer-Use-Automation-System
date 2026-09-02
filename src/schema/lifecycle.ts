import type { CapabilityArtifact } from "./artifact.js";

export type ArtifactStatus = "draft" | "approved" | "quarantined";

export interface ArtifactLifecycle {
  version: string;
  status: ArtifactStatus;
  correlationId?: string;
  lastVerifiedAt?: string;
  promotedAt?: string;
  consecutiveFailures: number;
}

const DEFAULT_LIFECYCLE: ArtifactLifecycle = {
  version: "1.0.0",
  status: "draft",
  consecutiveFailures: 0,
};

/** Apply lifecycle defaults — legacy artifacts without lifecycle are treated as approved */
export function normalizeLifecycle(artifact: CapabilityArtifact): ArtifactLifecycle {
  const existing = artifact.lifecycle;
  if (!existing) {
    return {
      version: "1.0.0",
      status: "approved",
      correlationId: artifact.metadata.discoveryRunId,
      consecutiveFailures: 0,
    };
  }
  return {
    version: existing.version ?? DEFAULT_LIFECYCLE.version,
    status: existing.status ?? DEFAULT_LIFECYCLE.status,
    correlationId: existing.correlationId ?? artifact.metadata.discoveryRunId,
    lastVerifiedAt: existing.lastVerifiedAt,
    promotedAt: existing.promotedAt,
    consecutiveFailures: existing.consecutiveFailures ?? 0,
  };
}

export class ArtifactLifecycleError extends Error {
  constructor(
    message: string,
    readonly status: ArtifactStatus
  ) {
    super(message);
    this.name = "ArtifactLifecycleError";
  }
}

/** Gate replay — production would block draft/quarantined in prod tenants */
export function assertReplayAllowed(
  artifact: CapabilityArtifact,
  opts: { allowDraft?: boolean; allowQuarantined?: boolean } = {}
): void {
  const lifecycle = normalizeLifecycle(artifact);
  if (lifecycle.status === "quarantined" && !opts.allowQuarantined) {
    throw new ArtifactLifecycleError(
      `Artifact ${artifact.name} is quarantined (${lifecycle.consecutiveFailures} consecutive failures). ` +
        "Re-discover or run: npm run artifact:approve -- --force",
      "quarantined"
    );
  }
  if (lifecycle.status === "draft" && !opts.allowDraft) {
    throw new ArtifactLifecycleError(
      `Artifact ${artifact.name} v${lifecycle.version} is draft. ` +
        "Approve with: npm run artifact:approve — or replay with --allow-draft",
      "draft"
    );
  }
}

export function withLifecycle(
  artifact: CapabilityArtifact,
  patch: Partial<ArtifactLifecycle>
): CapabilityArtifact {
  const current = normalizeLifecycle(artifact);
  return {
    ...artifact,
    lifecycle: { ...current, ...patch },
  };
}

export function approveArtifact(artifact: CapabilityArtifact): CapabilityArtifact {
  const now = new Date().toISOString();
  return withLifecycle(artifact, {
    status: "approved",
    promotedAt: now,
    lastVerifiedAt: now,
    consecutiveFailures: 0,
  });
}

export function recordReplaySuccess(artifact: CapabilityArtifact): CapabilityArtifact {
  return withLifecycle(artifact, {
    lastVerifiedAt: new Date().toISOString(),
    consecutiveFailures: 0,
  });
}

const QUARANTINE_THRESHOLD = 3;

export function recordReplayFailure(artifact: CapabilityArtifact): CapabilityArtifact {
  const lifecycle = normalizeLifecycle(artifact);
  const consecutiveFailures = lifecycle.consecutiveFailures + 1;
  const patch: Partial<ArtifactLifecycle> = { consecutiveFailures };
  if (consecutiveFailures >= QUARANTINE_THRESHOLD) {
    patch.status = "quarantined";
  }
  return withLifecycle(artifact, patch);
}
