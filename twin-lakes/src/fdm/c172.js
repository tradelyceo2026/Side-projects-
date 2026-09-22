// Cessna 172S Skyhawk. Geometry and mass from the POH, stability derivatives from Roskam,
// "Airplane Flight Dynamics and Automatic Flight Controls" (C172, cruise), propeller and engine
// calibrated so static RPM, climb rate and cruise TAS match the POH within a few percent (see test/).

const DEG = Math.PI / 180;

export const C172 = {
  name: 'Cessna 172S Skyhawk',
  // geometry
  S: 16.17,          // wing area, m²
  b: 10.91,          // span, m
  c: 1.49,           // mean aerodynamic chord, m
  AR: 7.36,
  e: 0.75,           // Oswald efficiency

  // mass (kg) and inertia (kg·m², body axes)
  emptyMass: 767,
  maxMass: 1111,
  pilotMass: 86,
  fuelMax: 144,      // 53 US gal usable avgas
  Ixx: 1285,
  Iyy: 1825,
  Izz: 2667,

  // longitudinal
  CL0: 0.307, CLa: 4.41, CLq: 3.9, CLde: 0.43, CLadot: 1.7,
  CLmax: 1.48, CLmin: -0.95,
  CD0: 0.031,
  Cm0: 0.04, Cma: -0.613, Cmq: -12.4, Cmadot: -7.27, Cmde: -1.122,
  // lateral-directional
  CYb: -0.393, CYp: -0.075, CYr: 0.214, CYdr: 0.187,
  Clb: -0.0923, Clp: -0.484, Clr: 0.0798, Clda: 0.229, Cldr: 0.0147,
  Cnb: 0.0587, Cnp: -0.0278, Cnr: -0.0937, Cnda: -0.0216, Cndr: -0.0645,

  // controls (rad)
  elevUp: 28 * DEG, elevDown: 23 * DEG,
  aileronMax: 10 * DEG,       // effective average deflection used with Clda (roll rate ~45°/s at cruise)
  rudderMax: 12 * DEG,       // effective (the 16° pedal throw acts on part of the fin)
  trimRange: [-12 * DEG, 6 * DEG],   // equivalent elevator from the trim tab
  noseSteer: 10 * DEG,

  // flaps: detents 0, 10, 20, 30 degrees
  flapDetents: [0, 10, 20, 30],
  flapRate: 3.5,              // deg/s electric flap motor
  flapCL: [0, 0.16, 0.34, 0.45],
  flapCLmax: [0, 0.14, 0.26, 0.34],
  flapCD: [0, 0.006, 0.02, 0.045],
  flapCm: [0, -0.01, -0.025, -0.035],

  // propeller: McCauley 2-blade fixed pitch, 75 in
  propD: 1.905,
  Ct: (J) => 0.11 - 0.0755 * J,
  Cp: (J) => 0.0612 - 0.0183 * J * J,
  engineInertia: 2.2,         // prop + crank, kg·m²
  // engine: Lycoming IO-360-L2A, 180 hp at 2700 rpm
  ratedPower: 134200,         // W
  ratedRpm: 2700,
  idleFraction: 0.12,
  frictionTorque: (rpm) => 16 + 0.006 * rpm,
  bsfc: 0.2737 / 3.6e6,       // kg per J (0.45 lb/hp/h)

  // landing gear in the model frame (+x right, +y up, -z forward), metres from the CG
  gear: [
    { name: 'nose', pos: [0, -1.10, -1.10], k: 62000, c: 4200, stroke: 0.2, steer: true, brake: false },
    { name: 'left', pos: [-1.27, -1.12, 0.55], k: 68000, c: 5200, stroke: 0.18, steer: false, brake: true },
    { name: 'right', pos: [1.27, -1.12, 0.55], k: 68000, c: 5200, stroke: 0.18, steer: false, brake: true },
  ],
  // points that must never touch the ground
  hardPoints: [
    { name: 'left wingtip', pos: [-5.45, 0.95, 0.2] },
    { name: 'right wingtip', pos: [5.45, 0.95, 0.2] },
    { name: 'tail', pos: [0, 0.05, 4.9] },          // tie-down ring: strikes near 14° nose up on the mains
    { name: 'propeller', pos: [0, -0.82, -2.2] },
    { name: 'belly', pos: [0, -0.78, -0.2] },
  ],
  mu: { roll: 0.025, brake: 0.55, side: 0.85 },

  // speeds (knots) for the airspeed tape and the checklist
  V: { s0: 40, s1: 48, r: 55, x: 62, y: 74, fe: 85, no: 129, ne: 163, a: 105, app: 65, ref: 61 },
};
