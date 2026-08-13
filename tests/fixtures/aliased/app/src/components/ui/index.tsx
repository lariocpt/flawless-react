import type { FC } from "react";

interface BadgeProps {
  text: string;
}

export const Badge: FC<BadgeProps> = ({ text }) => <em className="badge">{text}</em>;

export const Pill: FC<BadgeProps> = ({ text }) => <span className="pill">{text}</span>;
