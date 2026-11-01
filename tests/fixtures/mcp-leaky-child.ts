// A `flawless-react` child stand-in for the teardown tests: prints a --ci-shaped
// blob, spawns a straggler that inherits its stdout and outlives it, and exits.
// Models a test runner that leaks a dev server holding the output pipe — the
// one shape the child watchdog cannot cover, because by the time the straggler
// matters, the direct child it would kill is already gone.
//
// argv[2] (when given) is a file to write the straggler's pid into, so the
// caller can prove the group kill reached it.
const straggler = Bun.spawn(["sleep", "30"], { stdout: "inherit", stderr: "inherit" });
const pidFile = process.argv[2];
if (pidFile) await Bun.write(pidFile, String(straggler.pid));
console.log('{"exitCode":0}');
process.exit(0);
