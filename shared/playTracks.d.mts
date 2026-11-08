export const PLAY_TRACKS: {
  readonly [K in `play-${"internal" | "closed" | "open" | "production"}`]: {
    readonly track: "internal" | "alpha" | "beta" | "production";
    readonly label: string;
    readonly name: string;
  };
};
