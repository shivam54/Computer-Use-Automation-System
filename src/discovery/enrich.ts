import type { Locator } from "../schema/artifact.js";
import type { PageState } from "../surface/types.js";

interface AgentAction {
  thought: string;
  action: string;
  role?: string;
  name?: string;
  text?: string;
  css?: string;
  value?: string;
  url?: string;
  key?: string;
  frameName?: string;
  locator?: Locator;
}

/** Extract member ID or other numeric param from goal text */
export function extractMemberIdFromGoal(goal: string): string | null {
  const match = goal.match(/member\s+(\d+)/i);
  return match?.[1] ?? null;
}

export type DiscoveryPhase = "login" | "main_menu" | "member_form" | "member_results" | "unknown";

export function resolveDiscoveryPhase(state: PageState): DiscoveryPhase {
  if (state.url.includes("login")) return "login";
  if (state.visibleText.includes("Savings Balance") && state.visibleText.includes("Account Details")) {
    return "member_results";
  }
  if (
    state.url.includes("member-lookup") ||
    (state.frameContext === "workframe" && state.visibleText.includes("Member Number"))
  ) {
    return "member_form";
  }
  if (state.url.includes("main")) return "main_menu";
  return "unknown";
}

function getMemberIdValue(state: PageState): string | undefined {
  // No element ids — check interactive elements for filled text input
  const input = state.interactiveElements.find(
    (el) => el.tag === "input" && el.type === "text" && el.currentValue
  );
  return input?.currentValue || undefined;
}

/** Read login field values from page state (password inputs still expose .value in DOM) */
export function getLoginFieldValues(state: PageState): { username: string; password: string } {
  const textInput = state.interactiveElements.find((el) => el.tag === "input" && el.type === "text");
  const passwordInput = state.interactiveElements.find((el) => el.tag === "input" && el.type === "password");
  return {
    username: textInput?.currentValue?.trim() ?? "",
    password: passwordInput?.currentValue?.trim() ?? "",
  };
}

function extractBalanceFromText(text: string): string | undefined {
  const match = text.match(/Savings Balance[:\s]*\$?([\d,]+\.?\d*)/i);
  return match?.[1]?.replace(/,/g, "");
}

function extractMemberNameFromText(text: string): string | undefined {
  const match = text.match(/Member Name[:\s]*(.+)/i);
  return match?.[1]?.trim();
}

function extractMemberStatusFromText(text: string): string | undefined {
  const match = text.match(/Status[:\s]*(active|frozen)/i);
  return match?.[1]?.toLowerCase();
}

/** Legacy-form locators — no CSS ids, no test IDs */
export const LEGACY_LOCATORS = {
  username: { strategy: "table_row" as const, name: "User ID", fallbacks: [{ strategy: "role" as const, role: "textbox", name: "User ID" }] },
  password: { strategy: "table_row" as const, name: "Password", fallbacks: [{ strategy: "role" as const, role: "textbox", name: "Password" }] },
  signIn: { strategy: "role" as const, role: "button", name: "Sign In", fallbacks: [{ strategy: "text" as const, text: "Sign In" }] },
  memberInquiry: { strategy: "text" as const, text: "Member Account Inquiry" },
  memberId: { strategy: "table_row" as const, name: "Member Number", fallbacks: [{ strategy: "role" as const, role: "textbox", name: "Member Number" }] },
  search: { strategy: "role" as const, role: "button", name: "Search", fallbacks: [{ strategy: "text" as const, text: "Search" }] },
};

/** Deterministic login sequence — avoids LLM loops on legacy table forms */
export function resolveLoginAction(state: PageState): AgentAction {
  const { username, password } = getLoginFieldValues(state);
  if (!username) {
    return { action: "fill", thought: "Fill User ID", value: "shivam", locator: LEGACY_LOCATORS.username };
  }
  if (!password) {
    return { action: "fill", thought: "Fill Password", value: "demo123", locator: LEGACY_LOCATORS.password };
  }
  return { action: "click", thought: "Click Sign In", text: "Sign In", locator: LEGACY_LOCATORS.signIn };
}

/** Fill in missing fields using legacy a11y/text/table_row locators only */
export function enrichAction(action: AgentAction, state: PageState, goal: string): AgentAction {
  const phase = resolveDiscoveryPhase(state);
  const memberId = getMemberIdValue(state);
  const targetMemberId = extractMemberIdFromGoal(goal) ?? "12345";
  const enriched = { ...action };
  const thought = (action.thought + " " + (action.name ?? "")).toLowerCase();

  // Strip CSS — we don't use ids or selectors in legacy mode
  delete enriched.css;

  // Login is a fixed sequence — drive from form state, not LLM wording (prevents fill loops)
  if (phase === "login" && action.action !== "done" && action.action !== "stuck") {
    return resolveLoginAction(state);
  }

  if (phase === "member_results") {
    const balance = extractBalanceFromText(state.visibleText);
    const memberName = extractMemberNameFromText(state.visibleText);
    const memberStatus = extractMemberStatusFromText(state.visibleText);
    return {
      action: "done",
      thought: "Member found, extracted savings balance and account status",
      capabilityName: "lookup_member_savings_balance",
      capabilityDescription: goal,
      parameters: [{ name: "memberId", type: "string", description: "Member number to look up" }],
      outputDefs: [
        { name: "savingsBalance", type: "string", description: "Savings account balance" },
        { name: "memberName", type: "string", description: "Member name" },
        { name: "memberStatus", type: "string", description: "Account status (active or frozen)" },
      ],
      outputs: {
        savingsBalance: balance ?? "",
        memberName: memberName ?? "",
        memberStatus: memberStatus ?? "",
      },
    } as AgentAction;
  }

  if (phase === "member_form") {
    if (action.action === "switch_frame") {
      if (!memberId) {
        return { action: "fill", thought: "enter member id", value: targetMemberId, locator: LEGACY_LOCATORS.memberId };
      }
      return { action: "click", thought: "click search", text: "Search", locator: LEGACY_LOCATORS.search };
    }
    if (!memberId) {
      if (action.action !== "fill") {
        return { action: "fill", thought: "enter member id", value: targetMemberId, locator: LEGACY_LOCATORS.memberId };
      }
      enriched.locator = LEGACY_LOCATORS.memberId;
      enriched.value = targetMemberId;
    } else if (!state.visibleText.includes("Account Details")) {
      if (action.action !== "click") {
        return { action: "click", thought: "click search", text: "Search", locator: LEGACY_LOCATORS.search };
      }
      enriched.locator = LEGACY_LOCATORS.search;
      enriched.text = "Search";
    }
  }

  if (phase === "main_menu" && state.frameContext === "workframe" && state.visibleText.includes("Member Number")) {
    if (action.action === "click") {
      return { action: "fill", thought: "enter member id", value: targetMemberId, locator: LEGACY_LOCATORS.memberId };
    }
  }

  if (action.action === "fill") {
    if (phase === "member_form") {
      enriched.locator = LEGACY_LOCATORS.memberId;
      enriched.value = targetMemberId;
    }
  }

  if (action.action === "click") {
    if (thought.includes("sign in") || thought.includes("login")) {
      enriched.locator = LEGACY_LOCATORS.signIn;
      enriched.text = "Sign In";
    } else if (phase === "main_menu" && (thought.includes("member") || thought.includes("lookup") || thought.includes("inquiry"))) {
      enriched.locator = LEGACY_LOCATORS.memberInquiry;
      enriched.text = "Member Account Inquiry";
    } else if (thought.includes("search")) {
      enriched.locator = LEGACY_LOCATORS.search;
      enriched.text = "Search";
    }
  }

  if (action.action === "switch_frame" && !enriched.frameName) {
    enriched.frameName = "workframe";
  }

  return enriched;
}

export function detectLoop(recentActions: string[]): boolean {
  if (recentActions.length < 3) return false;
  const last3 = recentActions.slice(-3);
  return last3.every((a) => a === last3[0]);
}

export function loopRecoveryHint(state: PageState, goal: string): string {
  const phase = resolveDiscoveryPhase(state);
  const memberId = getMemberIdValue(state);
  const targetMemberId = extractMemberIdFromGoal(goal) ?? "12345";

  if (phase === "login") {
    const { username, password } = getLoginFieldValues(state);
    if (!username) {
      return `LOOP DETECTED. Next: fill table_row "User ID" with shivam.`;
    }
    if (!password) {
      return `LOOP DETECTED. User ID is filled. Next: fill table_row "Password" — do NOT re-fill User ID.`;
    }
    return `LOOP DETECTED. Credentials filled. Next: click button "Sign In".`;
  }
  if (phase === "main_menu") {
    return `LOOP DETECTED. Click text "Member Account Inquiry".`;
  }
  if (phase === "member_form") {
    if (!memberId) {
      return `LOOP DETECTED. Fill table_row "Member Number" with ${targetMemberId}.`;
    }
    return `LOOP DETECTED. Click button "Search".`;
  }
  if (phase === "member_results") {
    return `LOOP DETECTED. Use action "done".`;
  }
  return "LOOP DETECTED. Use table_row, role, or text locators — never css #id selectors.";
}
