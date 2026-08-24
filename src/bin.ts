// Compile entry point for `bun build --compile`.
//
// bin/flawless-react is the npm entry and stays as-is: a `#!/usr/bin/env bun` shim that
// imports ../src/cli.ts. It cannot double as the compile entry, because it has no file
// extension — `bun build --compile bin/flawless-react` cannot pick a loader for it, treats it
// as an opaque asset, reports "bundle 1 modules", and emits a binary that silently does
// nothing at all. Every flag, including --help, exits 0 with no output.
//
// src/cli.ts cannot be the compile entry either: it only *exports* main() and never calls it,
// so compiling it produces the same silent no-op binary.
//
// Hence this file. It exists solely so the compiled artifact has a real, extensioned entry
// that actually invokes main().
import { main } from "./cli.ts";

try {
  await main(Bun.argv.slice(2));
} catch (err) {
  // A rejection escaping main() must land on the documented exit-1 contract,
  // not surface as the runtime's uncaught-error dump.
  process.stderr.write(`${String((err as Error | undefined)?.stack ?? err)}\n`);
  process.exit(1);
}
