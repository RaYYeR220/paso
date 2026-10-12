import { Besley, Jost } from "next/font/google";

/** Display face: headings, the wordmark, the verdict. */
export const besley = Besley({
  subsets: ["latin"],
  style: ["normal", "italic"],
  variable: "--font-besley",
  display: "swap",
});

/** Text face: labels, addresses, amounts. */
export const jost = Jost({
  subsets: ["latin"],
  variable: "--font-jost",
  display: "swap",
});

export const fontVariables = `${besley.variable} ${jost.variable}`;
