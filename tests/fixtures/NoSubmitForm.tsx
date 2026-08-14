import type * as React from "react";

/**
 * The negative case: a form whose only button is an explicit `type="button"`,
 * plus a `<Button>` component tag whose type is unstated. Neither submits it —
 * base-ui and shadcn both render type="button" by default, so the absence of a
 * type attribute on a component tag is not evidence of anything. The generator
 * must skip with a reason rather than pick one and wait out the timeout.
 */
const Button: React.FC<React.ComponentProps<"button">> = (p) => <button {...p} />;

export const NoSubmitForm: React.FC<{ onChange: () => void }> = ({ onChange }) => {
  return (
    <form onChange={onChange}>
      <label htmlFor="q">Query</label>
      <input id="q" name="q" type="text" />
      <button type="button">Clear</button>
      <Button>Go</Button>
    </form>
  );
};

export default NoSubmitForm;
