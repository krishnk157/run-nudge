import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "RunNudge · Training Monitor",
    short_name: "RunNudge",
    description:
      "A private training monitor — weekly load, pace, efficiency and body data, with a chat that answers from your own database.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    // Matches the instrument-panel ground and header tint.
    background_color: "#070e13",
    theme_color: "#070e13",
    categories: ["health", "fitness", "productivity"],
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
