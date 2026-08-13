interface StaticCopyProps {
  items: string[];
  showNote: boolean;
}

export function StaticCopy({ items, showNote }: StaticCopyProps) {
  return (
    <section>
      <h2>Recent activity</h2>
      <p>
        From <em>Asha</em>
      </p>
      <span>·</span>
      <span>→ →</span>
      {showNote ? <p>Conditional copy</p> : null}
      <ul>
        {items.map((item) => (
          <li key={item}>Mapped copy</li>
        ))}
      </ul>
      <button type="button" aria-label={"Refresh the activity brief"}>
        {"Refresh brief"}
      </button>
    </section>
  );
}
