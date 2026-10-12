export const palette = {
  cream: "#F8EDD2",
  paper: "#FBF3DF",
  glow: "#FCF3DA",
  sky: "#F3E1B6",
  mustardPale: "#EDC978",
  mustard: "#E0A227",
  terracottaLight: "#D5693A",
  terracotta: "#C8552D",
  terracottaGround: "#AE4726",
  terracottaDeep: "#96391F",
  shade: "#6E2318",
  tealPale: "#A9CFC0",
  tealLight: "#62AA9E",
  teal: "#2F8F86",
  tealDeep: "#17605F",
  ink: "#0B3436",
} as const;

export type PaletteColor = keyof typeof palette;
