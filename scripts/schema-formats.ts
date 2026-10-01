// Every file format's Zod schema, by its `schemas/` file name. Split out of `schemas.ts` so
// `tests/unit/model/schemas-registry.test.ts` can import the same map and catch a schema no one
// registered here. Follows build plan section 10 §5.2.
import { z } from "zod";
import { Artifact } from "../src/core/model/artifact.js";
import { BatchPlan } from "../src/core/model/batch-plan.js";
import { BatchReport } from "../src/core/model/batch-report.js";
import { CandidateDecision } from "../src/core/model/candidate-decision.js";
import { CandidateIssues } from "../src/core/model/candidate-issues.js";
import { CandidateRuns } from "../src/core/model/candidate-runs.js";
import { Cassette } from "../src/core/model/cassette.js";
import { Config } from "../src/core/model/config.js";
import { EffectUpdate } from "../src/core/model/effect-update.js";
import { Faults } from "../src/core/model/faults.js";
import { Fixture } from "../src/core/model/fixture.js";
import { JevReconcileInput, JevTroubleInput } from "../src/core/model/jev.js";
import { LockFile } from "../src/core/model/lock.js";
import { HandlerDraft } from "../src/core/model/handler-draft.js";
import { ClaimFile, ClosedFile, DecisionFile, Intervention, ReleaseFile } from "../src/core/model/mailbox.js";
import { Pack } from "../src/core/model/pack.js";
import { Patch } from "../src/core/model/patch.js";
import { Policy } from "../src/core/model/policy.js";
import { PublishManifest } from "../src/core/model/publish.js";
import { Request } from "../src/core/model/request.js";
import { Result } from "../src/core/model/result.js";
import { ReviewerInput } from "../src/core/model/reviewer.js";
import { RunJson } from "../src/core/model/run.js";
import { RunSpec } from "../src/core/model/runspec.js";
import { SafetyReport } from "../src/core/model/safety-report.js";
import { Settings } from "../src/core/model/settings.js";
import { StaffFile } from "../src/core/model/staff.js";
import { IndexLine } from "../src/core/model/store-index.js";
import { Suite } from "../src/core/model/suite.js";
import { Thresholds } from "../src/core/model/thresholds.js";
import { Testdata } from "../src/core/model/testdata.js";

/** Every file format, by its schema name (its `schema` literal, with `/` written as `-`). */
export const formats: Record<string, z.ZodType> = {
  "intyy.artifact-1.0": Artifact,
  "intyy.patch-1.0": Patch,
  "intyy.pack-1.0": Pack,
  "intyy.fixture-1.0": Fixture,
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
  "intyy.claim-1.0": ClaimFile,
  "intyy.release-1.0": ReleaseFile,
  "intyy.cassette-1.0": Cassette,
  "intyy.publish-1.0": PublishManifest,
  "intyy.request-1.0": Request,
  "intyy.safety_report-1.0": SafetyReport,
  "intyy.result-1.0": Result,
  "intyy.effect_update-1.0": EffectUpdate,
  "intyy.suite-1.0": Suite,
  "intyy.testdata-1.0": Testdata,
  "intyy.faults-1.0": Faults,
  "intyy.batch_plan-1.0": BatchPlan,
  "intyy.batch_report-1.0": BatchReport,
  "intyy.thresholds-1.0": Thresholds,
  "intyy.jev.step-1.0": JevTroubleInput,
  "intyy.jev.reconcile-1.0": JevReconcileInput,
  "intyy.reviewer.step-1.0": ReviewerInput,
};
