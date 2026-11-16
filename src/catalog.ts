// Cosmetic catalogue. Every item is sold directly (no random packs) and is purely visual:
// nothing here changes odds, information or speed of play.
// Prices are placeholder suggestions in pence, to be set by the business.

export type ItemType = "deck" | "room" | "bundle";

export interface CatalogItem {
  id: string;
  type: ItemType;
  name: string;
  tier: number; // 1 = base/free ... 6 = flagship
  pricePence: number; // 0 = free for everyone
  description: string;
  includes?: string[]; // bundles only
}

export const CATALOG: CatalogItem[] = [
  // Card decks
  { id: "deck:modern", type: "deck", name: "Modern", tier: 1, pricePence: 0, description: "Clean minimal deck. Free for everyone." },
  { id: "deck:casino", type: "deck", name: "Casino Pro", tier: 2, pricePence: 199, description: "Crisp white, jumbo indices, glossy sheen." },
  { id: "deck:deco", type: "deck", name: "Art Deco", tier: 3, pricePence: 299, description: "1920s black-and-gold portraits, gilded edges." },
  { id: "deck:noir", type: "deck", name: "Noir", tier: 4, pricePence: 399, description: "Matte black with gold and red foil, white halo." },
  { id: "deck:royal", type: "deck", name: "Royal Four-Colour", tier: 5, pricePence: 499, description: "Four suit colours, gilded edges, gold glow." },
  { id: "deck:ivory", type: "deck", name: "Ivory & Gold", tier: 6, pricePence: 799, description: "Flagship: linen stock, gold glow, animated foil shimmer." },
  // Rooms
  { id: "room:classic", type: "room", name: "Classic", tier: 1, pricePence: 0, description: "Green felt and walnut rail. Free for everyone." },
  { id: "room:midnight", type: "room", name: "Midnight", tier: 2, pricePence: 199, description: "Navy felt, charcoal leather." },
  { id: "room:vegas", type: "room", name: "Vegas", tier: 3, pricePence: 299, description: "Crimson felt, black leather, gold stitching." },
  { id: "room:riviera", type: "room", name: "Riviera", tier: 4, pricePence: 399, description: "Teal felt, cream leather, Mediterranean dusk." },
  { id: "room:speakeasy", type: "room", name: "Speakeasy", tier: 5, pricePence: 499, description: "Bottle-green felt, mahogany and brass, lamp light." },
  { id: "room:penthouse", type: "room", name: "Penthouse", tier: 6, pricePence: 799, description: "Flagship: black latticed felt, marble rail, glowing gold inlay." },
  // Collections: a room with its matching deck, at a discount
  { id: "bundle:after-hours", type: "bundle", name: "After Hours Collection", tier: 2, pricePence: 299, description: "Midnight room + Casino Pro deck.", includes: ["room:midnight", "deck:casino"] },
  { id: "bundle:high-roller", type: "bundle", name: "High Roller Collection", tier: 3, pricePence: 499, description: "Vegas room + Art Deco deck.", includes: ["room:vegas", "deck:deco"] },
  { id: "bundle:monaco", type: "bundle", name: "Monaco Collection", tier: 4, pricePence: 699, description: "Riviera room + Royal Four-Colour deck.", includes: ["room:riviera", "deck:royal"] },
  { id: "bundle:prohibition", type: "bundle", name: "Prohibition Collection", tier: 5, pricePence: 799, description: "Speakeasy room + Noir deck.", includes: ["room:speakeasy", "deck:noir"] },
  { id: "bundle:penthouse", type: "bundle", name: "Penthouse Collection", tier: 6, pricePence: 1299, description: "Penthouse room + Ivory & Gold deck.", includes: ["room:penthouse", "deck:ivory"] },
  {
    id: "bundle:everything", type: "bundle", name: "The Full House", tier: 6, pricePence: 2499,
    description: "Every deck and every room.",
    includes: ["deck:casino", "deck:deco", "deck:noir", "deck:royal", "deck:ivory", "room:midnight", "room:vegas", "room:riviera", "room:speakeasy", "room:penthouse"],
  },
];

export const FREE_ITEMS = CATALOG.filter((i) => i.pricePence === 0).map((i) => i.id);

/** Items a purchase unlocks (a bundle unlocks its contents). */
export function unlocks(itemId: string): string[] {
  const item = CATALOG.find((i) => i.id === itemId);
  if (!item) return [];
  return item.type === "bundle" ? (item.includes ?? []) : [item.id];
}
