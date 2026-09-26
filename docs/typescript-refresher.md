# Modern TypeScript refresher

Short notes on the newer TypeScript features that intyy uses.
Each entry says what the feature is, shows an example, and says why intyy uses it.
New entries go at the end, the first time the code uses a feature.

## 1. ES modules and `import type`

- **An ES module** is a file that uses `import` and `export`. `"type": "module"` in `package.json` makes every `.js` file one.
- **Import paths end in `.js`,** even in a `.ts` file. The path names the compiled output.
- **`import type`** imports a type only. The compiler deletes the line from the output.
- **`verbatimModuleSyntax`** makes you write `import type` for types. So the output keeps exactly the imports you wrote.

```ts
import { Command } from "commander";          // a value, kept in the output
import type { Outcome } from "./outcome.js";  // a type, deleted from the output
```

- **Why intyy uses it:** Node 24 runs ES modules natively. Type-only imports never load a module at run time.

## 2. The strict flags

`tsconfig.json` turns on `strict` and two extra flags.

| Flag | What it does | Example it catches |
|---|---|---|
| `strict` | Turns on null checks, no implicit `any`, and more | `name.length` when `name` may be `undefined` |
| `noUncheckedIndexedAccess` | An index read may be `undefined` | `lines[0].trim()` on an empty array |
| `exactOptionalPropertyTypes` | An optional property may be absent, but not set to `undefined` | `{ note: undefined }` where `note?: string` |

- **Why intyy uses them:** section 1 §15 locks them. They turn runtime crashes into compile errors.

## 3. `unknown` versus `any`

- **`any`** switches off type checks. Anything goes, so bugs slip through.
- **`unknown`** means "some value, type not known yet". You must narrow it before use.
- **Narrowing** is a check that tells the compiler the real type. Examples: `typeof`, `in`, `Array.isArray`.

```ts
const pkg: unknown = JSON.parse(text);
if (typeof pkg === "object" && pkg !== null && "version" in pkg && typeof pkg.version === "string") {
  console.log(pkg.version); // the compiler knows this is a string
}
```

- **Why intyy uses it:** CLAUDE.md bans `any`. Data from files and the network always starts as `unknown`.

## 4. Union types with a `kind` field

- **A union type** is "one of these shapes". The `|` symbol joins the shapes.
- **A discriminated union** gives every shape a field with a fixed string, like `kind`. A check on `kind` narrows to one shape.

```ts
type Outcome<T> =
  | { kind: "ok"; value: T }
  | { kind: "failed"; reason: "unreachable" | "browser_failed" };

function show(o: Outcome<string>): string {
  if (o.kind === "ok") return o.value; // only the "ok" shape has value
  return o.reason;
}
```

- **Why intyy uses it:** expected trouble returns an `Outcome` value, not an exception (CLAUDE.md).

## 5. Branded types

- **A branded type** is a normal type plus an invisible tag. Other values of the same base type do not fit.
- **The brand exists only at compile time.** At run time the value is a plain string.

```ts
type Masked<T> = T & { readonly __masked: unique symbol };

function logText(text: Masked<string>): void { /* ... */ }
logText("100107"); // compile error: a raw string is not Masked
```

- **Why intyy uses it:** only redaction may create `Masked` values. A lint rule bans the cast everywhere else (build plan §5.3).

## 6. `satisfies`

- **`satisfies`** checks that a value fits a type. The value keeps its own, narrower type.
- **A type annotation** (`: Type`) widens the value to the type. `satisfies` does not.

```ts
const exitCodes = { ok: 0, refused: 3 } satisfies Record<string, number>;
exitCodes.refused; // type 3, and a typo like exitCodes.refsued is a compile error
```

- **Why intyy uses it:** config tables stay checked, and their exact keys stay known.

## 7. `z.infer`

- **Zod** is a library that checks data at run time. A Zod schema describes the data shape once.
- **`z.infer`** turns a schema into a TypeScript type. So the check and the type never drift apart.

```ts
import { z } from "zod";

const Config = z.object({ schema: z.literal("intyy.config/1.0"), library: z.string() });
type Config = z.infer<typeof Config>; // { schema: "intyy.config/1.0"; library: string }

const config: Config = Config.parse(JSON.parse(text)); // throws on a bad file
```

- **Why intyy uses it:** CLAUDE.md asks for one Zod schema per file format, in `src/core/model/`. Types come from `z.infer`.

## 8. `async`, `await`, and top-level `await`

- **An `async` function** always returns a `Promise`. `await` pauses the function until the promise settles.
- **A floating promise** is a promise that nobody awaits. Its errors vanish. The lint rules flag it.
- **Top-level `await`** works at the top of an ES module, outside any function.

```ts
async function checkHome(origin: URL): Promise<void> {
  const res = await fetch(new URL("/", origin));
  if (res.status >= 400) throw new Error(`GET / answered ${String(res.status)}`);
}

await checkHome(new URL("http://127.0.0.1:8080")); // top-level await in an ES module
```

- **Why intyy uses it:** browser steps, file writes, and HTTP calls are all asynchronous. An unawaited step could run out of order.
