import type * as React from "react";
import { RealButton } from "./RealButton.tsx";

/** Root is another component, so no host tag is knowable from here. */
export const WrapsAComponent: React.FC = () => <RealButton>Go</RealButton>;

export default WrapsAComponent;
