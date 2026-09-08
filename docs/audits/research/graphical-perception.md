# What the perception literature says about the charts this app could draw

Primary-source research note. Compiled 2026-08-25, extracted from the tracker on 2026-09-08.

**Where this came from, and why it moved.** Every figure below was read from the source PDF, not
from a summary. It was written inside issue #415, a proposal to replace one chart, and four other
issues (#416, #417, #418, #190) pointed at that issue for their evidence rather than repeating it.
When #415 was settled as a proposal, its evidence base would have gone behind a closed issue, which
is the same fault as citing a document nobody can open: the reference resolves for whoever knows
where to look and for nobody else. So the evidence and the rulings it supports live here, in a
tracked file that survives a clone, and the proposal was settled separately.

**One typographic note**, the same one the sibling notes in this directory carry. This repository's
prose rule (`AGENTS.md`, gated by `src/lib/prose/emDashesInProse.spec.ts`) allows no em dash in a
tracked Markdown file. Where a quoted source used one it is rendered here as a comma or a colon; no
quoted wording is altered.

## The shared basis

### Cleveland and McGill's ordering, quoted rather than paraphrased

They identify ten elementary perceptual tasks (Figure 1, p. 532) and then hypothesise an ordering
by accuracy. Verbatim, p. 536:

> The following are the 10 elementary tasks in Figure 1, ordered from most to least accurate:
>
> 1. Position along a common scale
> 2. Positions along nonaligned scales
> 3. Length, direction, angle
> 4. Area
> 5. Volume, curvature
> 6. Shading, color saturation

**Six ranks over ten tasks, not ten ranks.** Length, direction and angle share rank 3. Area is
rank 4. Shading and colour saturation share rank 6, last. **There is no "slope" in the list**; the
tenth task, absent from most retellings, is _curvature_.

This matters because a ten-item list with one rank per item circulates widely, and its numbers are
not the source's:

|                                                | angle                                 | area  |
| ---------------------------------------------- | ------------------------------------- | ----- |
| **Cleveland & McGill 1984, as printed**        | **3**, tied with length and direction | **4** |
| Mackinlay 1986, quantitative, _conjectured_    | 3                                     | 5     |
| the composite in circulation (inserts "slope") | 5                                     | 6     |

The first version of the tracker issues cited "angle rank 5, area rank 7", which matches **none**
of them. Anything citing a rank quotes the ordering above and names which source it is using.

**And the ordering is a hypothesis.** The section is titled "Theory: Ordering the Elementary
Perceptual Tasks of Extraction" and opens "In this section we _hypothesize_ an ordering". The
paper's own abstract says the experiments "validate these elements but also suggest that the set of
elementary tasks should be expanded". So the ordering is the theory; the numbers below are the
evidence.

### What Cleveland and McGill actually measured

Two experiments, 51 subjects with usable data each, scored by log absolute error (section 4.5,
p. 544):

- **Position and length.** Position judgments were more accurate than length judgments **by factors
  of 1.4 to 2.5**. Of the large errors, **78% were length judgments**, a rate **5.3 times** that of
  position judgments.
- **Position and angle**, which is a bar chart against a pie chart (their Figure 3). Position
  judgments were **1.96 times as accurate** as angle judgments, statistically significant. Of the
  large errors, **88% were angle judgments**, a rate **7.3 times** that of position.
- **Separation, within the position judgments.** Types 1, 2 and 3 differ only in how far apart the
  compared values sit. "As the distance between the two values being judged increased along an axis
  perpendicular to the common scale, the accuracy decreased." Type 1 (adjacent) was best, Type 3
  (most separated) worst, and Types 2 and 3 were **the only pair not significantly different** at
  the .05 level.

### What Heer and Bostock added, stated precisely

Their crowdsourced study is **a replication for types 1 to 5 only**, the position and length
judgments, and there "the rough shape and ranking of judgment types by accuracy (T1-5) are
preserved". Angle (pie) and circular area (bubble) were **new conditions they introduced**, not
replications: Cleveland and McGill's position-angle experiment "used a different task format,
making it difficult to compare". Two of their own findings:

- Rectangular area judgments **match** circular area judgments on average, and there was **no
  significant difference between a plain rectangle pair and a treemap**: treemap chrome does not add
  error.
- Rectangles at **aspect ratio 1 performed worst**, robust across both conditions, which "suggests
  that viewers actually benefit from the inability of a squarified treemap algorithm to perfectly
  optimize the rectangles to 1:1 aspect ratios."

### What Skau and Kosara found about pie and donut charts, which removes an argument

They decomposed pie and donut charts into their three cues, arc length, centre angle and segment
area, and varied the inner radius from a filled pie to a thin ring. Both studies point to **angle
being the least important cue**, and to **the donut being as accurate as the pie**: "Angle is
clearly not a significant bearer of information in pie charts, and in particular the central
meeting point of the circle segments does not appear to be crucial. Donut charts thus appear to be
no worse than pie charts." Their accuracy ordering was `baseline donut ~ baseline pie` >
`arc ~ area` > `angle pie` > `angle donut`.

**So the familiar argument that a donut is worse than a pie because its centre is missing is
refuted**, and nothing here rests on it. It also means a pie or donut is not usefully described as
"an angle encoding".

### The four bar-chart findings

From Talbot, Setlur and Anand, who ran four experiments explaining Cleveland and McGill's
bar-chart results:

- **Separated bars are harder than adjacent bars.** Their estimate of the total separation effect
  is **0.81 percentage points** of absolute error, "in line with estimates from previous work".
- **Short bars are harder to compare**, and separation makes short bars particularly hard.
- **Within a stack, immediately adjacent segments are _harder_, not easier**, the reverse of the
  simple-bar effect. "An intervening bar or gap reduces the average absolute error", by **0.87
  percentage points [0.47, 1.3]**. They attribute the bias to readers substituting the part-to-whole
  ratio for the ratio asked.
- Their conclusion, with its qualification intact: "The introduction of a gap between stacked bars
  can prevent erroneous part-of-whole comparisons **when desired**."

### Sources

All five were read directly; page and figure references above point into them.

- Cleveland, W. S. & McGill, R. (1984). _Graphical Perception: Theory, Experimentation, and
  Application to the Development of Graphical Methods._ Journal of the American Statistical
  Association **79**(387), 531-554. doi:10.1080/01621459.1984.10478080
- Mackinlay, J. (1986). _Automating the Design of Graphical Presentations of Relational
  Information._ ACM Transactions on Graphics **5**(2), 110-141. doi:10.1145/22949.22950
- Heer, J. & Bostock, M. (2010). _Crowdsourcing Graphical Perception: Using Mechanical Turk to
  Assess Visualization Design._ CHI '10, 203-212. doi:10.1145/1753326.1753357
- Skau, D. & Kosara, R. (2016). _Arcs, Angles, or Areas: Individual Data Encodings in Pie and Donut
  Charts._ Computer Graphics Forum **35**(3), 121-130. doi:10.1111/cgf.12888
- Talbot, J., Setlur, V. & Anand, A. (2014). _Four Experiments on the Perception of Bar Charts._
  IEEE TVCG **20**(12), 2152-2160. doi:10.1109/TVCG.2014.2346320

**No source here says anything about Sankey diagrams.** That absence is recorded in #190 rather
than papered over.

## What not to build

This section is the reason the visualisation issues were filed before anyone wanted them. Six
months from now someone will propose one of these; this is where the answer lives.

- **Treemap.** Area is rank 4 against position's rank 1, and Heer and Bostock measured rectangular
  area as no better than circular area. Note what the evidence does **not** say: a treemap's extra
  chrome does _not_ add error, so "treemaps are cluttered" is not the argument. The argument is that
  anything a treemap shows here, bars on a shared baseline show one to three ranks higher, and that
  a _squarified_ treemap pushes rectangles toward the aspect ratio that measured **worst**.
- **Pie or donut for anything quantitative.** Not because of angle: Skau and Kosara showed angle is
  the least important cue and that donuts read as well as pies. Because Cleveland and McGill
  measured position judgments **1.96 times as accurate** as pie reading, with large errors **7.3
  times more frequent**.
- **Any chart where a colour or a shade carries the value** rather than labelling a series. Shading
  and colour saturation are rank 6, the bottom tier, below volume and curvature. Colour is for
  identifying _which_ series, never for reading _how much_.

None of these is a matter of taste, and none should be re-argued from screenshots.
