//! Canonical JSON (RFC 8785, JCS): every kernel hash goes through it, and
//! Python never canonicalizes on its own.
//!
//! - [`canonical_json`] refuses floats: money is integer cents and scores are
//!   basis points, so a float in hashed input is a bug.
//! - [`canonical_json_any`] accepts floats and prints them as ECMAScript does;
//!   it is used only for MCP pins and the `/decide` call hash, whose raw input
//!   may hold floats.
//!
//! `serde_json` keeps insertion order in this build (cedar turns on
//! `preserve_order`), so keys are sorted here, by UTF-16 code units as RFC 8785
//! requires.
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value};
use std::fmt;

/// The largest integer every RFC 8785 implementation prints exactly: numbers
/// are IEEE doubles there, so a larger one would hash differently elsewhere.
const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JcsError(String);

impl fmt::Display for JcsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for JcsError {}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Numbers {
    IntegersOnly,
    /// Every number as an IEEE double, printed in ECMAScript form.
    Any,
}

/// RFC 8785 for integer-only JSON. Floats are an error.
pub fn canonical_json(s: &str) -> Result<String, JcsError> {
    canonicalize(s, Numbers::IntegersOnly)
}

/// RFC 8785 with floats: numbers print as ECMAScript's `Number.prototype.toString`.
pub fn canonical_json_any(s: &str) -> Result<String, JcsError> {
    canonicalize(s, Numbers::Any)
}

/// Parses JSON as RFC 8785 requires its input: no repeated names in an object.
pub(crate) fn parse_strict(s: &str) -> Result<Value, JcsError> {
    let StrictValue(value) =
        serde_json::from_str(s).map_err(|e| JcsError(format!("not canonicalizable JSON: {e}")))?;
    Ok(value)
}

fn canonicalize(s: &str, numbers: Numbers) -> Result<String, JcsError> {
    let value = parse_strict(s)?;
    let mut out = String::with_capacity(s.len());
    write(&value, numbers, &mut out)?;
    Ok(out)
}

fn write(value: &Value, numbers: Numbers, out: &mut String) -> Result<(), JcsError> {
    match value {
        Value::Null | Value::Bool(_) => out.push_str(&value.to_string()),
        Value::Number(n) => match numbers {
            Numbers::IntegersOnly => match n.as_i64() {
                Some(i) if (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&i) => {
                    out.push_str(&i.to_string())
                }
                Some(_) => return Err(JcsError(format!("integer outside ±(2^53 − 1): {n}"))),
                None if n.is_u64() => {
                    return Err(JcsError(format!("integer outside ±(2^53 − 1): {n}")));
                }
                None => return Err(JcsError(format!("floats are not allowed here: {n}"))),
            },
            Numbers::Any => out.push_str(&ecmascript_number(
                n.as_f64()
                    .ok_or_else(|| JcsError(format!("bad number {n}")))?,
            )),
        },
        // serde_json escapes exactly as RFC 8785 asks: `"`, `\`, and control
        // characters (\b \t \n \f \r, otherwise \u00xx in lowercase hex).
        Value::String(s) => out.push_str(&Value::String(s.clone()).to_string()),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(item, numbers, out)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (i, key) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(key.clone()).to_string());
                out.push(':');
                write(&map[key], numbers, out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

/// ECMAScript's Number.prototype.toString for a finite double (ECMA-262,
/// Number::toString), which RFC 8785 uses for every number. It needs the
/// shortest round-tripping digits, ties broken to even; Rust's own `{:e}`
/// rounds such ties up (1424953923781206.25 prints ...063, ECMAScript ...062),
/// so the digits come from Żmij.
fn ecmascript_number(f: f64) -> String {
    if f == 0.0 {
        return "0".into(); // also -0
    }
    let mut buffer = zmij::Buffer::new();
    let printed = buffer.format_finite(f.abs()); // "1424953923781206.2", "1e-7", "2.9514790517935283e+20"
    let (mantissa, exponent) = printed.split_once('e').unwrap_or((printed, "0"));
    let (int_part, frac_part) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let exponent: i32 = exponent.parse().expect("Żmij prints an integer exponent");
    // value = 0.digits × 10^n, with digits stripped of leading and trailing zeros
    let all = format!("{int_part}{frac_part}");
    let leading = all.len() - all.trim_start_matches('0').len();
    let digits = all.trim_matches('0');
    let k = digits.len() as i32;
    let n = int_part.len() as i32 + exponent - leading as i32;
    let sign = if f < 0.0 { "-" } else { "" };
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let e = if e < 0 {
            format!("-{}", -e)
        } else {
            format!("+{e}")
        };
        match k {
            1 => format!("{digits}e{e}"),
            _ => format!("{}.{}e{e}", &digits[..1], &digits[1..]),
        }
    };
    format!("{sign}{body}")
}

/// A JSON value parsed the way RFC 8785 requires its input (I-JSON): an object
/// may not repeat a name, since parsers disagree about which value wins.
struct StrictValue(Value);

impl<'de> Deserialize<'de> for StrictValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(StrictVisitor).map(StrictValue)
    }
}

struct StrictVisitor;

impl<'de> Visitor<'de> for StrictVisitor {
    type Value = Value;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a JSON value")
    }

    fn visit_bool<E>(self, b: bool) -> Result<Value, E> {
        Ok(Value::Bool(b))
    }

    fn visit_i64<E>(self, i: i64) -> Result<Value, E> {
        Ok(Value::from(i))
    }

    fn visit_u64<E>(self, u: u64) -> Result<Value, E> {
        Ok(Value::from(u))
    }

    fn visit_f64<E: de::Error>(self, f: f64) -> Result<Value, E> {
        serde_json::Number::from_f64(f)
            .map(Value::Number)
            .ok_or_else(|| E::custom("number out of range"))
    }

    fn visit_str<E>(self, s: &str) -> Result<Value, E> {
        Ok(Value::String(s.to_owned()))
    }

    fn visit_string<E>(self, s: String) -> Result<Value, E> {
        Ok(Value::String(s))
    }

    fn visit_unit<E>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
        let mut items = Vec::new();
        while let Some(StrictValue(item)) = seq.next_element()? {
            items.push(item);
        }
        Ok(Value::Array(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        let mut fields = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if fields.contains_key(&key) {
                return Err(de::Error::custom(format!("duplicate name {key:?}")));
            }
            let StrictValue(value) = map.next_value()?;
            fields.insert(key, value);
        }
        Ok(Value::Object(fields))
    }
}
