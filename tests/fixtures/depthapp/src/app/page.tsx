// Home page: every surface pattern on one route — except P8EffectFetch. The
// page spec asserts its INITIAL render synchronously, while P8's mount fetch
// is a grandchild effect the page's analysis cannot track; its async settle
// would race that assertion. P8 is driven by its own spec, which carries the
// msw fixture and the four fetch-state tests.
import { P1AlwaysDisabled } from "../components/P1AlwaysDisabled";
import { P10ActionForm } from "../components/P10ActionForm";
import { P2StateToAttribute } from "../components/P2StateToAttribute";
import { P3HostAriaLabel } from "../components/P3HostAriaLabel";
import { P4ClickFetch } from "../components/P4ClickFetch";
import { P5PropPredicate } from "../components/P5PropPredicate";
import { P7CappedVariants } from "../components/P7CappedVariants";
import { P9SetterTransition } from "../components/P9SetterTransition";
import { N1ConditionalDisabled } from "../components/N1ConditionalDisabled";
import { N2ComputedAriaLabel } from "../components/N2ComputedAriaLabel";

export default function HomePage() {
  return (
    <main>
      <P1AlwaysDisabled />
      <P2StateToAttribute />
      <P3HostAriaLabel />
      <P4ClickFetch />
      <P5PropPredicate empty={false} />
      <P7CappedVariants size="md" />
      <P9SetterTransition />
      <P10ActionForm />
      <N1ConditionalDisabled />
      <N2ComputedAriaLabel count={2} />
    </main>
  );
}
