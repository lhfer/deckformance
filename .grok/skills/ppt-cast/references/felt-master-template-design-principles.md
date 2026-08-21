# felt-master-template-design-principles

## Scope

`felt_editorial_split_master` is one opinionated master template, not a new general layout system. It has one composition and two strict mirrors:

- `media-left`
- `media-right`

The variants share geometry, type scale, vertical rhythm, palette, and media contract. Only the two columns exchange sides. Ratio experiments remain candidates inside this master; they are not new families or page roles.

## Communication job

By the end, an audience should understand the product claim quickly because a warm handmade scene demonstrates the idea while a quiet editorial panel states it precisely.

The media and copy do different jobs:

- media carries atmosphere, action, character, and tactile proof;
- the panel carries hierarchy, language, and conclusion;
- neither layer overlays or obscures the other.

“Clean” never means backgroundless. Each media scene needs a story-specific felt miniature world with readable foreground, midground, and background depth. The environment should carry the page metaphor through restrained landscapes, paths, trees, clouds, shelves, windows, workshops, or architecture. A plain studio sweep, empty tabletop, or large unused sky is not an accepted final scene merely because the subject is centered.

## Reference-derived structure

The supplied reference uses a single horizontal card near `2.08:1`, centered on a warm oatmeal canvas. Media and panel are equal-height, zero-gutter neighbors inside one outer boundary. The reference itself is about `52.5/47.5`; this master compares `54/46`, `57/43`, and `60/40` without changing any other composition rule.

The selected default is `57/43` because:

- `54/46` is closest to the reference and offers the safest Chinese measure, but the panel carries slightly too much visual weight;
- `57/43` gives the scene a clear lead, maps closely to a reusable `6:5` media frame, and still supports a compact Chinese editorial block;
- `60/40` is most image-led, but longer Chinese titles turn the panel into a narrow side rail.

## Geometry and boundary

- canvas background: warm oatmeal, approximately `#F3EAE1`;
- card width: `90%` of the slide width;
- card aspect: approximately `2.08:1`;
- card position: optically and mathematically centered vertically;
- panel: opaque charcoal, approximately `#232424`;
- media and panel: same height, no gutter, straight internal seam;
- rounding belongs to the outer card only; the seam must not look like two adjacent rounded cards;
- the fine felt edge is a source-derived alpha mask, not a generated border or geometric sawtooth. Its 608×294 source contour is extracted from the supplied reference card's complete outer pixel boundary, reconstructed from the four edge profiles with subpixel antialiasing, then scaled to the master. The negative overlay reveals the canvas only where the original silhouette is transparent, so media and panel keep their own colors;
- shadows stay extremely restrained. Miniature lighting supplies depth; UI-style elevation does not.

## Panel rhythm

Panel padding is about `9.5%` of panel width. Four stable vertical anchors control the page:

1. icon/page track at about `8.5%H`;
2. headline block ending at about `54%H`, growing upward from that baseline;
3. body beginning at about `61%H`;
4. closing line beginning at about `82%H`.

This is intentional whitespace. The top gap presents the headline; the lower gap separates explanation from conclusion. Copy must never be vertically centered as one loose cluster.

## Chinese headline shaping

`headline_shaping_for_felt_master` must compare multiple real candidates before choosing:

- a complete one-line title when it has confident measure;
- a two-line title split at semantic phrase boundaries;
- an explicit editorial alternative already supported by the source claim or takeaway.

Ranking favors semantic integrity, line balance, and the visual size of the title block. It must protect phrases such as `一句话`, `工作流`, `企业协作`, `协作链路`, `同一入口`, `同一套能力`, `交付闭环`, and `下一次交付`. A merely fitting break is not necessarily a designed break.

## Chinese body and closing shaping

`body_shaping_for_felt_master` turns the body into two to four short information units and keeps `closingLine` separate. The body uses real paragraph units, modest paragraph spacing, and a comfortable short measure. The closing line is shorter, brighter, and independently anchored so the page ends with a conclusion rather than trailing body text.

Shaping may add punctuation, expose sentence boundaries, or select approved claim/takeaway wording. It must not invent new facts.

## Media contract

- the preferred poster/video framing is near `6:5`, or a deliberately composed near-square source;
- keep the primary action and characters inside the central `72%` safe area;
- subjects avoid the seam and remain readable after a mild cover crop;
- a meaningful environment remains visible around the subject, with foreground, midground, and background depth rather than a generic studio void;
- no slide copy, logos, or dark panel is burned into the poster/video;
- a `16:9` source is not treated as a lossless fit. It needs a subject-aware crop or regeneration for the near-square slot.

Characters are media content, not template identity. `characterSet.referenceImages` accepts one or two job-relative user uploads and may include an optional description. A media generator must preserve the supplied identity while composing for the same safe area. With no `characterSet`, the template has no default character. The orange and ivory crochet pair in the sample deck and any earlier Qwen/octopus assets are demonstration or Before-only material, not a style source. A newly uploaded octopus, person, animal, product, or other subject is valid whenever the user selects it for the current deck.

## Acceptance

Engineering fit is necessary but not sufficient. Accept the master only after:

- rendering both mirrors at full size;
- comparing all three ratios in a contact sheet;
- checking every Chinese headline and paragraph visually;
- confirming media subjects do not hit the seam;
- confirming every page uses the same outer silhouette and vertical anchors;
- separating poster/template acceptance from real generated-video provenance and PowerPoint playback acceptance.
