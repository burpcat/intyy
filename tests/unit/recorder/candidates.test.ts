// Proves resolveSubject (section 6 §15, section 2 §10): which `edit` subjects the CLI's
// `candidate decide` accepts, before decide.ts ever sees the value.
import { describe, expect, test } from "vitest";
import { artifactExample } from "../../fixtures/design-examples.js";
import { Artifact } from "../../../src/core/model/artifact.js";
import { resolveSubject } from "../../../src/core/recorder/candidates.js";

function baseArtifact(): Artifact {
  return Artifact.parse(artifactExample());
}

describe("resolveSubject", () => {
  test("resolveSubject knows runs_on.paths and conditions.<id> subjects", () => {
    // runs_on.paths is a known edit subject, with nothing to map
    expect(resolveSubject(baseArtifact(), [], "edit", "runs_on.paths")).toBe("runs_on.paths");
    // conditions.<id> is a known edit subject when the condition exists
    expect(resolveSubject(baseArtifact(), [], "edit", "conditions.home_page_shown")).toBe(
      "conditions.home_page_shown",
    );
    // conditions.<id> is unknown when no condition has that id
    expect(resolveSubject(baseArtifact(), [], "edit", "conditions.no_such_condition")).toBeNull();
    // conditions.<id>.<field> (three parts) still resolves, unaffected by the new two-part form
    expect(resolveSubject(baseArtifact(), [], "edit", "conditions.home_page_shown.description")).toBe(
      "conditions.home_page_shown.description",
    );
  });
});
