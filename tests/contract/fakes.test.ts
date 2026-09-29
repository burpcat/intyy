// Runs every store contract suite against the in-memory fakes. Design section 9 §5.1 and §5.9.
import { ManualClock } from "../../src/fakes/clock.js";
import {
  FakeCandidateStore,
  FakeDocumentStore,
  FakeEvidenceStore,
  FakeLogStore,
} from "../../src/fakes/stores.js";
import { documentStoreContract } from "./document-store.suite.js";
import {
  candidateStoreContract,
  evidenceStoreContract,
  logStoreContract,
} from "./other-stores.suite.js";
import { CandidateFiles, Decision, LogLine, LogRecord, testKind } from "./test-kinds.js";

documentStoreContract("fake", () => {
  const clock = new ManualClock();
  const store = new FakeDocumentStore(testKind, clock);
  return Promise.resolve({
    store,
    clock,
    tamper: (id, rev, change) => {
      store.tamper(id, rev, change);
      return Promise.resolve();
    },
    corruptCandidate: (id, content) => {
      store.corruptCandidate(id, content);
      return Promise.resolve();
    },
  });
});

candidateStoreContract("fake", () => {
  const store = new FakeCandidateStore({ files: CandidateFiles, decision: Decision }, new ManualClock());
  return Promise.resolve({
    store,
    readSealed: (artifactId, version) => Promise.resolve(store.sealed(artifactId, version)),
  });
});

logStoreContract("fake", () =>
  Promise.resolve(new FakeLogStore({ line: LogLine, record: LogRecord })),
);

evidenceStoreContract("fake", () => Promise.resolve(new FakeEvidenceStore()));
