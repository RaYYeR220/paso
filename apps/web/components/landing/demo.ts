export const DEMO_ADDRESS = "0x7880DA9a52Af491f76421869d4e28DC0A4D1767C";
export const DEMO_ACCOUNT = "CCI3UVOB35NEJCTKPCLSPJVT745BNT2QNACV3QP46CRYTVD3QCOH2VME";

export const REPO_URL = "https://github.com/RaYYeR220/paso";
export const DOCS_URL = `${REPO_URL}/tree/main/docs`;
export const VERIFY_URL = `${REPO_URL}/blob/main/docs/VERIFY.md`;

const EXPLORER = "https://stellar.expert/explorer/testnet/tx";
export const MATCHED_TX_URL = `${EXPLORER}/b8a81489a2b20babc3ceadf6c9b22ba15965c725a6594b3413de6c4aadc91ac5`;
export const REFUSED_TX_URL = `${EXPLORER}/ded23530dfc8d114a1350522e45b257170ed775738b0e85887f0e6667d52b181`;

export const shorten = (value: string, head = 6, tail = 4) => `${value.slice(0, head)}…${value.slice(-tail)}`;
