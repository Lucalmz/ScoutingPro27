import { waitForTransition } from './browser.js';
import { delay } from './server.js';

export function buildPitwallSeed(eventId, scoutInfo = { id: 'host_1', username: 'PitWallHost' }) {
  const tsBase = Date.now() - 3_600_000;
  const pitSpecs = [
    {
      team: 27570,
      robotName: 'B.E.A.R Apex',
      drivetrainType: 'swerve',
      weightLbs: 41.2,
      chassisSize: 'standard_mid',
      odometryType: 'three_wheel',
      ballCompatibility: 'universal',
      launcherType: 'dual_flywheel',
      flowerMechanism: 'vertical_lift',
      hasColorSensor: true,
      hasDescoreMech: true,
      hasApriltagVision: true,
      claimedAutoStrategy: '2-ball fast auto + park',
      claimedAutoScore: 14,
      claimedTeleopCycles: 7,
      claimedTeleopScore: 52,
      claimedTeleopPark: true,
      claimedFlowerNectars: 3,
      claimedFlowerBottomBonus: 2,
      claimedFlowerPollens: 4,
      claimedGardenBalls: 3
    },
    {
      team: 11115,
      robotName: 'Volt Runner',
      drivetrainType: 'mecanum',
      weightLbs: 38.6,
      chassisSize: 'compact_small',
      odometryType: 'two_wheel',
      ballCompatibility: 'universal',
      launcherType: 'turret',
      flowerMechanism: 'angled_launcher',
      hasColorSensor: true,
      hasDescoreMech: false,
      hasApriltagVision: true,
      claimedAutoStrategy: '1-ball spike + park',
      claimedAutoScore: 11,
      claimedTeleopCycles: 6,
      claimedTeleopScore: 44,
      claimedTeleopPark: true,
      claimedFlowerNectars: 2,
      claimedFlowerBottomBonus: 1,
      claimedFlowerPollens: 3,
      claimedGardenBalls: 2
    },
    {
      team: 28410,
      robotName: 'Cobalt Surge',
      drivetrainType: 'tank',
      weightLbs: 42.0,
      chassisSize: 'wide_heavy',
      odometryType: 'pinpoint',
      ballCompatibility: 'sorting',
      launcherType: 'single_flywheel',
      flowerMechanism: 'angled_launcher',
      hasColorSensor: true,
      hasDescoreMech: false,
      hasApriltagVision: false,
      claimedAutoStrategy: 'Center rush + 1 ball',
      claimedAutoScore: 14,
      claimedTeleopCycles: 7,
      claimedTeleopScore: 60,
      claimedTeleopPark: true,
      claimedFlowerNectars: 3,
      claimedFlowerBottomBonus: 2,
      claimedFlowerPollens: 2,
      claimedGardenBalls: 4
    },
    {
      team: 31024,
      robotName: 'Orion Drive',
      drivetrainType: 'swerve',
      weightLbs: 39.4,
      chassisSize: 'standard_mid',
      odometryType: 'three_wheel',
      ballCompatibility: 'universal',
      launcherType: 'dual_flywheel',
      flowerMechanism: 'vertical_lift',
      hasColorSensor: true,
      hasDescoreMech: false,
      hasApriltagVision: true,
      claimedAutoStrategy: 'AprilTag aligned 2-ball',
      claimedAutoScore: 11,
      claimedTeleopCycles: 6,
      claimedTeleopScore: 40,
      claimedTeleopPark: true,
      claimedFlowerNectars: 2,
      claimedFlowerBottomBonus: 1,
      claimedFlowerPollens: 2,
      claimedGardenBalls: 2
    },
    {
      team: 9999,
      robotName: 'Granite Fox',
      drivetrainType: 'mecanum',
      weightLbs: 34.8,
      chassisSize: 'compact_small',
      odometryType: 'none',
      ballCompatibility: 'pollen_only',
      launcherType: 'spring_punch',
      flowerMechanism: 'none',
      hasColorSensor: false,
      hasDescoreMech: true,
      hasApriltagVision: false,
      claimedAutoStrategy: 'Leave + defensive park',
      claimedAutoScore: 8,
      claimedTeleopCycles: 4,
      claimedTeleopScore: 24,
      claimedTeleopPark: true,
      claimedFlowerNectars: 0,
      claimedFlowerBottomBonus: 0,
      claimedFlowerPollens: 0,
      claimedGardenBalls: 5
    }
  ];

  const officialTeams = pitSpecs.map((p) => ({
    eventId,
    teamNumber: p.team,
    nameFull: p.robotName,
    robotName: p.robotName,
    city: 'Chicago',
    country: 'USA'
  }));

  const pitRecords = pitSpecs.map((p) => {
    const claimedEndgameScore =
      (p.claimedTeleopPark ? 5 : 0) +
      p.claimedFlowerNectars * 2 +
      p.claimedFlowerBottomBonus * 5 +
      p.claimedFlowerPollens * 2 +
      p.claimedGardenBalls;
    const claimedTotalScore = p.claimedAutoScore + p.claimedTeleopScore + claimedEndgameScore;

    const payload = {
      id: `${eventId}_pit_${p.team}`,
      eventId,
      teamNumber: p.team,
      scoutId: scoutInfo.id,
      scoutName: scoutInfo.username,
      robotName: p.robotName,
      drivetrainType: p.drivetrainType,
      weightLbs: p.weightLbs,
      chassisSize: p.chassisSize,
      odometryType: p.odometryType,
      ballCompatibility: p.ballCompatibility,
      launcherType: p.launcherType,
      flowerMechanism: p.flowerMechanism,
      hasColorSensor: p.hasColorSensor,
      hasDescoreMech: p.hasDescoreMech,
      hasApriltagVision: p.hasApriltagVision,
      claimedAutoStrategy: p.claimedAutoStrategy,
      claimedAutoScore: p.claimedAutoScore,
      claimedTeleopCycles: p.claimedTeleopCycles,
      claimedTeleopScore: p.claimedTeleopScore,
      claimedTeleopPark: p.claimedTeleopPark,
      claimedFlowerNectars: p.claimedFlowerNectars,
      claimedFlowerBottomBonus: p.claimedFlowerBottomBonus,
      claimedFlowerPollens: p.claimedFlowerPollens,
      claimedGardenBalls: p.claimedGardenBalls,
      claimedEndgameScore,
      claimedTotalScore,
      photoKeys: [],
      version: 1
    };
    payload.rawData = JSON.stringify(payload);
    return payload;
  });

  function makeMatchRecord({
    id,
    matchNumber,
    teamNumber,
    allianceColor,
    autoBalls,
    teleopCycles,
    teleopMissedCycles,
    flowerNectars,
    flowerBottomBonusCount,
    flowerPollens,
    gardenBalls,
    flowerDescore,
    notes
  }) {
    const autoLeave = true;
    const autoPark = true;
    const teleopPark = true;
    const autoScore = 3 + autoBalls * 3 + 5;
    const teleopScore = teleopCycles.reduce((s, v) => s + v, 0) * 2;
    const clampedBottom = Math.min(flowerBottomBonusCount, flowerNectars, 4);
    const endgameScore = 5 + flowerNectars * 2 + clampedBottom * 5 + flowerPollens * 2 + gardenBalls;
    const totalScore = autoScore + teleopScore + endgameScore;

    const teleopCycleTimestamps = teleopCycles.map((_, idx) => tsBase + matchNumber * 300_000 + idx * 8800);

    const rawObj = {
      matchNumber,
      tournamentLevel: 'QUALIFICATION',
      teamNumber,
      allianceColor,
      isBroken: false,
      autoLeave,
      autoBalls,
      autoCycles: autoBalls > 0 ? [autoBalls] : [],
      autoMissedCycles: autoBalls > 0 ? [0] : [],
      autoPreload: autoBalls > 0,
      autoPark,
      teleopCycles,
      teleopMissedCycles,
      teleopCycleTimestamps,
      flowerNectars,
      flowerBottomBonusCount: clampedBottom,
      flowerPollens,
      gardenBalls,
      flowerDescore,
      g410EarlyFlowerFoul: false,
      flowerPlaced: flowerNectars > 0,
      flowerBottomBonus: clampedBottom > 0,
      teleopPark
    };

    const nowIso = new Date().toISOString();
    return {
      id: `${eventId}_rec_${id}`,
      eventId,
      scoutId: scoutInfo.id,
      scoutName: scoutInfo.username,
      matchNumber,
      teamNumber,
      autoScore,
      teleopScore,
      endgameScore,
      totalScore,
      notes,
      rawData: JSON.stringify(rawObj),
      syncStatus: 'SYNCED',
      createdAt: nowIso,
      updatedAt: nowIso,
      isBroken: false,
      version: 1
    };
  }

  const matchRecords = [
    makeMatchRecord({
      id: 'q1_27570',
      matchNumber: 1,
      teamNumber: 27570,
      allianceColor: 'red',
      autoBalls: 2,
      teleopCycles: [4, 4, 4, 4, 4, 3, 2],
      teleopMissedCycles: [0, 1, 0, 0, 1, 0, 0],
      flowerNectars: 3,
      flowerBottomBonusCount: 2,
      flowerPollens: 4,
      gardenBalls: 3,
      flowerDescore: true,
      notes: 'Consistent 8.6s cycle time, strong endgame nectar.'
    }),
    makeMatchRecord({
      id: 'q1_11115',
      matchNumber: 1,
      teamNumber: 11115,
      allianceColor: 'red',
      autoBalls: 1,
      teleopCycles: [4, 3, 4, 3, 4, 3],
      teleopMissedCycles: [0, 1, 0, 0, 1, 0],
      flowerNectars: 2,
      flowerBottomBonusCount: 1,
      flowerPollens: 3,
      gardenBalls: 2,
      flowerDescore: true,
      notes: 'Clean turret tracking and fast intake.'
    }),
    makeMatchRecord({
      id: 'q1_28410',
      matchNumber: 1,
      teamNumber: 28410,
      allianceColor: 'blue',
      autoBalls: 1,
      teleopCycles: [3, 2, 3, 2, 2, 2],
      teleopMissedCycles: [1, 1, 0, 1, 0, 0],
      flowerNectars: 1,
      flowerBottomBonusCount: 0,
      flowerPollens: 1,
      gardenBalls: 3,
      flowerDescore: false,
      notes: 'Heavy defense bot, occasional miss.'
    }),
    makeMatchRecord({
      id: 'q2_31024',
      matchNumber: 2,
      teamNumber: 31024,
      allianceColor: 'blue',
      autoBalls: 1,
      teleopCycles: [3, 3, 3, 3, 3, 2],
      teleopMissedCycles: [0, 1, 0, 0, 1, 0],
      flowerNectars: 2,
      flowerBottomBonusCount: 1,
      flowerPollens: 2,
      gardenBalls: 2,
      flowerDescore: false,
      notes: 'Steady swerve cycle pace.'
    }),
    makeMatchRecord({
      id: 'q1_9999',
      matchNumber: 1,
      teamNumber: 9999,
      allianceColor: 'blue',
      autoBalls: 0,
      teleopCycles: [2, 2, 2, 2],
      teleopMissedCycles: [0, 1, 0, 1],
      flowerNectars: 0,
      flowerBottomBonusCount: 0,
      flowerPollens: 0,
      gardenBalls: 4,
      flowerDescore: true,
      notes: 'Pollen specialist.'
    })
  ];

  const schedules = [
    { id: `${eventId}_sch_1`, eventId, matchNumber: 1, tournamentLevel: 'QUALIFICATION', red1: 27570, red2: 11115, blue1: 28410, blue2: 9999 },
    { id: `${eventId}_sch_2`, eventId, matchNumber: 2, tournamentLevel: 'QUALIFICATION', red1: 27570, red2: 28410, blue1: 31024, blue2: 11115 },
    { id: `${eventId}_sch_3`, eventId, matchNumber: 3, tournamentLevel: 'QUALIFICATION', red1: 9999, red2: 31024, blue1: 11115, blue2: 27570 }
  ];

  const assignments = [
    { id: `${eventId}_QUALIFICATION_1_red1`, eventId, matchNumber: 1, tournamentLevel: 'QUALIFICATION', station: 'red1', teamNumber: 27570, scoutId: scoutInfo.id, scoutName: scoutInfo.username },
    { id: `${eventId}_QUALIFICATION_1_red2`, eventId, matchNumber: 1, tournamentLevel: 'QUALIFICATION', station: 'red2', teamNumber: 11115, scoutId: 'scout_alex', scoutName: 'Alex' },
    { id: `${eventId}_QUALIFICATION_1_blue1`, eventId, matchNumber: 1, tournamentLevel: 'QUALIFICATION', station: 'blue1', teamNumber: 28410, scoutId: 'scout_chris', scoutName: 'Chris' },
    { id: `${eventId}_QUALIFICATION_1_blue2`, eventId, matchNumber: 1, tournamentLevel: 'QUALIFICATION', station: 'blue2', teamNumber: 9999, scoutId: 'scout_jordan', scoutName: 'Jordan' }
  ];

  const whiteboardPlan = {
    matchKey: 'QUALIFICATION_1',
    matchNumber: 1,
    tournamentLevel: 'QUALIFICATION',
    customTeams: { red1: 27570, red2: 11115, blue1: 28410, blue2: 9999 },
    phases: {
      auto: {
        strokes: [
          {
            id: 'str_auto_1',
            type: 'arrow',
            color: '#FF5D52',
            width: 4,
            points: [{ x: 0.16, y: 0.28 }, { x: 0.34, y: 0.42 }, { x: 0.46, y: 0.32 }],
            createdAt: Date.now()
          },
          {
            id: 'str_auto_2',
            type: 'arrow',
            color: '#4FA3FF',
            width: 4,
            points: [{ x: 0.84, y: 0.28 }, { x: 0.68, y: 0.38 }, { x: 0.58, y: 0.46 }],
            createdAt: Date.now()
          }
        ],
        undoStack: [],
        redoStack: [],
        robots: {
          red1: { station: 'red1', teamNumber: 27570, x: 0.16, y: 0.28, heading: 0, role: 'scorer' },
          red2: { station: 'red2', teamNumber: 11115, x: 0.16, y: 0.72, heading: 0, role: 'cycler' },
          blue1: { station: 'blue1', teamNumber: 28410, x: 0.84, y: 0.28, heading: 180, role: 'scorer' },
          blue2: { station: 'blue2', teamNumber: 9999, x: 0.84, y: 0.72, heading: 180, role: 'defense' }
        }
      },
      teleop: { strokes: [], undoStack: [], redoStack: [], robots: {} },
      endgame: { strokes: [], undoStack: [], redoStack: [], robots: {} }
    },
    tacticalNotes: 'Pit Wall E2E seeded match Q1.',
    updatedAt: Date.now()
  };

  return { officialTeams, pitRecords, matchRecords, schedules, assignments, whiteboardPlan };
}

export async function seedEventViaApi(page, eventId, scoutInfo) {
  const payload = buildPitwallSeed(eventId, scoutInfo);
  const res = await page.evaluate(async (eid, seed, token) => {
    const headers = {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    };
    const statusMap = {};

    const rTeams = await fetch(`/api/events/${encodeURIComponent(eid)}/official-teams/sync`, {
      method: 'POST',
      headers,
      body: JSON.stringify(seed.officialTeams)
    });
    statusMap.officialTeams = rTeams.status;

    const rPit = await fetch(`/api/events/${encodeURIComponent(eid)}/pit-records/batch`, {
      method: 'POST',
      headers,
      body: JSON.stringify(seed.pitRecords)
    });
    statusMap.pit = rPit.status;

    const rRec = await fetch('/api/records/sync', {
      method: 'POST',
      headers,
      body: JSON.stringify(seed.matchRecords)
    });
    statusMap.records = rRec.status;

    const rSch = await fetch(`/api/events/${encodeURIComponent(eid)}/schedule/batch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        items: seed.schedules,
        replace: true,
        assignments: seed.assignments
      })
    });
    statusMap.schedule = rSch.status;

    localStorage.setItem(
      `sp27_whiteboard_v1_${eid}`,
      JSON.stringify({ QUALIFICATION_1: seed.whiteboardPlan })
    );
    return statusMap;
  }, eventId, payload, scoutInfo?.token || '');

  for (const [step, status] of Object.entries(res)) {
    if (status < 200 || status >= 300) {
      throw new Error(`Seed step "${step}" returned HTTP ${status}`);
    }
  }

  await page.reload({ waitUntil: 'networkidle0' });
  await waitForTransition(page);
  await delay(400);

  if (!(await page.$('.event-view'))) {
    const card = await page.$('.event-card');
    if (card) {
      await card.click();
      await page.waitForSelector('.event-view', { visible: true, timeout: 10000 });
      await waitForTransition(page);
    }
  }

  return payload;
}
