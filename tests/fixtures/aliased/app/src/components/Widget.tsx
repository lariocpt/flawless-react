import type { FC } from "react";

interface WidgetProps {
  label: string;
}

export const Widget: FC<WidgetProps> = ({ label }) => <strong>{label}</strong>;
