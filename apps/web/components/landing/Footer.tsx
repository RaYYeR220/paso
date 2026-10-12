import { palette } from "@/components/art";

import { Crest } from "./Crest";
import { DOCS_URL, REPO_URL } from "./demo";

export function Footer() {
  return (
    <footer className="band foot">
      <Crest id="foot-crest" fill={palette.ink} seed={9} offset={3} />
      <div className="wrap">
        <span className="mark2">Paso</span>
        <a className="link" href={REPO_URL}>
          GitHub
        </a>
        <a className="link" href={DOCS_URL}>
          Docs
        </a>
        <p className="cctp">USDC moves over Circle CCTP. Built on Stellar.</p>
      </div>
    </footer>
  );
}
