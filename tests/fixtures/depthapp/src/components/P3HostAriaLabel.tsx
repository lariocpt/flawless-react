// P3 — D1 item 7, host case (salvaged by this branch): a host element's
// STATIC aria-label/role is asserted only through a locator rung that does
// not read that attribute. Button A is located by testid, so both attributes
// are asserted; button B is located by its own aria-label, so only the role
// is — asserting the label would tautologise the locator.
"use client";

export function P3HostAriaLabel() {
  function submit() {}
  function openMenu() {}
  return (
    <div>
      <button
        data-testid="p3-submit"
        aria-label="Submit document"
        role="button"
        onClick={submit}
      />
      <button aria-label="Open menu" role="button" onClick={openMenu} />
    </div>
  );
}
