// Every file format's Zod schema, by its `schemas/` file name. Split out of `schemas.ts` so
// `tests/unit/model/schemas-registry.test.ts` can import the same map and catch a schema no one
// registered here. Follows build plan section 10 §5.2.
import { z } from "zod";
import { Artifact } from "../src/core/model/artifact.js";
import { CandidateDecision } from "../src/core/model/candidate-decision.js";
import { CandidateIssues } from "../src/core/model/candidate-issues.js";
import { CandidateRuns } from "../src/core/model/candidate-runs.js";
import { Cassette } from "../src/core/model/cassette.js";
import { Config } from "../src/core/model/config.js";
import { LockFile } from "../src/core/model/lock.js";
import { HandlerDraft } from "../src/core/model/handler-draft.js";
import { ClosedFile, DecisionFile, Intervention } from "../src/core/model/mailbox.js";
import { Patch } from "../src/core/model/patch.js";
import { Policy } from "../src/core/model/policy.js";
import { Request } from "../src/core/model/request.js";
import { Result } from "../src/core/model/result.js";
import { RunJson } from "../src/core/model/run.js";
import { RunSpec } from "../src/core/model/runspec.js";
import { Settings } from "../src/core/model/settings.js";
import { StaffFile } from "../src/core/model/staff.js";
import { IndexLine } from "../src/core/model/store-index.js";

/** Every file format, by its schema name (its `schema` literal, with `/` written as `-`). */
export const formats: Record<string, z.ZodType> = {
  "intyy.artifact-1.0": Artifact,
  "intyy.patch-1.0": Patch,
  "intyy.candidate_decision-1.0": CandidateDecision,
  "intyy.candidate_runs-1.0": CandidateRuns,
  "intyy.candidate_issues-1.0": CandidateIssues,
  "intyy.handler_draft-1.0": HandlerDraft,
  "intyy.run-1.0": RunJson,
  "intyy.config-1.0": Config,
  "intyy.staff-1.0": StaffFile,
  "intyy.policy-1.0": Policy,
  "intyy.settings-1.0": Settings,
  "intyy.index-1.0": IndexLine,
  "intyy.lock-1.0": LockFile,
  "intyy.runspec-1.0": RunSpec,
  "intyy.intervention-1.0": Intervention,
  "intyy.decision-1.0": DecisionFile,
  "intyy.closed-1.0": ClosedFile,
  "intyy.cassette-1.0": Cassette,
  "intyy.request-1.0": Request,
  "intyy.result-1.0": Result,
};
