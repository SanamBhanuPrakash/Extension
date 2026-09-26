# Names and addresses in prose

The gap every earlier version of this project documented, and the one that
mattered most: a pattern engine sees `AKIA…` and is blind to

> Priya Nair, Flat 3B, 14 Koregaon Park Road, Pune 411001

which is the form most personal data actually takes outside a database export.

## Results

```console
$ node bench/ner.js

34 annotated documents · 13 of them hard negatives

  names      precision 97.8%   recall 100.0%   F1  98.9%   44 found / 1 false / 0 missed
  addresses  precision 100.0%  recall 100.0%   F1 100.0%   8 found / 0 false / 0 missed
```

Across **eight scripts**: Latin, Devanagari, Arabic, Hebrew, Thai, Han, Hangul
and Cyrillic.

The two remaining false positives are both organisations read as people
(`Goldman Sachs`, `Fabrikam`) — a low-harm error, since an organisation in a
prompt is usually worth a glance anyway.

## The model, and its ceiling

`src/nameweights.js` is a logistic regression over **16,384 hashed character
features** — 2-to-4-grams with boundary markers, prefixes and suffixes to depth
4, length, vowel ratio, consonant runs, doubled letters, diacritics.

Trained on **30,675 person names from 75 locales** against **46,528 hard
negatives**: cities, countries, companies, product names, animals, job titles,
months, weekdays, and ordinary vocabulary. Negatives are drawn from the
categories a name detector actually confuses — training against lowercase
dictionary words alone produces a model that thinks every capitalised token is
a person.

**Held-out result: precision 67.0%, recall 77.0%, F1 71.7%.**

More epochs, lower regularisation and a wider feature space were all tried; the
number does not move. **That ceiling is real, not a tuning failure.** A Yoruba
place name and a Yoruba person name share their morphology. 1,900 tokens —
`Austin`, `Paris`, `Virginia`, `Carmen`, `Charlotte` — are person names *and*
places simultaneously, and were dropped from training rather than labelled
arbitrarily, because contradictory labels teach a model nothing.

So character evidence cannot settle this. Something else has to.

## The pipeline, which is what ships

The classifier is one term in a log-odds sum. The others are structural, and
they are decisive:

| Evidence | Δ log-odds | Why |
|---|---|---|
| Honorific in front (`Dr.`, `Shri`, `Ms`) | **+3.4** | Nothing but a person follows one |
| Two or more capitalised tokens together | **+1.5** | The shape of a full name — the single most useful signal |
| Introduced (`name is`, `spoke to`, `Regards,`) | +1.9 | |
| Job title after (`(Director, Revenue)`) | +1.6 | |
| Email on the same line sharing its letters | +1.4 | |
| Verb of communication after (`said`, `confirmed`) | +1.2 | |
| Possessive (`Priya's`) | +0.9 | |
| Lone token with no *strong* evidence | **−1.9** | Every city, product and brand lands here |
| Opens a sentence | −2.2 | Capitalisation means nothing there |
| Followed by a place word (`region`, `office`) | **−4.6** | Beats character evidence outright |

Plus three hard gates:

- **A common-word stoplist** (4,422 entries). "Settings", "All Hands",
  "Public Holiday", "Funnel Reports" are ordinary words that happen to be
  capitalised. No amount of character evidence fixes that, because the
  characters really are word-like — only vocabulary can.
- **Already-claimed spans.** A capitalised run inside an AWS key or a
  private-key blob belongs to the credential, not to a person.
- **Blob detection.** A run of 44+ non-space characters is base64 or a hash,
  and a person's name in prose always has spaces around it.

**The classifier scores F1 71.7%. The pipeline scores F1 97.2%.** That gap is
the design.

This is the same shape as [Microsoft Presidio](https://microsoft.github.io/presidio/)
— a recogniser plus context enhancement — with a 21 KB model instead of spaCy,
because the whole thing has to fit in a browser extension a store will review,
with no network.

## Scripts without case

Capitalisation is a Latin-shaped assumption, and it quietly excluded most of
the world. Arabic, Hebrew, Devanagari, Bengali, Tamil, Telugu, Thai, Han,
Hangul and the kana have **no case at all** — so the single strongest feature
in the pipeline does not exist for them.

For those scripts an exact gazetteer is the right instrument, not a fallback.
The character inventory is small, names are short, and an exact match is the
strongest evidence available when there is no capitalisation to lean on.
**10,237 names**, 142 KB, parsed on first use — and most pastes never contain a
non-Latin character at all, so most never pay for it.

Two different treatments, because the scripts differ in a way that matters more
than the alphabet:

- **Space-separated** (Arabic, Hebrew, Devanagari, Bengali, Tamil, Telugu,
  Hangul): a token is a unit, so a gazetteer hit is decisive, and adjacent hits
  join into a full name.
- **Dense** (Han, Thai, kana): no token boundaries exist, so a sliding window
  finds candidates — up to the longest gazetteer entry, longest match first. A
  four-character ceiling silently missed every Thai name. Because a short
  window will inevitably collide with ordinary words, these additionally
  require a context cue and report at lower confidence.

**Cased non-Latin scripts** — Cyrillic, Greek, Armenian, Georgian — are in the
classifier's training set and behave like Latin, with one correction. The
classifier's *negatives* are Latin-only: it has never seen an ordinary Cyrillic
word, so it scored every one of them as a name, including the verb `Говорил`
("I spoke"). In those scripts character evidence is inadmissible on its own, and
a gazetteer hit or real context is required.

## Addresses

No model. A postal address is a *structure*, and structure is checkable:

```
  a house number or a unit marker   (14 · Flat 3B · Plot 27 · Suite 900)
+ a street or locality word         (Road · Marg · Nagar · Sector · Street)
+ optionally a postcode             (PIN · ZIP · UK · CA · AU · CEP)
─────────────────────────────────
  two or more parts, anchored by a number
```

The anchor requirement is what separates an address from a sentence about
roads: *"the Ring Road is heavy and the Coastal Highway is closed"* has two
street words and no number, so it is not an address.

Postcodes are matched per country and only count when other parts are already
present — a bare four-digit number is not an Australian postcode on its own.

**Known gap, stated rather than hidden:** an address written with no street or
unit word (`"Koregaon Park, Pune 411001"`) is not found. That line-level gate
is also worth roughly a 6× speed-up, and the trade was made deliberately.

## Cost

Name and address detection runs on every paste, so its cost is stated:

| | |
|---|---|
| Full scan, 46 KB, 102 detectors + tables + prose + injection | **4.8 ms (9.6 MB/s)** |
| Prose corpus, 105 KB, names + addresses only | 17.9 ms (5.9 MB/s) |
| Model weights | 21 KB, int8-quantised, decoded lazily |
| Stoplist | 34 KB, parsed into a Set on first use |

Three optimisations got it there, each worth measuring:

1. **Match capitalised tokens directly** instead of tokenising the whole
   document. Name detection only ever looks at capitalised tokens, and on
   ordinary prose those are a small minority. 6.1 ms → 0.69 ms.
2. **Gate address lines** on a single regex before tokenising. Testing six
   postcode patterns against every token of every line was ~48,000 regex tests
   on a 46 KB document.
3. **Memoise scores** per token, capped at 4,000 entries. A name in a document
   usually appears several times.

## Reproducing

```console
$ node bench/ner.js --failures      # score the pipeline
$ node tools/extract-corpus.js      # rebuild the training data
$ node tools/train-name-model.js    # retrain; writes src/nameweights.js
$ node tools/build-stopwords.js     # rebuild the common-word stoplist
```

`tools/` is not shipped. `src/namefeatures.js` is imported by both the trainer
and the extension, so train-time and inference-time features cannot drift —
training/serving skew is the most common way a small model silently stops
working, and the cheapest prevention is one copy of the code.

## What this still does not do

- **No coreference.** "She said the invoice was wrong" is not linked to Priya.
- **No organisation/person disambiguation.** The two remaining false positives
  are exactly this, and fixing it properly needs an organisation gazetteer.
- **Only the scripts listed above.** The gazetteer covers ten uncased scripts
  and four cased ones. A name in a script outside that set is not detected.
- **The gazetteer is finite.** Unlike the classifier, it cannot generalise: a
  Devanagari name nobody wrote down is missed. Devanagari coverage in
  particular is thin (93 entries) and deserves a better source than a
  test-data library.
- **No dates of birth, no medical identifiers in prose.** Structured forms are
  covered by the pattern rules; free-text forms are not.
