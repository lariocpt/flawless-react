export function SuppressedElsewhere() {
  return (
    <div>
      {/* The suppression below answers a rule from the PROJECT's config. A
          narrowed sweep that does not enable lint/a11y must not re-report it
          as an unused suppression. */}
      {/** biome-ignore below is attribute-adjacent on purpose. */}
      <img
        // biome-ignore lint/a11y/useAltText: decorative — answered in the project's own config
        src="/x.png"
      />
    </div>
  );
}
