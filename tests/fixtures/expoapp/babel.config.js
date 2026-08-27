// jsxImportSource is how NativeWind's className works at all, and it only ever
// runs through babel — which is why a bundler that does not run babel produces a
// structurally correct but entirely unstyled tree (docs/reviews/2026-08-expo-probes.md, P1).
module.exports = (api) => {
  api.cache(true);
  return { presets: [["babel-preset-expo", { jsxImportSource: "nativewind" }]] };
};
