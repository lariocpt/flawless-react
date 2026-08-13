"use client";

export function A() {
  return (
    <section>
      <B />
    </section>
  );
}

function B() {
  return <p>b</p>;
}
