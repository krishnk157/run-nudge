import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ServiceWorker } from "@/components/ServiceWorker";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "RunNudge · Training Monitor",
  description:
    "A private training monitor — weekly load, pace, efficiency and body data, with a chat that answers from your own database.",
  applicationName: "RunNudge",
  appleWebApp: {
    capable: true,
    title: "RunNudge",
    // The header is dark and translucent; let it run under the status bar.
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: "/icon-192.png",
    apple: "/apple-icon.png",
  },
};

export const viewport: Viewport = {
  // Extend under the notch so the standalone app fills the screen; the sticky
  // header and the sheet composer add safe-area padding of their own.
  viewportFit: "cover",
  themeColor: "#070e13",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
