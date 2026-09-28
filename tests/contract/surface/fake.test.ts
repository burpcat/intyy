// Runs the surface contract on the snapshot fake. The live run is tests/live/surface.test.ts.
// Design section 9 §5.9 and §16; M02 task 5.
import { SnapshotSurface } from "../../../src/fakes/snapshot-surface/index.js";
import { FAKE_ORIGIN, fixtureSite } from "./site.js";
import { surfaceContract } from "./surface.suite.js";

surfaceContract("snapshot fake", () =>
  Promise.resolve({ session: new SnapshotSurface(fixtureSite(FAKE_ORIGIN)), origin: FAKE_ORIGIN }),
);
