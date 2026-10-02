// Proves the text redactor, rule by rule: known values, the label rule, detectors, format patterns,
// digit runs, and per-run tokens. Design section 4 §9.2 to §9.10, updates file §3; M02 task 4.
// Names and values here are made up. Seed member 100240 is the canary and never appears.
import { describe, expect, test } from "vitest";
import {
  Redactor,
  fact,
  type RedactionRules,
} from "../../../src/core/safety/redaction/redactor.js";

/** The approved global lists (section 4 §9.7, §9.8; updates file §3). */
const rules: RedactionRules = {
  detectors: ["ssn", "card", "email", "phone", "money"],
  digitRunMin: 5,
  formats: [
    { format: "SH99999999", kind: "account" },
    { format: "CU9999999", kind: "member" },
  ],
  labels: {
    name: ["name", "customer name", "member name", "account holder", "holder name", "joint owner"],
    address: ["address", "street", "city", "state", "zip", "zip code", "postal code"],
    ssn: ["ssn", "social security", "social security number", "tax id", "tin", "itin"],
    dob: ["dob", "date of birth", "birth date"],
    phone: ["mobile", "phone", "telephone"],
    email: ["email", "e-mail"],
    member: ["member id", "customer id", "cif"],
    account: ["account no", "account number", "a/c no", "acct no"],
    money: ["balance", "available balance", "amount", "limit", "salary"],
  },
  dateFormats: ["YYYY-MM-DD", "MM/DD/YYYY", "DD/MM/YYYY", "MM/DD/YY", "DD-MMM-YYYY"],
};

/** A fresh redactor, as at run start. */
const fresh = (r: RedactionRules = rules): Redactor => new Redactor(r);

describe("known values (section 4 §9.6)", () => {
  test("known values turn into references or tokens by the section 9.6 rules", () => {
    {
      const r = fresh();
      r.addKnown({
        ref: "input.member_id",
        value: "100107",
        label: "pii",
        type: "text",
        kind: "member",
      });
      expect(r.text("Member 100107 found")).toBe("Member {input.member_id} found");
      expect(r.text("/members/100107/accounts")).toBe("/members/{input.member_id}/accounts");
      expect(r.text("ID 1100107")).toBe("ID [digits#1]");
    }
    {
      const r = fresh();
      r.addKnown({
        ref: "input.holder",
        value: "Dana Quillfeather",
        label: "pii",
        type: "text",
        kind: "name",
      });
      expect(r.text("Holder: DANA   QUILLFEATHER.")).toBe("Holder: {input.holder}.");
    }
    {
      const r = fresh();
      r.addKnown({ ref: "input.first", value: "Dana", label: "pii", type: "text", kind: "name" });
      r.addKnown({
        ref: "input.full",
        value: "Dana Quillfeather",
        label: "pii",
        type: "text",
        kind: "name",
      });
      expect(r.text("Dana Quillfeather and Dana")).toBe("{input.full} and {input.first}");
    }
    {
      const r = fresh();
      r.addKnown({
        ref: "input.member_id",
        value: "100107",
        label: "pii",
        type: "text",
        kind: "member",
      });
      expect(r.text("Member 1001-07 and 100 107")).toBe(
        "Member {input.member_id} and {input.member_id}",
      );
    }
    {
      const r = fresh();
      r.addKnown({
        ref: "output.account_number",
        value: "SH00481223",
        label: "financial",
        type: "text",
        kind: "account",
      });
      expect(r.text("Account SH00481223 created")).toBe("Account {output.account_number} created");
    }
    {
      const r = fresh();
      r.addKnown({ ref: "input.term", value: "5", label: "financial", type: "text", kind: "digits" });
      expect(r.text("Term 5 of Page 5")).toBe("Term [digits#1] of Page [digits#1]");
    }
    {
      const r = fresh();
      r.addKnown({ ref: "input.term", value: "5", label: "none", type: "text", kind: "digits" });
      expect(r.text("Page 5 of 10")).toBe("Page 5 of 10");
    }
    {
      const r = fresh();
      r.addKnown({
        ref: "input.branch",
        value: "Main Street",
        label: "none",
        type: "text",
        kind: "address",
      });
      expect(r.text("Branch: Main Street")).toBe("Branch: {input.branch}");
    }
    {
      const r = fresh();
      r.addKnown({ ref: "input.from", value: "100107", label: "pii", type: "text", kind: "member" });
      r.addKnown({ ref: "input.to", value: "100107", label: "pii", type: "text", kind: "member" });
      expect(r.text("Move 100107")).toBe("Move [member#1]");
    }
    {
      const r = fresh();
      r.addKnown({
        ref: "input.deposit",
        value: "137.00",
        label: "financial",
        type: "money",
        kind: "money",
      });
      for (const shown of ["$137", "$137.00", "USD 137.00", "137.00", "137", "$ 137.0"]) {
        expect(r.text(`Deposit ${shown} today`), shown).toBe("Deposit {input.deposit} today");
      }
      expect(r.text("Balance $1,250.00")).toBe("Balance [money#1]");
    }
    {
      const r = fresh();
      r.addKnown({
        ref: "input.deposit",
        value: "1250.00",
        label: "financial",
        type: "money",
        kind: "money",
      });
      expect(r.text("Deposit 1,250.00 and $1,250")).toBe(
        "Deposit {input.deposit} and {input.deposit}",
      );
    }
    {
      const r = fresh();
      r.addKnown({
        ref: "input.opened",
        value: "2026-01-15",
        label: "pii",
        type: "date",
        kind: "dob",
      });
      for (const shown of [
        "2026-01-15",
        "01/15/2026",
        "15/01/2026",
        "01/15/26",
        "15-JAN-2026",
        "15-Jan-2026",
      ]) {
        expect(r.text(`Opened ${shown}.`), shown).toBe("Opened {input.opened}.");
      }
    }
  });

});

describe("the label rule (section 4 §9.7)", () => {
  test("the label rule masks the value after a label, longest phrase first", () => {
    {
      const r = fresh();
      expect(r.text("DANA QUILLFEATHER", { label: "Member Name" })).toBe("[name#1]");
      expect(r.text("Main", { label: "Branch" })).toBe("Main");
    }
    {
      const r = fresh();
      expect(r.text("DOB: 12/03/1980")).toBe("DOB: [dob#1]");
      expect(r.text("Member Name: DANA QUILLFEATHER")).toBe("Member Name: [name#1]");
      expect(r.text("Branch: Main")).toBe("Branch: Main");
    }
    {
      const r = fresh();
      expect(r.text("Account Number: 77")).toBe("Account Number: [account#1]");
      expect(r.text("x", { label: "Available Balance" })).toBe("[money#1]");
    }
    {
      const r = fresh();
      r.addKnown({
        ref: "input.member_id",
        value: "100107",
        label: "pii",
        type: "text",
        kind: "member",
      });
      expect(r.text("100107 DANA", { label: "Name" })).toBe("{input.member_id} [name#1]");
    }
    {
      const r = fresh();
      expect(r.text("Name: DANA Q\nBranch: Main")).toBe("Name: [name#1]\nBranch: Main");
    }
    {
      expect(fresh().text("At 09:04 today")).toBe("At 09:04 today");
    }
  });

});

describe("detectors (section 4 §9.8, updates file §3.1)", () => {
  test("detectors: ssn, itin, card, email, phone, money, and routing numbers", () => {
    {
      const r = fresh();
      expect(r.text("SSN on file 123-45-6789 ok")).toBe("SSN on file [ssn#1] ok");
      expect(r.text("x 123 45 6789 y")).toBe("x [ssn#1] y");
      expect(r.text("x 000-12-3456 y")).not.toContain("[ssn#");
      expect(r.text("x 666-12-3456 y")).not.toContain("[ssn#");
    }
    {
      const r = fresh();
      for (const itin of [
        "912-50-1234",
        "912-65-1234",
        "912-70-1234",
        "912-88-1234",
        "912-90-1234",
        "912-92-1234",
        "912-94-1234",
        "912-99-1234",
      ]) {
        expect(r.text(`t ${itin}`), itin).toMatch(/^t \[ssn#\d+\]$/);
      }
      for (const bad of ["912-49-1234", "912-66-1234", "912-89-1234", "912-93-1234"]) {
        expect(r.text(`t ${bad}`), bad).not.toContain("[ssn#");
      }
    }
    {
      const r = fresh();
      expect(r.text("Card 4111 1111 1111 1111 on file")).toBe("Card [card#1] on file");
      expect(r.text("Card 4111-1111-1111-1111")).toBe("Card [card#1]");
      expect(r.text("Card 4111 1111 1111 1112")).not.toContain("[card#");
    }
    {
      const r = fresh();
      expect(r.text("Mail dana.q+kv@mail.example.org now")).toBe("Mail [email#1] now");
      expect(r.text("user@localhost")).toBe("user@localhost");
    }
    {
      const r = fresh();
      for (const p of [
        "(555) 010-4477",
        "555-010-4477",
        "555.010.4477",
        "+1 555 010 4477",
        "5550104477",
        "+15550104477",
      ]) {
        expect(r.text(`Call ${p} now`), p).toBe("Call [phone#1] now");
      }
    }
    {
      const r = fresh();
      expect(r.text("Fee $5 and USD 12.50 and 1,250.00 and 99.95")).toBe(
        "Fee [money#1] and [money#2] and [money#3] and [money#4]",
      );
    }
    {
      const r = fresh({ ...rules, detectors: [] });
      expect(r.text("mail a.b@c.example")).toBe("mail a.b@c.example");
    }
    {
      expect(fresh().text("Routing 021000021")).toBe("Routing [digits#1]");
    }
  });

});

describe("format patterns (section 4 §9.8)", () => {
  test("app ID shapes, as whole words, ignoring case", () => {
    const r = fresh();
    expect(r.text("Share SH00481223 and cu1029384")).toBe("Share [account#1] and [member#1]");
    expect(r.text("XSH00481223")).toBe("XSH00481223".replace("00481223", "[digits#1]"));
  });

  test("a quoted 9, A, or X is literal", () => {
    const r = fresh({ ...rules, formats: [{ format: '"A"9999', kind: "member" }] });
    expect(r.text("ids A1234 B1234")).toBe("ids [member#1] B1234");
  });
});

describe("digit runs (section 4 §9.9)", () => {
  test("digit runs: five or more digits become a token; the limit comes from the layers", () => {
    const r = fresh();
    expect(r.text("Year 2026, ref 12345, zip 02134")).toBe(
      "Year 2026, ref [digits#1], zip [digits#2]",
    );
    expect(fresh({ ...rules, digitRunMin: 3 }).text("PIN 123")).toBe("PIN [digits#1]");
    expect(fresh({ ...rules, digitRunMin: null }).text("Page 5")).toBe("Page [digits#1]");
  });

});

describe("per-run tokens (section 4 §9.3)", () => {
  test("per-run tokens are stable inside a run, reset between runs, and never rescan", () => {
    {
      const r = fresh();
      expect(r.text("Name: DANA Q")).toBe("Name: [name#1]");
      expect(r.text("Name: dana  q")).toBe("Name: [name#1]");
      expect(r.text("Name: LEE W")).toBe("Name: [name#2]");
      expect(r.text("Balance: 5")).toBe("Balance: [money#1]");
    }
    {
      const a = fresh();
      a.text("Name: LEE W");
      const b = fresh();
      expect(b.text("Name: DANA Q")).toBe("Name: [name#1]");
    }
    {
      const r = fresh();
      r.addKnown({
        ref: "input.member_id",
        value: "100107",
        label: "pii",
        type: "text",
        kind: "member",
      });
      expect(r.text("Name: 100107")).toBe("Name: {input.member_id}");
    }
    {
      expect(fresh().secretField()).toBe("[secret]");
    }
  });

});

describe("structured values (section 3 §6.7)", () => {
  test("every string inside a value is masked; keys and numbers stay", () => {
    const r = fresh();
    r.addKnown({
      ref: "input.member_id",
      value: "100107",
      label: "pii",
      type: "text",
      kind: "member",
    });
    expect(
      r.value({ seq: 3, path: "/members/100107", data: { names: ["Name: DANA Q"], ok: true } }),
    ).toEqual({
      seq: 3,
      path: "/members/{input.member_id}",
      data: { names: ["Name: [name#1]"], ok: true },
    });
  });
});

describe("known limit (section 4 §14)", () => {
  // Why: section 4 §15.3. A name with no label, no input, and no shape leaks. Tracked, not hidden.
  test.fails("a name inside a free sentence is masked", () => {
    expect(fresh().text("Account opened for Quillon Brask today.")).not.toContain("Quillon");
  });
});

describe("artifact keys are facts only when intyy makes them (section 2 §9, section 3 §6.7)", () => {
  test("an exact artifact key, wrapped as a fact, survives; so does the major form", () => {
    expect(
      fresh().value({ id: fact("kvfcu/open_sub@1.0.0"), link: fact("kvfcu/open_sub@1") }),
    ).toEqual({
      id: "kvfcu/open_sub@1.0.0",
      link: "kvfcu/open_sub@1",
    });
  });

  test("a key-like string inside screen text is still masked", () => {
    const out = fresh().text("mail bob@1.0.0 now, or kvfcu/open_sub@1.0.0 today");
    expect(out).not.toContain("bob@1.0.0");
    expect(out).not.toContain("kvfcu/open_sub@1.0.0");
  });

  test("only the strict shape can become a fact", () => {
    expect(() => fact("mail bob@1.0.0 now")).toThrow("not a fact shape");
    expect(() => fact("kvfcu/open_sub@1.0")).toThrow("not a fact shape");
    expect(() => fact("Bob/Open@1.0.0")).toThrow("not a fact shape");
  });
});
