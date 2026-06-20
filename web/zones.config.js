/* ============================================================================
 *  zones.config.js  —  DEFAULT trigger areas (the starting set).
 *  ----------------------------------------------------------------------------
 *  You normally DON'T need to edit this file: add and edit areas right in the
 *  page (the "Trigger areas" panel), and your changes are saved in the browser.
 *  This file is only the default set used on first run and when you click
 *  "Reset to defaults". Editing it here changes those defaults.
 *
 *  Each entry defines an AREA in the room and the INFORMATION that pops up when
 *  the tag walks into it. Coordinates are in METRES, in the same frame the app
 *  uses for positioning:
 *      A1 = (0,0)   A2 = (d12, 0)   A3 solved from d13/d23
 *  Tip: in the page, "Set area by dragging on map" lets you draw the box
 *  visually instead of typing coordinates.
 *
 *  Fields per area:
 *    name        (required) short label, also shown on the map
 *    area        (required) { xmin, ymin, xmax, ymax } box in metres
 *    title       big heading shown when the tag enters
 *    message     body text / the information to surface
 *    color       accent colour (any CSS colour). Defaults to blue.
 *    icon        an emoji shown on the card (optional)
 *    image       image URL shown on the card (optional)
 *    link        { label, url } button on the card (optional)
 *    sound       true = short beep on entry (default false)
 *    once        true = fire once per visit (default true). false = re-fire is
 *                allowed but rate-limited by cooldownMs.
 *    cooldownMs  minimum gap between re-fires while inside / on re-entry (ms).
 *    holdMs      how long the pop-up card stays before auto-dismiss (ms).
 * ========================================================================== */

window.ZONE_TRIGGERS = [
  {
    name: "Front door",
    area: { xmin: 0.0, ymin: 0.0, xmax: 1.5, ymax: 1.2 },
    title: "Welcome home 👋",
    message: "Entry detected at the front door. Hallway lights turned on.",
    color: "#3fb950",
    icon: "🚪",
    sound: true,
    once: true,
    cooldownMs: 5000,
    holdMs: 6000,
  },
  {
    name: "Desk",
    area: { xmin: 2.0, ymin: 1.5, xmax: 3.2, ymax: 2.6 },
    title: "At the desk",
    message: "Focus mode on. Notifications silenced while you're working here.",
    color: "#58a6ff",
    icon: "💻",
    sound: false,
    once: true,
    cooldownMs: 10000,
    holdMs: 5000,
  },
  {
    name: "Kitchen",
    area: { xmin: 3.5, ymin: 0.0, xmax: 5.0, ymax: 2.0 },
    title: "Kitchen",
    message: "Reminder: you left the oven timer running.",
    color: "#d29922",
    icon: "🍳",
    sound: true,
    once: false,        // allowed to fire again on re-entry…
    cooldownMs: 15000,  // …but no more than once every 15 s
    holdMs: 6000,
    // image: "https://example.com/recipe.jpg",
    // link:  { label: "Open recipe", url: "https://example.com/recipe" },
  },
];
