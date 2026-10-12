export const DEMO_ADDRESS = "0x7880DA9a52Af491f76421869d4e28DC0A4D1767C";
export const DEMO_ACCOUNT = "CCI3UVOB35NEJCTKPCLSPJVT745BNT2QNACV3QP46CRYTVD3QCOH2VME";

export const REPO_URL = "https://github.com/RaYYeR220/paso";
export const DOCS_URL = `${REPO_URL}/tree/main/docs`;
export const VERIFY_URL = `${REPO_URL}/blob/main/docs/VERIFY.md`;

const EXPLORER = "https://stellar.expert/explorer/testnet/tx";
export const MATCHED_TX_URL = `${EXPLORER}/dc3db1dd76496889c53a0007d3017e6b0d8019848c4ebbe555f9899b76eadf63`;
export const REFUSED_TX_URL = `${EXPLORER}/ded23530dfc8d114a1350522e45b257170ed775738b0e85887f0e6667d52b181`;

export const shorten = (value: string, head = 6, tail = 4) => `${value.slice(0, head)}…${value.slice(-tail)}`;
