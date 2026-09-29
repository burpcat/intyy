// One review issue (section 6 §14.15). The full issue list is a later task; this shape is
// seeded now so a rule module can report trouble instead of inventing data to fill a gap
// (CLAUDE.md: "Never invent product behavior to fill a gap").
export type RecorderIssue = {
  level: "blocking" | "warning";
  code: string;
  message: string;
  subject?: string;
};
