// Ambient augmentation for the repo's own tsc, which typechecks tests/**
// against the repo's node_modules: the repo's @types/react is 18.3.x, which
// predates two things this fixture uses — stable `useActionState` (it sits in
// react/canary.d.ts, a separate entry plain `from "react"` imports never
// load) and function-valued form `action` (18 leaves the marker interface
// below EMPTY, so `action` is string-only). This fixture's package.json
// declares react 19, where both are stable (the repo's node_modules ships
// react 19.1.0, which exports both). The augmentation copies the 19 shape of
// each into the 18 types so the import and the `<form action>` attribute
// typecheck here.
//
// Nothing the analyser or the emitted suite depends on this: the analyser
// recognises useActionState syntactically, and the emitted suite runs
// against the app's own react.
import "react";

declare module "react" {
  // Filled exactly as @types/react 19 fills it: `form` is the one action
  // shape a <form> accepts.
  interface DO_NOT_USE_OR_YOU_WILL_BE_FIRED_EXPERIMENTAL_FORM_ACTIONS {
    form: (formData: FormData) => void | Promise<void>;
  }

  export function useActionState<State>(
    action: (state: Awaited<State>) => State | Promise<State>,
    initialState: Awaited<State>,
    permalink?: string,
  ): [state: Awaited<State>, dispatch: () => void, isPending: boolean];
  export function useActionState<State, Payload>(
    action: (state: Awaited<State>, payload: Payload) => State | Promise<State>,
    initialState: Awaited<State>,
    permalink?: string,
  ): [state: Awaited<State>, dispatch: (payload: Payload) => void, isPending: boolean];
}
