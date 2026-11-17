// Types for public/fair.js, which the server imports too (one implementation for both sides).
export type RevealItem = { card: string; salt: string } | { leaf: string };
export function sha256Hex(text: string): Promise<string>;
export function permutationFrom(commit: string, seeds?: string[]): Promise<number[]>;
export function newSeed(): string;
export function dealPositions(button: number, dealtIn: boolean[]): { hole: Record<number, [number, number]>; board: number[] };
export function verifyDeal(input: {
  commit: string; reveal: RevealItem[]; seeds?: string[]; button: number; dealtIn: boolean[]; board: string[]; holes: Record<number, string[]>;
}): Promise<boolean>;
