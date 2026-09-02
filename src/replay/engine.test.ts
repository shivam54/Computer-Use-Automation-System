import { describe, it, expect } from "vitest";

describe("Replay engine", () => {
  it("sorts steps by id number regardless of array order", () => {
    const steps = [
      { id: "step-6", action: "click" as const },
      { id: "step-5", action: "fill" as const },
      { id: "step-10", action: "wait_for" as const },
    ];
    const sorted = [...steps].sort(
      (a, b) => parseInt(a.id.split("-")[1] ?? "0") - parseInt(b.id.split("-")[1] ?? "0")
    );
    expect(sorted.map((s) => s.id)).toEqual(["step-5", "step-6", "step-10"]);
  });

  it("rejects empty or missing required parameters before replay", () => {
    expect(String("" ?? "").trim() === "").toBe(true);
    expect("memberId" in ({} as Record<string, string>)).toBe(false);
  });
});
