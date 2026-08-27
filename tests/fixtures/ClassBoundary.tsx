// A class whose render() branches on state the analyser cannot decide.
//
// This is the shape that made B-17's detection produce a FAILING spec: the only
// clickable control lives inside the fallback branch, so a spec built from a
// whole-body walk drives a button the defaults never render. Executed, that is
// "Unable to find an accessible element with the role 'button' and name
// 'Try again'" against a component that is entirely correct.
//
// The happy path returns children wrapped in a real element on purpose: a bare
// `return this.props.children` also trips the pre-existing firstElementChild
// assertion, which would confound the finding this fixture exists to pin.
import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export class ClassBoundary extends Component<Props, State> {
  override state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  override componentDidCatch(error: Error): void {
    console.error(error);
  }

  reset = () => {
    this.setState({ hasError: false });
  };

  override render() {
    if (this.state.hasError) {
      return (
        <div>
          <span>Something went wrong</span>
          <button type="button" onClick={this.reset}>
            Try again
          </button>
        </div>
      );
    }
    return <div>{this.props.children}</div>;
  }
}
