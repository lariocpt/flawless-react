// Class components, and the near-misses that must NOT be mistaken for one.
//
// findComponents handled function declarations and variable statements only, so
// every one of these was invisible: parseFile threw "could not locate a React
// component" and core.ts turned that into a warning and exit 0 — while
// sourceCache had counted the exported class as an export all along.
import { Component, PureComponent, type ReactNode } from "react";
import * as React from "react";

interface PanelProps {
  title: string;
}

/** The ordinary case: extends Component, render() returns JSX. */
export class Panel extends Component<PanelProps> {
  override render() {
    return <section>{this.props.title}</section>;
  }
}

/** PureComponent counts too — same base, same contract. */
export class PurePanel extends PureComponent<PanelProps> {
  override render() {
    return <section>{this.props.title}</section>;
  }
}

/** Reached through a namespace, which is how a lot of older code writes it. */
export default class NamespacedPanel extends React.Component<PanelProps> {
  override render() {
    return <article>{this.props.title}</article>;
  }
}

/** Not exported: found, but specTargets filters it out, like any other. */
class InnerPanel extends Component<PanelProps> {
  override render() {
    return <div>{this.props.title}</div>;
  }
}
void InnerPanel;

// --- near misses, none of which is a React component --------------------------

/** Extends nothing React-ish. Having a render() that returns JSX is not enough. */
export class NotAComponent {
  render() {
    return <div>no</div>;
  }
}

/** Extends Component but renders no JSX — nothing a spec could describe. */
export class Headless extends Component<{ children: ReactNode }> {
  override render() {
    return null;
  }
}

/** Extends an unrelated base that merely shares the shape. */
class Base {
  render(): ReactNode {
    return null;
  }
}
export class Derived extends Base {
  override render() {
    return <div>still not react</div>;
  }
}
