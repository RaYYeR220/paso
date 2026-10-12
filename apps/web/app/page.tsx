import type { Metadata } from "next";
import { Besley, Jost } from "next/font/google";

import { AnyAddress } from "@/components/landing/AnyAddress";
import { Check } from "@/components/landing/Check";
import { Footer } from "@/components/landing/Footer";
import { Hero } from "@/components/landing/Hero";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { Proof } from "@/components/landing/Proof";

import "./landing.css";

const besley = Besley({ subsets: ["latin"], style: ["normal", "italic"], variable: "--font-besley", display: "swap" });
const jost = Jost({ subsets: ["latin"], variable: "--font-jost", display: "swap" });

const title = "Paso — your Ethereum wallet is already a Stellar account";
const description =
  "Every Ethereum address already has a Stellar account that the same key controls: bring USDC from Base in seconds and sign exactly what your wallet shows.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  icons: { icon: { url: "/paso-mark.svg", type: "image/svg+xml" } },
  openGraph: { type: "website", siteName: "Paso", title, description, images: [{ url: "/paso-og.svg", width: 1200, height: 630, alt: title }] },
  twitter: { card: "summary_large_image", title, description, images: ["/paso-og.svg"] },
};

export default function LandingPage() {
  return (
    <div className={`landing ${besley.variable} ${jost.variable}`}>
      <Hero />
      <main>
        <HowItWorks />
        <Check />
        <AnyAddress />
        <Proof />
      </main>
      <Footer />
      <div className="grain" aria-hidden="true" />
    </div>
  );
}
