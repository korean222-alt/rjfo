import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: "#0b0e14",
        surface: "#141a24",
        border: "#232b39",
        muted: "#8b97a8",
        up: "#22c55e",
        down: "#ef4444",
        flat: "#8b97a8",
      },
    },
  },
  plugins: [],
};

export default config;
