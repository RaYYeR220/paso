import { palette } from "@/components/art";

import { AddressLookup } from "./AddressLookup";
import { Crest } from "./Crest";

export function AnyAddress() {
  return (
    <section className="band any" id="any" aria-labelledby="any-title">
      <Crest id="any-crest" fill={palette.sky} seed={5} offset={9} />
      <AddressLookup>
        <div className="left">
          <h2 className="h2" id="any-title">
            Every Ethereum address already has one.
          </h2>
          <p className="body">
            Paste any address or ENS name to see its Stellar account. You can pay it before its owner has ever heard of Stellar.
          </p>
        </div>
      </AddressLookup>
    </section>
  );
}
