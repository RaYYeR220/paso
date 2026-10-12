import { BorderPost, palette } from "@/components/art";

import { CheckFrame, CheckSwitch, CheckVerdict } from "./check-state";
import { Crest } from "./Crest";
import { border } from "./terrain";

export function Check() {
  return (
    <CheckFrame id="check" className="band check">
      <Crest id="check-crest" fill={palette.ink} seed={13} offset={6}>
        {(ground) => (
          <>
            <g className="wide-only">
              <BorderPost x={border.wide} ground={ground} />
            </g>
            <g className="narrow-only">
              <BorderPost x={border.narrow} ground={ground} scale={border.narrowScale} />
            </g>
          </>
        )}
      </Crest>
      <div className="wrap">
        <div className="lede">
          <h2 className="h2" id="check-title">
            What you see is what you sign.
          </h2>
          <p className="body">
            A wallet popup is only useful if it tells the truth. Paso&rsquo;s account contract rebuilds the message your wallet displayed from the calls
            it is about to authorise, and refuses anything else.
          </p>
          <CheckSwitch />
        </div>
        <div className="ticket">
          <p className="slip" id="check-slip">
            A call signed for amount 1
          </p>
          <dl className="msg" aria-labelledby="check-slip">
            <dt>account</dt>
            <dd>CCI3UVOB…QCOH2VME</dd>
            <dt>contract</dt>
            <dd>
              CBIELTK6…MXQDAMA<span className="tok">USDC</span>
            </dd>
            <dt>fn</dt>
            <dd>approve</dd>
            <dt>args</dt>
            <dd>CCI3UVOB…QCOH2VME</dd>
            <dd>CBNSNERN…53QGFOBO</dd>
            <dt>amount</dt>
            <dd>
              <span className="signed">1</span>
              <span className="tamper">
                <span className="vh">signed, but about to run: </span>≠ 10000000000000
              </span>
            </dd>
          </dl>
          <CheckVerdict />
        </div>
      </div>
    </CheckFrame>
  );
}
