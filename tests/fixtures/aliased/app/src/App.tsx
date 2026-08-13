// @ts-nocheck — the "@/…" aliases resolve through this fixture's own tsconfig
// chain (app/tsconfig.json extends ../tsconfig.base.json), not the repo root.
import { Fragment } from "react";
import { Widget } from "@/components/Widget";
import * as UI from "@/components/ui";

export function App() {
  return (
    <Fragment>
      <main>
        <Widget label="hello" />
        <UI.Badge text="new" />
      </main>
    </Fragment>
  );
}
