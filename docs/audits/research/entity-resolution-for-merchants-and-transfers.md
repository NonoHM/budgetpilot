# What the record linkage literature says about the two decisions that need an algorithm

Primary-source research note. Compiled 2026-09-12, read-only session, no implementation.

**Where this came from, and why it is here.** Two design decisions were taken and both needed an
algorithm: the merchant label index (#520) and the counterparty link between two transactions the
same user owns (#212). The algorithms were chosen from the literature rather than invented, and this
file is the record of that reading. It lives in a tracked directory beside the perception note for
the reason that note gives: evidence behind a ruling has to resolve for whoever reads the ruling, not
only for whoever wrote it. Nothing here is a mapping, a mandate, or a claim about what the
application currently does, except where a claim is tagged as measured.

**One typographic note**, the same one the sibling notes in this directory carry. This repository's
prose rule (`AGENTS.md`, gated by `src/lib/prose/emDashesInProse.spec.ts`) allows no em dash in a
tracked Markdown file. Where a quoted source used one it is rendered here as a comma or a colon; no
quoted wording is altered.

## How to read this note

This note will be read once, months from now, by someone deciding whether to reopen a settled
question. That reader needs to tell, in one pass, what each claim rests on. Every claim below
carries one of five tags, and nothing is untagged.

| Tag              | What it means                                                                                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[MEASURED]**   | A figure produced by a command run in this repository. The command, the date and the commit are given with it.                                                               |
| **[READ-PDF]**   | Read in this session, from the publisher's PDF, by the author of this note. A page number is given.                                                                          |
| **[READ-AGENT]** | Read in this session by a parallel reading agent, from an online copy, and **not re-verified against the source by the author of this note**. Trust it less than [READ-PDF]. |
| **[UNREAD]**     | Nobody in this project has read the source. Recorded so that the gap is visible rather than assumed away.                                                                    |
| **[VENDOR]**     | Vendor documentation, or a maintainer statement in a public tracker. Engineering context about what a vendor says its product does. **Never a validated accuracy claim.**    |

The distinction between [READ-PDF] and [READ-AGENT] is deliberate and is not pedantry. Two DOIs
constructed from memory during this session resolved to the wrong papers, and both were caught only
because every identifier was re-resolved on retrieval. A claim nobody re-checked is a different fact
from a claim someone re-checked.

**Diataxis type: explanation.** This note exists to make two decisions understandable, not to
instruct. It is not a how-to and it is not reference: no procedure here is meant to be followed.

## Method

Searches ran against Crossref, OpenAlex, Unpaywall, Semantic Scholar and arXiv. Every DOI printed
below was resolved during this session; none was carried over from a brief. Three papers were read
from publisher PDFs obtained through the maintainer's institutional access and held in a local
gitignored folder; they are cited by DOI only, because a path into that folder resolves for nobody
else and citing it would repeat the failure #601 exists to fix.

Three parallel reading agents covered the entity resolution literature, the transfer matching
literature and competitor documentation. Their agreement was not treated as evidence, since two
agents can share one bad source, and the one case where two agents reported the same failure
(Fellegi and Sunter being closed access) is recorded below as one source of failure rather than two,
because both readings came from the same Unpaywall record.

## Decision 1: the merchant label index (#520)

### The question

A raw bank descriptor is not a merchant name. `CB****PRET A MANGER 44N 12/08` contains the merchant,
a card fragment, a location code and a date. The catalogue that assigns a category matches against
it by case-insensitive and accent-insensitive substring containment.

**[MEASURED]** The catalogue holds 157 entries: 141 plain substring patterns, of which 100 are
single-token and 41 are multi-token, plus 16 regular expressions. Measured in #520 on 2026-08-25
against `main` at `0d27bc0`, by calling the production functions rather than retyping them. Against
six noise shapes, the 100 single-token patterns broke 0 times out of 141, because containment does
not care about a prefix or a suffix; the 41 multi-token patterns broke 41 out of 41 whenever noise
landed **between** the words of a merchant name.

The decision taken: store a cleaned name as an **additional** field beside the raw descriptor. The
raw label is never destroyed and remains what `/transactions` displays. The deduplication key is not
touched. Resolution runs two ordered passes against the catalogue, pass 1 with digits preserved and
pass 2 with bare numeric tokens dropped, first match wins.

The conflict the two passes resolve: a numeric token is noise in `SUPER 4429 U` and signal in
`microsoft 365`, `trading 212` and `optic 2000`.

### What the literature says for the shape chosen

**[READ-AGENT]** Papadakis et al. call a scheme that places one entity into several blocks
**redundancy-positive**, as against redundancy-free schemes that assign every entity to a single
block. Two passes over one field is a redundancy-positive scheme, and the design therefore has a name
in the field rather than being an invention.

**[READ-PDF]** Christen's indexing survey states the underlying remedy at p. 1539: "Any error in a
field value used to generate a BKV will potentially result in records being inserted into the wrong
block, thus leading to missing true matches. One approach used to overcome errors and variations is
to generate several blocking keys based on different record fields, as is illustrated in Table 1."

**A discrepancy worth recording, because it is the sentence the two-pass design leans on.**
**[READ-AGENT]** The author's accepted manuscript of that survey carries a wider clause: several
blocking key definitions "based on different record fields, **or different encodings applied on the
same record fields**". **[READ-PDF]** The published version at p. 1539 does not carry the second
half of that clause in this sentence. Its own Table 1 nevertheless illustrates exactly that case:
postcode appears in all three example blocking keys under three different encodings, as full
postcode, as the first two digits and as the last two digits. So the published survey demonstrates
what the manuscript states. **Cite the published page for the sentence and Table 1 for the practice;
do not quote the manuscript's wider clause as if it were the published text.**

### What the literature says against it

**The premise "nothing in the string itself distinguishes them" is too strong.** **[READ-AGENT]**
Two papers on short noisy commercial strings resolve numeric noise against signal per token by
external lexicon rather than by a global fold. Akritidis et al. classify a numeric token as an
attribute when a measurement unit follows it and as a model descriptor when none does; `32 GB`
against `GTX1050` is `SUPER 4429 U` against `trading 212`. Koepcke, Thor, Thomas and Rahm remove
known feature tokens first, so that surviving alphanumerics are signal. Their algorithm's
verification step is a network call, which this application's offline constraint forbids, and that
limit is recorded rather than glossed.

The discriminator, in other words, need not live in the string. It can live in a lexicon, and the
catalogue already is one. Two ordered passes is a correct redundancy-positive scheme; it is a crude
one in that the pass order, rather than the match site, carries the noise-against-signal decision,
and nothing records which pass fired.

### The two hazards are two different problems

`catalog.ts` carries a comment naming an ordering hazard, and #520's body describes it as the
`UBEREATS` case. **These are two problems, and only one of them is an ordering problem.**

**[MEASURED]** The four catalogue entries, read from the JSON files at `8b42eb4`:

| key                          | match          |
| ---------------------------- | -------------- |
| `dining_uber_eats`           | `uber eats`    |
| `transport_uber`             | `uber`         |
| `subscriptions_amazon_prime` | `amazon prime` |
| `shopping_amazon`            | `amazon`       |

**Not run, and it does not need a run.** `normalizeForMatch` strips combining marks, lowercases and
trims; it does not remove interior whitespace. The pattern `uber eats` contains a space character.
The folded label `ubereats` contains no space character. A string containing no space cannot contain
a substring that contains one, so `"ubereats".includes("uber eats")` is false by the definition of
containment, and the only pattern that matches `UBEREATS` is `uber`. **There is no second match, so
there is nothing for any ordering or ranking rule to decide.**

The consequence, stated so a later reader does not rediscover it:

- **`UBER EATS`, separator intact.** Both patterns match. This is the ordering problem, and a
  ranking rule closes it.
- **`UBEREATS`, separator removed.** One pattern matches. This is the normalisation problem, it is
  one of the 41 multi-token shapes, and **[MEASURED]** #520 recorded the fold recovering 3 of 41 on
  that shape on 2026-08-25. No ranking rule can reach it.

**Nothing may describe the ranking change as closing the `UBEREATS` case.** A comment naming a
hazard that does not exist at that spelling is worse than no comment, and both #520's body and
`catalog.ts`'s own comment currently do so.

### Longest match, and why not word boundaries

The question asked was whether the matcher should become a multi-pattern automaton that finds all
matches and ranks them by specificity.

**[READ-AGENT]** Aho and Corasick does not answer it. Its output function emits every nested
keyword, and the paper contains no priority rule, no longest-match rule and no rule for choosing
between overlapping matches. The automaton converts "which pattern fires" into "here are all of
them, you decide". The ranking rule is the fix and it does not require the automaton. On scale, Aho
and Corasick's own evaluation used 15 and 24 keywords, and Hyperscan's evaluation runs at 1,300 and
2,800 regular expressions against network traffic; 157 patterns against a short label once per
transaction is neither regime.

**[READ-PDF]** The ranking rule itself is in the standard monograph, twice, and this is a better
source than the engineering documentation that first supplied it.

Christen, p. 53, on tokenisation: "The tokenisation is conducted in a 'greedy' fashion, in that
longer token sequences are considered first before shorter ones." And p. 54, with a worked example
structurally identical to ours: "It is important that longer candidate token sequences are
considered first, such that for example the token sequence 'sydney uni' is correctly identified to
correspond to the standardised locality name 'the university of sydney', rather than the single
token 'sydney' is assigned as locality name and then the second token 'uni' is left as a potentially
unknown token." `sydney uni` against `sydney` is `uber eats` against `uber`.

Christen, p. 58, names the choice between the two orderings directly: "The ordering can either be
based on the specificity of the rules, in that rules that cover more tags are fired first, or it can
be based on which output fields are most important and should have values assigned to them, or the
ordering can be based on a manual sorting of the rules using domain knowledge." **Catalogue order is
the third of those. It is a recognised option, not an accident, and it is the one that produces the
hazard.**

**The rule adopted: longest matched text anywhere in the label, tie-broken by catalogue order.**
Three properties have to be written beside it or a later reader will get them wrong.

1. It is **not POSIX leftmost-longest**, which takes the earliest starting position first. On
   `CARTE 12/08 CB****SUPER U 44N 4429` a generic `carte` pattern would beat `super u` under POSIX
   because it starts earlier. The rule here has no standard name.
2. Longest is an exact proxy for most specific **only when one pattern is a substring of the
   other**. `uber` inside `uber eats` and `amazon` inside `amazon prime` are both nested, so for that
   class the rule is a theorem about containment rather than a heuristic.
3. Rank on the length of the **matched text**, not of the pattern, which puts the 141 literals and
   the 16 regular expressions on one scale with no special case.

**Why not word boundaries, which is the published fix for this exact bug.** **[READ-AGENT]** Toran
et al. hit it and recorded it: "when designing a classifier for automobile payments, the pattern
'ford' was used in pattern matching, but triggered false positives due to the word 'afford', which
was fixed along with other examples using word breaks." `ford` inside `afford` is `uber` inside
`ubereats`. **Their fix is unavailable here, because word breaks would destroy the property this
project measured as working**: the 100 single-token patterns are robust to prefixes and suffixes
precisely because containment does not care about boundaries, and adding a boundary notion would
cost that robustness to buy a property that longest-match ranking supplies for free. Longest match
adds no boundary notion at all. **That is the reason for the choice, and it is recorded here because
it is the reason a later reader would otherwise have to rediscover at full cost.**

**[READ-AGENT]** One further note from the same paragraph of Toran et al., available with no machine
learning: "checking overlaps and coverage of labeling functions can help notice errors." Enumerating
every pair of the 141 literals where one contains the other is finite and would find the whole
nesting class rather than the two entries currently known. That audit belongs in the implementation
and its count belongs in the issue that runs it.

### Display against matching: the question the literature does not answer

The ruling is that the raw label is never destroyed and is what `/transactions` displays.

**[READ-PDF]** Christen's data pre-processing chapter, pp. 39 to 67, was read for this question and
**does not answer it**. Section 3.5 defines pre-processing as "converting the raw input data from
the databases to be matched or deduplicated into a format that allows efficient and accurate
matching" (p. 51). Section 3.8, Practical Considerations and Research Issues (pp. 65 to 66),
discusses data profiling, the customisation of look-up tables, and whether a matching exercise is
one-off or repeated; it says nothing about what a human is shown. Recording that the chapter was
read for this and did not answer is worth more than a shrug, because it stops the next session
reading it again.

The nearest the chapter comes is a principle of adding rather than overwriting, at p. 58: where a
value combination is invalid, "a flag can be added to the record indicating the attributes that
contain inconsistent values. This information can then be used in the matching process to, for
example, lower the similarity value between two records." That is additive derivation, which is the
shape chosen here, but it is about matching quality and not about display.

**[READ-AGENT]** The end-to-end entity resolution survey was searched for raw values, human-facing
output, interface and interpretability, and the only hits are crowd-sourcing and tool interfaces:
entity resolution's output is a link or a cluster, not a label on a screen. Binette and Steorts
describe canonicalisation as **selecting** the most representative record, so even the stage whose
job is producing one value picks a real observed value and runs downstream of matching.

**So the ruling is neither the standard position nor a minority one. It is a position the literature
does not address.** What the literature does not price, and what is therefore recorded here as a
consequence rather than as a citation: the displayed string and the matched string can disagree, so
when `super u` fires on `CARTE 12/08 CB****SUPER U 44N 4429`, nothing on screen contains `super u`
and the user cannot see why a category was applied. That is a real cost of this ruling and it is
tracked separately rather than solved here.

## Decision 2: the counterparty link (#212)

### The question

A transfer between two accounts the same user owns is imported twice, once as a debit and once as a
credit, and both count at full size. The decision taken: a nullable counterparty link between two
transaction rows, where a linked pair is neither income nor expense and is excluded from budgets and
cash flow while both account balances stay exact. Detection **proposes and never applies**, on
opposite signs, equal amount, near dates, and two accounts the user holds. Double-entry bookkeeping
is refused by name in `docs/explanation/what-this-does-not-do.md`, which also names the counterparty
link as the proportionate answer to this problem.

### The framing was tested, and it holds with one correction

The claim tested: matching a debit on account A to a credit on account B is merchant resolution one
level up, that is, record linkage with a blocking key of amount plus a date window over two sets.

**It is not a superficial resemblance.** **[READ-PDF]** The setup is the two-file cross product
Fellegi and Sunter define at p. 1184, and "blocking" is the correct technical name: Christen's survey
introduces it at p. 1539 as the criterion that "splits the databases into nonoverlapping blocks, such
that only records within each block are compared with each other". Amount equality is an equality
based key and the date window is a similarity based one. The vocabulary transfers exactly, so one
concept does cover both decisions.

**The correction: transfer linkage is one-to-one and merchant resolution is not.** **[READ-PDF]**
Christen states the one-to-one case at p. 1539: "assuming there are no duplicate records in the
databases to be matched (i.e., one record in A can only be a true match to one record in B and vice
versa), then the maximum possible number of true matches will correspond to min(|A|,|B|)."
**[READ-AGENT]** Binette and Steorts report that Fellegi and Sunter's independence assumption is not
satisfied in the context of one-to-one linkage, and name **bipartite record linkage** as the
subfield.

**And the original states two different independence assumptions, which a secondary source's
shorthand hides.** **[READ-PDF]** Fellegi and Sunter assume at p. 1185 that a pair of records "is
selected for comparison according to some probability process", equivalent to drawing a pair at
random from the cross product: that is the pair-level independence one-to-one linkage violates.
Separately, at p. 1189 in section 3.2, they introduce conditional independence of the comparison
vector's components as an explicit **simplifying** assumption, needed only because "the set of
distinct (vector) values of gamma may be so large that the estimation of the corresponding
probabilities becomes completely impracticable", and they are careful at p. 1190: "what we do assume
is that gamma-1, gamma-2, ..., gamma-K are conditionally independently distributed. We emphasize
that we do not assume anything about the unconditional distribution of gamma."

**This matters practically.** The conditional independence assumption belongs to the estimation
problem in section 3, not to the theory in section 2. The two-threshold construction and its theorem
do not depend on it. Since this application has almost no error model to estimate, one exact field
and one structured settlement lag, it takes the decision theory and leaves the statistics, and the
part it takes is the part that never needed the assumption.

### The auto-link region is empty by design

**[READ-PDF]** Fellegi and Sunter's three actions, defined at p. 1185, are a positive link, a
possible link, and a positive non-link. Their two thresholds sit on the likelihood ratio, and
Corollary 1 at p. 1188 gives the construction: with T-mu and T-lambda defined from the ordered
sequence, the rule links when T-mu is at or below the ratio, calls a possible link when the ratio
lies strictly between the two thresholds, and non-links when the ratio is at or below T-lambda.
Corollary 2 adds the property that makes it usable: for **any** two positive numbers with
T-mu greater than T-lambda there exists an admissible pair of error levels at which that rule is
best. So thresholds can be chosen directly rather than derived from error levels that this
application cannot estimate.

**The optimality claim, as the original states it** at p. 1186: among the rules at fixed error
levels, the optimal one satisfies P(A2 | L) at or below P(A2 | L') for every other rule in the
class, and the paper glosses this as maximising positive dispositions, that is, "it minimizes the
probability of failing to make a positive disposition". Note that the original minimises a
**probability**, not an area or a count; "smaller clerical review area" is a reasonable gloss and is
not the original's wording.

**[READ-PDF]** Fellegi and Sunter contemplate one degenerate case, at p. 1189: "In many applications
we may be willing to tolerate error levels sufficiently high to preclude the action A2. In this case
we choose n and n' or, alternatively, T-mu and T-lambda so that the middle set of gamma in (18) or
(19) is empty. In other words every (a, b) is allocated either to M or to U."

**This application does the opposite, and the difference is the design position.** Nothing
auto-links, so the **top** region is empty rather than the middle one: every candidate is either
proposed to the user or not proposed at all. Only the lower threshold is live, and Fellegi and
Sunter's objective degenerates, because minimising the probability of the possible-link class would
mean proposing nothing. **The consequence is the useful part: a wrong link requires a human
confirmation, so the standing bar's false-figure trigger is discharged at the confirmation interface
and not at the threshold.** That moves the design work off threshold tuning and onto what a
confirmation shows.

One further note from the original, because it corrects a contrast drawn during this session.
**[READ-PDF]** At p. 1188 Fellegi and Sunter observe that the whole theory "could have been
formulated, although somewhat awkwardly, in terms of the classical theory of hypothesis testing",
that the rule "is equivalent to the likelihood ratio test", and that the theorem "asserts this to be
the uniformly most powerful test for either hypothesis". So the Neyman-Pearson framing is not an
alternative to Fellegi and Sunter, it is inside it; what Fellegi and Sunter add is the third action.

### The window and the tolerance are tuned constants

**[READ-PDF]** Christen's survey says so plainly at p. 1540: "The optimal values of these parameters
depend both upon the data to be matched (such as distribution of values and error characteristics)
as well as the choice of blocking key(s) used. This makes it often difficult in practice to achieve
a good indexing, because time consuming manual parameter tuning, followed by test linkages and
careful evaluation is required." It adds, at the same page, that in many real-world applications "no
data that contain the known true match status of record pairs are available that can be used to
assess linkage quality", and closes the point as an aspiration rather than an achievement: "Ideally,
an indexing technique for record linkage and deduplication should be robust with regard to the
selected parameter values or not require parameters at all, which would allow automated indexing."

**[READ-AGENT]** Papadakis et al. reach the same verdict for blocking generally, that automatic,
data-driven, a-priori parameter configuration remains an open problem.

**So the window and the amount tolerance are tuned constants and this note does not pretend
otherwise.** What the literature offers instead of a principle is a measurement, Pair Completeness,
which names what a window costs in recall, and **[READ-AGENT]** Maskat, Paton and Embury's
pay-as-you-go configuration, which uses confirm and reject feedback to configure the process. **The
confirm and reject stream this feature produces is the only calibration data this application will
ever have**, since it ships with no labelled transfers and cannot acquire any offline.

**[READ-PDF]** One caution on that, from Christen p. 175, which the pay-as-you-go framing does not
carry: the manually classified pairs are drawn from the possible-match class, which "does contain
the most difficult to classify record pairs", so "using manually classified pairs as training data
for a record pair classifier therefore needs to be considered carefully". A calibration stream drawn
only from what was proposed is biased by what was proposed.

### The bipartite hazard, and where it surfaces

Two 200 EUR debits and two 200 EUR credits inside one window is a two by two assignment, not four
independent pair decisions. Per-pair thresholding can propose a globally impossible configuration,
for example linking one debit to both credits, or proposing a pairing while a better one goes
unoffered.

**[READ-PDF]** Christen states the reviewer-facing half of this at p. 174, and it is the sharpest
sentence found for this decision: "looking at Fig. 7.4, one can see that even for an experienced
domain and data matching expert it can be difficult to make an accurate manual classification when
assessing a single record pair in isolation. Other records might be similar and have characteristics
that also make them potential match candidates even though they have a lower overall similarity ...
Ideally, therefore, a system that facilitates manual clerical review should visualise not just a
pair of records but a whole group of similar records, for example in the same way as a Web search
engine presents a list of query results ranked according to relevance."

So the assignment problem does not only live in the classifier. It reaches the confirmation, and the
published guidance is to show the competing candidates rather than one pair.

### What a confirmation carries: three shapes, as options

The design position taken is that a proposal carries its own evidence, because a confirmation
without evidence is a guess the user rubber-stamps. **[VENDOR]** No product surveyed publishes why a
candidate was proposed: Quicken ships propose-never-apply as a visible preference but publishes
neither a window nor a tolerance; Toshl publishes tolerances of 4 days for automatic detection, 10
days for manual review and 5 percent on amount, but not per-pair reasoning; Actual Budget requires
amounts "exactly the same but inverted" and its control simply becomes unavailable otherwise, with
no page explaining why. **The literature, unlike the products, does address this**, at Christen
pp. 174 to 176.

Three shapes, as options rather than a recommendation.

**Shape A, the pair and its two gaps.** Both transactions' amount, date and account, plus the day
gap, the amount gap, and which tolerance each fell inside. Cost: the cheapest possible, since
detection computes all three values anyway. Limit: it is **[READ-PDF]** Christen's Fig. 7.4 (p. 175)
exactly, a pair with the differing fields emphasised and a similarity score, and Christen's own
criticism on the facing page applies to it, that a single pair in isolation is hard to judge because
a better candidate may exist and is invisible.

**Shape B, the pair plus the candidates it beat.** The proposed counterparty and every other
candidate inside the window, ranked, each with its own gaps. This is Christen's p. 174
recommendation applied. Cost: detection must retain the candidate set rather than only the winner,
and the confirmation becomes a choice rather than a yes or no. Benefit: it is the only shape that
surfaces the bipartite hazard to the person who can resolve it, since where two debits and two
credits compete the user sees the competition instead of confirming an arbitrary pairing.

**Shape C, a graded response rather than a binary one.** **[READ-PDF]** Christen's Fig. 7.5 (p. 176)
is a variant "that allows a reviewer to provide feedback about the confidence of their manual
classification decision", offering clear match, likely match, likely non-match and clear non-match.
Cost: the two middle answers need a meaning, and a likely match that is not applied is a state the
application must then carry. Benefit, and it interacts with a decision already taken: under
"propose once, never ask twice" a rejection is permanent, so with a binary control a user who is
unsure once loses the proposal for good, and a graded control separates "no" from "not now".

**[READ-PDF]** One cost applies to all three, from Christen p. 175: a clerical decision "can differ
not only from reviewer to reviewer, but even the same reviewer might make different decisions
depending upon their mood, time of day and concentration level", and the remedy offered is a second
reviewer. A single-user self-hosted application has no second reviewer, so whatever the proposal
shows is the only defence there is.

### Human in the loop, and what is not a known pattern

**[READ-AGENT]** The architecture has a standard name. CrowdER states it as machines doing an
initial coarse pass over all the data and people verifying only the most likely matching pairs, and
Vesdapunt et al. formalise the objective as minimising expected oracle calls, which is Fellegi and
Sunter's clerical region rediscovered. Active learning is a different mechanism and should not be
conflated with this one: active learning asks in order to train, whereas here the confirmation is
the decision. **[READ-PDF]** Christen makes the same separation at p. 175, treating clerical review
and active learning as distinct sections.

**"Propose once, never ask twice" is not named in anything read.** **[READ-AGENT]** Its halves are
known: a persisted rejection is a **cannot-link constraint** in the constrained clustering sense of
Wagstaff, Cardie, Rogers and Schroedl, notably a hard constraint the output must satisfy rather than
a penalty, which is exactly the semantics chosen; and "do not ask what can be inferred" is
transitive redundancy elimination in the oracle model. The composite appears to be this project's
own, and it is recorded as unnamed rather than given a borrowed name.

### Where the literature is thin, said rather than padded

**[READ-AGENT]** A search for peer-reviewed work on automated accounting reconciliation returned
overwhelmingly vendor marketing and patents. Accounting is not the closer field here, it is the
thinner one. One item was found and only its abstract was read **[UNREAD]** for its body: current
systems are effective for one-to-one matching but underperform on one-to-many, which is relevant
because a transfer carrying a fee is one-to-many.

## Security and standards position

Both decisions add stored, derived data computed from untrusted input. Both are tier 3 when they are
implemented and both need all three database engines. MariaDB is accent-insensitive by default, which
bears directly on any folded label. **Nothing below is a claim that a requirement is currently unmet;
requirement text is quoted inline so that no reader has to open a file to check the wording.**

**The cleaned name is untrusted input reaching a new stored context.** ASVS `v5.0.0-1.3.3`, level 2,
Encoding and Sanitization / Sanitization: "Verify that data being passed to a potentially dangerous
context is sanitized beforehand to enforce safety measures, such as only allowing characters which
are safe for this context and trimming input which is too long." A cleaned name derived downstream
of `sanitizeImportedText` inherits whatever that function does, and #594 records by reading that its
ordering is defective, since the trim runs before the test.

**The counterparty link is a direct object reference between two rows that must both belong to the
caller.** ASVS `v5.0.0-8.2.2`, level 1, Authorization / General Authorization Design: "Verify that
the application ensures that data-specific access is restricted to consumers with explicit
permissions to specific data items to mitigate insecure direct object reference (IDOR) and broken
object level authorization (BOLA)." This is the class #596 describes, and the direction recorded
there applies: scope in the query rather than in a comment, so that a foreign tenant is a zero-row
result rather than a correct answer about somebody else. The link is harder than the single-read case
in one specific way: **it takes two identifiers, so both sides need scoping, and a test that scopes
one side and not the other is green for the wrong reason.**

ASVS `v5.0.0-1.2.10` is level 3 and is quoted in #594 as context only. Nothing in this note changes
that, and nothing should be added to the level 2 map on the strength of this note.

**AISVS does not apply, and the condition under which that stops being true is recorded because it
would otherwise go stale silently.** Neither decision touches the AI path. The condition:
`anonymizeMerchant` is what feeds the labels reaching the local model prompt, behind an explicit
opt-in. **AISVS stays out of scope as long as #520's cleaned name remains a separate derived field
and does not become what `anonymizeMerchant` returns.** If it ever replaces that output, AISVS
chapter C02 applies, and its identifier form is `v1.0-Cx.y.z`, which must never be blended with the
ASVS `v5.0.0-x.y.z` form.

## References

Every identifier below was resolved during this session. Where a source has no DOI, that is stated
rather than left for a reader to wonder about.

**Read in this session from the publisher's PDF.**

- Fellegi, I. P., and Sunter, A. B. "A Theory for Record Linkage." _Journal of the American
  Statistical Association_ 64, no. 328 (1969): 1183-1210. DOI `10.1080/01621459.1969.10501049`.
  Volume, issue, year and page range all confirmed on the article's own first page.
- Christen, P. _Data Matching: Concepts and Techniques for Record Linkage, Entity Resolution, and
  Duplicate Detection._ Data-Centric Systems and Applications. Springer, 2012. DOI
  `10.1007/978-3-642-31164-2`. Chapters 3 and 7 read; the DOI is confirmed on the book's own chapter
  footers. **Crossref stores this title truncated to "Data Matching" as well, dropping the subtitle
  printed on the book's cover.**
- Christen, P. "A Survey of Indexing Techniques for Scalable Record Linkage and Deduplication."
  _IEEE Transactions on Knowledge and Data Engineering_ 24, no. 9 (2012): 1537-1555. DOI
  `10.1109/TKDE.2011.127`. The published first page is 1537, which confirms the pagination; an
  author's accepted manuscript circulates without it and differs in at least one sentence, recorded
  above.

**Read in this session by a reading agent, from an online copy, not re-verified by this note's
author.** Every DOI below was nevertheless resolved against Crossref by this note's author, and the
author lists, venues and page ranges printed here are Crossref's, not a recollection.

- Papadakis, G., Skoutas, D., Thanos, E., and Palpanas, T. "Blocking and Filtering Techniques for
  Entity Resolution: A Survey." _ACM Computing Surveys_ 53, no. 2 (2020): 1-42. DOI
  `10.1145/3377455`. Crossref records the page range; the article number 31 was read from the
  document's own running footer by the reading agent and is not in the Crossref record.
- Christophides, V., Efthymiou, V., Palpanas, T., Papadakis, G., and Stefanidis, K. "An Overview of
  End-to-End Entity Resolution for Big Data." _ACM Computing Surveys_ 53, no. 6 (2020): 1-42. DOI
  `10.1145/3418896`. **Caution:** the open arXiv version (`arXiv:1905.06397v3`) is titled
  "End-to-End Entity Resolution for Big Data: A Survey", which is not the published title above. Do
  not cite the arXiv title against this DOI.
- Binette, O., and Steorts, R. C. "(Almost) all of entity resolution." _Science Advances_ 8, no. 12
  (2022): eabi8021. DOI `10.1126/sciadv.abi8021`.
- Aho, A. V., and Corasick, M. J. "Efficient string matching: an aid to bibliographic search."
  _Communications of the ACM_ 18, no. 6 (1975): 333-340. DOI `10.1145/360825.360855`. **Crossref
  stores this title truncated to "Efficient string matching", dropping the subtitle. The full title
  above is the correct one and Crossref's record is the wrong one.** Verified directly against the
  Crossref API in this session.
- Cohen, W. W., Ravikumar, P., and Fienberg, S. E. "A Comparison of String Distance Metrics for
  Name-Matching Tasks." In _Proceedings of the IJCAI-03 Workshop on Information Integration on the
  Web (IIWeb-03)_, 2003. **This paper has no DOI.** Crossref holds no record for it. ACM's
  `10.5555/3104278.3104293` is an ACM internal identifier and is **not** a DOI, so it is not
  presented as one here. The page range 73-78 circulates widely and **could not be confirmed on
  retrieval**, so no pages are asserted. The dblp key `conf/ijcai/CohenRF03` locates it.
- Toran, L., et al. "Scalable and Weakly Supervised Bank Transaction Classification."
  `arXiv:2305.18430v2` (2023). **No DOI was resolved for this work; the arXiv identifier is the
  reliable locator.**
- Akritidis, L., et al. `arXiv:1903.04276` (2019), on numeric tokens in product titles. **No DOI was
  resolved; the arXiv identifier is the reliable locator.**
- Koepcke, H., Thor, A., Thomas, S., and Rahm, E. On product matching, _EDBT_ 2012. **No DOI was
  resolved for this work in this session**; it is located by venue and year.
- Wang, J., Kraska, T., Franklin, M. J., and Feng, J. "CrowdER: Crowdsourcing Entity Resolution."
  _Proceedings of the VLDB Endowment_ 5, no. 11 (2012): 1483-1494. DOI `10.14778/2350229.2350263`.
- Vesdapunt, N., Bellare, K., and Dalvi, N. "Crowdsourcing algorithms for entity resolution."
  _Proceedings of the VLDB Endowment_ 7, no. 12 (2014): 1071-1082. DOI `10.14778/2732977.2732982`.
- Sarawagi, S., and Bhamidipaty, A. "Interactive deduplication using active learning" (ALIAS).
  _Proceedings of the eighth ACM SIGKDD international conference on Knowledge discovery and data
  mining_, 2002, 269-278. DOI `10.1145/775047.775087`. **Note the year: 2002, not 2003.**
- Maskat, R., Paton, N. W., and Embury, S. M. "Pay-as-you-go Configuration of Entity Resolution."
  _Lecture Notes in Computer Science_, 2016, 40-65. DOI `10.1007/978-3-662-54037-4_2`. **A DOI
  constructed from memory during this session (`10.1007/978-3-662-53455-7_3`) resolved to a
  different paper entirely and was discarded; the DOI above was retrieved by bibliographic query and
  then re-resolved.**
- Wagstaff, K., Cardie, C., Rogers, S., and Schroedl, S. "Constrained K-means Clustering with
  Background Knowledge." _ICML_ 2001. **No DOI exists for this paper**; it is located by the
  proceedings and year.
- Jaro, M. A. "Advances in Record-Linkage Methodology as Applied to Matching the 1985 Census of
  Tampa, Florida." _Journal of the American Statistical Association_ 84, no. 406 (1989): 414-420.
  DOI `10.1080/01621459.1989.10478785`. Used for the linear assignment point only.
- Sadinle, M. "Bayesian Estimation of Bipartite Matchings for Record Linkage." _Journal of the
  American Statistical Association_ 112, no. 518 (2017): 600-612. DOI
  `10.1080/01621459.2016.1148612`. Identifier and title resolved; **[UNREAD]**.
- Wang, X., et al. Hyperscan, _NSDI_ 2019. **No DOI was resolved for this work**; it is located by
  venue and year.

**Vendor documentation, engineering context only.** Firefly III documentation and tracker (issues
5265, 12084, 12437 and discussion 10554); Actual Budget documentation, source and tracker (issues
6737, 8618); YNAB support articles; Monarch Money help centre; Quicken support articles; Toshl blog.
All were read in this session by a reading agent; the GitHub MCP server failed to authenticate
throughout, so all tracker facts came from the `gh` CLI. **Nothing was tested against a running
instance of any product.**

## What was not read, and why

- **Journal of Finance and Data Science, DOI `10.1016/j.jfds.2025.100170`.** Gold open access, but
  ScienceDirect refused automated retrieval. **[UNREAD]** beyond its abstract. Its one-to-many
  finding is cited above as an abstract-level claim and nothing rests on it.
- **Sadinle 2017, DOI `10.1080/01621459.2016.1148612`.** The bipartite linkage literature itself.
  Identifier verified, paper not read. **This is the largest remaining gap** and it is the one that
  would most change the bipartite section above.
- **Zenodo deposit `10.5281/zenodo.22094383`.** Abstract only, and deliberately not relied on: the
  title contains a non-word, the deposit is typed as a dataset while claiming a journal article, and
  a reported Macro-F1 of 0.9961 on 17-class noisy text makes leakage the first hypothesis. **No
  figure from it appears in this note.**
- **`arXiv:2506.09234`.** Abstract only. It bears on none of the questions here and is recorded so
  that a later session does not rediscover and re-evaluate it.
- **Whether settlement-lag modelling has been studied.** The date offset between the two halves of a
  transfer is per-account-pair and directional rather than symmetric noise, which is the one place
  this problem has structure that generic entity resolution does not. Nothing was found, and the
  search was not exhaustive. **This is the most promising unexplored thread** and is the likeliest
  route to a date window that is not a tuned constant.
- **Whether any peer-reviewed work evaluates string similarity metrics on payment descriptors
  specifically.** Reported as "nothing was found", which is not the same as "nothing exists":
  keyword search cannot see a differently worded literature.

## What would change this note

- Reading Sadinle 2017, which could replace the bipartite section's secondary sourcing with a
  primary one.
- Any measurement of the catalogue's nested pattern pairs, which would replace the two known
  instances with a count.
- Any finding that `sanitizeImportedText` behaves differently on PostgreSQL or MySQL from what #594
  measured on SQLite, which would move the cleaned name's sanitisation from a derived concern to a
  primary one.
