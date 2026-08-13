import type * as React from "react";

// Stands in for shadcn's <Label>, which forwards htmlFor to a real <label>.
function Label(props: { htmlFor: string; children: React.ReactNode }) {
  return <label htmlFor={props.htmlFor}>{props.children}</label>;
}

interface Props {
  onSubmit: (data: { title: string; body: string }) => void;
}

export const LabelledForm: React.FC<Props> = ({ onSubmit }) => {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ title: "", body: "" });
      }}
    >
      {/* An uppercase wrapper carrying htmlFor: still a real accessible label. */}
      <Label htmlFor="title">Title</Label>
      <input id="title" name="title" type="text" placeholder="A short summary" />

      {/* Placeholder only, no label anywhere — must NOT be treated as labelled. */}
      <textarea name="body" placeholder="Add an update — context or progress." />

      <button type="submit">Post update</button>
    </form>
  );
};

export default LabelledForm;
