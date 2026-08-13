interface ConditionalFieldProps {
  weight: number;
  label: string;
}

/**
 * A local const derived from a prop decides a ternary below it. Folding the
 * const into the env is what makes the textarea provably unreachable at the
 * defaults the spec passes (weight = 0).
 */
export function ConditionalField({ weight, label }: ConditionalFieldProps) {
  const boosted = weight > 1;
  return (
    <div>
      <p>{label}</p>
      <span>Always here</span>
      {boosted ? <textarea id="boost" name="boost" /> : null}
    </div>
  );
}
