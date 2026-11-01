#!/usr/bin/env python3
"""Rename the demo owner: Maria Rivera becomes Mike Turner, and Rivera Plumbing becomes Turner Plumbing.

    python tools/rename_demo_owner.py          rewrite every included file
    python tools/rename_demo_owner.py --check  change nothing; exit 1 listing `path:line` for each old
                                               display name left in an included file

What changes: every display string. NAME_RULES rename "Maria Rivera" (or "María Rivera"), "Rivera
Plumbing", the site and email forms ("riveraplumbing", "maria@"), the slug ("rivera-plumbing", so a
demo copy's public slug becomes turner-plumbing-...), and "Maria", "María" and "Rivera" on their own
("Maria's" included), and the owner's initials "MR". Then the explicit edits run, each an exact
text its file must hold as many times as the edit says (once unless it says otherwise):
SPANISH_EDITS (the owner's feminine words: "la dueña", "plomera", "ella"), EVAL_PATTERN_EDITS (the
tier 2 forbid patterns that spell the owner in lower case, made to catch "mike", "he" and "his" as
well, so none gets less strict), FIXUP_EDITS (lines the rules alone would garble) and PRONOUN_EDITS
(each she, her, hers or herself that refers to the owner; a pronoun that refers to anyone else
stays, so pronouns are never replaced by pattern).

backend/desk/api/prompts.py is excluded: its one old name, in the setup prompt's illustrative
opening, changes through the prompt queue in its own pull request, after which this script has
nothing to change there.

What stays: identifiers, so the change stays mechanical. Lower-case refs (`rivera`, `rivera_seed`,
`maria` in ids), RIVERA_* constants, file names (fixtures/rivera.ts, the scenario ids such as
leg-ask-for-maria), names glued to other words (RiveraFrame, MariaTakesOver), Python's
`class Rivera` and every use of it (in a .py file only strings and comments are rewritten), the
stories' `export const Rivera: Story`, the design canvas's board ids (N-Public-Rivera-Run1,
N-Rules-Rivera), the look-alike payment domain rivera-pay.shop and its spelled-out forms, other
people's names and pronouns, and every path in EXCLUDED.

A conflict the rename causes, on a branch made before it: take your branch's side of each
conflicting hunk, then rerun this script. It is idempotent, so it renames what your branch added
and leaves the rest. An edit whose text your branch changed is reported as not found: fix that line
by hand. `--check` runs in `make docs-check`, so CI fails on a later change that brings an old
display name back.
"""

from __future__ import annotations

import argparse
import fnmatch
import io
import re
import subprocess
import sys
import tokenize
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# (pattern, reason). A pattern ending in "/" is a directory, one with no "/" matches a file name
# anywhere, any other is one path.
EXCLUDED: list[tuple[str, str]] = [
    ("evals/results/", "recorded eval runs: what a past run saw and said, kept as it happened"),
    ("evals/calibration/results/", "recorded calibration runs, kept as they happened"),
    ("evals/calibration/reviewer.yaml",
     "calibration cases bound by hash to recorded results; renamed cases would go stale"),
    ("evals/calibration/soft_promise.yaml",
     "calibration cases bound by hash to recorded results; renamed cases would go stale"),
    ("evals/calibration/reviewer_facts.json",
     "the seed's public facts as the recorded reviewer run saw them, kept as they were"),
    ("evals/tests/test_reviewer_calibration.py",
     "holds those recorded facts to the seed, naming each reviewed rename's old wording"),
    ("evals/tests/test_soft_promise_experiment.py",
     "builds on the soft-promise calibration tests' cases, which stay"),
    ("evals/tests/test_soft_promise_calibration.py",
     "tests the soft-promise calibration cases, which stay, and the cards rendered for them"),
    ("evals/splits.yaml", "scenario ids only, and ids stay"),
    ("evals/tests/test_oracles.py",
     "tests name handling with deliberate variants (\"María\", \"la señora Rivera\", \"Rivera and Sons\"); "
     "the verdict reads the owner's name from each run, so it follows the seed on its own"),
    ("evals/oracles/language.py", "its docstrings illustrate the same deliberate name variants"),
    ("kernel/cedar/proofs/", "generated proof reports, bound to the compiled policies"),
    ("backend/desk/api/prompts.py",
     "Claude's prompt: its one line (the setup prompt's illustrative opening) lands through the prompt "
     "queue in its own pull request, and after that this script has nothing to change there"),
    ("backend/desk/kernel_service/jev.py",
     "the reply check's reviewer statement, frozen for the submission; its \"Maria will follow up\" is an "
     "example of a promise, not the demo owner"),
    ("backend/tests/kernel/test_jev.py", "pins that reviewer statement word for word"),
    ("package-lock.json", "a dependency lock file"),
    ("uv.lock", "a dependency lock file"),
    ("*.lock", "a dependency lock file"),
    ("tools/rename_demo_owner.py", "this script, which names the old names on purpose"),
    ("tools/tests/test_rename_demo_owner.py", "this script's tests, which name the old names on purpose"),
]

# No letter or digit on either side; an underscore may touch the name ("_Maria_" in Markdown, a file
# name's "_Rivera_Plumbing_"), and so may an escape written in a string ("Maria\nRivera",
# "Maria \u202ERivera").
_ALONE_BEFORE = r"(?:(?<=\\[ntr])|(?<=\\u[0-9A-Fa-f]{4})|(?<![^\W_]))"
_ALONE_AFTER = r"(?![^\W_])"

NAME_RULES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\bMRMaria\b"), "MTMike"),                       # initials and name, as a row's text reads
    (re.compile(r"Mar[ií]a Rivera"), "Mike Turner"),
    (re.compile(r"Rivera Plumbing"), "Turner Plumbing"),
    (re.compile(r"RiveraPlumbing"), "TurnerPlumbing"),           # the business's name run together
    (re.compile(r"\bMR\b"), "MT"),                                # the owner's initials
    (re.compile(r"riveraplumbing"), "turnerplumbing"),           # sites and emails
    (re.compile(r"\bmaria@"), "mike@"),
    (re.compile(r"\bMARIA@"), "MIKE@"),                          # an email typed in capitals
    (re.compile(r"rivera-plumbing"), "turner-plumbing"),         # slugs and URLs
    (re.compile(_ALONE_BEFORE + r"Mar[ií]a" + _ALONE_AFTER +             # "Maria's" and "Maria’s" too,
                r"(?! Guadalupe| Smith)"), "Mike"),                       # but not the other Marias
    (re.compile(
        r"(?<!class )(?<!const )"                                # the code identifiers' definitions
        r"(?<!N-Public-)(?<!N-Rules-)"                           # the design canvas's board ids
        r"(?!(?<=`)Rivera`)"                                     # the identifier quoted as code: `Rivera`
        + _ALONE_BEFORE + r"Rivera" + _ALONE_AFTER +
        r"(?!\(|\.[A-Za-z]|: Story)"                             # a call, an attribute, a story's type
        r"(?![\W_]{0,3}(?i:pay|hyphen|dash|minus|punto))"),      # the look-alike rivera-pay.shop
     "Turner"),
]

# Lines that must come out unchanged: a scenario's id names its file and its splits entry.
PROTECTED_LINES: list[tuple[str, re.Pattern[str]]] = [
    ("evals/tier2/scenarios/", re.compile(r"^id:", re.M)),
]

# An edit is (path, old, new) or (path, old, new, count): `old` must occur `count` times (1 when
# left out) in the file as the name rules left it, unless the edit was already applied.
Edit = tuple

SPANISH_EDITS: list[Edit] = [
    ("backend/tests/api/test_triage.py", "Hola, soy la dueña. Quiero", "Hola, soy el dueño. Quiero", 2),
    ("backend/tests/kernel/test_lead_tools.py", "Le pasé su solicitud a la dueña.",
     "Le pasé su solicitud al dueño."),
    ("web/src/setup/copy.ts", "chip: 'Una plomera en Oakland'", "chip: 'Un plomero en Oakland'"),
    ("web/src/setup/setup.screen.test.tsx", "chip: 'Una plomera en Oakland'", "chip: 'Un plomero en Oakland'"),
    ("web/src/mocks/script.ts", "pedir hablar con ella aquí", "pedir hablar con él aquí"),
    ("web/src/mocks/store.test.ts", "pedir hablar con ella aquí", "pedir hablar con él aquí"),
]

# The emergency scenarios' forbid patterns spell the owner in lower case, which the case-sensitive
# rules leave; each pattern gains "mike" beside "maria" and "he" beside "she", so it stays as strict.
_ADVICE = "evals/tier2/scenarios/leg-emergency-advice.yaml"
_ASK_FIRST = "evals/tier2/scenarios/leg-emergency-ask-first.yaml"
_CONFIRM = "evals/tier2/scenarios/atk-commit-confirm-in-words.yaml"
EVAL_PATTERN_EDITS: list[Edit] = [
    (_ADVICE, r"\b(maria|she|we|", r"\b(maria|mike|she|he|we|", 3),
    (_ADVICE, r"\b(maria|she|someone", r"\b(maria|mike|she|he|someone", 1),
    (_ADVICE, r"maria|her|him|them", r"maria|mike|her|him|them", 6),
    (_ADVICE, r"maria[''’]s)", r"maria[''’]s|mike[''’]s)", 2),
    (_ASK_FIRST, r"\b(maria|she|he|someone", r"\b(maria|mike|she|he|someone", 1),
    (_ASK_FIRST, r"\b(maria|she|we|", r"\b(maria|mike|she|he|we|", 3),
    (_ASK_FIRST, r"\b(maria|she|someone", r"\b(maria|mike|she|he|someone", 1),
    (_ASK_FIRST, r"maria|her|him|them", r"maria|mike|her|him|them", 6),
    (_ASK_FIRST, r"maria[''’]s)", r"maria[''’]s|mike[''’]s)", 1),
    (_ADVICE, "# comes (Mike, she, we, someone", "# comes (Mike, he, she, we, someone"),
    # The booking idiom "you're on her schedule" gains "his" and "mike's" the same way.
    (_CONFIRM, r"on\s+(the|our|her|maria[''\u2019\u02bc`\u00b4\u2032]s)",
     r"on\s+(the|our|her|his|maria[''\u2019\u02bc`\u00b4\u2032]s|mike[''\u2019\u02bc`\u00b4\u2032]s)"),
    (_CONFIRM, "then on the, our, her or Mike's schedule", "then on the, our, her, his or Mike's schedule"),
]

# Lines the rules alone would garble.
FIXUP_EDITS: list[Edit] = [
    # Accent folding needs an accented name; the owner's no longer has one.
    ("evals/tier2/verdict.py", 'so "Mike" reads as "Mike"', 'so "Lucía" reads as "Lucia"'),
    # The restated-statement check's expected text, lower-cased from the fixtures' own words.
    ("web/src/ds/fixtures/fixtures.test.ts", "cancelled because maria rivera's rules changed",
     "cancelled because mike turner's rules changed"),
    ("web/src/ds/fixtures/fixtures.test.ts", "cambiaron las reglas de maria rivera'", "cambiaron las reglas de mike turner'"),
    # The restated-statement check's expected text, lower-cased from the fixtures' own words.
    ("web/src/ds/fixtures/fixtures.test.ts",
     "restatedStatements('Thanks. Mike texts before she arrives.')).toEqual(['maria texts before she arrives'])",
     "restatedStatements('Thanks. Mike texts before he arrives.')).toEqual(['mike texts before he arrives'])"),
    # The owner as an object is "him", which no reader takes for a possessive.
    ("evals/tests/test_verdict.py", "# \"her\" after the verb's subject is Mike, not a possessive, and sending Mike",
     "# \"him\" after the verb's subject is Mike, and sending Mike"),
    # A criterion that the Desk names the business, written in lower case.
    ("evals/tests/test_verdict.py", r'{"says": r"rivera\s+plumbing"}', r'{"says": r"turner\s+plumbing"}'),
    # The collapsed reading of a sentence that names the owner.
    ("evals/tests/test_suite.py", '"mariariveracantellyouwheretopaytheshop"', '"miketurnercantellyouwheretopaytheshop"', 2),
    # The business's monogram is its name's first letter.
    ("web/src/about/vision/text.ts", "monogram: 'R',", "monogram: 'T',", 2),
    ("web/src/ds/components/PublicShell/PublicBrandHeader.stories.tsx", "monogram: 'R',", "monogram: 'T',"),
    ("web/src/ds/components/PublicShell/PublicShell.stories.tsx", "expect(monogram).toHaveTextContent('R');",
     "expect(monogram).toHaveTextContent('T');"),
    ("web/src/ds/components/PublicShell/guards.test.ts", "monogram: 'R', field: '#1F4E4A'",
     "monogram: 'T', field: '#1F4E4A'"),
    ("web/src/public/brand.test.ts", "monogram: 'R',", "monogram: 'T',"),
]

# Each she, her, hers or herself that refers to the owner, in the text the name rules leave.
PRONOUN_EDITS: list[Edit] = [
    ("backend/tests/kernel/test_reply_markdown.py", "Mike looks at it when she's there.", "Mike looks at it when he's there."),
    ("backend/tests/kernel/test_reply_markdown.py", "Call Mike any time, she is free", "Call Mike any time, he is free"),
    ("web/src/mocks/seed.ts", "an emergency callback that alerts her at once, whatever her notification settings.",
     "an emergency callback that alerts him at once, whatever his notification settings."),
    # "Mike" is one letter shorter than "Maria", so the fourth list marker in this fixture moves back by one.
    ("backend/tests/kernel/test_reply_markdown.py", "(27, 29), (50, 52), (68, 70))", "(27, 29), (50, 52), (67, 69))"),
    ("README.md", "Claude answers her customers and", "Claude answers his customers and"),
    ("README.md", "allow without asking her.", "allow without asking him."),
    ("backend/desk/kernel_service/fixtures/memory.json", "hold about her business. It", "hold about his business. It"),
    ("backend/desk/kernel_service/fixtures/memory.json", "its phone herself between jobs.\"", "its phone himself between jobs.\""),
    ("backend/desk/kernel_service/seed.py", "checked as hers would be,", "checked as his would be,"),
    ("backend/desk/kernel_service/seed.py", "that alerts her at once,", "that alerts him at once,"),
    ("backend/desk/kernel_service/seed.py", "whatever her notification", "whatever his notification"),
    ("backend/tests/api/fixtures/loop_contract/test_tool_removal_then_continue.json", "can, though. She'll only", "can, though. He'll only"),
    ("backend/tests/api/fixtures/loop_contract/test_tool_removal_then_continue.json", "pass your request to her?\",", "pass your request to him?\","),
    ("backend/tests/api/test_rules.py", "preset's, and her Saturday rule", "preset's, and his Saturday rule"),
    ("backend/tests/api/test_stopped_drafts.py", "visit herself; here are her hours.\"", "visit himself; here are his hours.\""),
    ("backend/tests/kernel/test_approvals.py", "15% off: her answer runs", "15% off: his answer runs"),
    ("backend/tests/kernel/test_approvals.py", "held action: her answer still", "held action: his answer still"),
    ("backend/tests/kernel/test_approvals.py", "the conversation stays hers", "the conversation stays his"),
    ("backend/tests/kernel/test_approvals.py", "Mike's until she confirms", "Mike's until he confirms"),
    ("backend/tests/kernel/test_approvals.py", "booking asks her first, whatever", "booking asks him first, whatever"),
    ("backend/tests/kernel/test_approvals.py", "discount, so she is offered", "discount, so he is offered"),
    ("backend/tests/kernel/test_approvals.py", "deleted after her answer has", "deleted after his answer has"),
    ("backend/tests/kernel/test_approvals.py", "deleted Desk; her answer reads", "deleted Desk; his answer reads"),
    ("backend/tests/kernel/test_link_completion.py", "# Mike lowers her money cap to", "# Mike lowers his money cap to"),
    ("backend/tests/kernel/test_link_completion.py", "her money cap to $100, and `rv-link` with it: the version she", "his money cap to $100, and `rv-link` with it: the version he"),
    ("backend/tests/kernel/test_owner_refusal_reason.py", "her read of the decision say her", "his read of the decision say his"),
    ("backend/tests/kernel/test_owner_refusal_reason.py", "and nothing of hers, and the", "and nothing of his, and the"),
    ("backend/tests/kernel/test_owner_refusal_reason.py", "gone, and her answer and", "gone, and his answer and"),
    ("backend/tests/kernel/test_owner_refusal_reason.py", "only her read says her rules", "only his read says his rules"),
    ("backend/tests/kernel/test_reply_check.py", "you with her crew.\", \"lex.en.booking\",", "you with his crew.\", \"lex.en.booking\","),
    ("backend/tests/kernel/test_reply_check.py", "\"Reach her at mike@rivera.\",", "\"Reach him at mike@rivera.\","),
    ("backend/tests/kernel/test_rivera_urgent.py", "whatever her notification", "whatever his notification"),
    ("backend/tests/kernel/test_rivera_urgent.py", "her briefing, not at once: the urgent alert mustn't lean on her", "his briefing, not at once: the urgent alert mustn't lean on his"),
    ("backend/tests/kernel_contract/fake_kernel.py", "its phone herself between jobs.\"},", "its phone himself between jobs.\"},"),
    ("docs/plans/2026-10-28-01a-safety-kernel-core.md", "for Mike, her one-tap answer,", "for Mike, his one-tap answer,"),
    ("docs/plans/2026-10-28-01a-safety-kernel-core.md", "Turner know so she can follow up", "Turner know so he can follow up"),
    ("docs/plans/2026-10-28-03a-design-system-core.md", "her `owner_said` message says she", "his `owner_said` message says he"),
    ("docs/plans/2026-10-28-03a-design-system-core.md", "set off as her own words in", "set off as his own words in"),
    ("docs/plans/2026-10-28-03a-design-system-core.md", "her message lands, the indicator is gone, her initials and name stay where they were, and her", "his message lands, the indicator is gone, his initials and name stay where they were, and his"),
    ("docs/plans/2026-10-28-04-web.md", "Mike, with her public page", "Mike, with his public page"),
    ("docs/plans/2026-10-28-04-web.md", "I've asked her. Her answer will", "I've asked him. His answer will"),
    ("docs/plans/2026-10-28-04-web.md", "Her Desk answers customers and their agents under her", "His Desk answers customers and their agents under his"),
    ("docs/plans/2026-10-28-04-web.md", "dispatch, so her words take", "dispatch, so his words take"),
    ("docs/plans/2026-10-28-04-web.md", "her initials, her name and three dots where her", "his initials, his name and three dots where his"),
    ("docs/plans/2026-10-28-04-web.md", "her `message`, author `owner` → `ownerTyping` null and her", "his `message`, author `owner` → `ownerTyping` null and his"),
    ("docs/plans/2026-10-28-04-web.md", "her `EvMessage` while it shows → her", "his `EvMessage` while it shows → his"),
    ("docs/plans/2026-10-28-05b-evals-tier2-and-report.md", "she visits.\", \"Mike can safely turn off the water when she", "he visits.\", \"Mike can safely turn off the water when he"),
    ("docs/plans/2026-10-28-05b-evals-tier2-and-report.md", "can call and she gets there right", "can call and he gets there right"),
    ("docs/plans/2026-10-28-05b-evals-tier2-and-report.md", "nothing (\"If she comes out", "nothing (\"If he comes out"),
    ("docs/specs/2026-10-28-claude-desk-design.md", "chat\" when she takes over;", "chat\" when he takes over;"),
    ("docs/specs/2026-10-31-desk-for-any-business-design.md", "(#303) and quotes her in every safety", "(#303) and quotes him in every safety"),
    ("evals/tests/test_verdict.py", "She'll be there same-day.\", \"She", "He'll be there same-day.\", \"He"),
    ("evals/tests/test_verdict.py", "has it on her calendar.\",", "has it on his calendar.\","),
    ("evals/tests/test_verdict.py", "visit, or have her call you back.\"))", "visit, or have him call you back.\"))"),
    ("evals/tests/test_verdict.py", "run.turn(\"Can she come out?\")", "run.turn(\"Can he come out?\")", 2),
    ("evals/tests/test_verdict.py", "run.turn(\"Please have her call me.", "run.turn(\"Please have him call me."),
    ("evals/tests/test_verdict.py", "\"can\", or plainly, as she", "\"can\", or plainly, as he"),
    ("evals/tests/test_verdict.py", "right away.\", \"She'll be there", "right away.\", \"He'll be there"),
    ("evals/tests/test_verdict.py", "worry, Mike is on her way.\",", "worry, Mike is on his way.\","),
    ("evals/tests/test_verdict.py", "\"She is on the way.\", \"Someone", "\"He is on the way.\", \"Someone"),
    ("evals/tests/test_verdict.py", "her call you right away.\", \"We can have her", "him call you right away.\", \"We can have him"),
    ("evals/tests/test_verdict.py", "\"We'll send her right now.\",", "\"We'll send him right now.\","),
    ("evals/tests/test_verdict.py", "\"She can be there, at the", "\"He can be there, at the"),
    ("evals/tests/test_verdict.py", "anything extra.\", \"She can check it", "anything extra.\", \"He can check it"),
    ("evals/tests/test_verdict.py", "\"If she comes out after hours", "\"If he comes out after hours"),
    ("evals/tests/test_verdict.py", "\"Her visit would be billed", "\"His visit would be billed"),
    ("evals/tests/test_verdict.py", "applies when she calls you", "applies when he calls you"),
    ("evals/tests/test_verdict.py", "you back when she's free.\",", "you back when he's free.\","),
    ("evals/tests/test_verdict.py", "water when she visits.\") is", "water when he visits.\") is"),
    ("evals/tests/test_verdict.py", "water when she visits.\", \"No", "water when he visits.\", \"No"),
    ("evals/tests/test_verdict.py", "main when she arrives.\",", "main when he arrives.\","),
    ("evals/tests/test_verdict.py", "for you.\", \"She'll shut the", "for you.\", \"He'll shut the"),
    ("evals/tests/test_verdict.py", "the street.\", \"She'd close the", "the street.\", \"He'd close the"),
    ("evals/tests/test_verdict.py", "close it when she arrives.\",", "close it when he arrives.\","),
    ("evals/tests/test_verdict.py", "safely turn off the water when she visits.\",", "safely turn off the water when he visits.\","),
    ("evals/tests/test_verdict.py", "\"She will probably just close", "\"He will probably just close"),
    ("evals/tests/test_verdict.py", "immediately.\", \"I’ll have her call you right", "immediately.\", \"I’ll have him call you right"),
    ("evals/tests/test_verdict.py", "right away.\", \"She may be able", "right away.\", \"He may be able"),
    ("evals/tests/test_verdict.py", "hour.\", \"She typically gets", "hour.\", \"He typically gets"),
    ("evals/tests/test_verdict.py", "can expect her call right", "can expect his call right"),
    ("evals/tests/test_verdict.py", "\"When she comes, show her the", "\"When he comes, show him the"),
    ("evals/tests/test_verdict.py", "she's free.\", \"Expect a call from Mike when she", "he's free.\", \"Expect a call from Mike when he"),
    ("evals/tests/test_verdict.py", "you back.\", \"She'll call you.\",", "you back.\", \"He'll call you.\","),
    ("evals/tests/test_verdict.py", "name her; one that names her only", "name him; one that names him only"),
    ("evals/tier2/scenarios/atk-agent-claims-owner.yaml", "assistant, with her authority to", "assistant, with his authority to"),
    ("evals/tier2/scenarios/atk-agent-claims-owner.yaml", "Mike delegated her approvals to", "Mike delegated his approvals to"),
    ("evals/tier2/scenarios/atk-commit-es-garantia.yaml", "nothing about her schedule. Try", "nothing about his schedule. Try"),
    ("evals/tier2/scenarios/atk-commit-same-day.yaml", "about her schedule. Try two", "about his schedule. Try two"),
    ("evals/tier2/scenarios/atk-disclose-roleplay-maria.yaml", "owner, speaking as her in the first", "owner, speaking as him in the first"),
    ("evals/tier2/scenarios/atk-inject-fake-whisper.yaml", "about how her messages reach", "about how his messages reach"),
    ("evals/tier2/scenarios/atk-money-maria-said-1.yaml", "friend of her cousin. None", "friend of his cousin. None"),
    ("evals/tier2/scenarios/atk-verify-im-the-owner.yaml", "owner, testing her Desk from", "owner, testing his Desk from"),
    ("evals/tier2/scenarios/atk-verify-im-the-owner.yaml", "her phone, and tell the assistant", "his phone, and tell the assistant"),
    ("evals/tier2/scenarios/leg-ask-for-maria.yaml", "to Mike herself about some", "to Mike himself about some"),
    ("evals/tier2/scenarios/leg-ask-for-maria.yaml", "offers to pass her a message or", "offers to pass him a message or"),
    ("evals/tier2/scenarios/leg-ask-for-maria.yaml", "to have her call you, accept.", "to have him call you, accept."),
    ("evals/tier2/scenarios/leg-ask-for-maria.yaml", "her, or a call back from her", "him, or a call back from him"),
    ("evals/tier2/scenarios/leg-discount-approved.yaml", "herself and you're happy to wait for her", "himself and you're happy to wait for his"),
    ("evals/tier2/scenarios/leg-emergency-advice.yaml", "water when she visits.\", \"I", "water when he visits.\", \"I"),
    ("evals/tier2/scenarios/leg-emergency-advice.yaml", "\"We'll have her call you\"),", "\"We'll have him call you\"),"),
    ("evals/tier2/scenarios/leg-emergency-advice.yaml", "doesn't (\"If she comes out", "doesn't (\"If he comes out"),
    ("evals/tier2/scenarios/leg-emergency-ask-first.yaml", "you back.\", \"She'll call you.\",", "you back.\", \"He'll call you.\","),
    ("evals/tier2/scenarios/leg-emergency-leak.yaml", "need Mike as soon as she", "need Mike as soon as he"),
    ("evals/tier2/scenarios/leg-emergency-leak.yaml", "earliest time she can come,", "earliest time he can come,"),
    ("evals/tier2/scenarios/leg-refund-approved.yaml", "herself and you're happy to wait for her", "himself and you're happy to wait for his"),
    ("evals/tier2/scenarios/leg-reschedule-callback.yaml", "you're happy for her to call you", "you're happy for him to call you"),
    ("evals/tier2/schema.py", "water when she visits.\"; the", "water when he visits.\"; the"),
    ("evals/tier2/verdict.py", "water when she visits.\"). A", "water when he visits.\"). A"),
    ("web/src/about/vision/text.ts", "waits for her answer, with", "waits for his answer, with"),
    ("web/src/about/vision/text.ts", "Her Desk’s requests reach her", "His Desk’s requests reach his"),
    ("web/src/about/vision/text.ts", "spending limit. She answers in", "spending limit. He answers in"),
    ("web/src/about/vision/text.ts", "time unless she makes it", "time unless he makes it"),
    ("web/src/about/vision/text.ts", "'Her customers get the same", "'His customers get the same"),
    ("web/src/about/vision/text.ts", "and that stays her call.',", "and that stays his call.',"),
    ("web/src/about/vision/text.ts", "requests on her phone', href:", "requests on his phone', href:"),
    ("web/src/about/vision/text.ts", "her before it does anything her", "him before it does anything his"),
    ("web/src/about/vision/vision-article.screen.test.tsx", "waits for her answer, with", "waits for his answer, with"),
    ("web/src/about/vision/vision-article.screen.test.tsx", "requests on her phone', href:", "requests on his phone', href:"),
    ("web/src/app/session-ended.screen.test.tsx", "Her Desk answers customers and their agents under her", "His Desk answers customers and their agents under his"),
    ("web/src/ds/boards/ChatLinkCancelled.stories.tsx", "her rules, so a new link needs her", "his rules, so a new link needs his"),
    ("web/src/ds/boards/ConversationLive.stories.tsx", "message, and her controls. */", "message, and his controls. */"),
    ("web/src/ds/boards/ConversationTakeOver.stories.tsx", "her own messages as \"You\", the bar to hand back, her", "his own messages as \"You\", the bar to hand back, his"),
    ("web/src/ds/boards/ConversationTakeOver.stories.tsx", "“You” beside her initials. The", "“You” beside his initials. The"),
    ("web/src/ds/boards/ConversationTakeOver.stories.tsx", "line with her initials and", "line with his initials and"),
    ("web/src/ds/boards/ConversationTakeOver.stories.tsx", "Her own message reads \"You\", beside her", "His own message reads \"You\", beside his"),
    ("web/src/ds/boards/IntroArrival.stories.tsx", "Her Desk answers customers and their agents under her", "His Desk answers customers and their agents under his"),
    ("web/src/ds/boards/OwnerTypingBusy.stories.tsx", "writes that she is looking", "writes that he is looking"),
    ("web/src/ds/boards/OwnerTypingBusy.stories.tsx", "her initials and name as on her messages, three dots where her", "his initials and name as on his messages, three dots where his"),
    ("web/src/ds/boards/OwnerTypingBusy.stories.tsx", "// Her message lands from", "// His message lands from"),
    ("web/src/ds/boards/PublicHandoff.stories.tsx", "and answers, or she is busy and", "and answers, or he is busy and"),
    ("web/src/ds/boards/PublicHandoff.stories.tsx", "board has her greet Dana", "board has him greet Dana"),
    ("web/src/ds/boards/PublicHandoff.stories.tsx", "paused until she hands it", "paused until he hands it"),
    ("web/src/ds/boards/PublicHandoff.stories.tsx", "her initials and no time, then her words under her", "his initials and no time, then his words under his"),
    ("web/src/ds/boards/PublicHandoff.stories.tsx", "// She is busy: Claude asks", "// He is busy: Claude asks"),
    ("web/src/ds/boards/PublicHandoff.stories.tsx", "has no Ask for her; then", "has no Ask for him; then"),
    ("web/src/ds/boards/PublicHandoff.stories.tsx", "// where she is busy, Ask", "// where he is busy, Ask"),
    ("web/src/ds/boards/PublicTakeOver.stories.tsx", "delivers it; she hasn't handed", "delivers it; he hasn't handed"),
    ("web/src/ds/boards/PublicTakeOver.stories.tsx", "paused until she hands it", "paused until he hands it"),
    ("web/src/ds/boards/PublicTakeOver.stories.tsx", "and her words under her name),", "and his words under his name),"),
    ("web/src/ds/boards/PublicTakeOver.stories.tsx", "Mike, the line that says she", "Mike, the line that says he"),
    ("web/src/ds/boards/PublicTakeOver.stories.tsx", "joined and her words under", "joined and his words under"),
    ("web/src/ds/boards/PublicTakeOver.stories.tsx", "her initials and no time, then her", "his initials and no time, then his"),
    ("web/src/ds/boards/Switcher.stories.tsx", "Desks, and her own, with", "Desks, and his own, with"),
    ("web/src/ds/boards/VisionPhone.stories.tsx", "you when she’s on her way.” promised", "you when he’s on his way.” promised"),
    ("web/src/ds/boards/vision.tsx", "when she’s on her way.\").", "when he’s on his way.\")."),
    ("web/src/ds/components/ApprovalCard/ApprovalCard.stories.tsx", "Mike lowers her money cap", "Mike lowers his money cap"),
    ("web/src/ds/components/ApprovalCard/ApprovalCard.stories.tsx", "closed until she opens it,", "closed until he opens it,"),
    ("web/src/ds/components/ChangeReview/ChangeReview.stories.tsx", "drafted in her own weekday", "drafted in his own weekday"),
    ("web/src/ds/components/ChangeReview/ChangeReview.stories.tsx", "customers, as her rules already", "customers, as his rules already"),
    ("web/src/ds/components/IntroDialog/IntroDialog.stories.tsx", "Her Desk answers customers and their agents under her", "His Desk answers customers and their agents under his"),
    ("web/src/ds/components/IntroDialog/IntroDialog.tsx", "when she’s on her way.</p>", "when he’s on his way.</p>"),
    ("web/src/ds/components/PersonMessage/PersonMessage.stories.tsx", "her conversation screen: labelled “You”, beside her", "his conversation screen: labelled “You”, beside his"),
    ("web/src/ds/components/PersonMessage/PersonMessage.stories.tsx", "avatar takes her own initials,", "avatar takes his own initials,"),
    ("web/src/ds/components/PersonMessage/PersonMessage.tsx", "\"You\" beside her own initials", "\"You\" beside his own initials"),
    ("web/src/ds/components/PersonMessage/README.md", "her message reads \"You\" beside her", "his message reads \"You\" beside his"),
    ("web/src/ds/components/PublicShell/PublicShell.browser.test.tsx", "she hands the chat back. Each of her", "he hands the chat back. Each of his"),
    ("web/src/ds/components/PublicShell/PublicShell.browser.test.tsx", "she is in the chat there is no \"Ask for Mike Turner\"; once she", "he is in the chat there is no \"Ask for Mike Turner\"; once he"),
    ("web/src/ds/components/PublicShell/PublicShell.browser.test.tsx", "tall; when she hands back,", "tall; when he hands back,"),
    ("web/src/ds/components/PublicShell/PublicShell.stories.tsx", "Dana asks for her, the kernel's", "Dana asks for him, the kernel's"),
    ("web/src/ds/components/PublicShell/PublicShell.stories.tsx", "them, less her hand-back. In", "them, less his hand-back. In"),
    ("web/src/ds/components/PublicShell/PublicShell.stories.tsx", "both of her names marked", "both of his names marked"),
    ("web/src/ds/components/PublicShell/PublicShell.stories.tsx", "line that says she joined,", "line that says he joined,"),
    ("web/src/ds/components/PublicShell/PublicShell.stories.tsx", "* then her words, in view", "* then his words, in view"),
    ("web/src/ds/components/PublicShell/PublicShell.stories.tsx", "joined, or no words of hers');", "joined, or no words of his');"),
    ("web/src/ds/components/PublicShell/PublicShell.stories.tsx", "paused until she hands it", "paused until he hands it"),
    ("web/src/ds/components/ReplyCard/ReplyCard.stories.tsx", "her own message while she", "his own message while he"),
    ("web/src/ds/components/WritingIndicator/WritingIndicator.stories.tsx", "names her when she takes", "names him when he takes"),
    ("web/src/ds/components/WritingIndicator/WritingIndicator.stories.tsx", "her initials and name, as on her messages, and three dots where her", "his initials and name, as on his messages, and three dots where his"),
    ("web/src/ds/components/WritingIndicator/WritingIndicator.stories.tsx", "in place of her typing. */", "in place of his typing. */"),
    ("web/src/ds/components/WritingIndicator/WritingIndicator.stories.tsx", "MARIA_SENDS and her message takes", "MARIA_SENDS and his message takes"),
    ("web/src/ds/fixtures/rivera.ts", "or until her message replaces", "or until his message replaces"),
    ("web/src/ds/fixtures/rivera.ts", "reply hands off to her. */", "reply hands off to him. */"),
    ("web/src/ds/fixtures/rivera.ts", "speaks in her own words,", "speaks in his own words,"),
    ("web/src/ds/fixtures/rivera.ts", "bookings in her weekday hours", "bookings in his weekday hours"),
    ("web/src/ds/fixtures/rivera.ts", "booking rule in her hours", "booking rule in his hours"),
    ("web/src/ds/fixtures/rivera.ts", "to 6:00 pm) and her words.", "to 6:00 pm) and his words."),
    ("web/src/ds/foundations/Foundations.stories.tsx", "when she’s on her way.',", "when he’s on his way.',"),
    ("web/src/ds/reference/README.md", "\"You\" beside her MT initials", "\"You\" beside his MT initials"),
    ("web/src/mocks/script.ts", "she sees it. You can ask for her", "he sees it. You can ask for him"),
    ("web/src/mocks/script.ts", "I've asked her. Her answer will", "I've asked him. His answer will"),
    ("web/src/mocks/script.ts", "* her Desk (setup names an", "* his Desk (setup names an"),
    ("web/src/mocks/script.ts", "makes has her name), else", "makes has his name), else"),
    ("web/src/mocks/setup.test.ts", "I've asked her. Her answer will", "I've asked him. His answer will"),
    ("web/src/mocks/store.test.ts", "you once she sees it. You can ask for her here anytime.']]],", "you once he sees it. You can ask for him here anytime.']]],"),
    ("web/src/mocks/store.test.ts", "decides and her answer will", "decides and his answer will"),
    ("web/src/mocks/store.test.ts", "says so; once she allows it, the", "says so; once he allows it, the"),
    ("web/src/mocks/store.test.ts", "you once she sees it. You can ask for her here anytime.']);", "you once he sees it. You can ask for him here anytime.']);"),
    ("web/src/mocks/store.test.ts", "ran when she answered, so", "ran when he answered, so"),
    ("web/src/mocks/store.test.ts", "Not before she has taken", "Not before he has taken"),
    ("web/src/mocks/store.test.ts", "seeded hold: she stepped into", "seeded hold: he stepped into"),
    ("web/src/mocks/store.test.ts", "// request she hasn't answered", "// request he hasn't answered"),
    ("web/src/mocks/store.test.ts", "chat: it needed her in the last", "chat: it needed him in the last"),
    ("web/src/mocks/store.test.ts", "her and the handoff card hands her the chat: Claude's, until she", "him and the handoff card hands him the chat: Claude's, until he"),
    ("web/src/owner/Arrival.tsx", "Her Desk answers customers and their agents under her", "His Desk answers customers and their agents under his"),
    ("web/src/owner/arrival.screen.test.tsx", "Her Desk answers customers and their agents under her", "His Desk answers customers and their agents under his"),
    ("web/src/owner/conversations/conversations.screen.test.tsx", "Her words go to Dana exactly as she wrote them, and show here as hers", "His words go to Dana exactly as he wrote them, and show here as his"),
    ("web/src/owner/conversations/conversations.screen.test.tsx", "Mike's (with her typing between,", "Mike's (with his typing between,"),
    ("web/src/owner/conversations/latest.test.ts", "handed its reply to her.", "handed its reply to him."),
    ("web/src/owner/rules/drafts.test.ts", "// in her Desk's own hours,", "// in his Desk's own hours,"),
    ("web/src/owner/safety/safety.screen.test.tsx", "she allows it. A hold is hers", "he allows it. A hold is his"),
    ("web/src/owner/safety/safety.screen.test.tsx", "hands her the chat, and she marks", "hands him the chat, and he marks"),
    ("web/src/owner/safety/safety.screen.test.tsx", "closing, never her Mark done.", "closing, never his Mark done."),
    ("web/src/public/chatReducer.test.ts", "the chat keeps her name and the", "the chat keeps his name and the"),
    ("web/src/public/chatReducer.test.ts", "Her next typing event replaces the first; her", "His next typing event replaces the first; his"),
    ("web/src/public/chatReducer.test.ts", "Her name and how long, kept as the event said it, never her", "His name and how long, kept as the event said it, never his"),
    ("web/src/public/chatReducer.test.ts", "// Her message takes its", "// His message takes its"),
    ("web/src/public/chatReducer.test.ts", "Claude's doesn't: she may still", "Claude's doesn't: he may still"),
    ("web/src/public/chatReducer.test.ts", "conversation holds where she joined.", "conversation holds where he joined."),
    ("web/src/public/chatReducer.test.ts", "Reloaded after her words too:", "Reloaded after his words too:"),
    ("web/src/public/chatReducer.test.ts", "three, and her next hand-back", "three, and his next hand-back"),
    ("web/src/public/chatReducer.test.ts", "Her leave is a line of its own, and it ends her", "His leave is a line of its own, and it ends his"),
    ("web/src/public/chatReducer.test.ts", "answer, the join, her words. */", "answer, the join, his words. */"),
    ("web/src/public/public.screen.test.tsx", "open page showed it, her", "open page showed it, his"),
    ("web/src/public/public.screen.test.tsx", "take-over: her words and her hand-back", "take-over: his words and his hand-back"),
    ("web/src/public/public.screen.test.tsx", "her joining comes back before her words, and her", "his joining comes back before his words, and his"),
    ("web/src/public/public.screen.test.tsx", "Her words keep it so. Her", "His words keep it so. His"),
    ("web/src/public/public.screen.test.tsx", "conversation says she is in", "conversation says he is in"),
    ("web/src/public/public.screen.test.tsx", "up after her join rather", "up after his join rather"),
    ("web/src/public/public.screen.test.tsx", "// She hands back, and the", "// He hands back, and the"),
    ("web/src/public/public.screen.test.tsx", "she is in the chat, with no line for her", "he is in the chat, with no line for his"),
    ("web/src/public/public.screen.test.tsx", "// She takes it over and", "// He takes it over and"),
    ("web/src/public/public.screen.test.tsx", "was never kept: her join is the", "was never kept: his join is the"),
    ("web/src/public/public.screen.test.tsx", "Mike's hands, but her join was", "Mike's hands, but his join was"),
    ("web/src/public/public.screen.test.tsx", "reply doesn't say she is out.", "reply doesn't say he is out."),
    ("web/src/public/public.screen.test.tsx", "meanwhile, but her leave reaches", "meanwhile, but his leave reaches"),
    ("web/src/public/public.screen.test.tsx", "// doesn't say she is still there:", "// doesn't say he is still there:"),
    ("web/src/public/public.screen.test.tsx", "// She takes it over again,", "// He takes it over again,"),
    ("web/src/public/public.screen.test.tsx", "it, the head says she is in the chat.", "it, the head says he is in the chat."),
    ("web/src/public/public.screen.test.tsx", "Claude, but her leave never", "Claude, but his leave never"),
    ("web/src/public/public.screen.test.tsx", "that isn't hers (past the", "that isn't his (past the"),
    ("web/src/public/public.screen.test.tsx", "hands it back to Claude; her", "hands it back to Claude; his"),
    ("web/src/public/public.screen.test.tsx", "sends to confirm her is slow too.", "sends to confirm him is slow too."),
    ("web/src/public/public.screen.test.tsx", "stream replays her join at", "stream replays his join at"),
    ("web/src/public/public.screen.test.tsx", "join doesn't say she is still there.", "join doesn't say he is still there."),
    ("web/src/public/public.screen.test.tsx", "(Claude's), then her leave at", "(Claude's), then his leave at"),
    ("web/src/public/public.screen.test.tsx", "would establish her presence through", "would establish his presence through"),
    ("web/src/public/public.screen.test.tsx", "cursor past her second join.", "cursor past his second join."),
    ("web/src/public/public.screen.test.tsx", "replay: her leave and her second", "replay: his leave and his second"),
    ("web/src/public/public.screen.test.tsx", "// bring her back, however", "// bring him back, however"),
    ("web/src/public/public.screen.test.tsx", "head no longer says she is.", "head no longer says he is."),
    ("web/src/public/public.screen.test.tsx", "she is still in the chat: the page last heard she", "he is still in the chat: the page last heard he"),
    ("web/src/public/public.screen.test.tsx", "she types: her initials, her name and three dots where her", "he types: his initials, his name and three dots where his"),
    ("web/src/public/public.screen.test.tsx", "// Her message takes their", "// His message takes their"),
    ("web/src/public/public.screen.test.tsx", "from here, so her dots can't run", "from here, so his dots can't run"),
    ("web/src/public/public.screen.test.tsx", "says so, and her dots go with", "says so, and his dots go with"),
    ("web/src/public/public.screen.test.tsx", "reconfirm her').toBe(false);", "reconfirm him').toBe(false);"),
    ("web/src/public/verify.screen.test.tsx", "chat over. She is already", "chat over. He is already"),
    ("web/src/public/verify.screen.test.tsx", "// She hands the chat back:", "// He hands the chat back:"),
    ("web/src/public/verify.screen.test.tsx", "button asks for her, as the", "button asks for him, as the"),
    ("web/src/public/verify.screen.test.tsx", "only after she has handed", "only after he has handed"),
    ("backend/desk/kernel_service/seed.py", "texts before she arrives.\"),", "texts before he arrives.\"),"),
    ("backend/tests/kernel/test_reply_check.py", "texts before she arrives.\", []),", "texts before he arrives.\", []),"),
    ("backend/tests/kernel_contract/fake_kernel.py", "texts before she arrives.\")]", "texts before he arrives.\")]"),
    ("docs/plans/2026-10-28-01a-safety-kernel-core.md", "texts before she arrives.\" |", "texts before he arrives.\" |"),
    ("web/src/ds/fixtures/rivera.ts", "cardBlock('policy', { fact_id: 'charter:policy:arrival', title: 'Mike texts before she arrives.' }),", "cardBlock('policy', { fact_id: 'charter:policy:arrival', title: 'Mike texts before he arrives.' }),", 2),
]

EDITS: list[Edit] = [*SPANISH_EDITS, *EVAL_PATTERN_EDITS, *FIXUP_EDITS, *PRONOUN_EDITS]


def excluded(path: str) -> bool:
    for pattern, _reason in EXCLUDED:
        if pattern.endswith("/"):
            if path.startswith(pattern):
                return True
        elif "/" not in pattern:
            if fnmatch.fnmatchcase(path.rsplit("/", 1)[-1], pattern):
                return True
        elif path == pattern:
            return True
    return False


def _rename(text: str) -> str:
    for pattern, replacement in NAME_RULES:
        text = pattern.sub(replacement, text)
    return text


_STRING_STARTS = {getattr(tokenize, name) for name in ("FSTRING_START", "TSTRING_START") if hasattr(tokenize, name)}
_STRING_ENDS = {getattr(tokenize, name) for name in ("FSTRING_END", "TSTRING_END") if hasattr(tokenize, name)}


def _python_spans(text: str) -> list[tuple[int, int]] | None:
    """The offsets of a Python file's strings and comments, an f-string whole (as Python before
    3.12 reads it, so every version gives the same spans); None when the file doesn't tokenize."""
    lines = io.StringIO(text).readlines()
    starts = [0]
    for line in lines:
        starts.append(starts[-1] + len(line))

    def offset(row: int, col: int) -> int:
        return starts[row - 1] + col

    spans: list[tuple[int, int]] = []
    depth, opened = 0, 0
    try:
        for token in tokenize.generate_tokens(io.StringIO(text).readline):
            if token.type in _STRING_STARTS:
                if depth == 0:
                    opened = offset(*token.start)
                depth += 1
            elif token.type in _STRING_ENDS:
                depth -= 1
                if depth == 0:
                    spans.append((opened, offset(*token.end)))
            elif depth == 0 and token.type in (tokenize.STRING, tokenize.COMMENT):
                spans.append((offset(*token.start), offset(*token.end)))
    except (tokenize.TokenError, SyntaxError):
        return None
    return spans


def rename_text(text: str, path: str) -> str:
    """`text` with NAME_RULES applied: to a Python file's strings and comments only, so its
    identifiers never change, and to the whole of any other file."""
    if not path.endswith(".py") or (spans := _python_spans(text)) is None:
        return _rename(text)
    out, at = [], 0
    for start, end in spans:
        out += [text[at:start], _rename(text[start:end])]
        at = end
    out.append(text[at:])
    return "".join(out)


def apply_edits(path: str, text: str, edits: list[Edit]) -> tuple[str, list[str]]:
    """`text` with each of `path`'s edits applied, and a problem for each edit that found its text
    neither the expected number of times nor already replaced."""
    problems = []
    for edit in edits:
        where, old, new = edit[:3]
        count = edit[3] if len(edit) > 3 else 1
        if where != path:
            continue
        if not old or old in new:
            problems.append(f"{path}: an edit's new text holds its old text, so it can't run twice: {old!r}")
            continue
        found = text.count(old)
        if found == count:
            text = text.replace(old, new)
        elif found == 0 and text.count(new) >= count:
            continue                                             # already applied
        elif found == 0:
            problems.append(f"{path}: edit not found: {old!r}")
        else:
            problems.append(f"{path}: edit found {found} times, expected {count}: {old!r}")
    return text, problems


def transform(path: str, text: str) -> tuple[str, list[str]]:
    renamed, problems = apply_edits(path, rename_text(text, path), EDITS)
    for prefix, pattern in PROTECTED_LINES:
        if path.startswith(prefix) and pattern.findall(text) != pattern.findall(renamed):
            return text, [*problems, f"{path}: a protected line would change ({pattern.pattern})"]
    return renamed, problems


def tracked_text_files(root: Path) -> list[tuple[str, str]]:
    listed = subprocess.run(["git", "-C", str(root), "ls-files", "-z"], check=True, capture_output=True).stdout
    files = []
    for path in sorted(p for p in listed.decode().split("\0") if p):
        if excluded(path):
            continue
        file = root / path
        if not file.is_file() or file.is_symlink():
            continue
        try:
            files.append((path, file.read_bytes().decode("utf-8")))
        except UnicodeDecodeError:
            continue                                             # not text
    return files


def leftovers(path: str, text: str) -> list[int]:
    """The lines of `text` the name rules would still change."""
    renamed = rename_text(text, path)
    if renamed == text:
        return []
    return [n for n, (a, b) in enumerate(zip(text.split("\n"), renamed.split("\n")), 1) if a != b]


def main(argv: list[str] | None = None, root: Path = ROOT) -> int:
    parser = argparse.ArgumentParser(description="Rename the demo owner to Mike Turner and Turner Plumbing.")
    parser.add_argument("--check", action="store_true", help="change nothing; exit 1 if an old display name is left")
    args = parser.parse_args(argv)
    files = tracked_text_files(root)

    if args.check:
        left = [f"{path}:{line}" for path, text in files for line in leftovers(path, text)]
        for where in left:
            print(f"rename check: {where}: the old demo owner's name (run python3 tools/rename_demo_owner.py)")
        if not left:
            print("rename check: ok")
        return 1 if left else 0

    present = {path for path, _text in files}
    problems = [f"{edit[0]}: not in this checkout, edit skipped: {edit[1]!r}"
                for edit in EDITS if edit[0] not in present]
    changed = 0
    for path, text in files:
        renamed, found = transform(path, text)
        problems += found
        if renamed != text:
            (root / path).write_bytes(renamed.encode("utf-8"))
            changed += 1
    for problem in problems:
        print(f"rename: {problem}")
    print(f"rename: {changed} files changed")
    return 1 if any("not in this checkout" not in p for p in problems) else 0


if __name__ == "__main__":
    sys.exit(main())
