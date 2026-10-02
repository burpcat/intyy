// Proves the request schema accepts the design's section 3 §4.10 example and refuses what
// section 3 §4 forbids.
import { describe, expect, test } from "vitest";
import { Request } from "../../../src/core/model/request.js";

/** Section 3 §4.10, full example. */
function requestExample(): Record<string, unknown> {
  return {
    schema: "intyy.request/1.0",
    request_id: "agt-teller-7f3c-0042",
    capability: "kvfcu/open_share_subaccount@1",
    inputs: { member_id: "100107", deposit: "100.00" },
    mode: "unattended",
    authorization: {
      consent_ref: "consent_88121",
      granted_by: "member",
      staff_id: "op_031",
      granted_at: "2026-09-24T10:14:00Z",
      expires_at: "2026-09-24T10:44:00Z",
      capability: "kvfcu/open_share_subaccount@1",
    },
    wait_ms: 30000,
  };
}

describe("intyy.request/1.0", () => {
  test("the request schema parses good requests and rejects each bad field", () => {
    // the section 3 §4.10 example parses
    expect(Request.safeParse(requestExample()).success).toBe(true);
    // a minimal supervised request, with no authorization and no wait_ms, parses
    {
      const req = {
        schema: "intyy.request/1.0",
        request_id: null,
        capability: "kvfcu/find_account_by_reference@1",
        inputs: { reference: "abc123" },
        mode: "supervised",
      };
      expect(Request.safeParse(req).success).toBe(true);
    }
    // request_id is required, but a caller with no ID sends null (owner decision, 2026-09-29)
    {
      const req = requestExample();
      delete req.request_id;
      expect(Request.safeParse(req).success).toBe(false);
      expect(Request.safeParse({ ...req, request_id: null }).success).toBe(true);
    }
    // an unknown field is rejected
    expect(Request.safeParse({ ...requestExample(), extra: true }).success).toBe(false);
    // mode must be supervised or unattended
    expect(Request.safeParse({ ...requestExample(), mode: "auto" }).success).toBe(false);
    // wait_ms must fit 0 to 120000
    expect(Request.safeParse({ ...requestExample(), wait_ms: -1 }).success).toBe(false);
    expect(Request.safeParse({ ...requestExample(), wait_ms: 120001 }).success).toBe(false);
    expect(Request.safeParse({ ...requestExample(), wait_ms: 0 }).success).toBe(true);
    // request_id must be 8 to 64 letters, digits, - or _
    expect(Request.safeParse({ ...requestExample(), request_id: "short" }).success).toBe(false);
    expect(Request.safeParse({ ...requestExample(), request_id: "has:colon:0042" }).success).toBe(
      false,
    );
    // capability must be app/capability@major
    expect(
      Request.safeParse({ ...requestExample(), capability: "kvfcu/open_share_subaccount" })
        .success,
    ).toBe(false);
    // authorization needs every required field, and granted_by is member or staff
    {
      const req = requestExample();
      const auth = req.authorization as Record<string, unknown>;
      expect(Request.safeParse({ ...req, authorization: { ...auth, granted_by: "bot" } }).success).toBe(
        false,
      );
      const noExpiry = { ...auth };
      delete noExpiry.expires_at;
      expect(Request.safeParse({ ...req, authorization: noExpiry }).success).toBe(false);
    }
  });
});
