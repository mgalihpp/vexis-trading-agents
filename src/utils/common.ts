import type { DecisionLogEntry } from "../types";

export const toLogJson = (entry: DecisionLogEntry): string => JSON.stringify(entry);

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const round = (value: number, digits = 4): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};
