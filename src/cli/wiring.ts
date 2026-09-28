// The only place that picks adapters: it wires plain files, env secrets, and the system clock
// to the ports. Follows design section 9 §2.1 and build plan section 10 §5.3 (row 4).
import { join } from "node:path";
import { EnvSecrets } from "../adapters/env-secrets/secrets.js";
import { FileDocumentStore } from "../adapters/files/document-store.js";
import { FileLockSlots, systemLockEnv } from "../adapters/files/locks.js";
import { FileEvidenceStore } from "../adapters/files/other-stores.js";
import { SystemClock } from "../adapters/system/clock.js";
import { SystemIds } from "../adapters/system/ids.js";
import { LockManager } from "../core/locks/manager.js";
import type { Config } from "../core/model/config.js";
import { policyKind, settingsKind } from "../core/model/kinds.js";
import type { Policy } from "../core/model/policy.js";
import type { Settings } from "../core/model/settings.js";
import type { Clock, Ids } from "../ports/clock.js";
import type { Locks } from "../ports/locks.js";
import type { Secrets } from "../ports/secrets.js";
import type { DocumentStore, EvidenceStore } from "../ports/stores.js";

/** Every port an M01 command may use. Commands see ports only, never adapters. */
export type Wiring = {
  clock: Clock;
  ids: Ids;
  secrets: Secrets;
  policy: DocumentStore<Policy>;
  settings: DocumentStore<Settings>;
  locks: Locks;
  evidence: EvidenceStore;
  /** Staging for atomic writes and edit buffers: `<state>/var/tmp`. */
  tmpDir: string;
};

/** Builds the real wiring for a data root (section 9 §6.2, §6.3). */
export function wire(
  root: string,
  config: Config,
  env: Record<string, string | undefined>,
): Wiring {
  const library = join(root, config.library);
  const state = join(root, config.state);
  const tmpDir = join(state, "var", "tmp");
  const clock = new SystemClock();
  return {
    clock,
    ids: new SystemIds(clock),
    secrets: new EnvSecrets(env),
    policy: new FileDocumentStore(policyKind, { dir: join(library, "policy"), tmpDir }, clock),
    settings: new FileDocumentStore(
      settingsKind,
      { dir: join(library, "settings"), tmpDir },
      clock,
    ),
    locks: new LockManager(new FileLockSlots(join(state, "var", "locks")), clock, systemLockEnv()),
    evidence: new FileEvidenceStore({ root: join(state, "evidence"), tmpDir }),
    tmpDir,
  };
}
