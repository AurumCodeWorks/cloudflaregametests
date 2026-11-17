// Types for public/machines.js, which the server imports too (one implementation for both sides).
export interface Pay { key: string; label: string; mult: number; show?: string[]; example?: string[] }
export interface Machine { id: string; name: string; kind: "classic" | "cards"; rows: number; blurb: string; reels: string[][]; pays: Pay[] }
export const STAKES: number[];
export function formatMoney(pence: number): string;
export const MIN_SPIN_MS: number;
export const MACHINES: Record<string, Machine>;
export const MACHINE_IDS: string[];
export function reelSizes(id: string): number[];
export function lineOf(id: string, stops: number[]): string[];
export function evaluate(id: string, stops: number[]): { mult: number; key: string | null; label: string | null; cells: number[]; line: string[] };
export function exactRtp(id: string): {
  combos: number; totalMult: number; rtp: number; maxMult: number; anyReturn: number; winRate: number; variance: number;
  lines: Record<string, { count: number; mult: number }>;
};
export function celebrationTier(stake: number, payout: number): "none" | "small" | "medium" | "big";
