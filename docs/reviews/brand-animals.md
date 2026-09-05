# Animal and visual directions

Research date: 2026-09-05. These are proposals for review, not a decision to rename the product. The current implementation can keep Dhole while replacing its mark. Name screening is recorded separately in [brand-names.md](brand-names.md).

The animal should make the product recognizable. Plain product language should explain what it does: "Agent access, coordination, and API gateway." An animal name alone will not communicate that scope. Sessions, runtime, and the overview belong within Core; animals should not become another set of module names.

## What the existing references tell us

The supplied Pangolin screenshots demonstrate a strong mark, quiet dark backgrounds, a single accent, and navigation whose icons remain useful when labels disappear. They are a layout reference. Reusing Pangolin's orange circular animal silhouette would weaken the new identity.

Relevant task history confirms that Mardwerk uses a marten, charcoal `#1B1818`, brown `#673921`, and amber `#FDBB41`. Its small mark turns the throat patch into negative space. The current RenewC redesign retains a red kite. Earlier RenewC work used a salp, so the older salp direction should not be treated as the current brand. Those projects suggest the right discipline here: one real animal with identifiable anatomy, a restrained palette, and a separate simplified mark for small sizes. Another marten would be too close to Mardwerk.

## Recommended directions

| Direction | Why the animal fits | Main drawback | Recommendation |
| --- | --- | --- | --- |
| Rook with a descriptive compound such as Rookport | Social bird; strong side-profile head, long pointed bill, pale bill base | Rook already names a Kubernetes storage project; corvids are common mascots | Best new visual direction if the compound survives further name screening |
| Dhole under Dhole or a compound such as Packrail | Real pack cooperation and vocal communication; already belongs to this product | Dhole needs pronunciation help and the present mark looks generic | Best immediate implementation; a rename does not require replacing the animal |
| Asian small-clawed otter with a compound such as Otterport | Social family groups and shared care; round ears, broad muzzle, tapering tail | Otter.ai already occupies adjacent AI territory; OtterLink overlaps the actual product category | Useful warmer alternative, below the first two |

### Rook

Build a head in side profile from a filled shape, with a slightly peaked crown, a long pointed bill, and a small pale cutout at the bill base. That cutout matters: a generic black bird would read as a crow or raven. Avoid the hooked eagle bill and spread wings. The latter would also approach RenewC's bird identity.

At 16 px, retain the head contour and one broad bill-base opening; omit the eye. At 24 px, an eye can return if it remains distinct from the cutout. At larger sizes, an upright full bird can appear on the connect screen or in documentation, with a pale face and a subtle violet feather sheen. The dashboard does not need a full mascot beside routine tables.

Use indigo as the interface accent, informed by the purple sheen described by the RSPB. Keep most of the bird and interface neutral. A perched pose reads as watchful; this is a visual interpretation, not a claim that rooks act as access-control guardians. Their sociability is documented: the RSPB describes communal nesting, feeding, and roosting.[1]

Prefer the full compound in the wordmark. Do not quietly shorten it to Rook throughout the interface, because [Rook](https://rook.io/) is an established storage-management project in the same infrastructure audience.[5]

### Dhole or Packrail

The existing `Mark.svelte` uses pointed corners, a round outlined head, eyebrows, eyes, and a smile. At small sizes it reads as a cat-like face. The replacement should use filled geometry, broad rounded ears, a short canid muzzle, and a fuller neck. A side profile gives it a more recognizable outline than a symmetric face. A white cheek or muzzle area can become negative space.

At 16 px, the silhouette must work without facial lines. At 24 px, add one nose or eye detail only if the contour still carries the identity. Keep interior openings at least about two rendered pixels wide in the micro-mark. Treat this as an optical-design target and inspect the actual rasterization. A single large illustration can add the brushy dark-tipped tail, long legs, and reddish fur. Do not curl the tail around the head into Pangolin's circular motif.

San Diego Zoo describes rounded ears, reddish through sandy coloring, a brushy tail often tipped in black, cooperative pack life, and whistles used in communication.[2] This gives Dhole a stronger factual relationship to agent coordination than most proposed animals. "Packrail" would change the wordmark while keeping that relationship. It should not introduce railway decoration throughout the UI.

Use a muted copper family for this direction. Bright amber would approach Mardwerk; saturated orange throughout the shell would approach the supplied Pangolin reference. Keep copper to the mark, active navigation, focus treatment, and the main action.

### Otter

Use the Asian small-clawed otter specifically. A side or three-quarter head needs a broad low muzzle and small round ears; otherwise it can read as a bear. For the full mascot, use a low standing pose with the long tapering tail visible. Avoid the floating sea otter holding hands, which represents another species and is already a common image.

At 16 px, use the head outline and a broad muzzle cutout, without whiskers. At 24 px, one nose detail is enough. Teal makes a calm accent but is an aquatic design association, not the animal's fur color. The Smithsonian documents family groups and care for young by the group. It also says they hunt individually, so "coordinated hunters" would be a false brand story.[3]

This direction carries the greatest category confusion. [Otter.ai](https://otter.ai/) already presents itself as an AI meeting agent, and the naming research found [OtterLink](https://github.com/lihy11/OtterLink), a remote interface for Codex, Claude Code, and OpenCode. A different suffix does not automatically remove that confusion. Keep this as an alternative, not the default.[6]

## Other animals considered

| Animal | Reason to consider it | Reason to leave it out of the leading set |
| --- | --- | --- |
| Sociable weaver | Shared nests and continuing communication are documented; the nest can suggest many agents using one core | Its bird silhouette is not distinctive; drawing a nest at 16 px produces visual noise. The behavior is stronger than the mark.[4] |
| Hoopoe | Raised crest and downcurved bill produce a distinctive profile | No need to invent a cooperation story. Crest detail disappears at small sizes, and its pronunciation is another hurdle. It also adds another bird to the user's brands.[7] |
| Marten | Long body, tail, and pale throat make a useful mascot | Already central to Mardwerk |
| Wolf, fox, generic cat | Easy to recognize | Too familiar in software and too close to the weaknesses of the current mark |

## Palette and contrast

These are role-specific pairs, not interchangeable swatches. Ratios were calculated with the WCAG relative-luminance formula. They describe these solid colors only; opacity, overlays, gradients, and disabled states need separate checks.

| Direction | Dark UI accent and background | Contrast | Light UI accent and background | Contrast |
| --- | --- | --- | --- | --- |
| Rook | `#A5B4FC` on `#14171C` | 9.01:1 | `#4338CA` on `#FFFFFF` | 7.90:1 |
| Dhole | `#FDBA74` on `#171717` | 10.63:1 | `#9A3412` on `#FFFFFF` | 7.31:1 |
| Otter | `#5EEAD4` on `#14191A` | 11.99:1 | `#0F766E` on `#FFFFFF` | 5.47:1 |

For filled buttons, the pale dark-mode accents need dark text such as `#111827`; those pairs reach 8.90:1, 10.52:1, and 11.99:1 respectively. The darker light-mode accents can use white text at the ratios listed above. Do not put white text on the pale accent swatches. WCAG AA requires 4.5:1 for ordinary text and 3:1 for meaningful control graphics; the logo exemption should not determine navigation or button colors.[8][9]

Brand color should not also mean health. Use a dot and a written state such as "Connected" or "Needs attention". When the sidebar collapses, each Lucide navigation icon still needs an accessible name, a keyboard-visible tooltip, and a persistent selected state. The mascot belongs in the brand position and favicon; it does not replace semantic navigation icons.

## Acceptance checks for the chosen mark

- Inspect original-size renders at 16, 24, 32, and 48 px on both dark and light backgrounds. Evaluate the 16 px version first, rather than shrinking the full illustration afterward.
- Check a single-color version, a grayscale rendering, and a print-sized lockup. The shape should identify the brand without its accent.
- Keep the default mark static. Reduced-motion preference should suppress any optional mascot animation.
- Give an unlabelled brand-home link the accessible name of the product. Hide the SVG from assistive technology when adjacent text already names it, to avoid duplicate announcements.
- Compare the finished candidate directly with the existing Mardwerk, RenewC, Pangolin, and Rook marks before selecting it. Similar subject matter alone is not the issue; similar outline, pose, and color are.

## Sources

Sources were retrieved on 2026-09-05. Animal facts inform the visual choices; the product associations are design judgments. Name and logo observations are an initial public screen, not a trademark or domain-availability guarantee.

1. [RSPB: Rook](https://www.rspb.org.uk/birds-and-wildlife/rook), identifying anatomy, purple feather sheen, and communal behavior.
2. [San Diego Zoo Wildlife Alliance: Dhole](https://animals.sandiegozoo.org/animals/dhole), anatomy, coloration, social life, and communication.
3. [Smithsonian's National Zoo: Asian small-clawed otter](https://nationalzoo.si.edu/animals/asian-small-clawed-otter), family structure, group care, and individual hunting.
4. [San Diego Zoo Wildlife Alliance: Sociable weaver](https://animals.sandiegozoo.org/animals/sociable-weaver), shared nests and vocal communication.
5. [Rook](https://rook.io/), established Kubernetes storage-management project.
6. [Otter.ai](https://otter.ai/) and [OtterLink](https://github.com/lihy11/OtterLink), adjacent and directly overlapping software identities. See the separate name screen for its retrieval details.
7. [RSPB: Hoopoe](https://www.rspb.org.uk/birds-and-wildlife/hoopoe), crest and bill anatomy.
8. [W3C: Understanding SC 1.4.3, Contrast minimum](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).
9. [W3C: Understanding SC 1.4.11, Non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html).
