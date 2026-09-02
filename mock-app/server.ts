/**
 * Legacy-style credit union back-office mock.
 * Intentionally hostile: table layouts, nested frames, no data-testid attributes.
 */
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3847;

// In-memory member database (simulated core banking)
const MEMBERS: Record<string, { name: string; savings: number; checking: number; status: string }> = {
  "12345": { name: "Jane Doe", savings: 12450.75, checking: 3200.0, status: "active" },
  "67890": { name: "John Smith", savings: 890.25, checking: 150.0, status: "active" },
  "11111": { name: "Maria Garcia", savings: 0, checking: 45.5, status: "frozen" },
};

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (_req, res) => res.redirect("/login.html"));

app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  if (username === "shivam" && password === "demo123") {
    res.json({ ok: true, sessionId: "sess-demo-001" });
  } else {
    res.status(401).json({ ok: false, error: "Invalid credentials" });
  }
});

app.get("/api/member/:id", (req, res) => {
  const member = MEMBERS[req.params.id];
  if (!member) {
    return res.status(404).json({ ok: false, error: "MEMBER_NOT_FOUND", message: "No member found with that ID" });
  }
  res.json({ ok: true, memberId: req.params.id, ...member });
});

app.post("/api/sub-account", (req, res) => {
  const { memberId, accountType } = req.body;
  const member = MEMBERS[memberId];
  if (!member) {
    return res.status(404).json({ ok: false, error: "MEMBER_NOT_FOUND" });
  }
  if (member.status === "frozen") {
    return res.status(403).json({ ok: false, error: "ACCOUNT_FROZEN", message: "Member account is frozen" });
  }
  res.json({
    ok: true,
    confirmationNumber: `SUB-${Date.now()}`,
    memberId,
    accountType,
    message: "Sub-account request submitted successfully",
  });
});

app.listen(PORT, () => {
  console.log(`[mock-app] Shivam Credit Union back-office running at http://localhost:${PORT}`);
});
