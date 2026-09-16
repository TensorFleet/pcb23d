export type RGB = [number, number, number];

export interface Palette {
  /** Bare substrate (FR4) seen through mask openings without copper. */
  substrate: RGB;
  /** Soldermask over bare substrate. */
  mask: RGB;
  /** Soldermask over copper (slightly lighter / brighter). */
  maskOverCopper: RGB;
  /** Exposed copper finish (pads). */
  copper: RGB;
  silk: RGB;
  /** Board edge (side walls). */
  edge: RGB;
  /** Component body. */
  component: RGB;
  componentPin: RGB;
}

const MASK_COLORS: Record<string, RGB> = {
  green: [0x0f, 0x5c, 0x2e],
  red: [0x8a, 0x16, 0x14],
  blue: [0x11, 0x2c, 0x6a],
  black: [0x17, 0x18, 0x1a],
  white: [0xe9, 0xe9, 0xe4],
  yellow: [0xc8, 0xa8, 0x1a],
  purple: [0x3c, 0x1b, 0x63],
  matteblack: [0x12, 0x12, 0x14],
  darkgreen: [0x0a, 0x3a, 0x1c],
};

const SILK_COLORS: Record<string, RGB> = {
  white: [0xf2, 0xf2, 0xee],
  black: [0x1a, 0x1a, 0x1a],
  yellow: [0xf0, 0xd2, 0x50],
};

const COPPER_FINISH: Record<string, RGB> = {
  gold: [0xd9, 0xb0, 0x4e],
  enig: [0xd9, 0xb0, 0x4e],
  silver: [0xc9, 0xcc, 0xc8],
  hasl: [0xc9, 0xcc, 0xc8],
  tin: [0xc9, 0xcc, 0xc8],
  copper: [0xc8, 0x7d, 0x4a],
  bare: [0xc8, 0x7d, 0x4a],
  none: [0xd9, 0xb0, 0x4e],
};

export function parseColor(input: string | undefined, fallback: RGB): RGB {
  if (!input) return fallback;
  const s = input.trim();
  const hex = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
  if (hex) {
    const v = parseInt(hex[1]!, 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  const short = /^#([0-9a-f]{3})$/i.exec(s);
  if (short) {
    const [r, g, b] = short[1]!.split("").map((c) => parseInt(c + c, 16));
    return [r!, g!, b!];
  }
  const rgb = /^rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(s);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  const key = s.toLowerCase().replace(/[\s_-]/g, "");
  return MASK_COLORS[key] ?? SILK_COLORS[key] ?? fallback;
}

export function maskColor(name: string | undefined): RGB {
  return parseColor(name, MASK_COLORS.green!);
}

export function silkColor(name: string | undefined): RGB {
  return parseColor(name, SILK_COLORS.white!);
}

export function copperColor(finish: string | undefined): RGB {
  if (!finish) return COPPER_FINISH.gold!;
  const key = finish.toLowerCase().replace(/[\s_-]/g, "");
  if (COPPER_FINISH[key]) return COPPER_FINISH[key]!;
  if (/gold|enig|enepig|immersion/.test(key)) return COPPER_FINISH.gold!;
  if (/hasl|tin|silver|immag/.test(key)) return COPPER_FINISH.silver!;
  return parseColor(finish, COPPER_FINISH.gold!);
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function lighten(c: RGB, amount: number): RGB {
  return mix(c, [255, 255, 255], amount);
}

export function darken(c: RGB, amount: number): RGB {
  return mix(c, [0, 0, 0], amount);
}

export function buildPalette(opts: { mask?: string; silk?: string; finish?: string }): Palette {
  const mask = maskColor(opts.mask);
  const light = luminance(mask) > 140;
  return {
    substrate: [0xc2, 0xa9, 0x6b],
    mask,
    maskOverCopper: light ? darken(mask, 0.06) : lighten(mask, 0.16),
    copper: copperColor(opts.finish),
    silk: silkColor(opts.silk),
    edge: [0xb8, 0x9e, 0x66],
    component: [0x2c, 0x2d, 0x31],
    componentPin: [0xb8, 0xb9, 0xb3],
  };
}

export function luminance(c: RGB): number {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
