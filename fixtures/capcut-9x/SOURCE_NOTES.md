# CapCut 9.x synthetic fixture

This fixture was derived from a locally created CapCut Desktop 9.0.0 project containing three synthetic color clips. The base track uses A, B, and A again. A shorter C clip sits on the upper video track.

Only the fields required by the experimental input adapter are retained. Media paths are fixture-relative, and device identifiers, hardware identifiers, account data, timestamps, and unrelated CapCut materials are removed. No original media is included.

Expected normalized result at 24 fps:

- duration: 186 frames;
- PRIMARY order: A, C, B, A;
- EDIT count: 4;
- SHOT count: 3, because both A segments share one source identity.
