// Undecidable, and NOT an error boundary — the case that must still be refused.
//
// `flag` comes from a hook this analysis does not follow, and BOTH branches
// return content, so there is no single render to describe. Unlike an error
// boundary, nothing in React's contract tells a spec how to reach either one.
//
// ClassBoundary used to stand in for this. It is an error boundary, so it now
// gets a real two-path spec — which left the refusal tests asserting against a
// file that no longer refuses.
import { useFeatureFlag } from "./useFeatureFlag";

export function UndecidableRender({ label }: { label: string }) {
  const flag = useFeatureFlag();
  if (flag) {
    return (
      <section>
        <span>Behind the flag</span>
        <button type="button" onClick={() => undefined}>
          Flagged action
        </button>
      </section>
    );
  }
  return <article>{label}</article>;
}
