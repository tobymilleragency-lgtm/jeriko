import type { Metadata } from "next";
import Script from "next/script";
import { Footer } from "./components/footer";
import "./globals.css";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://jeriko.app";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "Jeriko | The New Intelligent OS for macOS",
    template: "%s | Jeriko",
  },
  description: "Jeriko transforms your Mac into an AI-powered operating system. One daemon, one CLI, total control.",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "Jeriko",
    title: "Jeriko | The New Intelligent OS for macOS",
    description: "Build web and mobile apps, automate your OS, generate images, and connect tools from one local AI agent.",
    images: [{ url: "/jeriko-logo-white.png", width: 512, height: 512, alt: "Jeriko" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Jeriko | The New Intelligent OS for macOS",
    description: "A local AI agent for app building, browser automation, connectors, image generation, and OS control.",
    images: ["/jeriko-logo-white.png"],
  },
  icons: {
    icon: "/jeriko-logo-white.png",
    apple: "/jeriko-logo-white.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <Script
          src="https://www.googletagmanager.com/gtag/js?id=G-CNR2YGSH94"
          strategy="afterInteractive"
        />
        <Script id="google-analytics" strategy="afterInteractive">
          {`
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', 'G-CNR2YGSH94');
          `}
        </Script>
      </head>
      <body>
        <div className="site">
          <div className="site-content">{children}</div>
          <Footer />
        </div>
      </body>
    </html>
  );
}
