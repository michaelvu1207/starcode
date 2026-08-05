import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  installCommand: "npm install -g vite-plus && vp install --filter '@starcode/marketing...'",
  buildCommand: "vp run --filter @starcode/marketing build",
  outputDirectory: "dist",
};
