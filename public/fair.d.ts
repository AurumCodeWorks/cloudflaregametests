// Types for public/fair.js, which the server imports too (one implementation for both sides).
export type RevealItem = { card: string; salt: string } | { leaf: string };
export function sha256Hex(text: string): Promise<string>;
export function permutationFrom(commit: string, seeds?: string[]): Promise<number[]>;
export function newSeed(): string;
export function dealPositions(button: number, dealtIn: boolean[]): { hole: Record<number, [number, number]>; board: number[] };
export function verifyDeal(input: {
  commit: string; reveal: RevealItem[]; seeds?: string[]; button: number; dealtIn: boolean[]; board: string[]; holes: Record<number, string[]>;
}): Promise<boolean>;
export function hmacSha256Hex(key: string, message: string): Promise<string>;
export function spinMessage(clientSeed: string, nonce: number, machine: string, round: number): string;
export function digestWords(digestHex: string): number[];
export function stopsFromWords(words: number[], sizes: number[]): number[] | null;
export function spinStops(input: { serverSeed: string; clientSeed: string; nonce: number; machine: string; sizes: number[] }): Promise<number[]>;
export const CLIENT_SEED: RegExp;
export function verifySpin(input: { commit: string; serverSeed: string; clientSeed: string; nonce: number; machine: string; sizes: number[]; stops: number[] }): Promise<boolean>;
