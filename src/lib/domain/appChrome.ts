/**
 * How much of the application's chrome a route carries.
 *
 * A named rule rather than two arrays inside the layout, because it encodes a decision that has
 * now been wrong in both directions and needs to be inspectable and testable on its own.
 *
 * - `'full'`      — header, desktop navigation, and the fixed mobile tab bar. Every ordinary page.
 * - `'desktop'`   — header and desktop navigation from `lg`; NO mobile tab bar at any width.
 * - `'none'`      — the route paints its own full-height chrome and the layout adds nothing.
 */
export type AppChrome = 'full' | 'desktop' | 'none';

/**
 * Routes that own the whole viewport at every width.
 *
 * A route joins this list only when it renders its OWN full-height chrome AND has no destination
 * to offer: removing the navigation takes away the way out, so a page that merely looks busy does
 * not qualify. `/force-password-change` qualifies because leaving it is the one thing the user
 * must not do.
 */
const NO_CHROME = ['/force-password-change'];

/**
 * Routes that keep the DESKTOP chrome and drop the mobile one.
 *
 * `/import/columns` is here, and it has been in each of the other two states for a measured
 * reason:
 *
 * - **With full chrome** the fixed bottom tab bar painted over the screen's action footer and the
 *   import control the whole screen exists to reach was half covered. Nothing caught it — the
 *   component's four regions summed correctly and the e2e journey passed, because Playwright
 *   clicks what a human cannot see. Found by taking a screenshot for the manual.
 * - **With no chrome at all** the desktop screen had no header and no navigation while the
 *   correction route `/imports/<id>/columns` kept both, so the two halves of one feature
 *   disagreed (#350) and the primary path was the one missing its way out.
 *
 * Desktop-only satisfies both: the way out returns at 1280, and the bar that covered the button
 * never renders. The layout wraps the header in `hidden lg:block` rather than trusting the bar's
 * own `lg:hidden`, so a change to `AppNav` cannot reintroduce the covered button from a distance.
 */
const DESKTOP_CHROME_ONLY = ['/import/columns'];

export function chromeFor(pathname: string): AppChrome {
	if (NO_CHROME.includes(pathname)) return 'none';
	if (DESKTOP_CHROME_ONLY.includes(pathname)) return 'desktop';
	return 'full';
}
