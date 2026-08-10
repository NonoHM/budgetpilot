# Cash-flow forecast screenshots

The two working images come from the documented fixture:

```bash
BASE_URL=http://localhost:4175 node scripts/doc-screenshots.mjs forecast
```

## The two empty states are from a different instance

Neither is reachable from the documented fixture, which has three healthy
flows by design. They were reproduced on a throwaway instance rather than
described from the source:

| Image                          | How it was reached                                  |
| ------------------------------ | --------------------------------------------------- |
| `empty-dormant-desktop.png`    | Three monthly flows seeded 6, 7 and 8 months ago    |
| `empty-not-enough-desktop.png` | The same instance, with every detected flow removed |

The order matters and was measured, not assumed: with only **one** stale
flow left the card still read **Dormant**, so dormancy is decided before the
count is. **Not enough recurring flows** appeared only once no detected flow
remained at all.

Three one-off transactions were added before removing the last flow, so the
dashboard still rendered its normal layout rather than its onboarding empty
state — otherwise the capture would have shown a different screen entirely.

## Language

English, with the browser locale pinned as well as the app's. See
[the screenshots README](../README.md).
