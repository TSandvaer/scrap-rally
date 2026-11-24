// "Scrapyard 32": the fixed palette of the polished graphics (PLAN-GFX.md). Every pixel of the
// baked world, the effects and the HUD is one of these 32 colours; the DOM skin mirrors them
// in style.css :root. Cars are the exception: each car colour has three tones of its own
// (carTones), because the six server colours have no ramp here.
//
// One tone stands outside the 32: `water`, the body of a pool (M4-WORLD; user decision
// 2026-11-21, "a murky blue-grey": the 32 have no blue, and a pool in steel grey read as a
// metal plate). It is the last entry of P and of PALETTE, index SCRAPYARD, and water alone
// takes it: it is in no ramp, nothing is snapped to it (nearest), and the DOM does not mirror it.
//
// Our own palette, not a published one: each entry is taken or derived from a colour the game
// already draws (render.ts PAL and its literals, style.css :root); the comment says which.
// Ramps run dark to light. The sun is top-left: SHADE is the tone a colour takes in a cast
// shadow, LIT the tone of a 1 px sunlit edge. No alpha, no gradients: depth is two or three
// steps of a ramp, or an ordered (BAYER4) dither between two of them in small areas.

export const P = {
  // Soot: warm blacks. Pits, voids, outlines, tyres.
  soot0: "#050403", // PAL.pitDeep #030202: the bottom of a pit
  soot1: "#120e0b", // style.css --bg; PAL.void #0c0a08; the car outline #151210
  soot2: "#1d1a17", // PAL.hazardB (hazard stripes, chevron outline); tyres #1b1b1c
  soot3: "#2a2119", // PAL.rubble; PAL.rim #241c15
  // Dirt: the packed earth of the yard.
  dirt0: "#3b2e23", // PAL.pitWall; dirt in a cast shadow (today's 38% black over PAL.dirt)
  dirt1: "#4e3e2c", // the dark dirt speck #4e3e2c
  dirt2: "#5d4a35", // PAL.dirt
  dirt3: "#6f5a42", // the light dirt specks #6a5640 and #77634a, as one
  // Gravel: the verge. Its lightest step is bone0.
  gravel0: "#655640", // the dark gravel speck
  gravel1: "#7b6a50", // PAL.gravel
  gravel2: "#8f7d61", // the light gravel speck #8d7c61; PAL.edge #8a7d6a
  // Tarmac: warm greys.
  tar0: "#2b2927", // the dark tarmac speck #33302d, one step down: tarmac in shadow
  tar1: "#3b3835", // PAL.asphalt
  tar2: "#48433f", // the light tarmac speck #45413d
  tar3: "#66615a", // the centre dashes as they land today (PAL.dash at 55% over PAL.asphalt)
  // Steel: the one cool ramp. Barriers, ramp plates, junk.
  steel0: "#24282c", // PAL.wallDark; the windscreen #1e2a31
  steel1: "#4b545b", // between the two; the slate junk #3f4a5c
  steel2: "#7c858d", // PAL.wallLight, style.css --steel; PAL.steel #6f777d
  steel3: "#b6bec3", // new: the sunlit edge of steel
  // Rust: the signature ramp. Kerbs, junk, the accent.
  rust0: "#5c2616", // the dark red junk #6b2f2f, warmer: rust in shadow
  rust1: "#9c4419", // style.css --rust-dark
  rust2: "#c4532a", // PAL.kerbA
  rust3: "#e8752d", // PAL.accent, style.css --rust
  // Bone: off-whites. Kerbs, chevrons, text.
  bone0: "#a89981", // style.css --muted-solid; the lightest gravel speck #a29276
  bone1: "#ddd3bd", // PAL.kerbB
  bone2: "#efe6d2", // PAL.hudText, style.css --text; the start line's white #f1ece0
  // Hazard: warning yellow.
  haz0: "#8a6d2a", // the unarmed mine's lamp; the ochre junk #8a5a2b
  haz1: "#e0a526", // PAL.hazardA; the hp bar's amber #e8b83a
  haz2: "#ffe9a8", // the car lamps; the rivet #fff4cf
  // Signals: one of each.
  blast: "#ff9a33", // new: the one blast orange, between rust3 and haz1 and brighter than both
  red: "#e8452d", // the hp bar's red; the armed mine's lamp #ff3b2f
  green: "#7bc95a", // the hp bar's green
  // Not one of the 32: water, and nothing but water (see the top of the file).
  water: "#3a5068", // new: a murky blue-grey, darker than steel1 and bluer than any steel
} as const;

export type PaletteName = keyof typeof P;

/** How many of the entries are the palette proper: the 32. The one after them is `water`. */
export const SCRAPYARD = 32;

/** The 32 entries in order, then `water` (the index a baked tile stores). */
export const PALETTE: readonly { name: PaletteName; hex: string }[] = (Object.keys(P) as PaletteName[]).map((name) => ({ name, hex: P[name] }));

/** The ramps, dark to light. bone0 closes the gravel ramp and opens the bone ramp. */
export const RAMPS: Readonly<Record<string, readonly PaletteName[]>> = {
  soot: ["soot0", "soot1", "soot2", "soot3"],
  dirt: ["dirt0", "dirt1", "dirt2", "dirt3"],
  gravel: ["gravel0", "gravel1", "gravel2", "bone0"],
  tarmac: ["tar0", "tar1", "tar2", "tar3"],
  steel: ["steel0", "steel1", "steel2", "steel3"],
  rust: ["rust0", "rust1", "rust2", "rust3"],
  bone: ["bone0", "bone1", "bone2"],
  hazard: ["haz0", "haz1", "haz2"],
  signal: ["blast", "red", "green"],
};

/** A colour in a hard cast shadow (about today's 38% black, kept on the palette). */
export const SHADE: Readonly<Record<PaletteName, PaletteName>> = {
  soot0: "soot0", soot1: "soot0", soot2: "soot1", soot3: "soot1",
  dirt0: "soot3", dirt1: "soot3", dirt2: "dirt0", dirt3: "dirt1",
  gravel0: "dirt0", gravel1: "dirt1", gravel2: "dirt2",
  tar0: "soot2", tar1: "tar0", tar2: "tar0", tar3: "tar1",
  steel0: "soot2", steel1: "steel0", steel2: "steel1", steel3: "steel2",
  rust0: "soot3", rust1: "rust0", rust2: "rust1", rust3: "rust1",
  bone0: "gravel0", bone1: "bone0", bone2: "bone0",
  haz0: "dirt1", haz1: "haz0", haz2: "bone0",
  blast: "rust2", red: "rust1", green: "steel1",
  water: "steel0",
};

/** The 1 px sunlit (top-left) edge of a shape in that colour. */
export const LIT: Readonly<Record<PaletteName, PaletteName>> = {
  soot0: "soot1", soot1: "soot2", soot2: "soot3", soot3: "dirt0",
  dirt0: "dirt1", dirt1: "dirt2", dirt2: "dirt3", dirt3: "gravel1",
  gravel0: "gravel1", gravel1: "gravel2", gravel2: "bone0",
  tar0: "tar1", tar1: "tar2", tar2: "tar3", tar3: "bone0",
  steel0: "steel1", steel1: "steel2", steel2: "steel3", steel3: "bone2",
  rust0: "rust1", rust1: "rust2", rust2: "rust3", rust3: "blast",
  bone0: "bone1", bone1: "bone2", bone2: "bone2",
  haz0: "haz1", haz1: "haz2", haz2: "haz2", // haz2 is the lightest of the 32: its lit tone is itself
  blast: "haz2", red: "blast", green: "haz2",
  water: "steel1",
};

// ---- themes ---------------------------------------------------------------------------
//
// A track's surroundings (PLAN-THEMES.md 2.2): scrapyard, desert, city, jungle. A theme has the
// same 32 role names in colours of its own (the ground is `dirt` whether it is packed earth or
// sand), the same kind of SHADE and LIT links between them, and up to 31 colours more for the
// pixels of the baked world that take no track marks (a barrier, a prop, a void): the palette
// indices after `water`. What a mine's burn leaves is the theme's own too.
// - FIXED names have the same colour in every theme: soot (pits, voids, outlines), bone and
//   hazard (chevrons, lips, stripes), the signals, and the water, which stays blue-grey
//   wherever it lies (user decision 2026-11-21).
// - Cars, effects, cells, the obstacle sheet and the HUD keep the global 32 above, whatever the
//   theme: a theme recolours the baked world, nothing else.
// The tables a theme's tiles are made with are built in gfx/theme.ts (sceneryOf);
// tools/debug/theme-sheet.ts --check holds every theme to the rules.

/** The names whose colour no theme changes. */
export const FIXED: readonly PaletteName[] = ["soot0", "soot1", "soot2", "soot3", "bone0", "bone1", "bone2", "haz0", "haz1", "haz2", "blast", "red", "green", "water"];

/** One of a theme's colours beyond the 32 and `water`; `shade` and `lit` name a role or another extra of the theme. */
export interface Extra {
  name: string;
  hex: string;
  shade: string;
  lit: string;
}

/**
 * What a burn leaves on a colour, by how light the colour is (four bands of luminance: under
 * 45, under 85, under 150, lighter): `singed` and, deeper, `charred`. Names of roles or extras;
 * a pixel shows the darker of the tone here and its own cast-shadow tone (gfx/world.ts, track marks).
 */
export interface Burn {
  singed: readonly [string, string, string, string];
  charred: readonly [string, string, string, string];
}

export interface ThemePalette {
  colours: Readonly<Record<PaletteName, string>>;
  shade: Readonly<Record<PaletteName, PaletteName>>;
  lit: Readonly<Record<PaletteName, PaletteName>>;
  extras: readonly Extra[];
  burn: Burn;
}

/** The scrapyard: the palette above, as it is. */
export const SCRAPYARD_PALETTE: ThemePalette = {
  colours: P,
  shade: SHADE,
  lit: LIT,
  extras: [],
  burn: { singed: ["soot2", "soot3", "dirt0", "dirt1"], charred: ["soot1", "soot2", "soot3", "dirt0"] },
};

/**
 * The desert, "noon on the dunes" (PROVISIONAL: the user judges the look later). Our own
 * colours. The ground is pale ochre sand (`dirt`), the verge a darker grit (`gravel`), the
 * kerbs terracotta and bone (`rust`), the tarmac the scrapyard's with a warm tint and as dark.
 * Steel stays steel: ramps, plates and the truck are metal here too, and the water keeps its
 * edge and its glints. The extras: sandstone (the barrier's blocks), canyon rock (a gap's
 * layered walls, outcrops), burlap (sandbags), cactus green, and the two warm chars of a burn
 * (sand has no dark tone of its own to burn to).
 */
export const DESERT_PALETTE: ThemePalette = {
  colours: {
    ...P,
    // Sand. dirt0 is sand in a cast shadow, a little cooler.
    dirt0: "#7b6650",
    dirt1: "#ab8c58",
    dirt2: "#c9a86e",
    dirt3: "#dcc08a",
    // Grit: the verge, darker and greyer than the sand, so a rivet and a cell show on it.
    gravel0: "#695842",
    gravel1: "#857052",
    gravel2: "#a08a66",
    // Tarmac, tinted warm.
    tar0: "#2d2924",
    tar1: "#3e3932",
    tar2: "#4c453b",
    tar3: "#6a6253",
    // Clay and terracotta: rust1 is the red clay of a dirt patch, rust2 the kerb.
    rust0: "#5e3323",
    rust1: "#9a4a2c",
    rust2: "#c0603c",
    rust3: "#df8455",
  },
  shade: {
    ...SHADE,
    dirt0: "tar2", dirt1: "gravel0", dirt2: "dirt0", dirt3: "dirt1",
    gravel0: "tar1", gravel1: "rust0", gravel2: "gravel0",
    bone0: "gravel0",
    haz0: "rust0",
  },
  lit: {
    ...LIT,
    soot3: "rust0",
    dirt0: "dirt1", dirt1: "dirt2", dirt2: "dirt3", dirt3: "bone1",
    gravel0: "gravel1", gravel1: "gravel2", gravel2: "bone0",
  },
  extras: [
    { name: "stone0", hex: "#5f4c3a", shade: "soot3", lit: "stone1" },
    { name: "stone1", hex: "#8f7758", shade: "stone0", lit: "stone2" },
    { name: "stone2", hex: "#d6c19c", shade: "stone1", lit: "stone3" },
    { name: "stone3", hex: "#f0e2c0", shade: "stone2", lit: "stone3" },
    { name: "canyon0", hex: "#3a231a", shade: "soot2", lit: "canyon1" },
    { name: "canyon1", hex: "#5a3122", shade: "canyon0", lit: "canyon2" },
    { name: "canyon2", hex: "#7d4a30", shade: "canyon1", lit: "canyon3" },
    { name: "canyon3", hex: "#a36a45", shade: "canyon2", lit: "rust3" },
    { name: "bag0", hex: "#6e6247", shade: "soot3", lit: "bag1" },
    { name: "bag1", hex: "#a09068", shade: "bag0", lit: "bag2" },
    { name: "bag2", hex: "#c9bb92", shade: "bag1", lit: "bone2" },
    { name: "cactus0", hex: "#3f5a3a", shade: "soot3", lit: "cactus1" },
    { name: "cactus1", hex: "#5f7f4c", shade: "cactus0", lit: "cactus2" },
    { name: "cactus2", hex: "#8fa868", shade: "cactus1", lit: "bag2" },
    { name: "char0", hex: "#3b2e23", shade: "soot3", lit: "char1" },
    { name: "char1", hex: "#4e3e2c", shade: "char0", lit: "gravel0" },
    // Loose sand on the road (a sand patch, TH-LOOK-2): deeper than the bleached ground, so that
    // a rivet shows on it; its ripples' crests are the ground's own sand (dirt2).
    { name: "sand0", hex: "#7f6238", shade: "gravel0", lit: "sand1" },
    { name: "sand1", hex: "#9e804e", shade: "sand0", lit: "dirt2" },
  ],
  burn: { singed: ["soot2", "soot3", "char0", "char1"], charred: ["soot1", "soot2", "soot3", "char0"] },
};

/**
 * The city, "old town quarter" (TH-LOOK-2; PLAN-THEMES.md 2.2 and Amendment 1: a town, nothing
 * of a harbour). Our own colours. The ground between the houses is old paving, a brown-grey
 * (`dirt`); the verge a sidewalk of lighter slabs (`gravel`, its darkest tone the joints); the
 * kerb's stones are grey and white (steel2 and bone1); the tarmac the scrapyard's with a cool
 * tint and as dark. Steel and rust stay as they are: ramps, plates and belts are the same
 * metal here, and the water keeps its edge and its glints. The extras, all for pixels that take
 * no marks: concrete (the barrier), three roofs (clay tiles, slate, zinc), leaves (a planter's
 * tree), wood (crates, planters), three paints for parked cars (wine, moss, petrol: muted, and
 * none near a car's colour), and an oil slick's (a violet black, its gloss, the sheen at its edge).
 */
export const CITY_PALETTE: ThemePalette = {
  colours: {
    ...P,
    // Old paving. dirt0 is paving in a cast shadow: an alley.
    dirt0: "#2c2825",
    dirt1: "#413b36",
    dirt2: "#534c44",
    dirt3: "#676056",
    // The sidewalk: its joints, its slabs, a lighter slab.
    gravel0: "#56534c",
    gravel1: "#7c786e",
    gravel2: "#8f8b80",
    // Tarmac, tinted cool.
    tar0: "#28292b",
    tar1: "#37393c",
    tar2: "#44464a",
    tar3: "#5f6266",
  },
  shade: SHADE,
  lit: LIT,
  extras: [
    { name: "conc0", hex: "#4a4a48", shade: "soot3", lit: "conc1" },
    { name: "conc1", hex: "#6e6d68", shade: "conc0", lit: "conc2" },
    { name: "conc2", hex: "#a3a199", shade: "conc1", lit: "conc3" },
    { name: "conc3", hex: "#cfccc1", shade: "conc2", lit: "conc3" },
    { name: "tile0", hex: "#5c382d", shade: "soot3", lit: "tile1" },
    { name: "tile1", hex: "#7a4b3a", shade: "tile0", lit: "tile2" },
    { name: "tile2", hex: "#93604a", shade: "tile1", lit: "tile2" },
    { name: "slate0", hex: "#3b3c46", shade: "soot3", lit: "slate1" },
    { name: "slate1", hex: "#50525e", shade: "slate0", lit: "slate2" },
    { name: "slate2", hex: "#696b78", shade: "slate1", lit: "slate2" },
    { name: "zinc0", hex: "#535b56", shade: "dirt0", lit: "zinc1" },
    { name: "zinc1", hex: "#69726c", shade: "zinc0", lit: "zinc2" },
    { name: "zinc2", hex: "#858d86", shade: "zinc1", lit: "zinc2" },
    { name: "leaf0", hex: "#2f4a2c", shade: "soot3", lit: "leaf1" },
    { name: "leaf1", hex: "#446638", shade: "leaf0", lit: "leaf2" },
    { name: "leaf2", hex: "#5f8346", shade: "leaf1", lit: "leaf2" },
    { name: "wood0", hex: "#5a4026", shade: "soot3", lit: "wood1" },
    { name: "wood1", hex: "#80603a", shade: "wood0", lit: "wood2" },
    { name: "wood2", hex: "#a5824f", shade: "wood1", lit: "wood2" },
    { name: "wine0", hex: "#5e2a34", shade: "soot3", lit: "wine1" },
    { name: "wine1", hex: "#7d3a45", shade: "wine0", lit: "wine1" },
    { name: "moss0", hex: "#4d5233", shade: "soot3", lit: "moss1" },
    { name: "moss1", hex: "#686e45", shade: "moss0", lit: "moss1" },
    { name: "petrol0", hex: "#2c4f52", shade: "soot3", lit: "petrol1" },
    { name: "petrol1", hex: "#3f6c6e", shade: "petrol0", lit: "petrol1" },
    { name: "oil0", hex: "#0e0c14", shade: "soot0", lit: "oil1" },
    { name: "oil1", hex: "#1a1726", shade: "oil0", lit: "oil2" },
    { name: "oil2", hex: "#3b3556", shade: "oil1", lit: "oilv" },
    { name: "oilv", hex: "#9466b8", shade: "oil2", lit: "oilv" },
    { name: "oilt", hex: "#38a8a0", shade: "oil2", lit: "oilt" },
  ],
  burn: { singed: ["soot2", "soot3", "dirt0", "dirt1"], charred: ["soot1", "soot2", "soot3", "dirt0"] },
};

/**
 * The harbour, "working container port" (TH-LOOK-H; PLAN-THEMES.md Amendment 1, A1.2). Our own
 * colours. The ground is a quay of light concrete (`dirt`: its slabs, the joints between them a
 * tone down); the verge the apron beside the road, the same concrete worn darker (`gravel`); the
 * tarmac the scrapyard's without its warmth, a neutral grey as dark. Four greys, then, and each a clear
 * step from the next (tools/debug/theme-sheet.ts --check holds the numbers). `rust` is no rust
 * here but old yellow road paint: the kerb's painted slabs (rust2: faded, far less of a colour
 * than the hazard's amber, and none of the fixed hazard colours), its shade and its sunlit edge,
 * and darkest of it the brown of old timber (rust0: a rail sleeper, a belt's slats). Steel
 * stays steel: the kerb's bare slabs, ramps, plates and rails are the same metal and stone
 * grey here, and the water keeps its edge and its glints. Nothing in it is blue but the water.
 * The extras, all for pixels that take no marks: concrete (the jersey barrier), four paints of
 * containers and port machines (oxide red, green, ochre, and a reefer's white, which is a cool
 * grey: none near a car's colour), wood (pallets, and a hawser's hemp), the two warm chars of a
 * burn (concrete has no dark tone of its own to burn to), and the oil slick's, which are the
 * city's (PLAN-THEMES Amendment 1: oil lies on city and harbour tracks, and looks the same on both).
 */
export const HARBOUR_PALETTE: ThemePalette = {
  colours: {
    ...P,
    // Quay concrete. dirt0 is concrete in a cast shadow; dirt1 a joint, a dark speck.
    dirt0: "#5c5e5b",
    dirt1: "#7b7d77",
    dirt2: "#93948d",
    dirt3: "#a5a69e",
    // The apron: its pockets and dark specks, its plain tone, a light speck.
    gravel0: "#52524d",
    gravel1: "#72716a",
    gravel2: "#888780",
    // Tarmac: a neutral grey (no blue in it: the water is the one blue thing on the road).
    tar0: "#2a2b2b",
    tar1: "#393a3a",
    tar2: "#464848",
    tar3: "#616464",
    // Old yellow paint (and under it, old timber).
    rust0: "#4f4126",
    rust1: "#8c7438",
    rust2: "#bfae72",
    rust3: "#d6c68e",
  },
  // The scrapyard's links run through its earth tones, which are darker than its gravel; here the
  // ground is the lightest of the greys, so a shadow steps down through the apron and the tarmac.
  shade: {
    ...SHADE,
    dirt0: "tar1", dirt1: "tar2", dirt2: "dirt0", dirt3: "dirt0",
    gravel0: "tar1", gravel1: "tar2", gravel2: "gravel0",
    haz0: "rust0",
    blast: "haz0", red: "rust0",
  },
  lit: {
    ...LIT,
    soot3: "tar2",
    dirt3: "steel3",
    gravel2: "dirt2",
    rust3: "bone1",
  },
  extras: [
    { name: "conc0", hex: "#5a5b57", shade: "soot3", lit: "conc1" },
    { name: "conc1", hex: "#8e8f89", shade: "conc0", lit: "conc2" },
    { name: "conc2", hex: "#c4c5bd", shade: "conc1", lit: "conc3" },
    { name: "conc3", hex: "#dadbd3", shade: "conc2", lit: "conc3" },
    { name: "ox0", hex: "#5a2a22", shade: "soot3", lit: "ox1" },
    { name: "ox1", hex: "#80382b", shade: "ox0", lit: "ox2" },
    { name: "ox2", hex: "#a04c38", shade: "ox1", lit: "ox2" },
    { name: "grn0", hex: "#2c4a36", shade: "soot3", lit: "grn1" },
    { name: "grn1", hex: "#3f6b4a", shade: "grn0", lit: "grn2" },
    { name: "grn2", hex: "#58875f", shade: "grn1", lit: "grn2" },
    { name: "och0", hex: "#5f4a1c", shade: "soot3", lit: "och1" },
    { name: "och1", hex: "#8f6f24", shade: "och0", lit: "och2" },
    { name: "och2", hex: "#b08c38", shade: "och1", lit: "och2" },
    { name: "reef0", hex: "#66727a", shade: "steel0", lit: "reef1" },
    { name: "reef1", hex: "#9aa5ab", shade: "reef0", lit: "reef2" },
    { name: "reef2", hex: "#bcc6ca", shade: "reef1", lit: "reef2" },
    { name: "wood0", hex: "#5f4a2c", shade: "soot3", lit: "wood1" },
    { name: "wood1", hex: "#8a6f44", shade: "wood0", lit: "wood2" },
    { name: "wood2", hex: "#b09468", shade: "wood1", lit: "wood2" },
    { name: "char0", hex: "#3b2e23", shade: "soot3", lit: "char1" },
    { name: "char1", hex: "#4e3e2c", shade: "char0", lit: "gravel0" },
    { name: "oil0", hex: "#0e0c14", shade: "soot0", lit: "oil1" },
    { name: "oil1", hex: "#1a1726", shade: "oil0", lit: "oil2" },
    { name: "oil2", hex: "#3b3556", shade: "oil1", lit: "oilv" },
    { name: "oilv", hex: "#9466b8", shade: "oil2", lit: "oilv" },
    { name: "oilt", hex: "#38a8a0", shade: "oil2", lit: "oilt" },
  ],
  burn: { singed: ["soot2", "soot3", "char0", "char1"], charred: ["soot1", "soot2", "soot3", "char0"] },
};

/**
 * The jungle, "overgrown" (TH-LOOK-3; PLAN-THEMES.md 2.2). Our own colours. The ground is dark
 * loam (`dirt`: its lightest tone a fallen leaf's tan); the verge moss (`gravel`: a middling
 * green, light enough that a mine's dark body shows on it and dark enough for a rivet); the
 * tarmac the scrapyard's with a damp green-grey tint and as dark. Steel and rust stay as they
 * are: a kerb's stones, ramps, plates and belts are the same grey and the same rusted metal
 * here, and the water keeps its colour, its edge and its glints (advisor change 9: water is
 * blue-grey in every theme, the jungle's too). The extras, all for pixels that take no marks:
 * logs (the barrier's rail, fallen logs, a logging truck's load), rope (a rail's lashings, dried
 * bamboo), leaves in two greens (a tree's crown, ferns, vines: a yellow-green and a darker
 * blue-green; none near the green car's), bamboo, mossy rock (a gorge's rim, a wall fragment),
 * and the ford's: a shallow stream's jade (lighter and greener than a pool, so the two are never
 * taken for each other; a middling tone, so that a rivet's light head and a mine's dark body
 * both show on it), its dark and light streaks, and its foam.
 */
export const JUNGLE_PALETTE: ThemePalette = {
  colours: {
    ...P,
    // Loam. dirt0 is loam in a cast shadow; dirt3 a fallen leaf.
    dirt0: "#2e231a",
    dirt1: "#3a2c1f",
    dirt2: "#4a3826",
    dirt3: "#6b5530",
    // Moss: its dark hollows, its plain tone, a light tuft.
    gravel0: "#46592f",
    gravel1: "#62763f",
    gravel2: "#7d9150",
    // Tarmac, damp: tinted a green-grey.
    tar0: "#282a27",
    tar1: "#373a35",
    tar2: "#444841",
    tar3: "#61665c",
  },
  // Moss in a shadow is darker moss, not earth (the scrapyard's gravel shades into its dirt).
  shade: {
    ...SHADE,
    gravel0: "dirt0", gravel1: "gravel0", gravel2: "gravel1",
    bone0: "dirt3",
  },
  lit: {
    ...LIT,
    dirt3: "bone0",
  },
  extras: [
    { name: "log0", hex: "#3b2a1a", shade: "soot3", lit: "log1" },
    { name: "log1", hex: "#5c4127", shade: "log0", lit: "log2" },
    { name: "log2", hex: "#8a6a40", shade: "log1", lit: "log3" },
    { name: "log3", hex: "#b08f5c", shade: "log2", lit: "log3" },
    { name: "rope0", hex: "#6e6344", shade: "soot3", lit: "rope1" },
    { name: "rope1", hex: "#a99a6c", shade: "rope0", lit: "rope2" },
    { name: "rope2", hex: "#d6c79a", shade: "rope1", lit: "rope2" },
    { name: "leaf0", hex: "#1f3a22", shade: "soot3", lit: "leaf1" },
    { name: "leaf1", hex: "#2f5229", shade: "leaf0", lit: "leaf2" },
    { name: "leaf2", hex: "#44702f", shade: "leaf1", lit: "leaf3" },
    { name: "leaf3", hex: "#62903a", shade: "leaf2", lit: "leaf4" },
    { name: "leaf4", hex: "#8fb24a", shade: "leaf3", lit: "leaf4" },
    { name: "palm0", hex: "#17302a", shade: "soot3", lit: "palm1" },
    { name: "palm1", hex: "#23463a", shade: "palm0", lit: "palm2" },
    { name: "palm2", hex: "#32604c", shade: "palm1", lit: "palm3" },
    { name: "palm3", hex: "#487d5e", shade: "palm2", lit: "palm4" },
    { name: "palm4", hex: "#6a9c72", shade: "palm3", lit: "palm4" },
    { name: "bam0", hex: "#5a6a2c", shade: "soot3", lit: "bam1" },
    { name: "bam1", hex: "#8c9c46", shade: "bam0", lit: "bam2" },
    { name: "bam2", hex: "#b9c26c", shade: "bam1", lit: "bam2" },
    { name: "rock0", hex: "#3a3f38", shade: "soot3", lit: "rock1" },
    { name: "rock1", hex: "#5b6156", shade: "rock0", lit: "rock2" },
    { name: "rock2", hex: "#8a9082", shade: "rock1", lit: "rock2" },
    { name: "ford0", hex: "#3a6a5e", shade: "palm1", lit: "ford1" },
    { name: "ford1", hex: "#4f8273", shade: "ford0", lit: "ford2" },
    { name: "ford2", hex: "#7fb09a", shade: "ford1", lit: "foam" },
    { name: "foam", hex: "#e2eee2", shade: "ford2", lit: "foam" },
  ],
  burn: { singed: ["soot2", "soot3", "dirt0", "dirt1"], charred: ["soot1", "soot2", "soot3", "dirt0"] },
};

/**
 * style.css :root mirrored: the palette entry each CSS variable takes. Six equal today's CSS
 * value exactly; --line (#4a3a2b), --panel (rgba(22,17,13,0.92)) and --err (#ff8b6b) move
 * onto the palette when GFX-3 applies the mirror (red on soot1 is 4.8:1; GFX-3 judges it).
 */
export const CSS_MIRROR: Readonly<Record<string, PaletteName>> = {
  "--bg": "soot1",
  "--panel": "soot2",
  "--line": "dirt1",
  "--text": "bone2",
  "--muted-solid": "bone0",
  "--rust": "rust3",
  "--rust-dark": "rust1",
  "--steel": "steel2",
  "--err": "red",
};

/** Ordered dither thresholds, 0..15: pixel (x, y) takes the second colour when its share > BAYER4[y & 3][x & 3] / 16. */
export const BAYER4: readonly (readonly number[])[] = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

export type Rgb = [number, number, number];

export function rgbOf(hex: string): Rgb {
  const v = hex.replace("#", "");
  const full = v.length === 3 ? v.replace(/./g, (c) => c + c) : v;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function hexOf([r, g, b]: Rgb): string {
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

const RGB: readonly Rgb[] = PALETTE.map((p) => rgbOf(p.hex));

/** Index (into PALETTE) of a name. */
export function indexOf(name: PaletteName): number {
  return PALETTE.findIndex((p) => p.name === name);
}

/** The palette as packed 0xAABBGGRR words (little-endian ImageData), for index-to-pixel blits. */
export function palette32(): Uint32Array {
  return Uint32Array.from(RGB, ([r, g, b]) => (0xff000000 | (b << 16) | (g << 8) | r) >>> 0);
}

let lut: Uint8Array | null = null;

/**
 * Nearest palette index for a colour, through a 15-bit RGB table built on first use. For
 * fills and dither only (bake time): an edge is never snapped with it (PLAN-GFX advisor 3),
 * edges come from per-layer alpha masks.
 */
export function nearest(r: number, g: number, b: number): number {
  if (!lut) {
    lut = new Uint8Array(1 << 15);
    for (let i = 0; i < lut.length; i++) {
      // The cell's centre, back in 8 bits.
      const cr = (((i >> 10) & 31) << 3) | 4, cg = (((i >> 5) & 31) << 3) | 4, cb = ((i & 31) << 3) | 4;
      let best = 0, bestD = Infinity;
      for (let k = 0; k < SCRAPYARD; k++) {
        const dr = cr - RGB[k][0], dg = cg - RGB[k][1], db = cb - RGB[k][2];
        // "Redmean" weights: closer to the eye than plain RGB distance, and cheap.
        const rm = (cr + RGB[k][0]) / 2;
        const d = (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      }
      lut[i] = best;
    }
  }
  return lut[((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)];
}

// ---- cars -------------------------------------------------------------------------

/** The six car colours, in the server's order (server/room.ts COLORS): the body tone is exactly this. */
export const CAR_COLORS = ["#e8552d", "#33a3e8", "#f2c230", "#5cc46b", "#c46ad6", "#e8e2d4"] as const;

export interface CarTones {
  shade: string; // the side away from the sun, and the lower body panel
  body: string; // the server colour, untouched (minimap dots and name-tag lines use it too)
  lit: string; // the 1 px sunlit edge and the bonnet highlight
}

/** Neutrals every car shares, all from the palette. */
export const CAR_NEUTRALS = { outline: P.soot1, tyre: P.soot2, glass: P.steel0, glint: P.steel2, lamp: P.haz2 } as const;

/** The shadow side of a sunlit yard leans to violet; the sunlit side to a warm white. */
const SHADOW_TINT: Rgb = [42, 26, 46];
const SUN_TINT: Rgb = [255, 246, 220];

function mix(a: Rgb, b: Rgb, share: number): Rgb {
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * share)) as Rgb;
}

const tones = new Map<string, CarTones>();

/**
 * The three tones of a car colour: the body is the colour itself; the shade is the colour
 * mixed 42% toward a dark violet, the lit tone 45% toward a warm white. Any colour works
 * (the "#888" of a player not known yet); results are cached.
 */
export function carTones(color: string): CarTones {
  let t = tones.get(color);
  if (!t) {
    const body = rgbOf(color);
    t = { shade: hexOf(mix(body, SHADOW_TINT, 0.42)), body: color, lit: hexOf(mix(body, SUN_TINT, 0.45)) };
    tones.set(color, t);
  }
  return t;
}
