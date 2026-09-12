# What the record linkage literature says about the two decisions that need an algorithm

Primary-source research note. Compiled 2026-09-12, read-only, no implementation.

**Where this came from.** Two design decisions were taken and both needed an algorithm: the merchant
label index (#520) and the counterparty link between two transactions the same user owns (#212).
The algorithms were chosen from the literature rather than invented, and this file is the record of
that reading. It lives in a tracked directory beside the perception note for the reason that note
gives: evidence behind a ruling has to resolve for whoever reads the ruling, not only for whoever
wrote it.

**One typographic note**, the same one the sibling notes in this directory carry. This repository's
prose rule (`AGENTS.md`, gated by `src/lib/prose/emDashesInProse.spec.ts`) allows no em dash in a
tracked Markdown file. Where a quoted source used one it is rendered here as a comma or a colon; no
quoted wording is altered.

## How to read this note

This note will be opened once, months from now, by someone deciding whether to reopen a settled
question. That reader needs to tell, in one pass, what each claim rests on. **Every claim carries a
tag and nothing is untagged.** There are four classes; the read class records who did the reading,
because that changes how much the claim is worth.

| Tag              | Class                | What it means                                                                                                                                                                                                                                                                                |
| ---------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[MEASURED]**   | measured in a run    | A figure produced by a command run against this repository or an API. The command, the date and the commit or endpoint are given with it.                                                                                                                                                    |
| **[READ-PDF]**   | read in a paper      | Read for this note, from the publisher's PDF, by this note's author. A page number is given. **The maintainer has independently verified the Fellegi and Sunter and survey citations; he has not read the monograph, so monograph claims are quoted verbatim and remain unverified by him.** |
| **[READ-AGENT]** | read in a paper      | Read by a parallel reading agent during the session, from an online copy, and **not re-verified against the source by this note's author**. Trust it less than [READ-PDF].                                                                                                                   |
| **[NOT READ]**   | not read             | Nobody in this project has read the source. Recorded so the gap is visible rather than assumed away.                                                                                                                                                                                         |
| **[VENDOR]**     | vendor documentation | A vendor's own documentation, or a maintainer statement in a public tracker. Engineering context about what a vendor says its product does. **Never a validated accuracy claim.**                                                                                                            |

Two further conventions, adopted from scientific writing practice and worth stating because they
change how the note reads:

- **An unverified thing is marked unverified.** There is no plausible boilerplate standing in for a
  fact nobody checked.
- **Every borrowed claim is bounded.** Where a source's statement is about a different problem from
  ours, the note says so at the point of use rather than letting the analogy pass as inheritance.

**Diataxis type: explanation.** This note exists to make two decisions understandable. It is not a
how-to and not reference; no procedure here is meant to be followed.

## Method

Searches ran against Crossref, OpenAlex, DataCite, arXiv, Unpaywall and Semantic Scholar. **Every
identifier printed below was resolved during this session**, and the resolution was re-run after
drafting rather than trusted from a brief. Three papers were read from publisher PDFs obtained
through the maintainer's institutional access and held in a local gitignored folder; they are cited
by DOI only, because a path into that folder resolves for nobody else and citing it would repeat the
failure #601 exists to fix.

Three parallel reading agents covered the entity resolution literature, the transfer matching
literature and competitor documentation. Their agreement was not treated as evidence, since two
agents can share one bad source.

**Two verification failures from this session are recorded because they shaped the method.** Two
DOIs built from memory resolved to the wrong papers and were discarded rather than repeated. And an
earlier draft of this note asserted a discrepancy between the published indexing survey and its
accepted manuscript, on the strength of reading **one page** of a nineteen-page paper; the clause in
question is on a later page and the discrepancy did not exist. Both failures have the same shape,
which is why the note now records, for every source, how much of it was read.

## Decision 1: the merchant label index (#520)

### The question

A raw bank descriptor is not a merchant name. `CB****PRET A MANGER 44N 12/08` carries the merchant, a
card fragment, a location code and a date. The catalogue that assigns a category matches against it
by case-insensitive and accent-insensitive substring containment.

**[MEASURED]** The catalogue holds 157 entries: 141 plain substring patterns, of which 100 are
single-token and 41 multi-token, plus 16 regular expressions. Measured in #520 on 2026-08-25 against
`main` at `0d27bc0`, by calling the production functions rather than retyping them. Against six noise
shapes the 100 single-token patterns broke 0 times out of 141, because containment does not care
about a prefix or a suffix; the 41 multi-token patterns broke 41 out of 41 whenever noise landed
**between** the words of a merchant name.

The decision: store a cleaned name as an **additional** field beside the raw descriptor. The raw
label is never destroyed and remains what `/transactions` displays. The deduplication key is not
touched. Resolution runs two ordered passes against the catalogue, pass 1 with digits preserved and
pass 2 with bare numeric tokens dropped, first match wins.

The conflict the two passes resolve: a numeric token is noise in `SUPER 4429 U` and signal in
`microsoft 365`, `trading 212` and `optic 2000`.

### What the literature says for the shape chosen

**[READ-PDF]** Christen's indexing survey states the remedy verbatim, in section 3.1 Traditional
Blocking, **p. 1541**:

> As discussed in Section 2, a major drawback of traditional blocking is that errors and variations
> in the record fields used to generate BKVs will lead to records being inserted into the wrong
> block. This drawback can be overcome by using several blocking key definitions based on different
> record fields, or different encodings applied on the same record fields.

**Two ordered passes over one field is the second half of that sentence.** The practice is
demonstrated in the survey's own Table 1 (**p. 1539**), where postcode appears in all three example
blocking keys under three different encodings: the full value, its first two digits, and its last two
digits.

**[READ-AGENT]** Papadakis et al. call a scheme that places one entity into several blocks
**redundancy-positive**, as against redundancy-free schemes that assign every entity to a single
block. So the design has a name in the field.

### What the literature says against it

**The premise "nothing in the string itself distinguishes them" is too strong.** **[READ-AGENT]**
Two papers on short noisy commercial strings resolve numeric noise against signal per token by
external lexicon rather than by a global fold. Akritidis et al. classify a numeric token as an
attribute when a measurement unit follows it and as a model descriptor when none does; `32 GB`
against `GTX1050` is `SUPER 4429 U` against `trading 212`. Koepcke, Thor, Thomas and Rahm remove
known feature tokens first, so surviving alphanumerics are signal; their algorithm's verification
step is a network call, which this application's offline constraint forbids, and that limit is
recorded rather than glossed.

The discriminator need not live in the string. It can live in a lexicon, and the catalogue already
is one. Two ordered passes is a correct redundancy-positive scheme; it is a crude one in that the
pass order rather than the match site carries the noise-against-signal decision, and nothing records
which pass fired.

### The two hazards are two different problems

`catalog.ts` carries a comment naming an ordering hazard, and #520's body describes it as the
`UBEREATS` case. **These are two problems, and the comment names one that cannot occur at the
spelling it gives.**

**[MEASURED]** The four catalogue entries, read from the JSON files at `8b42eb4`:

| key                          | match          |
| ---------------------------- | -------------- |
| `dining_uber_eats`           | `uber eats`    |
| `transport_uber`             | `uber`         |
| `subscriptions_amazon_prime` | `amazon prime` |
| `shopping_amazon`            | `amazon`       |

**Every specific pattern carries a space, and that settles it without a run.** `normalizeForMatch`
strips combining marks, lowercases and trims; it does not remove interior whitespace. The pattern
`uber eats` contains a space character. The folded label `ubereats` contains no space character. A
string containing no space cannot contain a substring that contains one, so
`"ubereats".includes("uber eats")` is false by the definition of containment, and the only pattern
matching `UBEREATS` is `uber`. **There is no second match, so there is nothing for any ordering or
ranking rule to decide.** This is a proof from the pattern text, not a measurement, and is marked as
such.

The two problems, separated:

- **`UBER EATS`, separator intact.** Both patterns match. A genuine ordering problem, and a ranking
  rule closes it.
- **`UBEREATS`, separator removed.** One pattern matches. This is the normalisation problem, it is
  one of the 41 multi-token shapes, and **[MEASURED]** #520 recorded the fold recovering **3 of 41**
  on that shape on 2026-08-25. No ranking rule reaches it.

**Nothing may describe the ranking change as closing the `UBEREATS` case.**

### Longest match, and why not word boundaries

The question asked was whether the matcher should become a multi-pattern automaton that finds all
matches and ranks them by specificity.

**[READ-AGENT]** Aho and Corasick does not answer it: the output function emits every nested keyword,
and the paper contains no priority rule, no longest-match rule and no rule for choosing between
overlapping matches. The automaton converts "which pattern fires" into "here are all of them, you
decide". The ranking rule is the fix and it does not require the automaton. On scale, Aho and
Corasick's own evaluation used 15 and 24 keywords, and Hyperscan's evaluation runs at 1,300 and 2,800
regular expressions against network traffic; 157 patterns against a short label once per transaction
is neither regime.

**[READ-PDF]** The ranking rule is in the standard monograph, twice. Both quotations are verbatim,
and **neither has been verified by the maintainer, who does not have this book**.

Christen, **p. 53**, on tokenisation:

> The tokenisation is conducted in a 'greedy' fashion [76], in that longer token sequences are
> considered first before shorter ones.

Christen, **p. 54**, with the worked example:

> It is important that longer candidate token sequences are considered first, such that for example
> the token sequence 'sydney uni' is correctly identified to correspond to the standardised locality
> name 'the university of sydney', rather than the single token 'sydney' is assigned as locality name
> and then the second token 'uni' is left as a potentially unknown token.

Christen, **p. 58**, naming the competing orderings:

> The second part of a rule-based system is the ordering or the policies of which rules should be
> fired first when the condition's of several rules are true for a certain sequence of tags. The
> ordering can either be based on the specificity of the rules, in that rules that cover more tags
> are fired first, or it can be based on which output fields are most important and should have
> values assigned to them, or the ordering can be based on a manual sorting of the rules using domain
> knowledge.

**What these three quotations are worth, graded rather than assumed.** None is an evaluated result.
The first two are a normative statement illustrated by one constructed example; the third is a
three-way descriptive taxonomy with no preference stated and no experiment behind it. **So p. 58 may
be cited for "catalogue order is a recognised option" and may not be cited for "the literature
recommends specificity ordering".** And the generalisation is bounded: pp. 53 to 54 are about
tokenising names and addresses against look-up tables during segmentation, **not** about matching a
rule catalogue against a bank descriptor. The transfer is a structural analogy drawn here, which is
that `sydney uni` contains `sydney` exactly as `uber eats` contains `uber`, and not a result
inherited from the book.

**The rule adopted: longest matched text anywhere in the label, tie-broken by catalogue order.**
Three properties must be written beside it.

1. It is **not POSIX leftmost-longest**, which takes the earliest starting position first. On
   `CARTE 12/08 CB****SUPER U 44N 4429` a generic `carte` pattern would beat `super u` under POSIX
   because it starts earlier. The rule adopted here has no standard name.
2. Longest is an exact proxy for most specific **only when one pattern is a substring of the other**.
   `uber` inside `uber eats` and `amazon` inside `amazon prime` are both nested, so for that class the
   rule is a theorem about containment rather than a heuristic.
3. Rank on the length of the **matched text**, not of the pattern, which puts the 141 literals and
   the 16 regular expressions on one scale with no special case.

**How a later reader tells whether this worked**, since a rule adopted without a check is a
conclusion nobody can reconstruct: the count of nested pattern pairs in the catalogue is the
denominator, and every one of them is a case where catalogue order currently decides and ranking
would decide instead. The rule has done its job when that count is known and every pair in it
resolves to the longer pattern without a hand-placed ordering constraint. Until the count exists
there is no criterion, only an argument.

**Why not word boundaries, which is the published fix for this exact bug.** **[READ-AGENT]** Toran et
al. hit it and recorded it: "when designing a classifier for automobile payments, the pattern 'ford'
was used in pattern matching, but triggered false positives due to the word 'afford', which was fixed
along with other examples using word breaks." `ford` inside `afford` is `uber` inside `ubereats`.
**Their fix is unavailable here, because word breaks would destroy the property this project measured
as working**: the 100 single-token patterns are robust to prefixes and suffixes precisely because
containment does not care about boundaries, so a boundary notion would cost that robustness to buy a
property that longest-match ranking supplies for free. Longest match adds no boundary notion at all.
**That is the reason for the choice, and it is recorded here because a later reader would otherwise
pay full price to rediscover it.**

**[READ-PDF]** A second and independent argument for spending effort on the fold rather than on the
matcher, and this one **is** an evaluated result. Christen's survey, **p. 1551**, reporting its own
experiments over four real data sets:

> This figure once more highlights that the definition of suitable blocking keys is one of the most
> crucial components in the indexing step for record linkage or deduplication, and not the actual
> indexing technique employed.

The same page reports that "traditional blocking is the best performing technique for two of the four
data sets", traditional blocking being the simplest technique surveyed. **[MEASURED]** The survey
evaluates 6 indexing techniques in 12 variations; figure read from its abstract, p. 1537.

**[READ-AGENT]** One further note from Toran et al., available with no machine learning: "checking
overlaps and coverage of labeling functions can help notice errors." Enumerating every pair of the
141 literals where one contains the other is finite and would find the whole nesting class rather
than the two entries currently known. Tracked separately; its count belongs to the run that produces
it.

### Display against matching

The ruling is that the raw label is never destroyed and is what `/transactions` displays.

**Chapter 3 of the monograph, pp. 39 to 67, has now been read in full for this question.** An earlier
draft of this note claimed the chapter did not answer it, on the strength of having read about half
of it. That was wrong twice over: the claim overstated what had been read, and the unread half
carries the most relevant material in the chapter.

**[READ-PDF]** Christen, **p. 50**, on inconsistent values, verbatim and unverified by the
maintainer:

> Because a major aspect of the steps involved in data matching is to be able to deal with
> inconsistencies between attribute values, appropriate advice is to only change inconsistent
> attribute values if there is certainty about which value is wrong and needs to be corrected. If it
> is not possible to ascertain this, then the inconsistent values should rather be kept, and
> appropriate approximate comparison and classification techniques need to be applied that can deal
> with such inconsistencies but still achieve high matching accuracy.

**[READ-PDF]** Christen, **pp. 47 to 48**, on variation against error:

> Within the domain of data matching, one therefore has to deal with legitimate name variations as
> well as errors introduced during data entry and recording. While the former need to be preserved to
> improve data matching quality, the latter should be corrected if possible. The challenge lies in
> distinguishing between the two.

**[READ-PDF]** And Christen, **p. 49**, which is the over-folding hazard in general form, warning that
smoothing is unsuitable for matching data because a smoothed attribute:

> would lose much of the discriminating information that helps identify individuals that have the
> same age.

**Bounded, because this matters.** None of these three is about what a human is shown. They are about
what a matcher should be given. **So the literature still does not price the display question**, and
the note does not pretend it does. What the chapter does establish is a **preserve-the-original
default wherever the correction is uncertain**, which supports the ruling from a neighbouring
direction, and a general warning that cleaning which collapses distinctions destroys discriminating
information, which is the argument in decision 1's own terms for keeping the fold away from the
deduplication key.

**[READ-AGENT]** The end-to-end entity resolution survey was searched for raw values, human-facing
output, interface and interpretability, and the only hits are crowd-sourcing and tool interfaces:
entity resolution's output is a link or a cluster, not a label on a screen. Binette and Steorts
describe canonicalisation as **selecting** the most representative record, so even the stage whose
job is producing one value picks a real observed value and runs downstream of matching. **Absence of
a finding is not absence of a literature**, and this is reported as searched-and-not-found.

The cost of the ruling, which the literature does not price: the displayed string and the matched
string can disagree, so when `super u` fires on `CARTE 12/08 CB****SUPER U 44N 4429`, nothing on
screen contains `super u` and the user cannot see why a category was applied. Tracked separately.

## Decision 2: the counterparty link (#212)

### The question

A transfer between two accounts the same user owns is imported twice, once as a debit and once as a
credit, and both count at full size. The decision: a nullable counterparty link between two
transaction rows, where a linked pair is neither income nor expense and is excluded from budgets and
cash flow while both account balances stay exact. Detection **proposes and never applies**, on
opposite signs, equal amount, near dates, and two accounts the user holds. Double-entry bookkeeping
is refused by name in `docs/explanation/what-this-does-not-do.md`, which also names the counterparty
link as the proportionate answer.

### The framing was tested, and it holds with one correction

The claim tested: matching a debit on account A to a credit on account B is merchant resolution one
level up, that is, record linkage with a blocking key of amount plus a date window over two sets.

**It is not a superficial resemblance.** **[READ-PDF]** The setup is the two-file cross product
Fellegi and Sunter define at p. 1184, and blocking is the correct technical name: Christen's survey
introduces it at p. 1539 as the technique "which splits the databases into nonoverlapping blocks,
such that only records within each block are compared with each other". Amount equality is an
equality based key and the date window is a similarity based one.

**The correction: transfer linkage is one-to-one and merchant resolution is not.** **[READ-PDF]** The
survey states the one-to-one case and its consequence at **p. 1539**:

> At the same time, assuming there are no duplicate records in the databases to be matched (i.e., one
> record in A can only be a true match to one record in B and vice versa), then the maximum possible
> number of true matches will correspond to min(|A|,|B|).

and, on the same page, that "while the computational efforts of comparing records increase
quadratically as databases are getting larger, the number of potential true matches only increases
linearly in the size of the databases". **[READ-AGENT]** Binette and Steorts report that Fellegi and
Sunter's independence assumption is not satisfied under one-to-one linkage, and name **bipartite
record linkage** as the subfield.

**The original states two different independence assumptions, and a secondary source's shorthand
hides which is meant.** **[READ-PDF]** Fellegi and Sunter assume at **p. 1185** that a pair of records
"is selected for comparison according to some probability process", equivalent to drawing a pair at
random from the cross product: that is the pair-level independence one-to-one linkage violates.
Separately, in section 3.2 opening at p. 1189, they introduce conditional independence of the
comparison vector's components as an explicit **simplifying** assumption, needed only because the
comparison space may be too large to estimate over, and they are careful at **p. 1190**:

> what we do assume is that gamma-1, gamma-2, ..., gamma-K are conditionally independently
> distributed. We emphasize that we do not assume anything about the unconditional distribution of
> gamma.

**Appendix I confirms that the theorem does not need the second assumption.** **[READ-PDF]** The proof
at pp. 1203 to 1207 uses only the ordering of the comparison space by the likelihood ratio and the
definitions of the two error levels. The paper says as much at **p. 1207**: "we have proved that L0
is optimal separately under both the conditions M and the condition U. This also explains why the
prior probabilities P(M) and P(U) do not enter either the statement or the proof of the theorem; our
result is independent of these prior probabilities."

This matters practically. The conditional independence assumption belongs to the estimation problem,
not to the theory. Since this application has almost no error model to estimate, one exact field and
one structured settlement lag, it takes the decision theory and leaves the statistics, and the part
it takes never needed the assumption.

### The auto-link region is empty by design

**[READ-PDF]** Fellegi and Sunter's three actions, defined at p. 1185, are a positive link A1, a
possible link A2, and a positive non-link A3. Corollary 1 at **p. 1188** gives the two-threshold
construction on the likelihood ratio: link when the ratio is at or above T-mu, call a possible link
when it lies strictly between the thresholds, and non-link when it is at or below T-lambda.
Corollary 2 adds the property that makes it usable: for **any** two positive numbers with T-mu
greater than T-lambda there exists an admissible pair of error levels at which that rule is best. So
thresholds can be chosen directly rather than derived from error levels this application cannot
estimate.

**The optimality claim as the original states it**, at **p. 1186**: among rules at fixed error levels,
the optimal one satisfies P(A2 | L) at or below P(A2 | L') for every other rule in the class, glossed
as "it minimizes the probability of failing to make a positive disposition". The original minimises a
**probability**, not an area or a count.

**[READ-PDF]** Fellegi and Sunter contemplate one degenerate case, at **p. 1189**, quoted whole:

> In many applications we may be willing to tolerate error levels sufficiently high to preclude the
> action A2. In this case we choose n and n' or, alternatively, T-mu and T-lambda so that the middle
> set of gamma in (18) or (19) is empty. In other words every (a, b) is allocated either to M or to U.

**This application does the opposite.** Nothing auto-links, so the **top** region is empty rather than
the middle one: every candidate is either proposed to the user or not proposed at all. Only the lower
threshold is live, and the minimise-P(A2) objective degenerates, because minimising the proposal
class would mean proposing nothing. **The consequence is the useful part: a wrong link requires a
human confirmation, so the standing bar's false-figure trigger is discharged at the confirmation
interface and not at the threshold.** That moves the design work off threshold tuning and onto what a
confirmation shows.

### The objection the paper makes to this configuration, and the answer

**[READ-PDF]** Immediately after defining the optimal rule, at **p. 1186**, Fellegi and Sunter write:

> This seems a reasonable approach since in applications the decision A2 will require expensive
> manual linkage operations; alternatively, if the probability of A2 is not small, the linkage process
> is of doubtful utility.

**We have made P(A2) equal to one by design, so that sentence is the paper judging this
configuration, and it is recorded rather than omitted.**

**The answer, which is the maintainer's and is argued rather than asserted: the objection does not
transfer, because the cost term it rests on is not our cost term.** Fellegi and Sunter's A2 is paid
clerical labour at statistical-agency scale, on files whose cross product they size at ten to the
tenth comparisons (p. 1189); minimising it is minimising a payroll. Ours is one person, the account
holder, on a handful of candidates a month, and that person is the only party in the system who
actually knows whether two rows are the same movement of money. **For us the confirmation is not a
cost to be minimised, it is the product**: it is where a fact enters the system that no classifier
could have derived, and it is where the standing bar is discharged. A design that minimised P(A2)
here would be minimising the number of times the only competent authority is consulted.

**What does transfer is the second clause**, that the process is of doubtful utility if A2 is not
small. It transfers as a load constraint rather than as a correctness one: if detection proposes
faster than one person will confirm, the feature has failed in exactly the way the sentence
describes, and the figure to watch is proposals per month per user, not precision.

**[READ-PDF]** A further limit from the same paper, at **p. 1207**, which bears on any attempt to
replace the two thresholds with a cost function: "The situation would change if one tried to minimize
the unconditional probability of misallocation or if one tried to minimize some general loss
function." **So Fellegi and Sunter's optimality does not extend to a loss-minimising framing.** Given
that our costs are strongly asymmetric, reaching for a loss function is the obvious move, and this is
the primary-source reason it does not inherit their guarantee.

### The window and the tolerance are tuned constants

**[READ-PDF]** Christen's survey says so at **p. 1540**: "The optimal values of these parameters
depend both upon the data to be matched (such as distribution of values and error characteristics) as
well as the choice of blocking key(s) used. This makes it often difficult in practice to achieve a
good indexing, because time consuming manual parameter tuning, followed by test linkages and careful
evaluation is required." It closes the point as an aspiration: "Ideally, an indexing technique ...
should be robust with regard to the selected parameter values or not require parameters at all, which
would allow automated indexing."

**[READ-PDF]** And it states the precondition for tuning at all, at **p. 1553**:

> For effective parameter tuning, some form of "gold standard" data, where the true match status of
> record pairs is known, must be available. Such data must have the same characteristics as the data
> to be linked or deduplicated.

The survey's own conclusions, same page, add that because such data is usually unavailable "it is
commonly up to domain and linkage experts to decide how such blocking keys are defined".

**This sharpens the calibration argument rather than merely supporting it.** Without confirm and
reject feedback there is no tuning at all, not merely worse tuning: a self-hosted instance ships with
no labelled transfers and cannot acquire any offline, so the user's own confirmations are the only
gold standard that will ever exist for that instance. **[READ-AGENT]** Maskat, Paton and Embury's
pay-as-you-go configuration is the named technique for using that feedback.

**[READ-PDF]** One caution the pay-as-you-go framing does not carry, from Christen **p. 175**: the
manually classified pairs come from the possible-match class, which "does contain the most difficult
to classify record pairs", so "using manually classified pairs as training data for a record pair
classifier therefore needs to be considered carefully". A calibration stream drawn only from what was
proposed is biased by what was proposed.

### The bipartite hazard, and where it surfaces

Two 200 EUR debits and two 200 EUR credits inside one window is a two by two assignment, not four
independent pair decisions. Per-pair thresholding can propose a globally impossible configuration,
for instance linking one debit to both credits, or offering a pairing while a better one goes
unoffered.

**[READ-PDF]** Christen states the reviewer-facing half at **p. 174**, verbatim and unverified by the
maintainer:

> First of all, looking at Fig. 7.4, one can see that even for an experienced domain and data
> matching expert it can be difficult to make an accurate manual classification when assessing a
> single record pair in isolation. Other records might be similar and have characteristics that also
> make them potential match candidates even though they have a lower overall similarity. For the
> given example, there might be another record with surname 'Stevens', given name 'Sal' and age '17'
> but with a missing gender value, and an overall similarity of 72 %. This could well be a better
> matching record. Ideally, therefore, a system that facilitates manual clerical review should
> visualise not just a pair of records but a whole group of similar records, for example in the same
> way as a Web search engine presents a list of query results ranked according to relevance.

**Graded: this is a reasoned recommendation, not an evaluated result.** The word is "Ideally", the
supporting case is explicitly hypothetical ("there might be another record"), and no user study or
measured reviewer accuracy is offered. It is adopted because its argument holds independently on our
own problem's structure, not because the book measured it.

### The design position: the proposal carries its own evidence

**[VENDOR]** No product surveyed publishes why a candidate was proposed. Quicken ships
propose-never-apply as a visible preference but publishes neither a window nor a tolerance; Toshl
publishes tolerances of 4 days for automatic detection, 10 days for manual review and 5 percent on
amount, but no per-pair reasoning; Actual Budget requires amounts "exactly the same but inverted" and
its control simply becomes unavailable otherwise, with no page explaining why.

**The position taken: the proposal carries its own evidence, and where a candidate set exists it
shows the group ranked by relevance rather than a pair in isolation.** Concretely, both amounts, both
dates, the gap in days, both account names, and which tolerance the pair fell inside.

**Shape B, degenerating to shape A when there is exactly one candidate.** Showing a group where there
is no group is complexity for nothing, and the degenerate case is the common one.

**A graded confirmation control is refused, and the tension it named is recorded rather than lost.**
**[READ-PDF]** Christen's Fig. 7.5 (**p. 176**) is a variant "that allows a reviewer to provide
feedback about the confidence of their manual classification decision", offering clear match, likely
match, likely non-match and clear non-match. The tension is real: under "propose once, never ask
twice" a rejection is permanent, so a two-button control loses the proposal for anyone who hesitates.
**The answer is not a confidence scale but a third neutral state that does not persist as a
rejection**, so that declining to decide is distinguishable from deciding no.

**[READ-PDF]** One cost applies whatever the shape, from Christen **p. 175**:

> the manual match or non-match decision made can differ not only from reviewer to reviewer, but even
> the same reviewer might make different decisions depending upon their mood, time of day and
> concentration level. It is therefore of advantage to have more than one reviewer assessing the same
> set of record pairs, so that in case of a conflicting classification of a certain pair an
> additional review can be asked for.

**A single-user self-hosted application has no second reviewer**, so the remedy the book offers is
unavailable and what the proposal displays is the only defence there is. That is the argument for
spending effort on the evidence a proposal carries rather than on the threshold that generated it.

### Human in the loop, and what is not a known pattern

**[READ-AGENT]** The architecture has a standard name. CrowdER states it as machines doing an initial
coarse pass over all the data and people verifying only the most likely matching pairs, and Vesdapunt
et al. formalise the objective as minimising expected oracle calls. Active learning is a different
mechanism and should not be conflated: it asks in order to train, whereas here the confirmation is
the decision. **[READ-PDF]** Christen keeps them in separate sections, clerical review at 7.4 and
active learning at 6.7.

**"Propose once, never ask twice" is not named in anything read.** **[READ-AGENT]** Its halves are
known: a persisted rejection is a **cannot-link constraint** in the constrained clustering sense of
Wagstaff, Cardie, Rogers and Schroedl, notably a hard constraint the output must satisfy rather than a
penalty; and "do not ask what can be inferred" is transitive redundancy elimination in the oracle
model. The composite appears to be this project's own. **Recorded as not found in what was read,
which is not the same as not existing.**

### Where the literature is thin, said rather than padded

**[READ-AGENT]** A search for peer-reviewed work on automated accounting reconciliation returned
overwhelmingly vendor marketing and patents. Accounting is not the closer field here, it is the
thinner one. **[NOT READ]** One item was found and only its abstract read: current systems are
effective for one-to-one matching but underperform on one-to-many, which is relevant because a
transfer carrying a fee is one-to-many.

## Security and standards position

Both decisions add stored, derived data computed from untrusted input. Both are tier 3 when
implemented and both need all three database engines. MariaDB is accent-insensitive by default, which
bears directly on any folded label. **Nothing below claims a requirement is currently unmet;
requirement text is quoted inline so no reader has to open a file to check the wording.**

**The cleaned name is untrusted input reaching a new stored context.** ASVS `v5.0.0-1.3.3`, level 2,
Encoding and Sanitization / Sanitization: "Verify that data being passed to a potentially dangerous
context is sanitized beforehand to enforce safety measures, such as only allowing characters which
are safe for this context and trimming input which is too long." A cleaned name derived downstream of
`sanitizeImportedText` inherits whatever that function does, and #594 records by reading that its
ordering is defective, since the trim runs before the test.

**The counterparty link is a direct object reference between two rows that must both belong to the
caller.** ASVS `v5.0.0-8.2.2`, level 1, Authorization / General Authorization Design: "Verify that the
application ensures that data-specific access is restricted to consumers with explicit permissions to
specific data items to mitigate insecure direct object reference (IDOR) and broken object level
authorization (BOLA)." This is the class #596 describes, and its direction applies: scope in the
query rather than in a comment. The link is harder than the single-read case in one way: **it takes
two identifiers, so both sides need scoping, and a test that scopes one side and not the other is
green for the wrong reason.**

ASVS `v5.0.0-1.2.10` is level 3 and is quoted in #594 as context only. Nothing here changes that.

**AISVS does not apply, and the condition under which that stops being true is recorded because it
would otherwise go stale silently.** Neither decision touches the AI path. The condition:
`anonymizeMerchant` is what feeds the labels reaching the local model prompt, behind an explicit
opt-in. **AISVS stays out of scope as long as #520's cleaned name remains a separate derived field and
does not become what `anonymizeMerchant` returns.** If it ever replaces that output, AISVS chapter C02
applies, and its identifier form is `v1.0-Cx.y.z`, never blended with the ASVS `v5.0.0-x.y.z` form.

## References

**Every identifier below was resolved during this session**, against Crossref unless another registry
is named. Where a work has no DOI that is stated explicitly, and the absence was confirmed against
**two** independent indexes rather than one, because a gap in a single index reads as nonexistence
when it may only mean not indexed there.

### Read from the publisher's PDF, by this note's author

- Fellegi, I. P., and Sunter, A. B. "A Theory for Record Linkage." _Journal of the American
  Statistical Association_ 64, no. 328 (1969): 1183-1210. DOI `10.1080/01621459.1969.10501049`.
  Volume, issue, year and pages confirmed on the article's first page and against Crossref. Read:
  pp. 1183-1192 and Appendix I, pp. 1203-1207. **Independently verified by the maintainer.**
- Christen, P. _Data Matching: Concepts and Techniques for Record Linkage, Entity Resolution, and
  Duplicate Detection._ Data-Centric Systems and Applications. Springer, 2012. DOI
  `10.1007/978-3-642-31164-2`. Read: chapter 3 in full (pp. 39-67) and section 7.4 (pp. 174-176).
  **Crossref stores this title truncated to "Data Matching", dropping the subtitle printed on the
  cover. Not verified by the maintainer, who does not hold this book**, which is why every claim from
  it above is quoted verbatim with a page.
- Christen, P. "A Survey of Indexing Techniques for Scalable Record Linkage and Deduplication."
  _IEEE Transactions on Knowledge and Data Engineering_ 24, no. 9 (2012): 1537-1555. DOI
  `10.1109/TKDE.2011.127`. Published first page 1537 confirmed on the page itself. Read: pp. 1537-1541
  and 1551-1554. **Independently verified by the maintainer.**

### Read by a reading agent, not re-verified by this note's author

Author lists, venues and page ranges below are Crossref's or arXiv's, retrieved this session, not a
recollection.

- Papadakis, G., Skoutas, D., Thanos, E., and Palpanas, T. "Blocking and Filtering Techniques for
  Entity Resolution: A Survey." _ACM Computing Surveys_ 53, no. 2 (2020): 1-42. DOI
  `10.1145/3377455`. Crossref records the page range; the article number 31 was read from the
  document's running footer by the reading agent and is not in the Crossref record.
- Christophides, V., Efthymiou, V., Palpanas, T., Papadakis, G., and Stefanidis, K. "An Overview of
  End-to-End Entity Resolution for Big Data." _ACM Computing Surveys_ 53, no. 6 (2020): 1-42. DOI
  `10.1145/3418896`. **Caution:** the open arXiv version (`arXiv:1905.06397v3`) is titled
  "End-to-End Entity Resolution for Big Data: A Survey", which is not the published title. Do not
  cite the arXiv title against this DOI.
- Binette, O., and Steorts, R. C. "(Almost) all of entity resolution." _Science Advances_ 8, no. 12
  (2022): eabi8021. DOI `10.1126/sciadv.abi8021`.
- Aho, A. V., and Corasick, M. J. "Efficient string matching: an aid to bibliographic search."
  _Communications of the ACM_ 18, no. 6 (1975): 333-340. DOI `10.1145/360825.360855`. **Crossref
  stores this title truncated to "Efficient string matching", dropping the subtitle. The full title
  above is correct and Crossref's record is not.** Verified directly against the Crossref API.
- Cohen, W. W., Ravikumar, P., and Fienberg, S. E. "A Comparison of String Distance Metrics for
  Name-Matching Tasks." In _Proceedings of the IJCAI-03 Workshop on Information Integration on the Web
  (IIWeb-03)_, 2003. **This paper has no DOI.** Confirmed twice: Crossref holds no record, and
  OpenAlex holds exactly one matching work with `doi: null`. ACM's `10.5555/3104278.3104293` is an ACM
  internal identifier and is **not** a DOI, so it is not presented as one. The page range 73-78
  circulates widely and **could not be confirmed on retrieval**; no pages are asserted here, and the
  Christen survey's own bibliography (entry 12, p. 1554) likewise cites it without pages. The dblp key
  `conf/ijcai/CohenRF03` locates it.
- Wagstaff, K., Cardie, C., Rogers, S., and Schroedl, S. "Constrained K-means Clustering with
  Background Knowledge." _ICML_ 2001. **No DOI.** Confirmed twice: absent from Crossref, and OpenAlex
  holds one matching work with `doi: null`. Located by proceedings and year.
- Wang, X., et al. "Hyperscan: A Fast Multi-pattern Regex Matcher for Modern CPUs." _NSDI_ 2019. **No
  DOI.** Confirmed twice, as above. Located by venue and year.
- Toran, L., Van Der Walt, C., Sammarone, A., and Keller, A. "Scalable and Weakly Supervised Bank
  Transaction Classification." `arXiv:2305.18430` (submitted 2023-05-28). **No DOI; the arXiv
  identifier is the reliable locator.** Title and authors retrieved from the arXiv API this session.
- Akritidis, L., Fevgas, A., Bozanis, P., and Makris, C. "A Clustering-Based Combinatorial Approach to
  Unsupervised Matching of Product Titles." `arXiv:1903.04276` (submitted 2019-03-07). **No DOI; the
  arXiv identifier is the reliable locator.** Title and authors retrieved from the arXiv API this
  session.
- Koepcke, H., Thor, A., Thomas, S., and Rahm, E. "Tailoring entity resolution for matching product
  offers." In _Proceedings of the 15th International Conference on Extending Database Technology
  (EDBT)_, 2012, 545-550. DOI `10.1145/2247596.2247662`. **An earlier draft of this note recorded this
  work as having no DOI. That was wrong: the DOI was found by bibliographic query and resolved.**
- Wang, J., Kraska, T., Franklin, M. J., and Feng, J. "CrowdER: Crowdsourcing Entity Resolution."
  _Proceedings of the VLDB Endowment_ 5, no. 11 (2012): 1483-1494. DOI `10.14778/2350229.2350263`.
- Vesdapunt, N., Bellare, K., and Dalvi, N. "Crowdsourcing algorithms for entity resolution."
  _Proceedings of the VLDB Endowment_ 7, no. 12 (2014): 1071-1082. DOI `10.14778/2732977.2732982`.
- Sarawagi, S., and Bhamidipaty, A. "Interactive deduplication using active learning" (ALIAS).
  _Proceedings of the eighth ACM SIGKDD international conference on Knowledge discovery and data
  mining_, 2002, 269-278. DOI `10.1145/775047.775087`. **Note the year: 2002, not 2003.**
- Maskat, R., Paton, N. W., and Embury, S. M. "Pay-as-you-go Configuration of Entity Resolution."
  _Lecture Notes in Computer Science_, 2016, 40-65. DOI `10.1007/978-3-662-54037-4_2`. **A DOI built
  from memory during this session (`10.1007/978-3-662-53455-7_3`) resolved to a different paper
  entirely and was discarded.**
- Jaro, M. A. "Advances in Record-Linkage Methodology as Applied to Matching the 1985 Census of Tampa,
  Florida." _Journal of the American Statistical Association_ 84, no. 406 (1989): 414-420. DOI
  `10.1080/01621459.1989.10478785`. Used for the linear assignment point only.

### Vendor documentation, engineering context only

Firefly III documentation and tracker (issues 5265, 12084, 12437 and discussion 10554); Actual Budget
documentation, source and tracker (issues 6737, 8618); YNAB support articles; Monarch Money help
centre; Quicken support articles; Toshl blog. All read by a reading agent. The GitHub MCP server
failed to authenticate throughout, so tracker facts came from the `gh` CLI. **Nothing was tested
against a running instance of any product.**

## What was not read, and why

- **Sadinle, M. "Bayesian Estimation of Bipartite Matchings for Record Linkage." _Journal of the
  American Statistical Association_ 112, no. 518 (2017): 600-612. DOI
  `10.1080/01621459.2016.1148612`.** Identifier and title resolved; **[NOT READ]**. **The largest
  remaining gap**, and the one that would most change the bipartite section above.
- **Munoz, J., Jalili, M., and Tafakori, L. "Enhancing bookkeeper decision support through graph
  representation learning for bank reconciliation." _The Journal of Finance and Data Science_, 2025, 100170. DOI `10.1016/j.jfds.2025.100170`.** Gold open access, but ScienceDirect refused automated
  retrieval. **[NOT READ]** beyond the abstract; its one-to-many finding is cited above at
  abstract level and nothing rests on it.
- **Zenodo deposit, DOI `10.5281/zenodo.22094383`.** **The DOI resolves**, via DataCite rather than
  Crossref (Zenodo registers with DataCite), confirmed this session. **[NOT READ]** beyond its
  abstract, and deliberately not relied on: the title contains a non-word, the deposit is typed as a
  dataset while claiming a journal article, and a reported Macro-F1 of 0.9961 on 17-class noisy text
  makes leakage the first hypothesis. **No figure from it appears in this note.**
- **Dong, K., Jonnalagedda, P., Gao, X., Acharya, A., Kissa, M., and Flores, M. "Transaction
  Categorization with Relational Deep Learning in QuickBooks." `arXiv:2506.09234` (submitted
  2025-06-10).** **[NOT READ]** beyond the abstract. It bears on none of the questions here and is
  recorded so a later session does not rediscover and re-evaluate it.
- **Whether settlement-lag modelling has been studied.** The date offset between the two halves of a
  transfer is per-account-pair and directional rather than symmetric noise, which is the one place
  this problem has structure generic entity resolution does not. Nothing was found and the search was
  not exhaustive. **The most promising unexplored thread**, and the likeliest route to a date window
  that is not a tuned constant.
- **Whether any peer-reviewed work evaluates string similarity metrics on payment descriptors
  specifically.** Reported as "nothing was found", which is not the same as "nothing exists".

## A note on figures

Two candidates were considered for a diagram: the two-pass resolution, and the threshold degeneracy
where the top region rather than the middle one is empty. Both were declined. The two-pass resolution
is two sentences and a figure would restate them. The degeneracy is a statement about which of three
regions is non-empty, and prose names the three regions more precisely than a diagram would while
keeping Fellegi and Sunter's own notation, which a reader will need anyway to follow the citations.

## What would change this note

- Reading Sadinle 2017, which would replace the bipartite section's secondary sourcing with primary.
- Any measurement of the catalogue's nested pattern pairs, which would replace two known instances
  with a count.
- Any finding that `sanitizeImportedText` behaves differently on PostgreSQL or MySQL from what #594
  measured on SQLite, which would move the cleaned name's sanitisation from a derived concern to a
  primary one.
- A measured proposal rate per user per month, which is the figure the Fellegi and Sunter objection
  above says actually decides whether this feature is useful.
