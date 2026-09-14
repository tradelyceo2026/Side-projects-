// src/story.js — Agent G
// Pure data: no THREE, no DOM, safe to import in Node. The dialog, mission list,
// side characters and collectible metadata that missions.js drives at runtime.

// ---------------------------------------------------------------------------
// Helicarrier intro (played before the skydive)
// ---------------------------------------------------------------------------
export const INTRO = [
  { speaker: 'Storm', text: "Sentinel signatures over Baxter County. Radar's lighting up like a Friday night football game — you five are the closest team." },
  { speaker: 'Beast', text: "Landing zone is the courthouse square. Once you're down, the Mansion is the old college campus on South College Street — you can't miss the flag." },
  { speaker: 'Beast', text: "Try to land on your feet this time, Logan. The insurance adjuster still remembers the gazebo." },
  { speaker: 'Storm', text: "Go on, get. And somebody bring back barbecue." },
];

// ---------------------------------------------------------------------------
// Six main missions, run sequentially after M1.
// ---------------------------------------------------------------------------
export const MISSIONS = [
  {
    id: 'm1',
    title: 'Drop Zone',
    giver: 'beast',
    giverName: 'Beast',
    at: 'landing_zone',
    requires: null,
    intro: [
      { speaker: 'Beast', text: "Nice landing. Or landing-adjacent. Either way — welcome to Mountain Home." },
      { speaker: 'Beast', text: "Head on over to the Mansion, the old ASUMH campus. Storm and I will meet you there." },
    ],
    objectives: [
      { type: 'goto', poi: 'asumh', radius: 25, text: 'Make your way to the X-Mansion (ASUMH campus)' },
    ],
    outro: [
      { speaker: 'Beast', text: "Right on time. Come on in before the sweet tea gets warm." },
    ],
    reward: { cerebroCores: 1 },
  },
  {
    id: 'm2',
    title: 'Campus Lockdown',
    giver: 'dean',
    giverName: 'Dean Ledbetter',
    at: 'asumh',
    requires: null,
    intro: [
      { speaker: 'Dean Ledbetter', text: "Thank the Lord you're here. Feller calling himself Avalanche came rolling up with a truckload of Brotherhood goons." },
      { speaker: 'Dean Ledbetter', text: "They're after something on campus. Hold the line till we figure out what." },
    ],
    objectives: [
      { type: 'talk', characterId: 'dean', text: 'Check in with Dean Ledbetter' },
      { type: 'protect', poi: 'asumh', duration: 75, waves: 3, text: 'Defend the campus from the Brotherhood raid' },
    ],
    outro: [
      { speaker: 'Dean Ledbetter', text: "Avalanche hightailed it. You just saved fall semester — and my nerves." },
    ],
    reward: { cerebroCores: 2 },
  },
  {
    id: 'm3',
    title: 'Code Blue',
    giver: 'nurse',
    giverName: 'Nurse Whitfield',
    at: 'hospital',
    requires: null,
    intro: [
      { speaker: 'Nurse Whitfield', text: "Sentinel scout drones are buzzing the ER like horseflies. Scared the stuffing out of Mrs. Pruitt in bed six." },
      { speaker: 'Nurse Whitfield', text: "Clear 'em out before somebody pulls an IV loose." },
    ],
    objectives: [
      { type: 'defeat', kind: 'drone', count: 6, text: 'Shoot down the drones over Baxter Regional' },
    ],
    outro: [
      { speaker: 'Nurse Whitfield', text: "Quiet as a Sunday morning. Y'all want a popsicle from the nurses' station?" },
    ],
    reward: { cerebroCores: 2 },
  },
  {
    id: 'm4',
    title: 'Highway 62',
    giver: 'deputy',
    giverName: 'Deputy Youngblood',
    at: 'courthouse',
    requires: 'quicksilver',
    requiresToast: 'Switch to Quicksilver',
    intro: [
      { speaker: 'Deputy Youngblood', text: "Brotherhood truck's haulin' tail down 62 toward the Walmart with half our supply drop. Only one of y'all's fast enough to catch it." },
      { speaker: 'Quicksilver', text: "Say less." },
    ],
    objectives: [
      { type: 'escort', npcId: 'deputy_cruiser', to: { poi: 'walmart' }, radius: 15, text: 'Race the getaway truck down US-62' },
      { type: 'destroy', targets: [{ kind: 'thug', count: 3 }], text: 'Take out the Brotherhood outriders' },
    ],
    outro: [
      { speaker: 'Deputy Youngblood', text: "Didn't even see you go by. Radar gun about had itself a stroke." },
    ],
    reward: { cerebroCores: 2 },
  },
  {
    id: 'm5',
    title: 'Lake Run',
    giver: 'fisherman',
    giverName: 'Skeeter Combs',
    at: 'lake',
    requires: 'jean',
    requiresToast: 'Switch to Jean',
    intro: [
      { speaker: 'Skeeter Combs', text: "Somethin' fell outta the sky and sank right by my favorite stump. Glowin' like a lightning bug the size of a basketball." },
      { speaker: 'Jean', text: "Sounds like a Cerebro core. I can find it — let me try." },
    ],
    objectives: [
      { type: 'goto', poi: 'lake', radius: 25, text: 'Search the shallows near the lake' },
      { type: 'collect', kind: 'cerebro', count: 1, text: 'Recover the Cerebro core' },
    ],
    outro: [
      { speaker: 'Skeeter Combs', text: "Well I'll be. Keep the worm sinkers, Professor. That thing's yours." },
    ],
    reward: { cerebroCores: 3 },
  },
  {
    id: 'm6',
    title: 'Square Off',
    giver: 'storm',
    giverName: 'Storm',
    at: 'downtown',
    requires: null,
    intro: [
      { speaker: 'Storm', text: "The Sentinel's converging on the courthouse square. Whole town's watching — let's not embarrass Arkansas." },
      { speaker: 'Beast', text: "Aim for the neck joint. It's the one place they forgot to armor. Typical." },
    ],
    objectives: [
      { type: 'boss', kind: 'sentinel', at: 'downtown', text: 'Bring down the Sentinel at the square' },
    ],
    outro: [
      { speaker: 'Storm', text: "Mountain Home is safe. For today, at least." },
      { speaker: 'Beast', text: "I could go for that barbecue now." },
    ],
    reward: { cerebroCores: 5 },
  },
];

// ---------------------------------------------------------------------------
// Side characters — six locals with short idle chatter and a short side quest.
// ---------------------------------------------------------------------------
export const SIDE_CHARACTERS = [
  {
    id: 'deputy',
    name: 'Deputy Cody Youngblood',
    role: "Sheriff's Deputy",
    at: 'courthouse',
    lines: [
      "Y'all mutants sure beat waitin' on state troopers.",
      "Courthouse clock's been ten minutes fast since '99. Nobody's fixed it. Nobody will.",
      "Careful round the square — Miss Ferril's dog thinks he's deputized too.",
      "Heard tell a Sentinel stepped clean over the Dairy Dip. Didn't spill a shake.",
    ],
    rigSpec: { gender: 'male', skin: '#d9a878', hair: '#3b2a1a', outfit: { top: '#4a5a3a', bottom: '#2f3a26', hat: '#2f3a26' }, seed: 101 },
    mission: {
      id: 'deputy_goats',
      title: 'Loose Livestock',
      intro: [
        { speaker: 'Deputy Youngblood', text: "Couple of Toad's boys spooked the Widow Calloway's goats loose downtown. Run 'em off before somebody gets head-butted." },
      ],
      objectives: [
        { type: 'defeat', kind: 'thug', count: 2, text: 'Chase off the goat-spookers' },
        { type: 'goto', poi: 'courthouse', radius: 15, text: 'Report back to Deputy Youngblood' },
      ],
      outro: [
        { speaker: 'Deputy Youngblood', text: "Widow Calloway thanks you. So do the goats, probably, in their way." },
      ],
    },
  },
  {
    id: 'dean',
    name: 'Dean Constance Ledbetter',
    role: 'ASUMH Dean',
    at: 'asumh',
    lines: [
      "Budget committee's scarier than any Brotherhood goon, I'll tell you what.",
      "We got a mutant studies minor now. Enrollment's up, oddly enough.",
      "Mind the lawn. Groundskeeping already hates the Sentinels for the footprints.",
      "Storm dropped by faculty parking once. Never did find a spot she liked.",
    ],
    rigSpec: { gender: 'female', skin: '#c99a72', hair: '#5a4636', outfit: { top: '#7a1f2b', bottom: '#2b2b2b' }, seed: 102 },
    mission: {
      id: 'dean_library',
      title: 'Library Rescue',
      intro: [
        { speaker: 'Dean Ledbetter', text: "A couple drones dive-bombed the library stacks. Miss Ferril's afraid to go back for her reserved copy of the Farmers' Almanac." },
      ],
      objectives: [
        { type: 'goto', poi: 'asumh', radius: 40, text: 'Head to the library' },
        { type: 'defeat', kind: 'drone', count: 2, text: 'Clear the drones out of the stacks' },
      ],
      outro: [
        { speaker: 'Dean Ledbetter', text: "Bless your heart. The almanac lives to see another printing." },
      ],
    },
  },
  {
    id: 'cook',
    name: 'Merle Tatum',
    role: 'Square Diner Cook',
    at: 'downtown',
    lines: [
      "Pie's fresh. Sentinels ain't invited.",
      "Coffee's strong enough to wake up a hibernating bear, or Wolverine on a Monday.",
      "Toad tracked mud clean across my counter last week. Rude.",
      "You save the town, breakfast's on me. Every day. Forever. I mean it.",
    ],
    rigSpec: { gender: 'male', skin: '#e0b28c', hair: '#8a8a8a', outfit: { top: '#ffffff', bottom: '#3a3a3a', hat: '#ffffff' }, seed: 103 },
    mission: {
      id: 'cook_raccoon',
      title: 'Walk-In Trouble',
      intro: [
        { speaker: 'Merle Tatum', text: "Some fool thug's holed up in my walk-in eatin' my pie inventory. Get on back there and set him straight." },
      ],
      objectives: [
        { type: 'goto', poi: 'downtown', radius: 12, text: 'Head around back of the diner' },
        { type: 'defeat', kind: 'thug', count: 1, text: 'Chase the pie thief out of the walk-in' },
      ],
      outro: [
        { speaker: 'Merle Tatum', text: "Saved the meringue. You're a hero, officially, in my book." },
      ],
    },
  },
  {
    id: 'coach',
    name: 'Coach Bo Renfro',
    role: 'High School Football Coach',
    at: 'high_school',
    lines: [
      "Two-a-days are hard enough without drones buzzin' the practice field.",
      "Bobcats made state in '08. We don't let anybody forget it.",
      "You hit like a linebacker, bub. You ever consider tryouts?",
      "Water break's over when I say it's over. Even for X-Men.",
    ],
    rigSpec: { gender: 'male', skin: '#c98a5a', hair: '#20201f', outfit: { top: '#8a1a1a', bottom: '#1a1a1a', hat: '#8a1a1a' }, seed: 104 },
    mission: {
      id: 'coach_drones',
      title: 'Fifty-Yard Line',
      intro: [
        { speaker: 'Coach Renfro', text: "Drones are runnin' pattern drills better than my receivers. Clear the field before practice starts." },
      ],
      objectives: [
        { type: 'defeat', kind: 'drone', count: 3, text: 'Clear the drones off the practice field' },
      ],
      outro: [
        { speaker: 'Coach Renfro', text: "Field's clear. Now git — you're blockin' my sightline." },
      ],
    },
  },
  {
    id: 'fisherman',
    name: 'Skeeter Combs',
    role: 'Bass Fisherman',
    at: 'lake',
    lines: [
      "Norfork's stripers are bitin', if the world would quit endin' for five minutes.",
      "Seen a Sentinel wade in up to its knee once. Ruined my whole morning.",
      "You want a lure that works? Chartreuse. Always chartreuse.",
      "Careful of my trotlines out there, hero.",
    ],
    rigSpec: { gender: 'male', skin: '#d3a074', hair: '#9a9a9a', outfit: { top: '#3a5a4a', bottom: '#5a4a2a', hat: '#c9b27a' }, seed: 105 },
    mission: {
      id: 'fisherman_tackle',
      title: 'Tangled Tackle',
      intro: [
        { speaker: 'Skeeter Combs', text: "Couple of Toad's goons tangled up my best trotline messin' around the bank. Run 'em off, would ya?" },
      ],
      objectives: [
        { type: 'goto', poi: 'lake', radius: 30, text: "Head down to Skeeter's fishing spot" },
        { type: 'defeat', kind: 'thug', count: 2, text: 'Run off the goons tangling the trotline' },
      ],
      outro: [
        { speaker: 'Skeeter Combs', text: "Much obliged. Line's untangled and so are my nerves." },
      ],
    },
  },
  {
    id: 'nurse',
    name: 'Patty Whitfield',
    role: 'ER Nurse',
    at: 'hospital',
    lines: [
      "You bleed, you come see me. Even you, Mr. Claws.",
      "We've had three broken toes from tripping over Sentinel debris this month alone.",
      "Vending machine's broke again. World might actually be ending.",
      "Drink some water, hero. You look plumb wrung out.",
    ],
    rigSpec: { gender: 'female', skin: '#e3b58f', hair: '#3a2a20', outfit: { top: '#bfe3ea', bottom: '#e8e8e8' }, seed: 106 },
    mission: {
      id: 'nurse_ambulance',
      title: 'Ambulance Bay',
      intro: [
        { speaker: 'Patty Whitfield', text: "Drones keep divin' at the ambulance bay. We can't get a rig in or out. Clear the airspace, hon." },
      ],
      objectives: [
        { type: 'defeat', kind: 'drone', count: 2, text: 'Keep the drones off the ambulance bay' },
        { type: 'goto', poi: 'hospital', radius: 15, text: 'Check back in with Nurse Whitfield' },
      ],
      outro: [
        { speaker: 'Patty Whitfield', text: "Bay's clear. Go on now, before I put you to work restocking gauze." },
      ],
    },
  },
];

// ---------------------------------------------------------------------------
// Collectible metadata (actual placement math lives in missions.js, since it
// needs a live City instance to raycast/snap to roads).
// ---------------------------------------------------------------------------
export const COLLECTIBLES = { kind: 'cerebro', count: 25, placement: 'rooftops|pois|roads' };

export const STORY = {
  intro: INTRO,
  missions: MISSIONS,
  sideCharacters: SIDE_CHARACTERS,
  collectibles: COLLECTIBLES,
};
