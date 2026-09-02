import { describe, it, expect } from "vitest";
import { enrichAction, detectLoop, extractMemberIdFromGoal, LEGACY_LOCATORS, resolveLoginAction } from "./enrich.js";
import type { PageState } from "../surface/types.js";

const loginState: PageState = {
  url: "http://localhost:3847/login.html",
  title: "Login",
  accessibilityTree: [],
  visibleText: "",
  interactiveElements: [
    { tag: "input", type: "text", currentValue: "" },
    { tag: "input", type: "password", currentValue: "" },
    { tag: "input", type: "submit", text: "Sign In" },
  ],
};

describe("Discovery enrich", () => {
  it("uses table_row locators for legacy login forms (no CSS ids)", () => {
    const username = resolveLoginAction(loginState);
    expect(username.locator?.strategy).toBe("table_row");
    expect(username.locator?.name).toBe("User ID");
    expect(username.value).toBe("shivam");

    const withUser = resolveLoginAction({
      ...loginState,
      interactiveElements: [
        { tag: "input", type: "text", currentValue: "shivam" },
        { tag: "input", type: "password", currentValue: "" },
        { tag: "input", type: "submit", text: "Sign In" },
      ],
    });
    expect(withUser.locator?.name).toBe("Password");

    const ready = resolveLoginAction({
      ...loginState,
      interactiveElements: [
        { tag: "input", type: "text", currentValue: "shivam" },
        { tag: "input", type: "password", currentValue: "demo123" },
        { tag: "input", type: "submit", text: "Sign In" },
      ],
    });
    expect(ready.action).toBe("click");
    expect(ready.locator?.name).toBe("Sign In");
  });

  it("extracts member id from goal and detects action loops", () => {
    expect(extractMemberIdFromGoal("look up member 12345")).toBe("12345");
    expect(detectLoop(["fill:User ID", "fill:User ID", "fill:User ID"])).toBe(true);
    expect(detectLoop(["fill:User ID", "fill:Password"])).toBe(false);
  });

  it("auto-clicks Search when member id is filled in iframe", () => {
    const formState: PageState = {
      url: "http://localhost:3847/member-lookup.html",
      title: "Member Account Inquiry",
      accessibilityTree: [],
      visibleText: "Member Number",
      frameContext: "workframe",
      interactiveElements: [{ tag: "input", type: "text", currentValue: "12345" }],
    };
    const result = enrichAction({ action: "switch_frame", thought: "switch" }, formState, "member 12345");
    expect(result.action).toBe("click");
    expect(result.locator).toEqual(LEGACY_LOCATORS.search);
  });

  it("returns done with outputs when results page is visible", () => {
    const active = enrichAction(
      { action: "click", thought: "check" },
      {
        url: "http://localhost:3847/member-lookup.html",
        title: "Results",
        accessibilityTree: [],
        visibleText: "Account Details\nMember Name: Jane Doe\nStatus: active\nSavings Balance: $12450.75",
        interactiveElements: [],
      },
      "member 12345"
    );
    expect(active.action).toBe("done");
    expect((active as { outputs?: { memberStatus?: string } }).outputs?.memberStatus).toBe("active");

    const frozen = enrichAction(
      { action: "click", thought: "check" },
      {
        url: "http://localhost:3847/member-lookup.html",
        title: "Results",
        accessibilityTree: [],
        visibleText: "Account Details\nMember Name: Maria Garcia\nStatus: frozen\nSavings Balance: $0.00",
        interactiveElements: [],
      },
      "member 11111"
    );
    expect((frozen as { outputs?: { memberStatus?: string } }).outputs?.memberStatus).toBe("frozen");
  });
});
