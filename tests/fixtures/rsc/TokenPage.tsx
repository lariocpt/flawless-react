// @ts-nocheck — parsed, not typechecked, like its siblings.
// Prop-decided branches: a bare optional searchParam and one compared to a
// literal — the DEFAULTS decide both, and buildProps overrides flip them.
interface Props {
  searchParams: Promise<{ token?: string; error?: string }>;
}

export default async function TokenPage({ searchParams }: Props) {
  const { token, error } = await searchParams;
  return (
    <main>
      {token ? <p>Enter a new password</p> : <p>This reset link is missing or malformed</p>}
      {error === "expired" ? <b>The link has expired</b> : null}
    </main>
  );
}
