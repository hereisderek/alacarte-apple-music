# GD Studio Music API: `s=` signature

Findings from reverse-engineering https://music.gdstudio.xyz/ (client JS as of `mkPlayer.version` 2026.09.25).
The public API doc (https://music-api.gdstudio.xyz/api.php) does not mention `s=`.

## Where it comes from

- `js/ajax.js` appends `&s=` + `crc32(...)` to every API call.
- `js/crc32.min.js` (jsjiami-obfuscated) defines `crc32()`. Despite the name it is **not CRC32**; it is an MD5 wrapper.

## Algorithm

```js
s = md5( timeBucket + "|" + hostname + "|" + ver + "|" + input )
      .slice(-8).toUpperCase()
```

| Part | Value |
|------|-------|
| `timeBucket` | `String(unixSeconds).slice(0, 9)`, i.e. a 10-second bucket (e.g. `179064293`). Comes from an internal `_0xgt_impl()`, which returned plain Unix seconds when called. |
| `hostname` | `location.hostname`, e.g. `music.gdstudio.xyz` |
| `ver` | `mkPlayer.version` (`"2026.09.25"`) with each dot-part zero-padded to 2 digits, joined: `20260925`. Changes when the site JS is updated. |
| `input` | The id sent in the request (see below) |

### `input` per request type

| `types=` | `input` |
|----------|---------|
| `url` | `urlEncode(id)` |
| `pic` | `urlEncode(pic_id)` |
| `lyric` | `urlEncode(lyric_id)` |
| `playlist`, `userlist` | `urlEncode(id)` |
| search (and `embeat_*`) | `String(name)`, the raw search text (from code; not verified live) |

## Verified example

```
str = "179064293|music.gdstudio.xyz|20260925|1234567"
md5(str).slice(-8).toUpperCase() = "8F3D7AA6"
site crc32("1234567")            = "8F3D7AA6"   (match)
```

Apple request shape: `types=url&id=<appleTrackId>&source=apple&br=<br>&s=<sig>`.

## Reference implementation

```js
import { createHash } from "node:crypto";

const HOST = "music.gdstudio.xyz";
const VER = "2026.09.25"; // mkPlayer.version

export function sign(input) {
  const t = String(Math.floor(Date.now() / 1000)).slice(0, 9);
  const ver = VER.split(".").map(p => p.padStart(2, "0")).join("");
  return createHash("md5").update(`${t}|${HOST}|${ver}|${input}`)
    .digest("hex").slice(-8).toUpperCase();
}
```

## Open questions

- Whether the server accepts adjacent time buckets (clock skew tolerance).
- Whether a non-browser client with the same hostname string is accepted.
- `VER` is a moving target: re-read `mkPlayer.version` from `js/*.js` if requests start failing.
- Rate limit per the API doc: 50 requests / 5 minutes.
