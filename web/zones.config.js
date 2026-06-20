/* ============================================================================
 *  zones.config.js  —  DEFAULT trigger areas (the starting set).
 *  ----------------------------------------------------------------------------
 *  You normally DON'T need to edit this file: add and edit areas right in the
 *  page (the "Trigger areas" panel), and your changes are saved in the browser.
 *  This file is only the default set used on first run and when you click
 *  "Reset to defaults". Editing it here changes those defaults.
 *
 *  Each entry defines an AREA in the room and what happens when the tag enters:
 *  an info pop-up (title + message + image) and, if set, an AUDIO GUIDE that
 *  plays automatically. Coordinates are in METRES in the positioning frame
 *  (A1=(0,0), A2=(d12,0), A3 from d13/d23). Tip: in the page use "Set area by
 *  dragging on map" to place a box visually, and add an "Audio guide URL".
 *
 *  The starter set below is the SK TechChange tour (6 attractions, files in
 *  ./attractions). The boxes assume a ~10 m × 6 m room — recalibrate / redraw to
 *  match your real layout.
 * ========================================================================== */

window.ZONE_TRIGGERS = [
  { name:"Long Building", icon:"🏛️", color:"#58a6ff",
    area:{ xmin:-1.2, ymin:-1.2, xmax:1.2, ymax:1.2 },
    title:"Long Building", message:"Historic long building — a landmark of the campus.",
    image:"attractions/a1-Long-building.jpeg", audio:"attractions/a1-Long-building.mp3",
    sound:true, once:true, cooldownMs:15000, holdMs:12000 },

  { name:"Luang Pu", icon:"🙏", color:"#d29922",
    area:{ xmin:3.8, ymin:-1.2, xmax:6.2, ymax:1.2 },
    title:"Luang Pu", message:"Statue and shrine of Luang Pu, a revered figure.",
    image:"attractions/a2-Luang-Pu.jpeg", audio:"attractions/a2-Luang-Pu.mp3",
    sound:true, once:true, cooldownMs:15000, holdMs:12000 },

  { name:"Planetarium", icon:"🪐", color:"#a371f7",
    area:{ xmin:8.8, ymin:-1.2, xmax:11.2, ymax:1.2 },
    title:"Planetarium", message:"Planetarium dome — explore the stars and the solar system.",
    image:"attractions/a3-Planetarium.jpeg", audio:"attractions/a3-Planetarium.mp3",
    sound:true, once:true, cooldownMs:15000, holdMs:12000 },

  { name:"Edu Museum", icon:"🔬", color:"#3fb950",
    area:{ xmin:-1.2, ymin:4.8, xmax:1.2, ymax:7.2 },
    title:"Edu Museum", message:"Educational museum with rotating science and history exhibits.",
    image:"attractions/a4-Edu-Museum.jpg", audio:"attractions/a4-Edu-Museum.mp3",
    sound:true, once:true, cooldownMs:15000, holdMs:12000 },

  { name:"King Rama V", icon:"👑", color:"#f0883e",
    area:{ xmin:3.8, ymin:4.8, xmax:6.2, ymax:7.2 },
    title:"King Rama V", message:"Monument honouring King Rama V (Chulalongkorn the Great).",
    image:"attractions/a5-KingRamaV.jpg", audio:"attractions/a5-KingRamaV.mp3",
    sound:true, once:true, cooldownMs:15000, holdMs:12000 },

  { name:"Horror", icon:"👻", color:"#f85149",
    area:{ xmin:8.8, ymin:4.8, xmax:11.2, ymax:7.2 },
    title:"Horror", message:"Horror attraction — not for the faint-hearted.",
    image:"attractions/a6-Horror.jpeg", audio:"attractions/a6-Horror.mp3",
    sound:true, once:true, cooldownMs:15000, holdMs:12000 },
];
