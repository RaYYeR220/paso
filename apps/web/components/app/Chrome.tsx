"use client";

import { formatEvmAmount } from "paso-sdk";
import { MAINNET_BURN_CEILING, type NetworkChoice } from "@/lib/client";
import { MainnetConfirm, MainnetStrip } from "./Mainnet";
import { SITE_LINKS } from "./site";
import { TopBar, type TopBarProps } from "./TopBar";

export interface ChromeProps extends Pick<TopBarProps, "signer" | "signerKind" | "leaveLabel" | "onLeave"> {
  /** The network choice of the page. */
  choice: NetworkChoice;
  /** The page this is the top of: its own link is left out. */
  current: (typeof SITE_LINKS)[number]["href"];
}

/**
 * The top of every page of the app: the bar with the network switch, the
 * caution that stays for as long as the page is on mainnet, and the question
 * that is asked before it gets there. Links to the other pages stay on the
 * network the page is on.
 */
export function Chrome({ choice, current, ...bar }: ChromeProps) {
  const links = SITE_LINKS.filter((link) => link.href !== current).map((link) => ({ ...link, href: choice.href(link.href) }));
  return (
    <div className="top">
      <TopBar
        network={choice.ready ? choice.network : undefined}
        onNetworkChange={choice.choose}
        links={links}
        {...bar}
      />
      {choice.ready && choice.network === "mainnet" ? <MainnetStrip /> : null}
      <MainnetConfirm
        open={choice.ready && choice.confirming}
        ceiling={formatEvmAmount(MAINNET_BURN_CEILING)}
        onConfirm={choice.confirm}
        onDecline={choice.decline}
      />
    </div>
  );
}
