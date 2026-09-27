// Turns Apple Music catalog search candidates into an auto-pick / not-found
// verdict for one parsed (title, artists) line.
//
// Trusts the backend's own search ranking: with any results at all, the top
// hit is auto-picked (per spec: "usually the first"). This deliberately does
// NOT verify the candidate's artist name against the parsed one — Apple
// Music storefronts outside Greater China return romanized metadata ("周杰倫"
// comes back as "Jay Chou", "七里香" as "Qi-Li-Xiang"), so a same-script text
// comparison would reject correct matches on every non-CJK storefront (this
// was tried and confirmed broken against a real "nz" storefront). If this
// proves too loose in practice (wrong-artist same-title collisions), revisit
// with a transliteration-aware check rather than reintroducing a same-script
// gate.
export function pickBestMatch(candidates) {
  const list = Array.isArray(candidates) ? candidates : []
  if (list.length === 0) return { status: 'notfound', candidates: [] }
  return { status: 'matched', chosen: list[0], candidates: list.slice(0, 5) }
}
