//! Text form of call arguments, as a wallet displays them.
//!
//! | Soroban value                  | Text                                  |
//! |--------------------------------|---------------------------------------|
//! | Address (account or contract)  | strkey (`G…` / `C…`)                  |
//! | u32, i32, u64, i64, u128, i128 | base 10, `-` for negatives            |
//! | bool                           | `true` / `false`                      |
//! | void                           | `void`                                |
//! | Symbol                         | its characters                        |
//! | String                         | its bytes                             |
//! | Bytes, BytesN                  | `0x` + lowercase hex                  |
//! | anything else                  | `xdr:` + lowercase hex of sha256(XDR) |
//!
//! The kind of a value is read from its XDR encoding, which starts with a
//! four-byte big-endian type tag.

use soroban_sdk::{xdr::ToXdr, Address, Bytes, Env, FromVal, Val};

// SCValType in Stellar-contract.x.
const SCV_BOOL: u32 = 0;
const SCV_VOID: u32 = 1;
const SCV_U32: u32 = 3;
const SCV_I32: u32 = 4;
const SCV_U64: u32 = 5;
const SCV_I64: u32 = 6;
const SCV_U128: u32 = 9;
const SCV_I128: u32 = 10;
const SCV_BYTES: u32 = 13;
const SCV_STRING: u32 = 14;
const SCV_SYMBOL: u32 = 15;
const SCV_ADDRESS: u32 = 18;

/// SCAddressType: accounts are 0 and contracts are 1. Every later kind
/// (muxed accounts and so on) has no strkey form here.
const SC_ADDRESS_TYPE_CONTRACT: u32 = 1;

/// The type tag followed by the widest fixed-size value, a 128-bit integer.
const HEAD: usize = 4 + 16;

/// Text of one argument.
pub fn text(env: &Env, value: &Val) -> Bytes {
    let xdr = value.to_xdr(env);

    let mut head = [0u8; HEAD];
    let len = xdr.len().min(HEAD as u32);
    xdr.slice(..len).copy_into_slice(&mut head[..len as usize]);

    // The bytes after the tag, left-aligned in a 128-bit integer: narrower
    // values are read from its top bits.
    let tag = u32::from_be_bytes([head[0], head[1], head[2], head[3]]);
    let mut body = [0u8; 16];
    body.copy_from_slice(&head[4..]);
    let body = u128::from_be_bytes(body);
    let word = (body >> 96) as u32;

    match tag {
        SCV_BOOL if word == 0 => Bytes::from_slice(env, b"false"),
        SCV_BOOL => Bytes::from_slice(env, b"true"),
        SCV_VOID => Bytes::from_slice(env, b"void"),
        SCV_U32 => decimal(env, body >> 96, false),
        SCV_I32 => signed(env, body as i128 >> 96),
        SCV_U64 => decimal(env, body >> 64, false),
        SCV_I64 => signed(env, body as i128 >> 64),
        SCV_U128 => decimal(env, body, false),
        SCV_I128 => signed(env, body as i128),
        SCV_BYTES => hex(env, b"0x", &xdr.slice(8..8 + word)),
        SCV_STRING | SCV_SYMBOL => xdr.slice(8..8 + word),
        SCV_ADDRESS if word <= SC_ADDRESS_TYPE_CONTRACT => address(&Address::from_val(env, value)),
        _ => hex(env, b"xdr:", &env.crypto().sha256(&xdr).to_bytes().into()),
    }
}

/// Strkey of an account or contract address.
pub fn address(address: &Address) -> Bytes {
    address.to_string().to_bytes()
}

fn signed(env: &Env, value: i128) -> Bytes {
    decimal(env, value.unsigned_abs(), value < 0)
}

/// Base-10 text of `magnitude`, with a leading `-` if `negative`.
fn decimal(env: &Env, magnitude: u128, negative: bool) -> Bytes {
    // Long division by ten over the big-endian bytes: each pass leaves the
    // quotient in place and yields the next digit, least significant first.
    let mut bytes = magnitude.to_be_bytes();
    let mut text = Bytes::new(env);
    loop {
        let mut remainder = 0u32;
        let mut quotient_is_zero = true;
        for byte in bytes.iter_mut() {
            let value = (remainder << 8) | *byte as u32;
            *byte = (value / 10) as u8;
            remainder = value % 10;
            quotient_is_zero &= *byte == 0;
        }
        text.insert(0, b'0' + remainder as u8);
        if quotient_is_zero {
            break;
        }
    }
    if negative {
        text.insert(0, b'-');
    }
    text
}

/// `prefix` followed by the lowercase hex of `data`.
fn hex(env: &Env, prefix: &[u8], data: &Bytes) -> Bytes {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    const CHUNK: usize = 16;

    let mut out = Bytes::from_slice(env, prefix);
    let mut raw = [0u8; CHUNK];
    let mut encoded = [0u8; 2 * CHUNK];
    let len = data.len();
    let mut start = 0;
    while start < len {
        let end = len.min(start + CHUNK as u32);
        let count = (end - start) as usize;
        data.slice(start..end).copy_into_slice(&mut raw[..count]);
        for (i, byte) in raw[..count].iter().enumerate() {
            encoded[2 * i] = DIGITS[(byte >> 4) as usize];
            encoded[2 * i + 1] = DIGITS[(byte & 0x0f) as usize];
        }
        out.extend_from_slice(&encoded[..2 * count]);
        start = end;
    }
    out
}
