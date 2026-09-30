// The recorder's own version, stamped into `provenance.runs[].recorder_version` (section 2 §17.2).
// Follows design section 6 §14.14. Bump this with every change to the recorder's rules, so a
// changed rule set never hides behind an unchanged version (docs/decisions.md, M04).
export const RECORDER_VERSION = "0.2.0";
