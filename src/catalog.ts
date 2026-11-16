// Cosmetic catalogue. Every item is sold directly (no random packs) and is purely visual:
// nothing here changes odds, information or speed of play.
// Prices are placeholder suggestions in pence, to be set by the business.

export type ItemType = "deck" | "room" | "chips" | "celebration" | "bundle";

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
  // Chip sets (modelled on real casino chip construction)
  { id: "chips:casino", type: "chips", name: "Casino Clay", tier: 1, pricePence: 0, description: "Classic clay chips: six edge inserts, suited mold, ivory inlay. Free for everyone." },
  { id: "chips:tricolour", type: "chips", name: "Tri-Colour Clay", tier: 2, pricePence: 149, description: "Three-colour edge inserts and a coloured inlay ring." },
  { id: "chips:ceramic", type: "chips", name: "Ceramic Pro", tier: 3, pricePence: 249, description: "Edge-to-edge printed ceramic with a glossy finish." },
  { id: "chips:highroller", type: "chips", name: "High Roller", tier: 4, pricePence: 349, description: "Jewel-tone bodies, eight inserts, gold-foil inlay." },
  { id: "chips:pearl", type: "chips", name: "Mother of Pearl", tier: 5, pricePence: 449, description: "Pearlescent bodies with an iridescent sheen." },
  { id: "chips:goldfoil", type: "chips", name: "Gold Foil", tier: 6, pricePence: 699, description: "Flagship: hot-stamped gold rim, inserts and inlay, with a travelling glint." },
  // Win celebrations
  { id: "celebration:glow", type: "celebration", name: "Glow", tier: 1, pricePence: 0, description: "Winner pulse and rising total. Free for everyone." },
  { id: "celebration:chipshower", type: "celebration", name: "Chip Shower", tier: 2, pricePence: 149, description: "Your chips burst up and rain down." },
  { id: "celebration:confetti", type: "celebration", name: "Confetti", tier: 3, pricePence: 249, description: "Twin confetti cannons." },
  { id: "celebration:spotlight", type: "celebration", name: "Spotlight", tier: 4, pricePence: 349, description: "The room dims, a spotlight finds you, sparkles." },
  { id: "celebration:fireworks", type: "celebration", name: "Fireworks", tier: 5, pricePence: 449, description: "Four firework bursts over the table." },
  { id: "celebration:goldrush", type: "celebration", name: "Gold Rush", tier: 6, pricePence: 699, description: "Flagship: light rays, a gold coin fountain and a foil BIG WIN headline." },
  // Collections: a room with its matching deck, at a discount
  { id: "bundle:after-hours", type: "bundle", name: "After Hours Collection", tier: 2, pricePence: 299, description: "Midnight room + Casino Pro deck.", includes: ["room:midnight", "deck:casino"] },
  { id: "bundle:high-roller", type: "bundle", name: "High Roller Collection", tier: 3, pricePence: 499, description: "Vegas room + Art Deco deck.", includes: ["room:vegas", "deck:deco"] },
  { id: "bundle:monaco", type: "bundle", name: "Monaco Collection", tier: 4, pricePence: 699, description: "Riviera room + Royal Four-Colour deck.", includes: ["room:riviera", "deck:royal"] },
  { id: "bundle:prohibition", type: "bundle", name: "Prohibition Collection", tier: 5, pricePence: 799, description: "Speakeasy room + Noir deck.", includes: ["room:speakeasy", "deck:noir"] },
  { id: "bundle:penthouse", type: "bundle", name: "Penthouse Collection", tier: 6, pricePence: 1299, description: "Penthouse room + Ivory & Gold deck.", includes: ["room:penthouse", "deck:ivory"] },
  { id: "bundle:high-life", type: "bundle", name: "The High Life", tier: 6, pricePence: 2299, description: "Penthouse room, Ivory & Gold deck, Gold Foil chips and Gold Rush celebration.", includes: ["room:penthouse", "deck:ivory", "chips:goldfoil", "celebration:goldrush"] },
  {
    id: "bundle:everything", type: "bundle", name: "The Full House", tier: 6, pricePence: 3999,
    description: "Every deck, room, chip set and celebration.",
    includes: [
      "deck:casino", "deck:deco", "deck:noir", "deck:royal", "deck:ivory",
      "room:midnight", "room:vegas", "room:riviera", "room:speakeasy", "room:penthouse",
      "chips:tricolour", "chips:ceramic", "chips:highroller", "chips:pearl", "chips:goldfoil",
      "celebration:chipshower", "celebration:confetti", "celebration:spotlight", "celebration:fireworks", "celebration:goldrush",
    ],
  },
];

export const FREE_ITEMS = CATALOG.filter((i) => i.pricePence === 0).map((i) => i.id);

/** Items a purchase unlocks (a bundle unlocks its contents). */
export function unlocks(itemId: string): string[] {
  const item = CATALOG.find((i) => i.id === itemId);
  if (!item) return [];
  return item.type === "bundle" ? (item.includes ?? []) : [item.id];
}
